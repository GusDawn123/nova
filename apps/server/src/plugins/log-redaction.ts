import type { FastifyRequest, FastifyServerOptions } from "fastify";

/**
 * Request-log redaction, enforced globally in `buildApp`.
 *
 * WHY: the live socket (`GET /live`) accepts `?token=` as an auth fallback for
 * React Native WS clients, and pino's DEFAULT req serializer logs `req.url`
 * INCLUDING the query string — so without this, every `/live?token=<JWT>`
 * upgrade would write a Supabase access token to info-level logs (RULES: never
 * log secrets). The ENTIRE query string is stripped, not just the token param:
 * masking one known key invites the next query-borne secret to leak silently.
 */

/** `/live?token=eyJ...` → `/live?[redacted]`; a url with no query is unchanged. */
export function redactUrl(url: string): string {
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : `${url.slice(0, queryStart)}?[redacted]`;
}

/**
 * Replacement for pino/Fastify's default `req` serializer: same fields, but the
 * logged url never carries a query string.
 */
export function serializeRequest(request: FastifyRequest): {
  method: string;
  url: string;
  hostname: string;
  remoteAddress: string;
  remotePort?: number;
} {
  const { remotePort } = request.socket;
  return {
    method: request.method,
    url: redactUrl(request.url),
    hostname: request.hostname,
    remoteAddress: request.ip,
    ...(remotePort === undefined ? {} : { remotePort }),
  };
}

/**
 * Wrap a `buildApp` logger option so the redacting req serializer is ALWAYS
 * installed (and always wins over any caller-supplied one). `false` stays
 * `false` (tests); `true`/undefined becomes a config carrying the serializer.
 */
export function withLogRedaction(
  logger: FastifyServerOptions["logger"] | undefined,
): Exclude<FastifyServerOptions["logger"], undefined> {
  const base = logger ?? true;
  if (base === false) return false;
  const config = base === true ? {} : base;
  return {
    ...config,
    serializers: { ...config.serializers, req: serializeRequest },
  };
}
