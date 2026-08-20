import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type {
  LiveLogger,
  LlmDebugEntry,
  LlmDebugSink,
} from "./modules/live/ports.js";

/**
 * Dev-only answer ledger (Gustavo, 2026-08-19): one JSONL line per live
 * generation — trigger, full answer text, outcome, timing, cache stats — so
 * prompt-register work can be diagnosed from what the model ACTUALLY said
 * instead of from memory of the pill.
 *
 * Lives HERE, in the app wiring, and not in `modules/live`: that whole layer
 * is scanned by the [no-disk] audit (raw audio must never be able to reach
 * disk), so the live module carries only the sink TYPE (ports.ts) and this
 * file owns the filesystem.
 *
 * DELIBERATE exception to RULES §6 (never log raw transcripts): this sink
 * writes conversation content, so it exists ONLY behind the explicit
 * `LLM_DEBUG_TRANSCRIPT` env opt-in, defaults hard-off, and lands in a
 * gitignored local file. Never enable it in production.
 */

/** `LLM_DEBUG_TRANSCRIPT=1|true` → this path (from the server cwd); any other
 * non-empty value is used as the path itself. */
const DEFAULT_PATH = ".dev/llm-transcript.jsonl";

/**
 * Build the sink, or undefined when the flag is unset/empty (the production
 * posture — absent flag means the code path does not exist, like every other
 * optional seam). Writes are serialized fire-and-forget appends: a slow or
 * failing disk never blocks or breaks a generation — failures log (ids only)
 * and the entry is dropped.
 */
export function createLlmDebugLedger(
  env: NodeJS.ProcessEnv,
  logger?: LiveLogger,
): LlmDebugSink | undefined {
  const flag = env.LLM_DEBUG_TRANSCRIPT;
  if (flag === undefined || flag === "") return undefined;
  const path = resolve(flag === "1" || flag === "true" ? DEFAULT_PATH : flag);
  // Serialize appends through one promise chain so concurrent generations
  // cannot interleave half-written lines.
  let tail: Promise<void> = Promise.resolve();
  return (entry: LlmDebugEntry): void => {
    tail = tail
      .then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
      })
      .catch((err: unknown) => {
        logger?.error(
          { user_id: entry.user_id, meeting_id: entry.meeting_id, err },
          "live.debug_transcript_write_failed",
        );
      });
  };
}
