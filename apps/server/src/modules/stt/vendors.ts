import { z } from "zod";

import { createAssemblyAiVendor } from "./adapters/assemblyai.js";
import { createDeepgramVendor } from "./adapters/deepgram.js";
import type { SttVendor } from "./ports.js";

/**
 * Build the priority-ordered STT vendor lineup from the environment (Phase 3.5,
 * filling the Task 4 seam). The live transport constructs its engine over
 * whatever this returns; tests inject mock vendors by mocking this function.
 *
 * Order is FIXED primary-first: AssemblyAI (`ASSEMBLYAI_API_KEY`) is primary,
 * Deepgram (`DEEPGRAM_API_KEY`) the fallback. A vendor is included ONLY when its
 * key is present, so the server boots with neither, one, or both — with no key
 * at all, `createSttEngine([])` surfaces a single typed `error` (engine
 * exhaustion) to the client rather than hanging. Keys are zod-parsed at this
 * boundary (RULES §5); the real SDKs live behind `adapters/` only.
 */

/** Optional vendor keys read off the environment. Absent keys → that vendor is skipped. */
const vendorKeysSchema = z.object({
  ASSEMBLYAI_API_KEY: z.string().min(1).optional(),
  DEEPGRAM_API_KEY: z.string().min(1).optional(),
});

export function createSttVendorsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): readonly SttVendor[] {
  const parsed = vendorKeysSchema.safeParse(env);
  const keys = parsed.success ? parsed.data : {};

  const vendors: SttVendor[] = [];
  if (keys.ASSEMBLYAI_API_KEY !== undefined) {
    vendors.push(createAssemblyAiVendor({ apiKey: keys.ASSEMBLYAI_API_KEY }));
  }
  if (keys.DEEPGRAM_API_KEY !== undefined) {
    vendors.push(createDeepgramVendor({ apiKey: keys.DEEPGRAM_API_KEY }));
  }
  return vendors;
}
