import { jsonrepair } from "jsonrepair";
import type { z } from "zod";

import type { JobUsage } from "../../db/jobs.js";
import type { ChatMessage, LlmRouter } from "../llm/index.js";

/**
 * The structured-output ladder (RULES §1, adr-0006 §7). LLM output is hostile
 * input, so every structured response walks the same rungs:
 *
 *   1. buffer the router's stream into one string
 *   2. `JSON.parse` → zod `safeParse`                       (the clean path)
 *   3. deterministic salvage — fence/brace extraction + `jsonrepair` (syntactic
 *      only) → zod                                          (recovers fenced/prose-
 *      wrapped/trailing-comma/single-quote output without a second model call)
 *   4. on a zod (or parse) failure, EXACTLY ONE repair round-trip: a fresh router
 *      call carrying the invalid output + the zod issue paths + a "preserve valid
 *      content, return ONLY the corrected JSON" instruction (may land on any
 *      healthy provider)                                    (one paid retry, capped)
 *   5. still invalid → the caller's deterministic fallback  (`status:'failed'`)
 *
 * Generic over the zod schema + prompt so the follow-up draft (Task 5) reuses it.
 * The ladder never constructs the fallback itself (that differs per consumer):
 * it reports `status:'failed'` and hands back the raw failing text so the caller
 * can fall back AND surface the raw output on the job row (never in a typed jsonb
 * column). Transport failures are NOT swallowed here — a router throw
 * (`LlmError`/`AllProvidersFailedError`) propagates so the worker can classify it
 * as a retry (adr-0006 §3); only CONTENT failures walk to `status:'failed'`.
 */

/** Salvage/repair/fallback flags for structured logs + the job telemetry seam. */
export interface LadderTelemetry {
  /** Syntactic salvage (fence/brace extraction or `jsonrepair`) produced the object. */
  readonly salvageApplied: boolean;
  /** The one repair round-trip was spent. */
  readonly repairUsed: boolean;
  /** Both rungs failed; the caller must apply its deterministic fallback. */
  readonly fellBack: boolean;
}

/** Whether the ladder produced a schema-valid value or exhausted its rungs. */
export type LadderResult<T> =
  { readonly status: "ok"; readonly value: T } | { readonly status: "failed" };

/** The full ladder outcome: result + raw text + telemetry + per-call usage. */
export interface LadderOutcome<T> {
  readonly result: LadderResult<T>;
  /** The last attempt's raw buffered text — for `jobs.raw_output` / observability. */
  readonly rawText: string;
  readonly telemetry: LadderTelemetry;
  /** One {@link JobUsage} entry per router call (generate, then repair if spent). */
  readonly usage: JobUsage[];
}

/** Inputs to {@link runLadder}. `repair` builds the round-trip prompt for THIS schema. */
export interface RunLadderParams<T> {
  readonly schema: z.ZodType<T>;
  readonly messages: ChatMessage[];
  readonly router: LlmRouter;
  /** Build the repair prompt from the invalid output + formatted zod issue paths. */
  readonly repair: (invalidText: string, issues: string) => ChatMessage[];
  readonly signal?: AbortSignal;
}

/**
 * Buffer a router stream into its full text + one usage entry. A transport throw
 * from the router propagates (the ladder does not swallow it). `provider` is left
 * unset: the locked {@link LlmRouter} port surfaces token counts on the `done`
 * event but not which provider committed (see the Task 4/5 handoff in the report).
 */
