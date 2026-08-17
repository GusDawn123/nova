import { randomUUID } from "node:crypto";

import { LIVE_PROTOCOL_VERSION, type ServerLiveEvent } from "@nova/shared";

import { type LlmRouter, type Meter } from "../llm/index.js";
import {
  assemble,
  type PromptMode,
  type PromptTranscriptTurn,
} from "../prompt/index.js";
import type { RagService } from "../rag/index.js";

import { conductorConfig, type ConductorConfig } from "./conductor-config.js";
import type { LiveLogger } from "./ports.js";
import { isConfidentPartial, reconcile } from "./speculation.js";
import { evaluateTrigger, type TriggerDecision } from "./trigger.js";

/**
 * The live copilot conductor (Phase 7, design: live-pipeline.md §modules/live).
 * It watches the rolling transcript, gates spend through the pure tiered trigger,
 * speculates on confident partials, and streams suggestions over the socket —
 * first tokens immediately, coalesced ~50ms/batch, with an active-abort deadline
 * ladder and adopt-or-discard reconcile so the focal pane never shows a zombie.
 *
 * ONE focal-pane suggestion at a time: starting a new generation supersedes the
 * in-flight one (discard, then start). Transport-agnostic: it takes a `send`
 * callback (the same one the STT relay uses) so it is unit-testable without a WS.
 */

/** The conductor's public surface — fed transcript events by the LiveSession. */
export interface LiveConductor {
  onPartial(text: string, speaker: string | null): void;
  onFinal(text: string, speaker: string | null): void;
  /**
   * A question typed straight AT the copilot (`transcript.input` with
   * `origin: "copilot_question"`). Bypasses the trigger gate — the gate exists to
   * decide whether an overheard utterance is worth spending on, and a question
   * the user deliberately typed to their assistant already answered that. Matches
   * the 2026-07-23 prompt-freedom decision ("the AI always answers"). The turn is
   * recorded as the USER's own, never as the other party's.
   */
  onDirectQuestion(text: string): void;
  /**
   * The user pressed Answer with nothing typed (`suggest.now`, 2026-08-17
   * no-auto-response decision): respond to whatever was just said. Bypasses the
   * trigger gate for the same reason `onDirectQuestion` does — the user pressing
   * the key IS the decision to spend. Adds no turn: the moment already sits at
   * the transcript tail, which becomes the trigger text.
   */
  answerNow(): void;
  /** Abort any in-flight generation (teardown). No discard — the socket closes. */
  dispose(): void;
}

/** Per-session args the transport supplies to build a conductor at `session.start`. */
export interface ConductorFactoryArgs {
  readonly send: (event: ServerLiveEvent) => void;
  readonly userId: string;
  readonly meetingId: string;
  /**
   * The copilot mode this call picked, off `session.start`. REQUIRED here (not
   * optional-with-a-default) so a transport that forgets to thread it fails to
   * compile: the alternative is every call quietly running general, which looks
   * like the copilot being vague rather than like a wiring bug.
   */
  readonly mode: PromptMode;
}

/**
 * Builds a {@link LiveConductor} once a session is authenticated and its
 * owner/meeting are known. Wired by the transport (metering-wiring.ts) closing
 * over the live router, RAG service, and the per-call meter factory; the session
 * supplies `send` + identity. Omitted on keyless boots (no LLM → no suggestions,
 * transcription still runs).
 */
export type LiveConductorFactory = (
  args: ConductorFactoryArgs,
) => LiveConductor;

