import { randomUUID } from "node:crypto";

import {
  generateKeyPair,
  SignJWT,
  type JWTVerifyGetKey,
  type KeyLike,
} from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyAccessToken } from "./verify-token.js";

/**
 * Pure verifier tests. Supabase signs user tokens with ES256, so we mint a real
 * ES256 keypair, sign fixtures with the private key, and hand the verifier a
 * resolver that returns the public key — no network, no stack.
 */

let privateKey: KeyLike;
let publicKey: KeyLike;
let wrongPublicKey: KeyLike;
/** Resolver the verifier consumes (same shape a JWKS produces). */
let getKey: JWTVerifyGetKey;

beforeAll(async () => {
  ({ privateKey, publicKey } = await generateKeyPair("ES256"));
  ({ publicKey: wrongPublicKey } = await generateKeyPair("ES256"));
  getKey = () => Promise.resolve(publicKey);
});

/** Sign an ES256 token like Supabase would, with overridable claims/expiry. */
async function signToken(
  claims: Record<string, unknown>,
  {
    expiresIn = "1h",
    key = privateKey,
  }: { expiresIn?: string; key?: KeyLike } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

describe("verifyAccessToken", () => {
  it("accepts a well-formed token and returns the user id + email", async () => {
    const sub = randomUUID();
    const token = await signToken({ sub, email: "user@nova.test" });

    const result = await verifyAccessToken(token, getKey);

    expect(result).toEqual({
      valid: true,
      user: { id: sub, email: "user@nova.test" },
    });
  });

  it("accepts a token with no email (email omitted, not undefined)", async () => {
    const sub = randomUUID();
    const token = await signToken({ sub });

    const result = await verifyAccessToken(token, getKey);

    expect(result).toEqual({ valid: true, user: { id: sub } });
  });

  it("rejects an expired token", async () => {
    const token = await signToken({ sub: randomUUID() }, { expiresIn: "-1h" });

    const result = await verifyAccessToken(token, getKey);

    expect(result).toEqual({ valid: false, reason: "expired" });
  });

  it("rejects a token signed with the wrong key", async () => {
    const token = await signToken({ sub: randomUUID() });

    const result = await verifyAccessToken(token, () =>
      Promise.resolve(wrongPublicKey),
    );

    expect(result).toEqual({ valid: false, reason: "invalid-signature" });
  });

  it("rejects a token whose payload is missing sub", async () => {
    const token = await signToken({ email: "no-sub@nova.test" });

    const result = await verifyAccessToken(token, getKey);

    expect(result).toEqual({ valid: false, reason: "invalid-payload" });
  });

  it("rejects a token whose sub is not a uuid", async () => {
    const token = await signToken({ sub: "not-a-uuid" });

    const result = await verifyAccessToken(token, getKey);

    expect(result).toEqual({ valid: false, reason: "invalid-payload" });
  });

  it("rejects garbage that is not a JWT", async () => {
    const result = await verifyAccessToken("not.a.jwt", getKey);

    expect(result).toEqual({ valid: false, reason: "malformed" });
  });
});
