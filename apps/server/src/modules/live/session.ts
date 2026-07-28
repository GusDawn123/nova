import { randomUUID } from "node:crypto";

import {
  LIVE_PROTOCOL_VERSION,
  parseClientEvent,
  type ClientLiveEvent,
  type LiveErrorCode,
  type ServerLiveEvent,
  type TranscriptInputOrigin,
} from "@nova/shared";

import type { SttEngine, SttSessionHandle } from "../stt/ports.js";

import type { LiveConductor, LiveConductorFactory } from "./conductor.js";
import type { LiveNotesConductorFactory } from "./notes-conductor.js";
import {
  createDisposer,
  noopAudioFrameHandler,
  type AudioFrameHandler,
  type Disposer,
  type LiveLogger,
  type LiveMetering,
  type LiveSessionRegistry,
  type LiveTranscriptConsumer,
  type TranscriptPersister,
} from "./ports.js";

import {
  DEFAULT_QUOTA_RECHECK_SECONDS,
  isOverSttQuotaAtStart,
  STT_SAMPLE_RATE_HZ,
  SttUsageMeter,
} from "./stt-usage.js";

/**
 * One live session per socket (per-user concurrency caps are Phase 6 — not
 * here). Transport-agnostic on purpose: it takes a `send` callback and is fed
 * decoded text / binary messages, so the whole lifecycle is unit-testable
 * without a real WebSocket. `routes.ts` is the only thing that knows about `ws`.
 */

export interface LiveSessionDeps {
  /** Emit a typed event down the socket (serialization lives in the transport). */
  send: (event: ServerLiveEvent) => void;
  /** Binary-audio seam; defaults to a no-op (Task 4 wires the STT relay). */
  onAudioFrame?: AudioFrameHandler;
  /** Session id factory; overridable for deterministic tests. */
  generateSessionId?: () => string;
  /**
   * Whether the TEST-ONLY `echo` mode may be honored. The transport passes
   * `NODE_ENV !== "production"` so echo can never be triggered in production
   * even if a client sends `echo: true`.
   */
  allowEcho?: boolean;
  /**
   * The STT engine over the configured vendor lineup. On `session.start` a
   * per-call engine session is started; audio frames relay into it and its
   * transcript / `provider_switched` / `error` events go straight down the
   * socket via {@link send}. Omitted in pure protocol unit tests; the transport
   * always supplies one (built from the env vendor registry).
   */
  sttEngine?: SttEngine;
  /**
   * Durable transcript memory. When present (and {@link userId} is set), the
   * session persists every FINAL transcript off the relay path and stamps
   * `ended_at` on disposal. Omitted when the DB is not configured — the session
   * still streams to the phone, just without persistence.
   */
  persister?: TranscriptPersister;
  /** The authenticated caller (the meeting owner). Required to persist. */
  userId?: string;
  /** Structured-error sink for persistence failures (never receives content). */
  logger?: LiveLogger;
  /**
   * Metering + quota seam (Phase 6, adr-0007 §3/§4). OPTIONAL, like the
   * persister: a keyless/DB-less dev boot skips enforcement exactly as it skips
   * persistence — the session streams unmetered because there is no ledger.
   * Effective only when {@link userId} is also set (attribution needs an owner).
   */
  metering?: LiveMetering;
  /**
   * The FIRST vendor of the configured STT lineup — pre-failover attribution
   * (the engine only announces vendors on a SWITCH). The transport supplies it
   * from the same registry it builds the engine with.
   */
  initialSttVendor?: string;
  /** Mid-stream quota recheck cadence in seconds of METERED audio (default 15). */
  quotaRecheckSeconds?: number;
  /**
   * ONE-live-session-per-user registry (Phase 6, adr-0007 §6). OPTIONAL like
   * the other enforcement seams; effective only with a {@link userId}.
   */
  registry?: LiveSessionRegistry;
  /**
   * The live copilot conductor factory (Phase 7). When wired (an LLM key is
   * present) and an owner is known, a per-call conductor is built at
   * `session.start`: it watches the same transcript stream the relay forwards,
   * gates spend, and streams `suggestion.*` down THIS socket. Omitted on a
   * keyless boot — the session still transcribes, just without suggestions.
   */
  createConductor?: LiveConductorFactory;
  /**
   * The running-notes conductor factory (Phase 8). Same posture as
   * {@link createConductor}: wired only when an LLM key AND the DB are present,
   * built at `session.start` for a known owner, skipped in echo mode. It watches
   * the same transcript stream and streams `notes.update` down THIS socket.
   */
  createNotesConductor?: LiveNotesConductorFactory;
}