export async function bufferStream(
  router: LlmRouter,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<{ text: string; usage: JobUsage }> {
  let text = "";
  const usage: JobUsage = {};
  const iterable = signal
    ? router.stream({ messages }, { signal })
    : router.stream({ messages });
  for await (const event of iterable) {
    if (event.type === "token") {
      text += event.text;
    } else if (event.usage) {
      if (event.usage.inputTokens !== undefined) {
        usage.inputTokens = event.usage.inputTokens;
      }
      if (event.usage.outputTokens !== undefined) {
        usage.outputTokens = event.usage.outputTokens;
      }
    }
  }
  return { text, usage };
}

/** Walk the ladder for one schema + prompt. Never throws for content reasons. */
export async function runLadder<T>(
  params: RunLadderParams<T>,
): Promise<LadderOutcome<T>> {
  const { schema, messages, router, repair, signal } = params;
  const usage: JobUsage[] = [];

  const first = await bufferStream(router, messages, signal);
  usage.push(first.usage);
  const firstParse = parseStructured(first.text, schema);
  if (firstParse.ok) {
    return {
      result: { status: "ok", value: firstParse.value },
      rawText: first.text,
      telemetry: {
        salvageApplied: firstParse.salvaged,
        repairUsed: false,
        fellBack: false,
      },
      usage,
    };
  }

  // Exactly one repair round-trip — a fresh call with the invalid output + issues.
  const repairMessages = repair(first.text, firstParse.issues);
  const second = await bufferStream(router, repairMessages, signal);
  usage.push(second.usage);
  const secondParse = parseStructured(second.text, schema);
  const salvageApplied = firstParse.salvaged || secondParse.salvaged;
  if (secondParse.ok) {
    return {
      result: { status: "ok", value: secondParse.value },
      rawText: second.text,
      telemetry: { salvageApplied, repairUsed: true, fellBack: false },
      usage,
    };
  }

  return {
    result: { status: "failed" },
    rawText: second.text,
    telemetry: { salvageApplied, repairUsed: true, fellBack: true },
    usage,
  };
}

/** The outcome of trying to coax a schema-valid value out of one raw response. */
type ParseAttempt<T> =
  | { ok: true; value: T; salvaged: boolean }
  | { ok: false; salvaged: boolean; issues: string };

/**
 * Parse rungs 2–3: direct JSON → salvage (fence/brace extraction) → `jsonrepair`,
 * each followed by a zod `safeParse`. `salvaged` records whether any syntactic
 * recovery beyond a clean `JSON.parse` was needed (so a clean-but-schema-wrong
 * response reports `salvaged:false`).
 */
function parseStructured<T>(
  text: string,
  schema: z.ZodType<T>,
): ParseAttempt<T> {
  const direct = tryJson(text);
  if (direct.ok) {
    return finish(direct.value, schema, false);
  }

  const candidate = extractJson(text);
  if (candidate !== null) {
    const parsed = tryJson(candidate);
    if (parsed.ok) {
      return finish(parsed.value, schema, true);
    }
    const repaired = tryRepair(candidate);
    if (repaired.ok) {
      return finish(repaired.value, schema, true);
    }
  }

  // Last resort: repair the whole response (handles stray leading/trailing prose
  // that the brace scan already trimmed, but also doubly-broken output).
  const repairedWhole = tryRepair(text);
  if (repairedWhole.ok) {
    return finish(repairedWhole.value, schema, true);
  }

  return { ok: false, salvaged: true, issues: "Response was not valid JSON." };
}

/** Run the zod parse on a recovered value and shape the {@link ParseAttempt}. */
function finish<T>(
  value: unknown,
  schema: z.ZodType<T>,
  salvaged: boolean,
): ParseAttempt<T> {
  const result = schema.safeParse(value);
  if (result.success) {
    return { ok: true, value: result.data, salvaged };
  }
  return { ok: false, salvaged, issues: formatIssues(result.error) };
}

/** `path: message` lines the repair prompt feeds back to the model. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join(".");
      return `${path === "" ? "(root)" : path}: ${issue.message}`;
    })
    .join("\n");
}

/**
 * Pull a JSON candidate out of a non-JSON response: a fenced ```json … ``` block
 * first, else the span from the first `{` to the last `}` (drops prose wrappers).
 */
function extractJson(text: string): string | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence?.[1] !== undefined) {
    return fence[1].trim();
  }
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open !== -1 && close > open) {
    return text.slice(open, close + 1);
  }
  return null;
}

function tryJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

function tryRepair(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(jsonrepair(text)) };
  } catch {
    return { ok: false };
  }
}
