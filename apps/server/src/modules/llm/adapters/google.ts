import {
  type GenerateContentConfig,
  GoogleGenAI,
  ThinkingLevel,
} from "@google/genai";

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

/** The current model — see docs before changing (do not guess IDs).
 * Lineage: gemini-2.0-flash (retired mid-2026) → gemini-2.5-flash →
 * gemini-3.5-flash-lite (2026-07-23 refresh) → gemini-3.7-flash (2026-08-17,
 * Gustavo's pick: the lite tier ignored Brain A's register rules; $0.75/$3.75
 * per 1M intro pricing) → REVERTED to gemini-3.5-flash-lite (2026-08-19,
 * Gustavo: keep the old models; id re-probed LIVE on our key the same day and
 * answering — $0.30/$2.50 per 1M, the price book moves in lockstep, adr-0004
 * addendum).
 *
 * THINKING: the knob below is model-conditional and stays that way — the lite
 * default is non-thinking (lite-lineage models REJECT thinkingConfig outright;
 * probed 2026-07-23: 400), so the knob is skipped for it, while an explicit
 * non-lite override (e.g. 3.7-flash, which defaults to MEDIUM and bills
 * thinking tokens as output) still gets `thinkingLevel: "low"` pinned. */
const DEFAULT_MODEL = "gemini-3.5-flash-lite";

export interface GoogleProviderOptions {
  apiKey: string;
  model?: string;
  /**
   * Optional output ceiling. OMITTED by default — no product cap on answer
   * length (Gustavo, 2026-08-17: caps silently squeezed the comments out of
   * code answers); the model's own vendor limit is the only bound.
   */
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

export function createGoogleProvider(opts: GoogleProviderOptions): LlmProvider {
  const client = new GoogleGenAI({ apiKey: opts.apiKey });
  const model = opts.model ?? DEFAULT_MODEL;
  const maxTokens = opts.maxOutputTokens;

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
          ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
          // Thinking LOW (Gustavo, 2026-08-17: decently smart, reasoning low).
          // 3.7-flash defaults to MEDIUM and bills thinking tokens as OUTPUT,
          // so leaving the knob off silently costs money and first-token
          // latency. Lite-lineage models REJECT thinkingConfig (probed
          // 2026-07-23: 400 INVALID_ARGUMENT — that lineage is non-thinking by
          // default), so the knob is skipped for them.
          ...(model.includes("lite")
            ? {}
            : { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }),
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
