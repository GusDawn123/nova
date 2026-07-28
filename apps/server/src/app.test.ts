import { describe, expect, it } from "vitest";
import { healthResponseSchema } from "@nova/shared";

import { buildApp } from "./app.js";
import { version } from "./version.js";

describe("GET /health", () => {
  it("returns 200 with a body matching healthResponseSchema", async () => {
    const app = buildApp({ logger: false });
    try {
      const response = await app.inject({ method: "GET", url: "/health" });

      expect(response.statusCode).toBe(200);
      const parsed = healthResponseSchema.parse(response.json<unknown>());
      expect(parsed.ok).toBe(true);
      expect(parsed.version).toBe(version);
    } finally {
      await app.close();
    }
  });

  it("echoes a provided x-request-id header", async () => {
    const app = buildApp({ logger: false });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/health",
        headers: { "x-request-id": "test-req-123" },
      });

      expect(response.headers["x-request-id"]).toBe("test-req-123");
    } finally {
      await app.close();
    }
  });

  it("generates an x-request-id when none is provided", async () => {
    const app = buildApp({ logger: false });
    try {
      const response = await app.inject({ method: "GET", url: "/health" });

      const requestId = response.headers["x-request-id"];
      expect(typeof requestId).toBe("string");
      expect(requestId).toBeTruthy();
    } finally {
      await app.close();
    }
  });
});
