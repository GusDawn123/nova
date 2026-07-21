import type { AddressInfo } from "node:net";

import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { buildApp } from "../app.js";
import { redactUrl, withLogRedaction } from "./log-redaction.js";

/**
 * The /live socket accepts `?token=<JWT>` as an auth fallback; pino's default
 * req serializer logs `req.url` INCLUDING the query string. These tests prove
 * the buildApp-installed serializer keeps the token out of every emitted log
 * line (RULES: never log secrets).
 */

describe("redactUrl", () => {
  it("strips the query string, keeping the path", () => {
    expect(redactUrl("/live?token=eyJ.secret.jwt")).toBe("/live?[redacted]");
  });

  it("leaves a query-less url unchanged", () => {
    expect(redactUrl("/health")).toBe("/health");
  });

  it("redacts everything after the first ?", () => {
    expect(redactUrl("/live?a=1&token=s3cret&b=2")).toBe("/live?[redacted]");
  });
});

describe("withLogRedaction", () => {
  it("keeps `false` as `false` (silent test apps stay silent)", () => {
    expect(withLogRedaction(false)).toBe(false);
  });

  it("turns true/undefined into a config carrying the req serializer", () => {
    for (const input of [true, undefined] as const) {
      const config = withLogRedaction(input);
      expect(config).toHaveProperty("serializers.req");
    }
  });
});

describe("request logging redaction (live app, captured log stream)", () => {
  const SECRET = "super-secret-token-value.abc.def";

  let app: FastifyInstance;
  let port: number;
  let lines: string[];

  beforeEach(async () => {
    // Env unset -> the /live upgrade is answered with a fast 4503 close, no
    // network. The request is still logged, which is what we're testing.
    vi.stubEnv("SUPABASE_URL", "");
    lines = [];
    app = buildApp({
      logger: {
        level: "info",
        // Capture pino's output instead of writing to stdout.
        stream: {
          write: (line: string) => {
            lines.push(line);
          },
        },
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it("never emits a ?token= value during a /live upgrade attempt", async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${String(port)}/live?token=${SECRET}`,
    );
    ws.on("error", () => undefined);
    await new Promise<void>((resolve) => {
      ws.once("close", () => {
        resolve();
      });
    });
    ws.terminate();

    const output = lines.join("");
    // The request WAS logged (otherwise this test proves nothing)...
    expect(output).toContain("/live?[redacted]");
    // ...but the token never appears in any line.
    expect(output).not.toContain(SECRET);
  });

  it("redacts query strings on plain HTTP routes too (global, not /live-only)", async () => {
    const response = await app.inject({ url: `/health?token=${SECRET}` });
    expect(response.statusCode).toBe(200);

    const output = lines.join("");
    expect(output).toContain("/health?[redacted]");
    expect(output).not.toContain(SECRET);
  });
});
