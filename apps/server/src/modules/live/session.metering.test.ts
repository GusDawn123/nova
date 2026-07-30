import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import { serverLiveEventSchema, type ServerLiveEvent } from "@nova/shared";

import type { SttEmit, SttEngine } from "../stt/ports.js";

import type { LiveMetering, LiveSttUsage } from "./ports.js";
import { LiveSession, type LiveSessionDeps } from "./session.js";

/**
 * [stt-metering] Phase 6 (adr-0007 §3/§4): the session bills RELAYED audio bytes
 * (16kHz mono PCM16 → bytes/32000 = seconds), flushing an `stt_seconds` span to
 * the metering seam on vendor switch / disposal / each quota-recheck tick of
 * METERED AUDIO (crash loses at most one tick). Quota: checked at session start
 * (over → typed `quota_exceeded` + close BEFORE any STT vendor starts — no spend
 * on a refused session) and mid-stream on the recheck cadence (over → final
 * flush + typed error + close). All enforcement is OPTIONAL — no metering deps,
 * no change (the persister-optional posture; existing suites prove it).
 */

const MEETING_ID = "11111111-1111-4111-8111-111111111111";
const FIXED_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

/** 16kHz mono PCM16: bytes per second of audio (sample rate × 2 bytes). */
const BYTES_PER_SECOND = 16000 * 2;

const FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fixtures",
  "stt",
);

/** Extract the raw PCM data chunk from a canonical little-endian WAV file. */
function readWavPcm(fileName: string): Buffer {
  const buf = readFileSync(join(FIXTURE_DIR, fileName));
  let offset = 12; // past RIFF header
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === "data") return buf.subarray(body, body + chunkSize);
    offset = body + chunkSize + (chunkSize % 2);
  }
  throw new Error(`no data chunk in ${fileName}`);
}

interface FakeEngine {
  engine: SttEngine;
  emit: (event: ServerLiveEvent) => void;
  starts: () => number;
  stops: () => number;
}

function makeFakeEngine(): FakeEngine {
  let captured: SttEmit | null = null;
  let starts = 0;
  let stops = 0;
  const engine: SttEngine = {
    startSession(_info, emit) {
      starts += 1;
      captured = emit;
      return {
        onAudioFrame() {
          /* frames are counted by the session, not the fake vendor */
        },
        stop() {
          stops += 1;
        },
      };
    },
  };
  return {
    engine,
    emit: (event) => {
      if (captured) captured(event);
    },
    starts: () => starts,
    stops: () => stops,
  };
}

/** A controllable metering seam: records spans, scripts the quota answer. */
function fakeMetering(): {
  metering: LiveMetering;
  records: LiveSttUsage[];
  setOver: (v: boolean) => void;
  failQuotaCheck: (err: Error) => void;
  quotaCalls: () => number;
} {
  const records: LiveSttUsage[] = [];
  let over = false;
  let quotaError: Error | null = null;
  let quotaCalls = 0;
  const metering: LiveMetering = {
    recordSttSeconds(usage) {
      records.push(usage);
      return Promise.resolve();
    },
    isOverSttQuota() {
      quotaCalls += 1;
      if (quotaError) return Promise.reject(quotaError);
      return Promise.resolve(over);
    },
    // The daily cap is exercised by session.cap.test.ts; here it never trips.
    isOverDailyCap: () => Promise.resolve(false),
  };
  return {
    metering,
    records,
    setOver: (v) => (over = v),
    failQuotaCheck: (err) => (quotaError = err),
    quotaCalls: () => quotaCalls,
  };
}

function makeSession(overrides: Partial<LiveSessionDeps> = {}): {
  session: LiveSession;
  sent: ServerLiveEvent[];
} {
  const sent: ServerLiveEvent[] = [];
  const session = new LiveSession({
    send: (event) => sent.push(event),
    generateSessionId: () => FIXED_SESSION_ID,
    ...overrides,
  });
  return { session, sent };
}

const startFrame = (): string =>
  JSON.stringify({ v: 1, type: "session.start", meeting_id: MEETING_ID });

