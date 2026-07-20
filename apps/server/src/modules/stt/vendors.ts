import type { SttVendor } from "./ports.js";

/**
 * Build the priority-ordered STT vendor lineup from the environment. This is the
 * registry SEAM: the live transport constructs its engine over whatever this
 * returns, and tests inject mock vendors by mocking this function (the same DI
 * shape the transport uses for `authenticateToken`).
 *
 * Task 5 fills this in — real AssemblyAI (primary) / Deepgram (fallback) adapters
 * behind `adapters/`, gated on configured keys, zod-parsed at the env boundary
 * (RULES §5). Until then there are NO vendors: a `session.start` surfaces a single
 * typed `error` (engine exhaustion) to the client rather than hanging forever.
 */
export function createSttVendorsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): readonly SttVendor[] {
  // Task 5 reads the vendor keys off `env` and returns the adapter lineup.
  void env;
  return [];
}
