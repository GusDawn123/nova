import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { defaultSttConfig, sttConfigSchema } from "./config.js";
import { createSttEngine } from "./engine.js";
import type { SttSessionInfo } from "./ports.js";
import { MockVendor } from "./testing/mock-vendor.js";

/**
 * [no-disk] RUNTIME audit (Phase 3.5, complements the static grep): actually run
 * a full STT engine session — connect, relay frames, receive partial+final,
 * reconnect, exhaust — and prove it left ZERO footprint on disk. Two probes:
 *   1. the repo working tree is byte-for-byte unchanged (`git status --porcelain`
 *      snapshot before == after), so nothing was written into the project;
 *   2. no new `.wav`/`.pcm`/`.raw`/`.pcm16` file appeared in the tmpdir root.
 * Uses the in-memory mock vendor (no network); deterministic and cheap.
 */

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

/** Snapshot of the working tree's dirty set (tracked + untracked). */
function gitPorcelain(): string {
  return execFileSync("git", ["status", "--porcelain"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
}

/** Audio-ish files in the tmpdir root (non-recursive; cheap and deterministic). */
function tmpAudioFiles(): Set<string> {
  const audio = /\.(wav|pcm|raw|pcm16)$/i;
  return new Set(readdirSync(tmpdir()).filter((name) => audio.test(name)));
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("modules/stt leaves no disk footprint at runtime", () => {
  it("[no-disk] a full mock-vendor session writes nothing to the repo or tmpdir", async () => {
    const treeBefore = gitPorcelain();
    const tmpBefore = tmpAudioFiles();

    // A vendor that connects, emits a partial + final, then closes — driving the
    // engine's connect → consume → reconnect → exhaust path in one short run.
    const vendor = new MockVendor({
      id: "audit-mock",
      connections: [
        {
          events: [
            { afterMs: 0, event: { type: "partial", text: "hello", speaker: null, ts_ms: 0 } },
            { afterMs: 0, event: { type: "final", text: "hello there", speaker: "A", ts_ms: 0 } },
          ],
          terminal: "close",
        },
      ],
    });

    // Fast, deterministic teardown: no backoff, no reconnects → exhausts at once.
    const config = sttConfigSchema.parse({
      ...defaultSttConfig,
      reconnectBackoffMs: [0],
      maxReconnects: 0,
      failoverThreshold: 1,
      connectTimeoutMs: 1000,
    });
    const info: SttSessionInfo = { sessionId: "audit", sampleRateHz: 16000 };
    const engine = createSttEngine(config, [vendor]);
    const emitted: string[] = [];
    const handle = engine.startSession(info, (event) => {
      emitted.push(event.type);
    });

    // Relay several PCM frames (some before connect resolves → buffered path).
    for (let i = 0; i < 8; i++) {
      handle.onAudioFrame(Buffer.alloc(1920, i));
    }
    await delay(50);
    for (let i = 0; i < 8; i++) {
      handle.onAudioFrame(Buffer.alloc(1920, i));
    }
    await delay(100);
    handle.stop();

    // The session actually ran (frames relayed, transcripts emitted) …
    expect(vendor.connections[0]?.framesReceived.length).toBeGreaterThan(0);
    expect(emitted).toContain("transcript.final");

    // … and touched no disk.
    expect(gitPorcelain()).toBe(treeBefore);
    const newAudio = [...tmpAudioFiles()].filter((name) => !tmpBefore.has(name));
    expect(newAudio).toEqual([]);
  });
});
