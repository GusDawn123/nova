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
  /**
   * Sampling temperature. OMITTED by default (the vendor's own default); the
   * live wiring passes a low value (Natively reference, 2026-08-18 doc: their
   * answer paths run 0.25–0.4 — "lower = faster, more focused"). Probed
   * 2026-08-19: gemini-3.5-flash-lite accepts it.
   */
  temperature?: number;
  /**
   * Nucleus sampling. OMITTED by default; the live wiring passes 0.85 — the
   * reference product's exact gemini live-voice setting (2026-08-21, copying
   * their per-model params verbatim per Gustavo).
   */
  topP?: number;
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
      let cachedInputTokens: number | undefined;
      try {
        const config: GenerateContentConfig = {
          ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
          ...(opts.temperature !== undefined
            ? { temperature: opts.temperature }
            : {}),
          ...(opts.topP !== undefined ? { topP: opts.topP } : {}),
          // THINKING LEVEL, measured 2026-08-22 against the real composed
          // prompt (streaming TTFT, three rounds each):
          //   no knob (= the model's own default)  9,217ms
          //   MEDIUM (3.5-flash's documented default) 5,167ms
          //   LOW      48s / 95s / 503 UNAVAILABLE  <- pathological, never use
          //   MINIMAL  918ms / 1,060ms / 883ms      <- the live lane
          // 3.5-flash ships thinking ON at medium (Google's 3.5 release note),
          // which is what made the gemini pick feel slow and out of sync, and
          // its LOW tier is currently both glacial and 503-prone. So the 3.5
          // lineage pins MINIMAL. The 3.7 lineage keeps LOW (probed fine
          // 2026-08-17); lite-lineage models REJECT thinkingConfig outright
          // (probed 2026-07-23: 400), so they still get no knob at all.
          ...(model.includes("lite")
            ? {}
            : model.startsWith("gemini-3.5")
              ? { thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL } }
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
            // Prefix-cache telemetry (Natively reference §4/§6): implicit-cache
            // hits surface here; a silent miss bills the full input rate.
            cachedInputTokens = usage.cachedContentTokenCount;
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