export class LiveSession {
  /** Run-exactly-once teardown latch; vendor resources register here (Task 4+). */
  readonly disposer: Disposer = createDisposer();

  private readonly send: (event: ServerLiveEvent) => void;
  private readonly onAudioFrame: AudioFrameHandler;
  private readonly generateSessionId: () => string;
  private readonly allowEcho: boolean;
  private readonly sttEngine: SttEngine | null;
  private readonly persister: TranscriptPersister | null;
  private readonly userId: string | null;
  private readonly logger: LiveLogger | null;

  private readonly metering: LiveMetering | null;
  private readonly registry: LiveSessionRegistry | null;
  private readonly createConductor: LiveConductorFactory | null;
  private readonly createNotesConductor: LiveNotesConductorFactory | null;
  private readonly initialSttVendor: string;
  private readonly quotaRecheckSeconds: number;
  /**
   * The live copilot conductor for this call; null until start (or unwired). Kept
   * as its own handle ALONGSIDE {@link consumers} because the typed-question
   * channel (`onDirectQuestion`) is copilot-specific — it is not part of the
   * transcript stream every consumer sees.
   */
  private conductor: LiveConductor | null = null;
  /** Everything watching this call's transcript, in registration order. */
  private readonly consumers: LiveTranscriptConsumer[] = [];

  private started = false;
  private sessionId: string | null = null;
  private echo = false;
  /** Wall-clock ms at `session.ready` — anchors ts_ms for typed-input finals. */
  private startedAtMs: number | null = null;
  /** The meeting this socket is tied to (from `session.start`); null until start. */
  private meetingId: string | null = null;
  /** The live STT relay handle for this call; null until start (or in echo mode). */
  private stt: SttSessionHandle | null = null;
  /** STT usage accounting + quota cadence; null until start (or unmetered). */
  private sttUsage: SttUsageMeter | null = null;
  /**
   * In-flight final-transcript writes. `markEnded` waits on these so a call is
   * never stamped ended while its own transcript rows are still being written.
   */
  private readonly pendingWrites = new Set<Promise<void>>();

  constructor(deps: LiveSessionDeps) {
    this.send = deps.send;
    this.onAudioFrame = deps.onAudioFrame ?? noopAudioFrameHandler;
    this.generateSessionId = deps.generateSessionId ?? randomUUID;
    this.allowEcho = deps.allowEcho ?? false;
    this.sttEngine = deps.sttEngine ?? null;
    this.persister = deps.persister ?? null;
    this.userId = deps.userId ?? null;
    this.logger = deps.logger ?? null;
    this.metering = deps.metering ?? null;
    this.registry = deps.registry ?? null;
    this.createConductor = deps.createConductor ?? null;
    this.createNotesConductor = deps.createNotesConductor ?? null;
    // "unknown" only ever bills on a misconfigured wiring (the transport always
    // passes the lineup head when vendors exist); kept explicit, never invented.
    this.initialSttVendor = deps.initialSttVendor ?? "unknown";
    this.quotaRecheckSeconds =
      deps.quotaRecheckSeconds ?? DEFAULT_QUOTA_RECHECK_SECONDS;
  }

  /** The generated session id once `session.start` has been accepted. */
  get id(): string | null {
    return this.sessionId;
  }

