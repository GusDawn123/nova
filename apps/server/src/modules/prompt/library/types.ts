/**
 * The shape every piece of the prompt library shares.
 *
 * The source document (`docs/prompts/nova-prompts-source.md`) fuses three
 * different jobs into each of its blocks: how to DETECT a situation, which
 * situation WINS, and what the answer should LOOK like. Only the last of those is
 * language work. Detection and precedence belong in code — and with the mode now
 * PICKED BY THE USER on the front end, neither is needed at all.
 *
 * So a mode here is exactly one thing: the answer structure for a domain.
 */

/** One worked example. Few-shot travels WITH its mode, never with the system prompt. */
export interface PromptExample {
  /** What the transcript looked like at the moment help was needed. */
  readonly transcript: string;
  /** What a good answer looks like, in this mode's structure. */
  readonly response: string;
}

/** One domain the user can select on the Live screen. */
export interface ModePrompt {
  /** Stable id — the wire value carried on `session.start`. */
  readonly id: string;
  /** Shown in the mode picker. */
  readonly label: string;
  /** One line: when a user should pick this. Also the picker's subtitle. */
  readonly useWhen: string;
  /** The domain's rules — what to prioritise, what to avoid. */
  readonly directive: string;
  /** The SHAPE of the answer. This is the part that makes a mode a mode. */
  readonly answerStructure: string;
  /** Few-shot demonstrations of that shape. Ship only with this mode. */
  readonly examples: readonly PromptExample[];
}

/** A non-mode prompt: a job Nova does that the user does not select per call. */
export interface CategoryPrompt {
  readonly id: string;
  readonly label: string;
  /** Why this is NOT a mode. */
  readonly notAMode: string;
  readonly directive: string;
  readonly answerStructure: string;
  readonly examples: readonly PromptExample[];
}
