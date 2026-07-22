import type { ConversationType } from "@nova/shared";

import type { ChatMessage } from "../../llm/index.js";

import { REPAIR_SYSTEM_PROMPT } from "./system.js";
import { schemaTextFor } from "./types.js";

/**
 * The ONE repair round-trip prompt (adr-0006 §7). Carries the target schema, the
 * model's own invalid output, and the zod issue paths ("path: message" lines), then
 * the preserve-and-return-only-JSON law. Curried by conversation type so the schema
 * it echoes matches the pinned request schema the pipeline validated against.
 */
export function buildNotesRepairMessages(
  type: ConversationType,
  invalidText: string,
  issues: string,
): ChatMessage[] {
  const user = [
    "Your previous response did not match the required schema.",
    "",
    "Required shape:",
    schemaTextFor(type),
    "",
    "Your invalid output:",
    invalidText,
    "",
    "Problems found:",
    issues,
    "",
    "Preserve all valid content, return ONLY the corrected JSON object.",
  ].join("\n");

  return [
    { role: "system", content: REPAIR_SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}
