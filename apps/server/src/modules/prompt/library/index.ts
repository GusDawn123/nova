import { behavioralMode } from "./modes/behavioral.js";
import { financeMode } from "./modes/finance.js";
import { technicalMode } from "./modes/technical.js";
import { liveNotesCategory } from "./notes/live-notes.js";
import type { ModePrompt } from "./types.js";

export { SYSTEM_PROMPT } from "./system.js";
export type { CategoryPrompt, ModePrompt, PromptExample } from "./types.js";

/**
 * The prompt library: one always-on system prompt, one file per mode, and
 * categories that are not modes.
 *
 * WIRED (Phase 8.6). `assemble(mode, context)` builds every live stablePrefix
 * from here: SYSTEM_PROMPT always, plus the picked mode's block. The flattened
 * `content/system-prompt.ts` and its generator are LEGACY — still on disk for
 * reference, imported by nothing on the live path.
 *
 * BUILT: behavioral (extracted), technical and finance (thin in the source,
 * structure and examples added).
 * DEFERRED by decision: sales and negotiation. Their raw material — conversation
 * advancement and objection handling — was promoted into the system prompt
 * instead, since both apply in every domain.
 * NOT BUILT: creative. It exists in the source; see the README for what it is.
 *
 * `satisfies` rather than an annotation: it keeps the shape honest while leaving
 * each key's presence KNOWN to the type checker, so `assemble` can build its
 * per-mode prefix table without an index-signature `undefined` to explain away.
 */
export const MODES = {
  behavioral: behavioralMode,
  finance: financeMode,
  technical: technicalMode,
} satisfies Readonly<Record<string, ModePrompt>>;

export const LIVE_NOTES_CATEGORY = liveNotesCategory;
