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
 * NOT WIRED into the live path yet — `assemble()` still uses the flattened
 * `content/system-prompt.ts`. Wiring is a separate change so the text can be
 * reviewed and the live gates re-run against it deliberately, rather than a
 * prompt rewrite shipping as a side effect of a refactor.
 *
 * BUILT: behavioral (extracted), technical and finance (thin in the source,
 * structure and examples added).
 * DEFERRED by decision: sales and negotiation. Their raw material — conversation
 * advancement and objection handling — was promoted into the system prompt
 * instead, since both apply in every domain.
 * NOT BUILT: creative. It exists in the source; see the README for what it is.
 */
export const MODES: Readonly<Record<string, ModePrompt>> = {
  behavioral: behavioralMode,
  finance: financeMode,
  technical: technicalMode,
};

export const LIVE_NOTES_CATEGORY = liveNotesCategory;
