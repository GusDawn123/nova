import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RoleReader } from "../db/roles.js";

import { createRequireRole } from "./role.js";

/**
 * `requireRole` unit proof over a fake reader (adr-0008): allowed role passes,
 * disallowed → 403, reader throw → 403 fail CLOSED, no reader → 503,
 * missing request.user (requireAuth not composed) → 401.
 */

const USER_ID = "33333333-3333-4333-8333-333333333333";

function fakeReader(
  result: "developer" | "admin" | "customer" | Error,
): RoleReader {
  return {
    getRole: () =>
      result instanceof Error
        ? Promise.reject(result)
        : Promise.resolve(result),
  };
}

function buildApp(reader: RoleReader | undefined, withUser = true) {
  const app = Fastify({ logger: false });
  const requireRole = createRequireRole(reader);
  app.get(
    "/admin-only",
    {
      preHandler: [
        // A stand-in for requireAuth: decorate request.user (or don't).
        (request, _reply, done) => {
          if (withUser) request.user = { id: USER_ID };
          done();
        },
        requireRole(["developer", "admin"]),
      ],
    },
    () => ({ ok: true }),
  );
  return app;
}

describe("plugins/role requireRole", () => {
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    app = buildApp(fakeReader("developer"));
  });
  afterEach(async () => {
    await app.close();
  });

  it("[role] an allowed role reaches the handler", async () => {
    const res = await app.inject({ method: "GET", url: "/admin-only" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("[role] a disallowed role is refused with a typed 403", async () => {
    const customer = buildApp(fakeReader("customer"));
    const res = await customer.inject({ method: "GET", url: "/admin-only" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden" });
    await customer.close();
  });

  it("[role] a reader failure fails CLOSED (403, never through)", async () => {
    const broken = buildApp(fakeReader(new Error("db down")));
    const res = await broken.inject({ method: "GET", url: "/admin-only" });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "forbidden" });
    await broken.close();
  });

  it("[role] no reader wired (DB-less boot) → 503 unavailable", async () => {
    const dbless = buildApp(undefined);
    const res = await dbless.inject({ method: "GET", url: "/admin-only" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "unavailable" });
    await dbless.close();
  });

  it("[role] missing request.user (requireAuth not composed) → 401", async () => {
    const bare = buildApp(fakeReader("developer"), false);
    const res = await bare.inject({ method: "GET", url: "/admin-only" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
    await bare.close();
  });
});
