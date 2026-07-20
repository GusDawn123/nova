import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ServerLiveEvent } from "@nova/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { sttConfigSchema } from "../config.js";
import { createSttEngine } from "../engine.js";
import type { SttSessionInfo, SttVendor } from "../ports.js";
import { normalizedTokenOverlap } from "../testing/text-metrics.js";
import { createAssemblyAiVendor } from "./assemblyai.js";
import { createDeepgramVendor } from "./deepgram.js";

/**
 * KEY-GATED accuracy tests (Phase 3.5 — playbook VERIFY items). These stream a
 * real fixture through the REAL engine against the REAL vendors, so they run
 * ONLY when a vendor key is present (`describe.skipIf`) — CI has none, so they
 * skip cleanly there while the unit suites carry correctness. Every check PRINTS
 * its measured number so the run can be quoted verbatim in the report.
 *
 * SYNTHETIC-SPEECH CAVEAT (see make-stt-fixtures.sh): the fixtures are macOS TTS,
 * not human phone audio. The 80%/70% bars below are the playbook's; if a real
 * vendor underperforms a bar on THIS synthetic audio, that is a finding to
 * REPORT, not a reason to silently lower the bar.
 */

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "fixtures", "stt");
const SAMPLE_RATE_HZ = 16000;
const FRAME_MS = 60; // 60ms frame → 1920 bytes at 16kHz mono PCM16 (in the 40–80ms band)
const FRAME_BYTES = (SAMPLE_RATE_HZ * 2 * FRAME_MS) / 1000;
const PACE_MS = 20; // faster than real-time; vendors accept bursts (documented)
const FINAL_FLUSH_MS = 6000; // wait after last frame for endpointed finals
const NETWORK_TIMEOUT_MS = 240_000; // generous per-file network budget

const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY;
const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;

/** Shape of two-speaker-60s.json (parsed at the boundary). */
const fixtureSchema = z.object({
  reference_text: z.string(),
  sample_rate_hz: z.number(),
  turns: z.array(
    z.object({
      speaker: z.string(),
      start_s: z.number(),
      end_s: z.number(),
      text: z.string(),
    }),
  ),
});
type Fixture = z.infer<typeof fixtureSchema>;

function loadFixtureJson(): Fixture {
  const raw: unknown = JSON.parse(
    readFileSync(join(FIXTURE_DIR, "two-speaker-60s.json"), "utf8"),
  );
  return fixtureSchema.parse(raw);
}

/** Extract the raw PCM data chunk from a canonical little-endian WAV file. */
function readWavPcm(fileName: string): Buffer {
  const buf = readFileSync(join(FIXTURE_DIR, fileName));
  // Walk RIFF chunks to find "data" (robust to an fmt chunk of any size).
  let offset = 12; // skip "RIFF"<size>"WAVE"
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === "data") return buf.subarray(body, body + chunkSize);
    offset = body + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }
  throw new Error(`no data chunk in ${fileName}`);
}

