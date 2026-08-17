import Anthropic from "@anthropic-ai/sdk";

import type {
  ChatMessage,
  ChatRequest,
  LlmProvider,
  LlmStreamEvent,
} from "../ports.js";
import { toLlmError } from "./map-error.js";
import { doneEvent, parseVendorUsage } from "./usage.js";

/**
 * Anthropic provider adapter (official `@anthropic-ai/sdk`). Thin by design: it
 * translates a {@link ChatRequest} into the Messages streaming call and the
 * vendor's stream events into {@link LlmStreamEvent}s. Vendor errors are mapped
 * to the typed taxonomy in {@link toLlmError}; the router owns all failover.
 */

/** A cheap/fast current model — see docs before changing (do not guess IDs). */
const DEFAULT_MODEL = "claude-haiku-4-5";
/**
 * Anthropic's API REQUIRES `max_tokens` — this is the vendor-mandated field,
 * not a product cap (Gustavo, 2026-08-17: no output caps). Set to the model
 * family's ceiling so it never truncates a real answer.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

export interface AnthropicProviderOptions {
  apiKey: string;
  /** Overrides {@link DEFAULT_MODEL}. */
  model?: string;
  /** Overrides {@link DEFAULT_MAX_OUTPUT_TOKENS} (the vendor-required field). */
  maxOutputTokens?: number;
}

/** Anthropic's message shape: a top-level `system` string + user/assistant turns. */
export interface AnthropicMessages {
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
}

/**
 * Translate our transport-agnostic messages into Anthropic's shape: `system`
 * turns are hoisted into the top-level `system` field (joined), the rest map
 * one-to-one. Exported for translation unit tests.
 */
export function toAnthropicMessages(
  messages: readonly ChatMessage[],
): AnthropicMessages {
  const systemParts: string[] = [];
  const chat: { role: "user" | "assistant"; content: string }[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
    } else {
      chat.push({ role: message.role, content: message.content });
    }
  }
  const result: AnthropicMessages = { messages: chat };
  if (systemParts.length > 0) {
    result.system = systemParts.join("\n\n");
  }
  return result;
}

export function createAnthropicProvider(
  opts: AnthropicProviderOptions,
): LlmProvider {
  // maxRetries: 0 — retries are the ROUTER's job (failover + breaker); SDK
  // retries must not stack under it (would burn the TTFT window / re-hammer 429s).
  const client = new Anthropic({ apiKey: opts.apiKey, maxRetries: 0 });
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  return {
    id: "anthropic",
    async *stream(
      req: ChatRequest,
      signal: AbortSignal,
    ): AsyncGenerator<LlmStreamEvent> {
      const { system, messages } = toAnthropicMessages(req.messages);
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      try {
        const params: Anthropic.MessageCreateParamsStreaming = {
          model,
          max_tokens: maxTokens,
          messages,
          stream: true,
        };
        if (system !== undefined) {
          params.system = system;
        }
        // The router's per-attempt AbortSignal is passed straight through so an
        // abort promptly rejects the SDK's pending read and unwinds this loop.
        const events = await client.messages.create(params, { signal });
        for await (const event of events) {
          if (event.type === "message_start") {
            inputTokens = event.message.usage.input_tokens;
          } else if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            // Runtime boundary guard (mirrors openai/google): don't trust the
            // SDK type — only yield an actual non-empty string.
            const text: unknown = event.delta.text;
            if (typeof text === "string" && text !== "") {
              yield { type: "token", text };
            }
          } else if (event.type === "message_delta") {
            outputTokens = event.usage.output_tokens;
          }
        }
        yield doneEvent(parseVendorUsage({ inputTokens, outputTokens }));
      } catch (error) {
        throw toLlmError(error, signal);
      }
    },
  };
}