  /**
   * Handle one inbound TEXT frame (a JSON control event). A malformed frame is
   * answered with an `error` event and DROPPED — a single bad frame never tears
   * down the session (that is what WS close codes are for).
   */
  handleTextMessage(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.sendError("invalid_json", "message was not valid JSON");
      return;
    }

    const parsed = parseClientEvent(json);
    if (!parsed.success) {
      this.sendError("invalid_event", "unrecognized or malformed live event");
      return;
    }
    this.dispatch(parsed.data);
  }

  /**
   * Handle one inbound BINARY frame — the audio path. Before `session.start` it
   * is an error (and dropped); after, it goes to the audio seam, and in echo
   * mode its byte length is reported back for transit tests.
   */
  handleBinaryMessage(frame: Buffer): void {
    if (!this.started) {
      this.sendError("audio_before_start", "audio frame before session.start");
      return;
    }
    this.onAudioFrame(this, frame);
    // Hot relay into the STT engine (synchronous, throwing-free by contract).
    this.stt?.onAudioFrame(frame);
    // Bill exactly what we relay (adr-0007 §3: frame count is authoritative).
    // Synchronous accumulation; flush + quota recheck live in the usage meter.
    if (this.stt !== null) {
      this.sttUsage?.onRelayedBytes(frame.byteLength);
    }
    if (this.echo) {
      this.send({
        v: LIVE_PROTOCOL_VERSION,
        type: "audio.echo",
        bytes: frame.byteLength,
      });
    }
  }

  /** Idempotent teardown — the single entry point the transport calls on end. */
  close(): void {
    this.disposer.dispose();
  }

  private dispatch(event: ClientLiveEvent): void {
    switch (event.type) {
      case "session.start":
        // `onSessionStart` is async (it awaits the ownership guard when a persister
        // is wired). It catches its own DB errors and never rejects; `void` is safe.
        void this.onSessionStart(event.meeting_id, event.echo ?? false);
        return;
      case "session.end":
        this.close();
        return;
      case "ping":
        this.send({ v: LIVE_PROTOCOL_VERSION, type: "pong" });
        return;
      case "audio.frame":
        // The JSON marker is documentation-only; real audio is binary.
        this.sendError("invalid_event", "audio must be sent as binary frames");
        return;
      case "transcript.input":
        this.onTranscriptInput(event.text, event.origin);
        return;
    }
  }

  /**
   * Typed-input channel (Phase 7, decision 2026-07-22): the user typed what the
   * other party said (or a question to the copilot). Treated EXACTLY like a
   * final transcript utterance from "them": routed through the same sink the STT
   * engine feeds ({@link onServerEvent}), so it is echoed down as a
   * `transcript.final`, enters the conductor's rolling transcript + trigger
   * gate, and is persisted — one path, no divergence. Valid only once the
   * session is fully LIVE (`session.ready` emitted — the start gates passed);
   * before that it is refused with a typed error. No new vendor call site: any
   * resulting suggestion rides the conductor's already-metered router path.
   */
  private onTranscriptInput(
    text: string,
    origin: TranscriptInputOrigin = "utterance",
  ): void {
    if (this.sessionId === null || this.disposer.disposed) {
      this.sendError(
        "input_before_start",
        "typed input requires an active session (send session.start first)",
      );
      return;
    }
    const tsMs =
      this.startedAtMs !== null ? Date.now() - this.startedAtMs : Date.now();

    if (origin === "copilot_question") {
      // NOT part of the conversation — the user asked their assistant something.
      // Echoed back as their OWN turn so the UI can show it, routed to the
      // conductor's direct channel so it is always answered, and deliberately
      // NOT run through `onServerEvent`: that is the path that persists, and a
      // question to the copilot must never become a `transcripts` row (from
      // there it would reach post-call notes and RAG memory as something the
      // other party said — see docs/DESIGN/live-notes.md §13 F2).
      this.send({
        v: LIVE_PROTOCOL_VERSION,
        type: "transcript.final",
        text,
        speaker: "me",
        ts_ms: tsMs,
        is_final: true,
      });
      this.conductor?.onDirectQuestion(text);
      return;
    }

    this.onServerEvent({
      v: LIVE_PROTOCOL_VERSION,
      type: "transcript.final",
      text,
      speaker: "them",
      ts_ms: tsMs,
      is_final: true,
    });
  }

  private async onSessionStart(
    meetingId: string,
    echo: boolean,
  ): Promise<void> {
    if (this.started) {
      // One live session per socket; a second start is a client protocol bug.
      this.sendError("already_started", "session already started");
      return;
    }
    this.started = true;
    this.echo = this.allowEcho && echo;
    this.meetingId = meetingId;

    // Concurrency cap (Phase 6, adr-0007 §6) — the CHEAPEST check, first:
    // synchronous, no DB, so two simultaneous starts resolve deterministically
    // before any ownership/quota/vendor work. The release is registered on the
    // disposer IMMEDIATELY (before any await) so a socket that drops during the
    // later guards still frees the slot exactly once.
    if (this.registry !== null && this.userId !== null) {
      const registry = this.registry;
      const userId = this.userId;
      if (!registry.acquire(userId)) {
        this.sendError(
          "concurrent_session",
          "another live session is already active for this user",
        );
        this.close();
        return;
      }
      this.disposer.add(() => {
        registry.release(userId);
      });
    }

    // Global daily-cap kill-switch (Phase 6, adr-0007 §5) — cheap/global before
    // the per-user DB work below; refuses NEW sessions while in-flight ones
    // finish (there is deliberately no mid-stream cap cut). Fail OPEN on a
    // failing check (the kill-switch already logs loudly; this guards a
    // misbehaving seam).
    if (this.metering !== null) {
      let capTripped = false;
      try {
        capTripped = await this.metering.isOverDailyCap();
      } catch (err: unknown) {
        this.logger?.error(
          { user_id: this.userId, meeting_id: meetingId, err },
          "live.daily_cap_check_failed",
        );
      }
      if (this.disposer.disposed) return;
      if (capTripped) {
        this.sendError(
          "daily_cap_reached",
          "the service's daily spend cap is reached; try again tomorrow",
        );
        this.close();
        return;
      }
    }

    // Ownership guard (Phase 4 review C1). The persist path is service-role (RLS +
    // the DB parentage `with_check` are BYPASSED), so before this socket may start
    // STT or write a single transcript, confirm the client-supplied meeting_id names
    // a LIVE meeting owned by the caller — otherwise B could stream a call onto A's
    // meeting_id and wedge A's purge. Awaited BEFORE any engine start / persistence.
    //
    // DEV-MODE BOUNDARY: the guard is only enforced when a persister (DB) is wired.
    // A keyless/DB-less dev session already streams to the phone WITHOUT persistence
    // (routes.ts wires no persister then), so there is nothing to protect and no DB
    // to ask; that path stays guard-free, exactly as it streams without persistence.
    if (this.persister !== null && this.userId !== null) {
      let owned: boolean;
      try {
        owned = await this.persister.verifyMeetingOwnership(
          meetingId,
          this.userId,
        );
      } catch (err: unknown) {
        // Fail CLOSED: a DB-unavailable start is REFUSED (typed error + policy
        // close), never silently accepted. Log ids only (never content, RULES §6).
        this.logger?.error(
          { user_id: this.userId, meeting_id: meetingId, err },
          "live.meeting_ownership_check_failed",
        );
        this.sendError("internal", "could not verify meeting ownership");
        this.close();
        return;
      }
      if (!owned) {
        this.sendError(
          "meeting_forbidden",
          "meeting not found or not owned by caller",
        );
        this.close();
        return;
      }
      // The socket may have dropped while the guard was in flight — the disposer
      // ran, so do not resurrect a dead session (no ready, no engine, no writes).
      if (this.disposer.disposed) return;
    }

    // Quota gate (Phase 6, adr-0007 §4): AFTER the ownership guard, BEFORE any
    // STT vendor connects — a refused session spends nothing. Enforced only when
    // the metering seam + owner are wired (the persister-optional posture); a
    // failing check FAILS OPEN inside the helper (quota protects spend, not
    // tenancy — see stt-usage.ts).
    if (this.metering !== null && this.userId !== null) {
      const over = await isOverSttQuotaAtStart(
        this.metering,
        this.userId,
        meetingId,
        this.logger,
      );
      if (this.disposer.disposed) return;
      if (over) {
        this.sendError(
          "quota_exceeded",
          "stt quota exhausted for the current period",
        );
        this.close();
        return;
      }
    }

    this.sessionId = this.generateSessionId();
    this.startedAtMs = Date.now();
    this.send({
      v: LIVE_PROTOCOL_VERSION,
      type: "session.ready",
      session_id: this.sessionId,
    });

    // Persistence teardown: on ANY disposal path (client end, socket close, error)
    // flush pending final-transcript writes then stamp `ended_at`. Registered
    // BEFORE the STT stop below so LIFO runs stop() first (no new finals arrive),
    // then this flush + mark. Only when a persister + owner are wired.
    if (this.persister !== null && this.userId !== null) {
      this.disposer.add(() => {
        void this.finalizePersistence();
      });
    }

    // Usage accounting (Phase 6): one meter per started session, only when the
    // seam + owner are wired. Its disposal flush is registered before the STT
    // stop below so LIFO runs stop() first (no more frames), then the final
    // flush of the unbilled tail.
    if (this.metering !== null && this.userId !== null) {
      const sttUsage = new SttUsageMeter({
        metering: this.metering,
        userId: this.userId,
        meetingId,
        initialVendor: this.initialSttVendor,
        quotaRecheckSeconds: this.quotaRecheckSeconds,
        logger: this.logger,
        isDisposed: () => this.disposer.disposed,
        onQuotaExceeded: () => {
          this.sendError(
            "quota_exceeded",
            "stt quota exhausted for the current period",
          );
          this.close();
        },
      });
      this.sttUsage = sttUsage;
      this.disposer.add(() => {
        sttUsage.flush();
      });
    }

    // Live copilot conductor (Phase 7). Built AFTER the gates, BEFORE STT starts
    // so it is ready when the first transcript flows. It streams suggestions down
    // THIS socket and its teardown (abort any in-flight generation) rides the
    // disperser BEFORE the STT stop is registered — LIFO stops STT first (no new
    // finals), then the conductor aborts. Only when a factory + owner are wired
    // and not in echo mode (echo is the pre-vendor transit diagnostic).
    if (this.createConductor !== null && this.userId !== null && !this.echo) {
      const conductor = this.createConductor({
        send: this.send,
        userId: this.userId,
        meetingId,
      });
      this.conductor = conductor;
      this.registerConsumer(conductor);
    }

    // Running-notes conductor (Phase 8). Consumer #2 on the SAME stream, sharing
    // nothing with the copilot above: its own cadence, gate, model call and state.
    // Same gating — a factory, a known owner, and not echo mode.
    if (
      this.createNotesConductor !== null &&
      this.userId !== null &&
      !this.echo
    ) {
      this.registerConsumer(
        this.createNotesConductor({
          send: this.send,
          userId: this.userId,
          meetingId,
        }),
      );
    }

    // Start the STT relay for this call. Echo mode is the pre-vendor transit
    // diagnostic, so it deliberately bypasses the engine; otherwise a per-call
    // engine session streams transcript/provider_switched/error events straight
    // to the socket, and its teardown rides the exactly-once disposer (a dropped
    // phone must abort the vendor socket — the money-leak rule, design doc).
    if (this.sttEngine !== null && !this.echo) {
      const stt = this.sttEngine.startSession(
        { sessionId: this.sessionId, sampleRateHz: STT_SAMPLE_RATE_HZ },
        this.onServerEvent,
      );
      this.stt = stt;
      this.disposer.add(() => {
        stt.stop();
      });
    }
  }

  /**
   * The engine's emit sink: forward every event to the socket UNCHANGED (the relay
   * stays synchronous), then — for FINAL transcripts only — kick off a durable
   * write. Partials are never persisted (RULES). The write is fire-and-forget so a
   * slow/failed DB never delays or drops a socket send.
   */
  private readonly onServerEvent = (event: ServerLiveEvent): void => {
    this.send(event);
    // Feed every consumer the SAME transcript stream (off the relay's hot path —
    // their own work is async/aborted, never blocking send).
    if (event.type === "transcript.partial") {
      this.fanOut((c) => c.onPartial?.(event.text, event.speaker));
    }
    if (event.type === "transcript.final") {
      this.fanOut((c) => c.onFinal?.(event.text, event.speaker));
      this.persistFinal(event.text, event.speaker, event.ts_ms);
    }
    if (event.type === "provider_switched") {
      // Attribution split (adr-0007 §3): the usage meter bills the stretch so
      // far to the OLD vendor and everything after to the new one.
      this.sttUsage?.onVendorSwitch(event.to);
    }
  };

  /**
   * Register a transcript consumer and hang its teardown on the exactly-once
   * disposer. Consumers are built AFTER the gates and BEFORE STT starts, so LIFO
   * teardown stops STT first (no new finals), then disposes them in reverse.
   */
  private registerConsumer(consumer: LiveTranscriptConsumer): void {
    this.consumers.push(consumer);
    this.disposer.add(() => {
      consumer.dispose();
    });
  }

  /**
   * Deliver one transcript event to every consumer, ISOLATED. A synchronous throw
   * from one must not skip the others or escape into the relay — with a single
   * hardcoded consumer that was academic, but a notes-conductor bug taking the
   * copilot down mid-call (or vice versa) is not.
   */
  private fanOut(deliver: (consumer: LiveTranscriptConsumer) => void): void {
    for (const consumer of this.consumers) {
      try {
        deliver(consumer);
      } catch (err: unknown) {
        this.logger?.error(
          { user_id: this.userId, meeting_id: this.meetingId, err },
          "live.consumer_threw",
        );
      }
    }
  }

  /** Fire-and-forget persist of one final utterance; errors logged, never thrown. */
  private persistFinal(
    content: string,
    speaker: string | null,
    tsMs: number | null,
  ): void {
    const persister = this.persister;
    const meetingId = this.meetingId;
    const userId = this.userId;
    if (persister === null || meetingId === null || userId === null) return;

    const write = persister
      .saveFinal({ meetingId, userId, content, speaker, tsMs })
      .catch((err: unknown) => {
        // A DB hiccup must never surface to the relay — log with ids only (never
        // transcript content, RULES §6) and move on.
        this.logger?.error(
          { user_id: userId, meeting_id: meetingId, err },
          "live.transcript_persist_failed",
        );
      });
    this.pendingWrites.add(write);
    void write.finally(() => {
      this.pendingWrites.delete(write);
    });
  }

  /**
   * Teardown persistence: await every in-flight final write, THEN mark the call
   * ended. Runs at most once (guarded by the exactly-once disposer). Best-effort —
   * a failed `markEnded` is logged; the sweeper only indexes meetings whose
   * `ended_at` is set, so a lost stamp simply means this call is not yet indexed.
   */
  private async finalizePersistence(): Promise<void> {
    const persister = this.persister;
    const meetingId = this.meetingId;
    const userId = this.userId;
    if (persister === null || meetingId === null || userId === null) return;

    // Flush before markEnded: a meeting must never be stamped ended (and swept
    // for indexing) while its own transcript rows are still in flight.
    await Promise.allSettled([...this.pendingWrites]);
    try {
      await persister.markEnded(meetingId, userId);
    } catch (err: unknown) {
      this.logger?.error(
        { user_id: userId, meeting_id: meetingId, err },
        "live.mark_ended_failed",
      );
    }
  }

  private sendError(code: LiveErrorCode, message: string): void {
    this.send({ v: LIVE_PROTOCOL_VERSION, type: "error", code, message });
  }
}
