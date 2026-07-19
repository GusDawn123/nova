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

/**
 * Sign an ES256 token like Supabase would: `aud: "authenticated"` + `exp` by
 * default, both overridable so the negative tests can strip/spoof them
 * (`expiresIn: null` omits exp entirely; `audience: null` omits aud).
 */
async function signToken(
  claims: Record<string, unknown>,
  {
    expiresIn = "1h",
    audience = "authenticated",
    key = privateKey,
  }: {
    expiresIn?: string | null;
    audience?: string | null;
    key?: KeyLike;
  } = {},
): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256" })
    .setIssuedAt();
  if (audience !== null) jwt.setAudience(audience);
  if (expiresIn !== null) jwt.setExpirationTime(expiresIn);
  return jwt.sign(key);
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

  it("rejects a token with the wrong audience", async () => {
    const token = await signToken({ sub: randomUUID() }, { audience: "anon" });

    const result = await verifyAccessToken(token, getKey);

    expect(result).toEqual({ valid: false, reason: "invalid-payload" });
  });

  it("rejects a token with no audience at all", async () => {
    const token = await signToken({ sub: randomUUID() }, { audience: null });

    const result = await verifyAccessToken(token, getKey);

    expect(result).toEqual({ valid: false, reason: "invalid-payload" });
  });

  it("rejects a signature-valid token that has no exp claim", async () => {
    const token = await signToken({ sub: randomUUID() }, { expiresIn: null });

    const result = await verifyAccessToken(token, getKey);

    expect(result).toEqual({ valid: false, reason: "invalid-payload" });
  });

  it("rejects a non-ES256 token (alg-confusion: HS256 with a shared secret)", async () => {
    // An attacker who knows any shared string (or even the JWKS contents)
    // must not be able to downgrade to a symmetric alg. The ES256 pin makes
    // jose refuse the header before any key is ever consulted.
    const secret = new TextEncoder().encode(
      "attacker-chosen-secret-32-characters-yy",
    );
    const token = await new SignJWT({ sub: randomUUID() })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setAudience("authenticated")
      .setExpirationTime("1h")
      .sign(secret);

    const result = await verifyAccessToken(token, getKey);

    expect(result).toEqual({ valid: false, reason: "malformed" });
  });

  it("rejects garbage that is not a JWT", async () => {
    const result = await verifyAccessToken("not.a.jwt", getKey);

    expect(result).toEqual({ valid: false, reason: "malformed" });
  });
});
