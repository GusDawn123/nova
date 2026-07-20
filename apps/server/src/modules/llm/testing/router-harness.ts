import { z } from "zod";

import { llmConfigSchema } from "../config.js";
import { AllProvidersFailedError, LlmError } from "../errors.js";
import type {
  ChatRequest,
  LlmProvider,
  LlmStreamEvent,
  Meter,
} from "../ports.js";
import { createLlmRouter, type LlmRouter } from "../router.js";

/**
 * Shared, vitest-free scaffolding for the router behaviour suite
 * (`router.*.test.ts`). Kept out of the `*.test.ts` files so it is compiled as
 * ordinary module source (like `mock-provider.ts`) rather than run as a suite,
 * and imports nothing from `vitest` — assertions live in the test files.
 */

/** A minimal valid request reused across the router behaviour suite. */
export const REQ: ChatRequest = { messages: [{ role: "user", content: "hi" }] };

/** Build a `token` event. */
export function tok(text: string): LlmStreamEvent {
  return { type: "token", text };
}

/** A `done` event carrying no usage. */
export const DONE: LlmStreamEvent = { type: "done", usage: null };

/** Build a `done` event carrying usage. */
export function doneWith(usage: {
  inputTokens?: number;
  outputTokens?: number;
}): LlmStreamEvent {
  return { type: "done", usage };
}

/** Parse config overrides into a full {@link LlmConfig}, applying defaults. */
export function makeConfig(overrides: z.input<typeof llmConfigSchema> = {}) {
  return llmConfigSchema.parse(overrides);
}

/**
 * Build a router over mock providers with parsed config and an optional meter.
 * `overrides` are the raw config knobs; everything else defaults.
 */
export function makeRouter(
  providers: LlmProvider[],
  overrides: z.input<typeof llmConfigSchema> = {},
  meter?: Meter,
): LlmRouter {
  const config = makeConfig(overrides);
  return createLlmRouter(
    meter ? { providers, config, meter } : { providers, config },
  );
}

/** The outcome of draining a router/provider stream to completion. */
export interface DrainResult {
  events: LlmStreamEvent[];
  error: unknown;
}

/**
 * Drain a stream to completion, capturing a terminal throw instead of
 * propagating it — so a test can assert on both the events seen and the error.
 */
export async function drain(
  iterable: AsyncIterable<LlmStreamEvent>,
): Promise<DrainResult> {
  const events: LlmStreamEvent[] = [];
  try {
    for await (const event of iterable) {
      events.push(event);
    }
    return { events, error: undefined };
  } catch (error) {
    return { events, error };
  }
}

/** Narrow a captured value to an {@link LlmError} or throw a helpful failure. */
export function asLlmError(value: unknown): LlmError {
  if (value instanceof LlmError) {
    return value;
  }
  throw new Error(`expected an LlmError, received: ${String(value)}`);
}

/** Narrow a captured value to the terminal {@link AllProvidersFailedError}. */
export function asAllProvidersFailed(value: unknown): AllProvidersFailedError {
  if (value instanceof AllProvidersFailedError) {
    return value;
  }
  throw new Error(
    `expected AllProvidersFailedError, received: ${String(value)}`,
  );
}
