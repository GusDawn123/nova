import { type GenerateContentConfig, GoogleGenAI } from "@google/genai";

import type {
  ChatMessage,
  ChatRequest,
  LlmProvider,
  LlmStreamEvent,
} from "../ports.js";
import { toLlmError } from "./map-error.js";
import { doneEvent, parseVendorUsage } from "./usage.js";

/**
 * Google (Gemini) provider adapter (official `@google/genai` SDK). Thin: it
 * translates messages into Gemini's `contents` + `systemInstruction` shape and
 * the streamed chunks into {@link LlmStreamEvent}s.
 */

/** A cheap/fast current model — see docs before changing (do not guess IDs).
 * gemini-2.0-flash was retired (404 "no longer available", mid-2026); gemini-2.5-flash
 * is its GA flash-class successor per the @google/genai model list. */
const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

export interface GoogleProviderOptions {
  apiKey: string;
  model?: string;
  maxOutputTokens?: number;
}

/** Gemini's request shape: a `systemInstruction` string + role-tagged contents. */
export interface GoogleContents {
  systemInstruction?: string;
  contents: { role: "user" | "model"; parts: { text: string }[] }[];
}

/**
 * Translate our messages into Gemini's shape: `system` turns become the
 * `systemInstruction` (joined), `assistant` maps to Gemini's `model` role, and
 * `user` stays `user`. Exported for translation unit tests.
 */
export function toGoogleContents(
  messages: readonly ChatMessage[],
): GoogleContents {
  const systemParts: string[] = [];
  const contents: { role: "user" | "model"; parts: { text: string }[] }[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
    } else {
      contents.push({
        role: message.role === "assistant" ? "model" : "user",
        parts: [{ text: message.content }],
      });
    }
  }
  const result: GoogleContents = { contents };
  if (systemParts.length > 0) {
    result.systemInstruction = systemParts.join("\n\n");
  }
  return result;
}

export function createGoogleProvider(
  opts: GoogleProviderOptions,
): LlmProvider {
  const client = new GoogleGenAI({ apiKey: opts.apiKey });
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  return {
    id: "google",
    async *stream(
      req: ChatRequest,
      signal: AbortSignal,
    ): AsyncGenerator<LlmStreamEvent> {
      const { systemInstruction, contents } = toGoogleContents(req.messages);
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      try {
        const config: GenerateContentConfig = {
          maxOutputTokens: maxTokens,
          // Disable Gemini 2.5's default dynamic "thinking": a live call copilot
          // wants low latency, and thinking tokens count against maxOutputTokens
          // (a small cap can be consumed entirely by thinking, yielding zero text
          // — the router then sees no first token and fails the provider).
          thinkingConfig: { thinkingBudget: 0 },
          // Client-side abort: unwinds the stream promptly (billing may still
          // apply per the SDK, but our contract is prompt unwind, not un-billing).
          abortSignal: signal,
        };
        if (systemInstruction !== undefined) {
          config.systemInstruction = systemInstruction;
        }
        const stream = await client.models.generateContentStream({
          model,
          contents,
          config,
        });
        for await (const chunk of stream) {
          const text = chunk.text;
          if (typeof text === "string" && text !== "") {
            yield { type: "token", text };
          }
          // usageMetadata is cumulative and repeated across chunks; the last
          // one seen wins.
          const usage = chunk.usageMetadata;
          if (usage) {
            inputTokens = usage.promptTokenCount;
            outputTokens = usage.candidatesTokenCount;
          }
        }
        yield doneEvent(parseVendorUsage({ inputTokens, outputTokens }));
      } catch (error) {
        throw toLlmError(error, signal);
      }
    },
  };
}