/** Let queued microtasks + one macrotask settle (async start / fire-and-forget). */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const providerSwitched = (from: string, to: string): ServerLiveEvent => ({
  v: 1,
  type: "provider_switched",
  from,
  to,
});

const totalSeconds = (records: LiveSttUsage[]): number =>
  records.reduce((sum, r) => sum + r.seconds, 0);

describe("LiveSession stt metering", () => {
  it("[stt-accuracy] the fixture WAV's relayed bytes bill within ±5% of ground truth", async () => {
    const fake = makeFakeEngine();
    const m = fakeMetering();
    const { session } = makeSession({
      sttEngine: fake.engine,
      metering: m.metering,
      userId: USER_ID,
      initialSttVendor: "assemblyai",
    });
    session.handleTextMessage(startFrame());
    await flush();

    const pcm = readWavPcm("two-speaker-60s.wav");
    const groundTruthSeconds = pcm.length / BYTES_PER_SECOND;
    // Relay in 80ms frames (2560 bytes), dropping any trailing partial frame.
    const frameBytes = 2560;
    let relayed = 0;
    for (let i = 0; i + frameBytes <= pcm.length; i += frameBytes) {
      session.handleBinaryMessage(pcm.subarray(i, i + frameBytes));
      relayed += frameBytes;
    }
    session.close();
    await flush();

    const billed = totalSeconds(m.records);
    // The frame count is authoritative (adr-0007 §3): exact on relayed bytes …
    expect(billed).toBeCloseTo(relayed / BYTES_PER_SECOND, 6);
    // … and within the ±5% accuracy bar of the fixture's true duration.
    expect(
      Math.abs(billed - groundTruthSeconds) / groundTruthSeconds,
    ).toBeLessThan(0.05);
    for (const record of m.records) {
      expect(record).toMatchObject({
        userId: USER_ID,
        meetingId: MEETING_ID,
        vendor: "assemblyai",
      });
    }
  });

  it("[stt-split] a mid-call vendor switch splits attribution across vendors", async () => {
    const fake = makeFakeEngine();
    const m = fakeMetering();
    const { session } = makeSession({
      sttEngine: fake.engine,
      metering: m.metering,
      userId: USER_ID,
      initialSttVendor: "assemblyai",
    });
    session.handleTextMessage(startFrame());
    await flush();

    // 2 seconds on the first vendor …
    session.handleBinaryMessage(Buffer.alloc(2 * BYTES_PER_SECOND));
    // … then the engine fails over …
    fake.emit(providerSwitched("assemblyai", "deepgram"));
    // … and 1 more second lands on the second vendor.
    session.handleBinaryMessage(Buffer.alloc(1 * BYTES_PER_SECOND));
    session.close();
    await flush();

    expect(m.records).toHaveLength(2);
    expect(m.records[0]).toMatchObject({ vendor: "assemblyai", seconds: 2 });
    expect(m.records[1]).toMatchObject({ vendor: "deepgram", seconds: 1 });
  });

  it("[stt-flush-tick] each recheck tick of metered audio flushes (crash loses ≤ one tick)", async () => {
    const fake = makeFakeEngine();
    const m = fakeMetering();
    const { session } = makeSession({
      sttEngine: fake.engine,
      metering: m.metering,
      userId: USER_ID,
      initialSttVendor: "assemblyai",
      quotaRecheckSeconds: 1,
    });
    session.handleTextMessage(startFrame());
    await flush();

    // 2.5 seconds in quarter-second frames → ticks at 1s and 2s flush WITHOUT
    // any disposal; only the 0.5s tail is still unflushed (the ≤-one-tick bound).
    const quarter = BYTES_PER_SECOND / 4;
    for (let i = 0; i < 10; i++) {
      session.handleBinaryMessage(Buffer.alloc(quarter));
    }
    await flush();

    expect(m.records).toHaveLength(2);
    expect(totalSeconds(m.records)).toBeCloseTo(2, 6);

    // Disposal flushes the tail: the full 2.5s is billed in total.
    session.close();
    await flush();
    expect(totalSeconds(m.records)).toBeCloseTo(2.5, 6);
  });

  it("[stt-no-metering] without the seam nothing is recorded and behavior is unchanged", async () => {
    const fake = makeFakeEngine();
    const { session, sent } = makeSession({
      sttEngine: fake.engine,
      userId: USER_ID,
    });
    session.handleTextMessage(startFrame());
    await flush();
    session.handleBinaryMessage(Buffer.alloc(BYTES_PER_SECOND));
    session.close();
    expect(sent[0]).toMatchObject({ type: "session.ready" });
  });
});