function* pcmFrames(pcm: Buffer): Generator<Buffer> {
  for (let i = 0; i + FRAME_BYTES <= pcm.length; i += FRAME_BYTES) {
    yield pcm.subarray(i, i + FRAME_BYTES);
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface SessionResult {
  readonly events: readonly ServerLiveEvent[];
  /** True if any transcript.partial arrived before the LAST audio frame was sent. */
  readonly partialBeforeLastFrame: boolean;
}

/** Stream a fixture PCM buffer through the engine over `vendors`, collect events. */
async function streamThroughEngine(
  vendors: readonly SttVendor[],
  pcm: Buffer,
): Promise<SessionResult> {
  const config = sttConfigSchema.parse({
    connectTimeoutMs: 15_000,
    vendorSilenceTimeoutMs: 60_000,
  });
  const events: ServerLiveEvent[] = [];
  const engine = createSttEngine(config, vendors);
  const info: SttSessionInfo = {
    sessionId: "accuracy-fixture",
    sampleRateHz: SAMPLE_RATE_HZ,
  };
  const handle = engine.startSession(info, (event) => {
    events.push(event);
  });

  const frames = [...pcmFrames(pcm)];
  let partialBeforeLastFrame = false;
  for (let i = 0; i < frames.length; i++) {
    if (i === frames.length - 1) {
      partialBeforeLastFrame = events.some(
        (event) => event.type === "transcript.partial",
      );
    }
    const frame = frames[i];
    if (frame !== undefined) handle.onAudioFrame(frame);
    await delay(PACE_MS);
  }

  await delay(FINAL_FLUSH_MS);
  handle.stop();
  return { events, partialBeforeLastFrame };
}

/** Join every final utterance (arrival order) into one hypothesis string. */
function hypothesisText(events: readonly ServerLiveEvent[]): string {
  return events
    .filter((event) => event.type === "transcript.final")
    .map((event) => event.text)
    .join(" ");
}

/** Finals as (speaker, ts_ms), in ts order — the diarization signal. */
function finalsWithSpeaker(
  events: readonly ServerLiveEvent[],
): { speaker: string | null; ts_ms: number }[] {
  return events
    .flatMap((event) =>
      event.type === "transcript.final"
        ? [{ speaker: event.speaker, ts_ms: event.ts_ms }]
        : [],
    )
    .sort((a, b) => a.ts_ms - b.ts_ms);
}

/**
 * Count how many of the fixture's known speaker-change boundaries (the start of
 * every turn after the first) are matched by a hypothesis speaker-change within
 * ±2s. Returns matched count, total boundaries, and the per-boundary deltas (ms).
 */
function boundaryAlignment(
  finals: { speaker: string | null; ts_ms: number }[],
  fixture: Fixture,
): { matched: number; total: number; deltasMs: number[] } {
  const changePoints: number[] = [];
  let previous: string | null = null;
  for (const final of finals) {
    if (final.speaker !== null && final.speaker !== previous) {
      changePoints.push(final.ts_ms);
      previous = final.speaker;
    }
  }
  const boundaries = fixture.turns.slice(1).map((turn) => turn.start_s * 1000);
  const deltasMs: number[] = [];
  let matched = 0;
  for (const boundaryMs of boundaries) {
    const best = changePoints.reduce(
      (min, cp) => Math.min(min, Math.abs(cp - boundaryMs)),
      Number.POSITIVE_INFINITY,
    );
    deltasMs.push(Math.round(best));
    if (best <= 2000) matched += 1;
  }
  return { matched, total: boundaries.length, deltasMs };
}

// ---------------------------------------------------------------------------
// AssemblyAI (primary)
// ---------------------------------------------------------------------------

describe.skipIf(!ASSEMBLYAI_KEY)("assemblyai — live accuracy", () => {
  const apiKey = ASSEMBLYAI_KEY ?? "";

  it(
    "clean: interims stream, ≥80% word-overlap, ≥2 speakers, boundaries ±2s",
    async () => {
      const fixture = loadFixtureJson();
      const pcm = readWavPcm("two-speaker-60s.wav");
      const { events, partialBeforeLastFrame } = await streamThroughEngine(
        [createAssemblyAiVendor({ apiKey })],
        pcm,
      );

      const overlap = normalizedTokenOverlap(fixture.reference_text, hypothesisText(events));
      const finals = finalsWithSpeaker(events);
      const speakers = new Set(finals.map((f) => f.speaker).filter((s) => s !== null));
      const alignment = boundaryAlignment(finals, fixture);

      console.log(
        `[assemblyai clean] overlap=${(overlap * 100).toFixed(1)}% ` +
          `interim_before_end=${String(partialBeforeLastFrame)} ` +
          `distinct_speakers=${String(speakers.size)} ` +
          `boundaries_matched=${String(alignment.matched)}/${String(alignment.total)} ` +
          `deltas_ms=[${alignment.deltasMs.join(", ")}]`,
      );

      expect(partialBeforeLastFrame).toBe(true);
      expect(overlap).toBeGreaterThanOrEqual(0.8);
      expect(speakers.size).toBeGreaterThanOrEqual(2);
      expect(alignment.matched).toBeGreaterThanOrEqual(2);
    },
    NETWORK_TIMEOUT_MS,
  );

  it(
    "noisy: ≥70% word-overlap under speakerphone simulation",
    async () => {
      const fixture = loadFixtureJson();
      const pcm = readWavPcm("two-speaker-60s-noisy.wav");
      const { events } = await streamThroughEngine(
        [createAssemblyAiVendor({ apiKey })],
        pcm,
      );
      const overlap = normalizedTokenOverlap(fixture.reference_text, hypothesisText(events));
      console.log(`[assemblyai noisy] overlap=${(overlap * 100).toFixed(1)}%`);
      expect(overlap).toBeGreaterThanOrEqual(0.7);
    },
    NETWORK_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Deepgram (fallback)
// ---------------------------------------------------------------------------

describe.skipIf(!DEEPGRAM_KEY)("deepgram — live accuracy", () => {
  const apiKey = DEEPGRAM_KEY ?? "";

  it(
    "clean: interims stream, ≥80% word-overlap, ≥2 speakers, boundaries ±2s",
    async () => {
      const fixture = loadFixtureJson();
      const pcm = readWavPcm("two-speaker-60s.wav");
      const { events, partialBeforeLastFrame } = await streamThroughEngine(
        [createDeepgramVendor({ apiKey })],
        pcm,
      );

      const overlap = normalizedTokenOverlap(fixture.reference_text, hypothesisText(events));
      const finals = finalsWithSpeaker(events);
      const speakers = new Set(finals.map((f) => f.speaker).filter((s) => s !== null));
      const alignment = boundaryAlignment(finals, fixture);

      console.log(
        `[deepgram clean] overlap=${(overlap * 100).toFixed(1)}% ` +
          `interim_before_end=${String(partialBeforeLastFrame)} ` +
          `distinct_speakers=${String(speakers.size)} ` +
          `boundaries_matched=${String(alignment.matched)}/${String(alignment.total)} ` +
          `deltas_ms=[${alignment.deltasMs.join(", ")}]`,
      );

      expect(partialBeforeLastFrame).toBe(true);
      expect(overlap).toBeGreaterThanOrEqual(0.8);
      expect(speakers.size).toBeGreaterThanOrEqual(2);
      expect(alignment.matched).toBeGreaterThanOrEqual(2);
    },
    NETWORK_TIMEOUT_MS,
  );

  it(
    "noisy: ≥70% word-overlap under speakerphone simulation",
    async () => {
      const fixture = loadFixtureJson();
      const pcm = readWavPcm("two-speaker-60s-noisy.wav");
      const { events } = await streamThroughEngine(
        [createDeepgramVendor({ apiKey })],
        pcm,
      );
      const overlap = normalizedTokenOverlap(fixture.reference_text, hypothesisText(events));
      console.log(`[deepgram noisy] overlap=${(overlap * 100).toFixed(1)}%`);
      expect(overlap).toBeGreaterThanOrEqual(0.7);
    },
    NETWORK_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Failover smoke — primary dead, fallback real (needs DEEPGRAM_KEY only)
// ---------------------------------------------------------------------------

describe.skipIf(!DEEPGRAM_KEY)("failover — dead assemblyai → real deepgram", () => {
  const deepgramKey = DEEPGRAM_KEY ?? "";

  it(
    "still transcribes via deepgram and emits provider_switched",
    async () => {
      const fixture = loadFixtureJson();
      const pcm = readWavPcm("two-speaker-60s.wav");
      // Primary points at an unroutable WS endpoint → connect fails fast → failover.
      const deadPrimary = createAssemblyAiVendor({
        apiKey: ASSEMBLYAI_KEY ?? "dead-key",
        websocketBaseUrl: "wss://127.0.0.1:1/v3/ws",
      });
      const { events } = await streamThroughEngine(
        [deadPrimary, createDeepgramVendor({ apiKey: deepgramKey })],
        pcm,
      );

      const switched = events.filter((e) => e.type === "provider_switched");
      const overlap = normalizedTokenOverlap(fixture.reference_text, hypothesisText(events));
      console.log(
        `[failover] provider_switched=${String(switched.length)} ` +
          `to=${switched.map((e) => e.to).join(",")} ` +
          `overlap=${(overlap * 100).toFixed(1)}%`,
      );

      expect(switched.length).toBeGreaterThanOrEqual(1);
      expect(switched.some((e) => e.to === "deepgram")).toBe(true);
      expect(overlap).toBeGreaterThanOrEqual(0.7);
    },
    NETWORK_TIMEOUT_MS,
  );
});
