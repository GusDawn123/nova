import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * The seam to the native capture addon (pivot chunk 2). The ONLY file that
 * touches `nova_audio.node`; everything else sees the AudioEngine interface.
 *
 * Loaded lazily and cached: the addon spins up WASAPI machinery, and a user
 * who never starts a session should never pay for it. A load failure is a
 * typed result rather than a throw — the app must boot (and sign in, and show
 * settings) even when the native build is missing on a dev machine.
 */

export interface AudioBatch {
  readonly stream: "me" | "them";
  readonly pcm: Buffer;
}

export interface AudioEngineEvent {
  readonly type: string;
  readonly detail: string;
}

export interface AudioEngine {
  start(
    onBatch: (batch: AudioBatch) => void,
    onEvent: (event: AudioEngineEvent) => void,
  ): void;
  stop(): { droppedBatches: number };
}

export type AudioEngineResult =
  { ok: true; engine: AudioEngine } | { ok: false; message: string };

function isAudioEngine(value: unknown): value is AudioEngine {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["start"] === "function" &&
    typeof record["stop"] === "function"
  );
}

let cached: AudioEngineResult | null = null;

export function loadAudioEngine(): AudioEngineResult {
  if (cached !== null) {
    return cached;
  }
  try {
    // Path from the bundled main (out/main/) back to the addon's build output.
    // Packaging (chunk 7) will relocate this next to the app's resources.
    const addonPath = join(
      import.meta.dirname,
      "../../native/audio/build/Release/nova_audio.node",
    );
    const nodeRequire = createRequire(import.meta.url);
    const addon: unknown = nodeRequire(addonPath);
    cached = isAudioEngine(addon)
      ? { ok: true, engine: addon }
      : {
          ok: false,
          message: "The audio addon loaded but has the wrong shape.",
        };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    cached = {
      ok: false,
      message: `The audio engine could not load (${reason}). Run: npm run build:native --workspace apps/desktop`,
    };
  }
  return cached;
}