export interface LiveConductorDeps {
  /** Emit a typed event down the socket (the session's own `send`). */
  send: (event: ServerLiveEvent) => void;
  /** A LIVE-tuned llm router (cheapest-first cascade, tight budgets). */
  router: LlmRouter;
  /** Per-user RAG memory for grounding. Omitted → suggestions are ungrounded. */
  rag?: RagService;
  /** The authenticated owner — RAG scoping + metering attribution. */
  userId?: string;
  /** The meeting this session belongs to (metering attribution). */
  meetingId?: string;
  /** Per-call meter (metering.meterFor(userId, meetingId)); threaded into every call. */
  meter?: Meter;
  /** User-provided context (profile / scripts); hard-guarded in the suffix. */
  userContext?: string;
  /**
   * The mode this session picked; fixed for the conductor's whole life, which is
   * what keeps its assembled prefix byte-stable (and the vendor cache warm).
   * Omitted → `general`, matching the wire rule for a `session.start` with no
   * mode. Held per conductor — never module state — so one call's pick can never
   * be read by another's.
   */
  mode?: PromptMode;
  logger?: LiveLogger;
  config?: ConductorConfig;
  /** Injected clock (fake-timer tests); defaults to Date.now. */
  now?: () => number;
  /** Suggestion-id factory; overridable for deterministic tests. */
  generateSuggestionId?: () => string;
  /**
   * Whether the conductor may fire suggestions ON ITS OWN off the transcript
   * (the Phase-7 trigger gate + speculation). REQUIRED, not defaulted, so every
   * construction site states its policy — the product wiring passes `false`
   * (Gustavo, 2026-08-17: no auto-responses; the copilot speaks only when asked
   * via `onDirectQuestion` / `answerNow`). The gate machinery stays intact
   * behind this flag: turning insight-style auto-fire back on later is a
   * one-line policy change, not an engine rebuild.
   */
  autoSuggest: boolean;
}

/**
 * One in-flight (or just-finished) generation for the single focal pane.
 * "Superseded" is derived from identity — a generation is current iff it is still
 * `active`; discard/supersede/dispose all point `active` elsewhere, which the
 * async stream loop reads to stay silent (async mutation CFA can't otherwise see).
 */
interface ActiveGeneration {
  readonly id: string;
  readonly controller: AbortController;
  readonly triggerText: string;
  speculative: boolean;
  firstToken: boolean;
}

