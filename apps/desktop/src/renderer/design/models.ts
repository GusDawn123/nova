/**
 * The live-model picker vocabulary (Gustavo, 2026-08-20 — the humanized-speech
 * bake-off). Ids are the shared wire's `liveModelSchema` values; names are the
 * pill's display labels. Groq-the-llama-vendor is deliberately absent.
 */
export const NOVA_MODELS = [
  { id: "gpt", name: "GPT" },
  { id: "gemini", name: "Gemini" },
  { id: "grok", name: "Grok" },
] as const;

export type NovaModelId = (typeof NOVA_MODELS)[number]["id"];

/** localStorage key: the pick survives restarts (a taste, not a session fact). */
export const MODEL_STORAGE_KEY = "nova.liveModel";

export function isNovaModelId(value: string | null): value is NovaModelId {
  return NOVA_MODELS.some((model) => model.id === value);
}