describe("LiveSession stt quota", () => {
  it("[quota-start] an over-quota start is refused BEFORE any vendor starts", async () => {
    const fake = makeFakeEngine();
    const m = fakeMetering();
    m.setOver(true);
    const { session, sent } = makeSession({
      sttEngine: fake.engine,
      metering: m.metering,
      userId: USER_ID,
    });

    session.handleTextMessage(startFrame());
    await flush();

    // Typed paywall state on the wire (zod-valid), then policy close.
    const error = sent.find((e) => e.type === "error");
    expect(error).toMatchObject({ code: "quota_exceeded" });
    expect(() => serverLiveEventSchema.parse(error)).not.toThrow();
    expect(sent.some((e) => e.type === "session.ready")).toBe(false);
    // NO vendor spend on a refused session: the engine never started.
    expect(fake.starts()).toBe(0);
    expect(session.disposer.disposed).toBe(true);
  });

  it("[quota-midstream] the recheck tick flips over → final flush + typed error + close", async () => {
    const fake = makeFakeEngine();
    const m = fakeMetering();
    const { session, sent } = makeSession({
      sttEngine: fake.engine,
      metering: m.metering,
      userId: USER_ID,
      initialSttVendor: "assemblyai",
      quotaRecheckSeconds: 1,
    });
    session.handleTextMessage(startFrame());
    await flush();
    expect(sent[0]).toMatchObject({ type: "session.ready" });

    // Quota exhausts mid-call; the next full tick of metered audio detects it.
    m.setOver(true);
    session.handleBinaryMessage(Buffer.alloc(BYTES_PER_SECOND));
    await flush();

    const error = sent.find((e) => e.type === "error");
    expect(error).toMatchObject({ code: "quota_exceeded" });
    expect(() => serverLiveEventSchema.parse(error)).not.toThrow();
    expect(session.disposer.disposed).toBe(true);
    expect(fake.stops()).toBe(1);
    // The metered audio up to the cut was flushed (nothing is lost or unbilled).
    expect(totalSeconds(m.records)).toBeCloseTo(1, 6);
  });

  it("[quota-recheck-cadence] rechecks fire per tick of METERED AUDIO, not wall clock", async () => {
    const fake = makeFakeEngine();
    const m = fakeMetering();
    const { session } = makeSession({
      sttEngine: fake.engine,
      metering: m.metering,
      userId: USER_ID,
      quotaRecheckSeconds: 1,
    });
    session.handleTextMessage(startFrame());
    await flush();
    const afterStart = m.quotaCalls(); // the session-start check

    // Less than one tick of audio → no recheck, however long we "wait".
    session.handleBinaryMessage(Buffer.alloc(BYTES_PER_SECOND / 2));
    await flush();
    expect(m.quotaCalls()).toBe(afterStart);

    // Completing the tick's worth of audio triggers exactly one recheck.
    session.handleBinaryMessage(Buffer.alloc(BYTES_PER_SECOND / 2));
    await flush();
    expect(m.quotaCalls()).toBe(afterStart + 1);
  });

  it("[quota-fail-open] a failing start check logs and lets the session proceed", async () => {
    const fake = makeFakeEngine();
    const m = fakeMetering();
    m.failQuotaCheck(new Error("quota backend down"));
    const errorLog = vi.fn();
    const { session, sent } = makeSession({
      sttEngine: fake.engine,
      metering: m.metering,
      userId: USER_ID,
      logger: { error: errorLog },
    });

    session.handleTextMessage(startFrame());
    await flush();

    expect(sent[0]).toMatchObject({ type: "session.ready" });
    expect(fake.starts()).toBe(1);
    expect(errorLog).toHaveBeenCalled();
    session.close();
  });
});