export function createLiveConductor(deps: LiveConductorDeps): LiveConductor {
  const config = deps.config ?? conductorConfig;
  const now = deps.now ?? Date.now;
  const newId = deps.generateSuggestionId ?? randomUUID;
  const logger = deps.logger;
  const mode = deps.mode ?? "general";

  const transcript: PromptTranscriptTurn[] = [];
  let active: ActiveGeneration | null = null;
  /**
   * The outstanding speculation awaiting its final utterance — tracked SEPARATELY
   * from `active` because a speculative answer usually FINISHES streaming before
   * the final arrives (that is the sub-500ms win). Reconcile then adopts the
   * finished answer or discards it; cleared on reconcile or on a failed spec.
   */
  let speculation: { id: string; triggerText: string } | null = null;
  let disposed = false;

  function send(event: ServerLiveEvent): void {
    deps.send(event);
  }

  function pushTurn(text: string, speaker: string | null): void {
    transcript.push({ speaker, text });
    if (transcript.length > config.transcriptWindowTurns) {
      transcript.splice(0, transcript.length - config.transcriptWindowTurns);
    }
  }

  function isUserSpeaker(speaker: string | null): boolean {
    return speaker !== null && speaker.toLowerCase() === "me";
  }

  /** Whether `gen` is still the current focal generation (not superseded). */
  function isCurrent(gen: ActiveGeneration): boolean {
    return active === gen;
  }

  /** Discard the active suggestion (abort + one wire discard). Clears the pane. */
  function discardActive(reason: string): void {
    if (active === null) return;
    const gen = active;
    active = null; // point elsewhere FIRST so the stream loop reads superseded
    gen.controller.abort();
    send({
      v: LIVE_PROTOCOL_VERSION,
      type: "suggestion.discard",
      suggestion_id: gen.id,
      reason,
    });
  }

  function startGeneration(
    decision: Extract<TriggerDecision, { fire: true }>,
    triggerText: string,
    speculative: boolean,
  ): void {
    // Supersede any lingering suggestion — one focal pane, never a zombie.
    discardActive("superseded");
    const gen: ActiveGeneration = {
      id: newId(),
      controller: new AbortController(),
      triggerText,
      speculative,
      firstToken: false,
    };
    active = gen;
    if (speculative) speculation = { id: gen.id, triggerText };
    send({
      v: LIVE_PROTOCOL_VERSION,
      type: "suggestion.start",
      suggestion_id: gen.id,
      kind: decision.kind,
    });
    void generate(gen).catch((err: unknown) => {
      logger?.error(
        {
          user_id: deps.userId ?? null,
          meeting_id: deps.meetingId ?? null,
          err,
        },
        "live.conductor.generate_failed",
      );
    });
  }

  /** Race RAG grounding against its deadline — shrink the prompt, never delay it. */
  async function groundingSnippets(
    queryText: string,
  ): Promise<{ header: string; content: string }[]> {
    if (deps.rag === undefined || deps.userId === undefined) return [];
    const userId = deps.userId;
    const rag = deps.rag;
    const timeout = new Promise<null>((resolve) => {
      setTimeout(() => {
        resolve(null);
      }, config.ragDeadlineMs);
    });
    try {
      const result = await Promise.race([
        rag.query(userId, queryText, {
          tier: "live",
          k: config.ragK,
          tokenBudget: config.ragTokenBudget,
        }),
        timeout,
      ]);
      if (result === null) return []; // deadline won → proceed ungrounded
      return result.snippets.map((s) => ({
        header: s.header,
        content: s.content,
      }));
    } catch (err: unknown) {
      // Grounding is best-effort: a keyless/failed RAG never blocks a suggestion.
      logger?.error(
        { user_id: userId, meeting_id: deps.meetingId ?? null, err },
        "live.conductor.rag_failed",
      );
      return [];
    }
  }

  async function generate(gen: ActiveGeneration): Promise<void> {
    const snippets = await groundingSnippets(gen.triggerText);
    if (!isCurrent(gen)) return;

    const { stablePrefix, dynamicSuffix } = assemble(mode, {
      transcript,
      ...(snippets.length > 0 ? { ragSnippets: snippets } : {}),
      ...(deps.userContext !== undefined
        ? { userContext: deps.userContext }
        : {}),
    });

    // Deadline ladder: abort if the router yields no first token in time.
    const deadline = setTimeout(() => {
      if (!gen.firstToken) gen.controller.abort();
    }, config.firstTokenDeadlineMs);

    let full = "";
    let batch = "";
    let lastFlush = now();
    const flush = (): void => {
      if (batch === "" || !isCurrent(gen)) return;
      send({
        v: LIVE_PROTOCOL_VERSION,
        type: "suggestion.delta",
        suggestion_id: gen.id,
        text: batch,
      });
      batch = "";
      lastFlush = now();
    };

    try {
      const stream = deps.router.stream(
        {
          messages: [
            { role: "system", content: stablePrefix },
            { role: "user", content: dynamicSuffix },
          ],
          latencyTier: "live",
        },
        {
          signal: gen.controller.signal,
          ...(deps.meter !== undefined ? { meter: deps.meter } : {}),
        },
      );
      for await (const event of stream) {
        if (!isCurrent(gen)) break;
        if (event.type === "token" && event.text !== "") {
          if (!gen.firstToken) {
            gen.firstToken = true;
            clearTimeout(deadline);
          }
          full += event.text;
          batch += event.text;
          if (now() - lastFlush >= config.coalesceMs) flush();
        }
      }
      clearTimeout(deadline);
      if (!isCurrent(gen)) return;
      flush();
      send({
        v: LIVE_PROTOCOL_VERSION,
        type: "suggestion.done",
        suggestion_id: gen.id,
        text: full,
      });
      active = null;
    } catch (err: unknown) {
      clearTimeout(deadline);
      if (!isCurrent(gen)) return; // an intentional discard already cleared the pane
      if (full === "") {
        // Never produced a token → clear the pane rather than leave an empty start.
        send({
          v: LIVE_PROTOCOL_VERSION,
          type: "suggestion.discard",
          suggestion_id: gen.id,
          reason: "no_response",
        });
        // A failed speculation has nothing to reconcile against later.
        if (speculation?.id === gen.id) speculation = null;
      } else {
        // Committed then died → keep what streamed (adr-0004 §2: no zombie, no mix).
        flush();
        send({
          v: LIVE_PROTOCOL_VERSION,
          type: "suggestion.done",
          suggestion_id: gen.id,
          text: full,
        });
      }
      active = null;
      logger?.error(
        {
          user_id: deps.userId ?? null,
          meeting_id: deps.meetingId ?? null,
          err,
        },
        "live.conductor.stream_error",
      );
    }
  }

  return {
    onPartial(text, speaker) {
      // Speculation is an auto-fire mechanism; with autoSuggest off it would
      // spend on utterances nobody asked about.
      if (!deps.autoSuggest) return;
      if (disposed || !config.speculationEnabled) return;
      // One pane, one outstanding speculation: don't stack on a live suggestion
      // or a speculation still awaiting its final.
      if (active !== null || speculation !== null) return;
      if (!isConfidentPartial(text, config.speculationMinWords)) return;
      const decision = evaluateTrigger(text, isUserSpeaker(speaker));
      if (!decision.fire) return;
      startGeneration(decision, text.trim(), true);
    },

    onFinal(text, speaker) {
      if (disposed) return;
      const finalText = text.trim();
      pushTurn(finalText, speaker);

      // With autoSuggest off, a final only feeds the rolling transcript window
      // (answerNow / onDirectQuestion read it). No speculation can be
      // outstanding — onPartial never ran — so skipping the reconcile is safe.
      if (!deps.autoSuggest) return;

      // Reconcile an outstanding speculation against its final utterance — even
      // if the speculative answer already finished streaming (the common case).
      if (speculation !== null) {
        const spec = speculation;
        speculation = null;
        const decision = reconcile(
          spec.triggerText,
          finalText,
          config.speculationThreshold,
        );
        if (decision === "adopt") {
          // The bet paid off — keep the finished/in-flight answer; do not refire.
          if (active !== null && active.id === spec.id)
            active.speculative = false;
          return;
        }
        // Diverged: clear the (possibly finished) speculative card, then refire.
        if (active !== null && active.id === spec.id) {
          discardActive("speculation_reconcile_miss");
        } else {
          send({
            v: LIVE_PROTOCOL_VERSION,
            type: "suggestion.discard",
            suggestion_id: spec.id,
            reason: "speculation_reconcile_miss",
          });
        }
      }

      // A fresh final utterance supersedes any stale in-flight suggestion — the
      // newest question owns the focal pane (startGeneration discards the old one).
      const trigger = evaluateTrigger(finalText, isUserSpeaker(speaker));
      if (trigger.fire) startGeneration(trigger, finalText, false);
    },

    onDirectQuestion(text) {
      if (disposed) return;
      const asked = text.trim();
      if (asked === "") return;
      // The user's OWN turn — never "them" (that mislabel is the whole bug this
      // channel exists to fix), and it stays in the ephemeral prompt window only.
      pushTurn(asked, "me");
      // A direct question supersedes the pane outright, so drop any outstanding
      // speculation first: its generation is about to be discarded, and leaving
      // it set would make the next final reconcile against a dead id.
      speculation = null;
      startGeneration(
        { fire: true, kind: "answer", reason: "direct_question" },
        asked,
        false,
      );
    },

    answerNow() {
      if (disposed) return;
      // No new turn: the moment is already the transcript tail. An empty
      // transcript still fires — Brain's own rules own the thin-input case,
      // and refusing here would make the Answer key feel dead.
      const tail = transcript.at(-1)?.text ?? "";
      speculation = null;
      startGeneration(
        { fire: true, kind: "answer", reason: "answer_now" },
        tail,
        false,
      );
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      speculation = null;
      if (active !== null) {
        const gen = active;
        active = null; // supersede before aborting so the stream loop stays silent
        gen.controller.abort();
      }
    },
  };
}
