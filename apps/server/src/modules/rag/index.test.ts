import { describe, expect, it } from "vitest";

import { createRagFromEnv, isRagError } from "./index.js";

/**
 * Module-factory posture (createRagFromEnv). Mirrors createSttVendorsFromEnv: the
 * server must BOOT without keys, and a keyless RAG surface degrades EXPLICITLY —
 * every method throws a typed RAG_NOT_CONFIGURED rather than crashing at wiring or
 * hanging at call time. An explicit empty env keeps this deterministic regardless
 * of the ambient process environment (e.g. a locally-sourced .env).
 */

describe("createRagFromEnv — keyless posture", () => {
  it("constructs a stub without throwing when no keys are present", () => {
    expect(() => createRagFromEnv({})).not.toThrow();
  });

  it("stub.ingest throws RAG_NOT_CONFIGURED", async () => {
    const rag = createRagFromEnv({});
    await expect(
      rag.ingest("u", {
        kind: "context_doc",
        contextDocId: "d",
        title: "T",
        content: "text",
      }),
    ).rejects.toSatisfy(
      (err: unknown) => isRagError(err) && err.code === "RAG_NOT_CONFIGURED",
    );
  });

  it("stub.query throws RAG_NOT_CONFIGURED", async () => {
    const rag = createRagFromEnv({});
    await expect(rag.query("u", "q", { tier: "live" })).rejects.toSatisfy(
      (err: unknown) => isRagError(err) && err.code === "RAG_NOT_CONFIGURED",
    );
  });
});
