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

/** OpenAI requires a token cap; kept small — smoke output is trivial. */
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

export interface OpenAiCompatibleOptions {
  id: ProviderId;
  apiKey: string;
  model: string;
  /** Override the API host (Groq points this at its OpenAI-compatible URL). */
  baseURL?: string;
  maxOutputTokens?: number;
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
  const clientOptions: { apiKey: string; maxRetries: number; baseURL?: string } =
    { apiKey: opts.apiKey, maxRetries: 0 };
  if (opts.baseURL !== undefined) {
    clientOptions.baseURL = opts.baseURL;
  }
  const client = new OpenAI(clientOptions);
  const maxTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  return {
    id: opts.id,
    async *stream(
      req: ChatRequest,
      signal: AbortSignal,
    ): AsyncGenerator<LlmStreamEvent> {
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      try {
        const stream = await client.chat.completions.create(
          {
            model: opts.model,
            messages: toOpenAiMessages(req.messages),
            max_completion_tokens: maxTokens,
            stream: true,
            // Usage arrives in a final chunk (after `[DONE]`-adjacent deltas);
            // without this it is omitted from streamed responses.
            stream_options: { include_usage: true },
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
          }
        }
        yield doneEvent(parseVendorUsage({ inputTokens, outputTokens }));
      } catch (error) {
        throw toLlmError(error, signal);
      }
    },
  };
}
