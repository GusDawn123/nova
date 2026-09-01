import { z } from "zod";

import type { LlmStreamEvent } from "../ports.js";

/**
 * Vendor usage numbers are hostile output like any other boundary — zod-parse
 * them before they enter our domain (RULES: don't trust SDK types at the edge).
 * A count that isn't a nonnegative integer is dropped, not coerced.
 */
const tokenCountSchema = z.number().int().nonnegative();

/** Parsed token usage, all fields independently optional. */
export interface ParsedUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Input tokens the vendor served from its prompt cache (telemetry). */
  cachedInputTokens?: number;
}

/**
 * zod-parse raw token counts. Each field is validated on its own so a single
 * malformed count doesn't discard the others.
 */
export function parseVendorUsage(raw: {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cachedInputTokens?: unknown;
}): ParsedUsage {
  const parsed: ParsedUsage = {};
  const input = tokenCountSchema.safeParse(raw.inputTokens);
  if (input.success) {
    parsed.inputTokens = input.data;
  }
  const output = tokenCountSchema.safeParse(raw.outputTokens);
  if (output.success) {
    parsed.outputTokens = output.data;
  }
  const cached = tokenCountSchema.safeParse(raw.cachedInputTokens);
  if (cached.success) {
    parsed.cachedInputTokens = cached.data;
  }
  return parsed;
}

/**
 * Build the terminal `done` event from parsed usage. When the vendor reported
 * no usable counts, `usage` is `null` (the port's "no counts" signal) rather
 * than an empty object.
 */
export function doneEvent(usage: ParsedUsage): LlmStreamEvent {
  const hasCounts =
    usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.cachedInputTokens !== undefined;
  return { type: "done", usage: hasCounts ? usage : null };
}
