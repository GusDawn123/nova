import OpenAI from "openai";

import type {
  ChatMessage,
  ChatRequest,
  LlmProvider,
  LlmStreamEvent,
  ProviderId,
} from "../ports.js";
import { toLlmError } from "./map-error.js";
import { doneEvent, parseVendorUsage } from "./usage.js";

/**
 * Shared engine for OpenAI and every OpenAI-compatible endpoint (Groq). The
 * `openai` SDK is the one vendor dependency; `openai.ts` and `groq.ts` are thin
 * wrappers over this factory that differ only in `id`, default `model`, and
 * `baseURL`. Keeping the streaming/translation/error logic here avoids two
 * near-identical adapters.
 */

export interface OpenAiCompatibleOptions {
  id: ProviderId;
  apiKey: string;
  model: string;
  /** Override the API host (Groq points this at its OpenAI-compatible URL). */
  baseURL?: string;
  maxOutputTokens?: number;
  /**
   * Reasoning-effort setting for reasoning-capable models (gpt-5.x family).
   * adr-0004 §4: low/none at the adapter layer is the single biggest TTFT
   * lever. Omit for endpoints/models without the param (Groq passes nothing).
   */
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
  /**
   * Sampling temperature. OMITTED by default (the vendor's own default); the
   * live wiring passes a low value (Natively reference, 2026-08-18 doc: their
   * answer paths run 0.25–0.4 — "lower = faster, more focused"). Probed
   * 2026-08-19: gpt-5.4-mini accepts the param alongside reasoning_effort.
   */
  temperature?: number;
}

/**
 * Our roles (`system`/`user`/`assistant`) are all valid OpenAI roles, so
 * messages map one-to-one. Exported for translation unit tests.
 */
export function toOpenAiMessages(
  messages: readonly ChatMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

export function createOpenAiCompatibleProvider(
  opts: OpenAiCompatibleOptions,
): LlmProvider {
  // maxRetries: 0 — retries are the ROUTER's job (failover + breaker); SDK
  // retries must not stack under it (would burn the TTFT window / re-hammer 429s).
  const clientOptions: {
    apiKey: string;
    maxRetries: number;
    baseURL?: string;
  } = { apiKey: opts.apiKey, maxRetries: 0 };
  if (opts.baseURL !== undefined) {
    clientOptions.baseURL = opts.baseURL;
  }
  const client = new OpenAI(clientOptions);
  // No default output cap (Gustavo, 2026-08-17) — only an explicit option caps.
  const maxTokens = opts.maxOutputTokens;

  return {
    id: opts.id,
    async *stream(
      req: ChatRequest,
      signal: AbortSignal,
    ): AsyncGenerator<LlmStreamEvent> {
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let cachedInputTokens: number | undefined;
      try {
        const stream = await client.chat.completions.create(
          {
            model: opts.model,
            messages: toOpenAiMessages(req.messages),
            ...(maxTokens !== undefined
              ? { max_completion_tokens: maxTokens }
              : {}),
            stream: true,
            // Usage arrives in a final chunk (after `[DONE]`-adjacent deltas);
            // without this it is omitted from streamed responses.
            stream_options: { include_usage: true },
            ...(opts.reasoningEffort !== undefined
              ? { reasoning_effort: opts.reasoningEffort }
              : {}),
            ...(opts.temperature !== undefined
              ? { temperature: opts.temperature }
              : {}),
          },
          { signal },
        );
        for await (const chunk of stream) {
          const text = chunk.choices[0]?.delta.content;
          if (typeof text === "string" && text !== "") {
            yield { type: "token", text };
          }
          // The usage-bearing chunk carries empty `choices`; it may arrive at any
          // point but conventionally last. Capture it whenever present.
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens;
            outputTokens = chunk.usage.completion_tokens;
            // Prefix-cache telemetry (Natively reference §4/§6): how much of
            // the prompt was served from the vendor's cache. A silent cache
            // miss looks identical from outside — same answer, same shape —
            // but bills the full input rate, so the count must surface.
            cachedInputTokens =
              chunk.usage.prompt_tokens_details?.cached_tokens;
          }
        }
        yield doneEvent(
          parseVendorUsage({ inputTokens, outputTokens, cachedInputTokens }),
        );
      } catch (error) {
        throw toLlmError(error, signal);
      }
    },
  };
}
