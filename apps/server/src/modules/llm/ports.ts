import { z } from "zod";

/**
 * The provider port — the transport-agnostic contract every LLM adapter (and the
 * scriptable mock) implements. The router in a later task consumes ONLY this
 * surface; it knows nothing about HTTP, vendor SDKs, or streaming wire formats.
 * Adapters translate a vendor's stream into {@link LlmStreamEvent}s and signal
 * failure by THROWING one of the typed errors in `./errors.js`.
 */

/** The providers Nova can route across, in no particular order (order is config). */
export const providerIdSchema = z.enum([
  "anthropic",
  "openai",
  "google",
  "groq",
]);
export type ProviderId = z.infer<typeof providerIdSchema>;

/** One chat turn. `content` is plain text — no multimodal parts today (YAGNI). */
export const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/**
 * A streaming chat-completion request. `providerOrder`, when present, is the
 * per-request override seam the router uses instead of the configured default
 * order — the [order] override the playbook calls for.
 */
export const chatRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1),
  model: z.string().min(1).optional(),
  providerOrder: z.array(providerIdSchema).min(1).optional(),
  /**
   * Latency tier (adr-0004 §4). `"live"` selects the router's `liveOrder`
   * cascade (the live copilot) unless `providerOrder` overrides it;
   * anything else (or absent) uses the quality-first `defaultOrder` (notes /
   * follow-up). Order selection only — budgets are the router config's job.
   */
  latencyTier: z.enum(["live", "deliberate"]).optional(),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

/**
 * What a provider stream emits, as a discriminated union (RULES §10: never a
 * boolean flag plus optional payload). A `done` event closes the stream and
 * carries token usage when the vendor reports it, or `null` when it doesn't.
 */
export const llmStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("token"), text: z.string() }),
  z.object({
    type: z.literal("done"),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional(),
        /**
         * Input tokens the vendor served from its prompt cache (Natively
         * reference §4/§6: a silent cache miss looks identical from outside
         * but bills the full input rate — the count must surface so a log
         * line can catch it). Telemetry only; the meter ignores it.
         */
        cachedInputTokens: z.number().int().nonnegative().optional(),
      })
      .nullable(),
  }),
]);
export type LlmStreamEvent = z.infer<typeof llmStreamEventSchema>;

/**
 * A single LLM provider. `stream` yields events until the stream completes with
 * a `done` event; failure is signalled by throwing a typed `LlmError`, either
 * before the first event or mid-iteration. Implementations MUST respect
 * `signal`: on abort they stop yielding promptly and throw (an `aborted`
 * `LlmError`) or return.
 */
export interface LlmProvider {
  readonly id: ProviderId;
  stream(req: ChatRequest, signal: AbortSignal): AsyncIterable<LlmStreamEvent>;
}

/** A usage report handed to the {@link Meter} for one completed provider call. */
export interface UsageEntry {
  provider: ProviderId;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Metering port. Every path to a paid vendor must report through this (RULES:
 * no unmetered vendor calls). This is only the port — Phase 4 of the playbook
 * wires the real metering module behind it; Phase 2 needs a stub.
 */
export interface Meter {
  recordUsage(entry: UsageEntry): void;
}

/** A Meter that drops everything — the default until real metering is wired. */
export const noopMeter: Meter = {
  recordUsage(): void {
    /* no-op: real metering is wired in a later phase */
  },
};
