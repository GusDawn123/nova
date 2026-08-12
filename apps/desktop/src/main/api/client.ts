import { z } from "zod";
import { meResponseSchema, type MeResponse } from "@nova/shared";

/**
 * The Nova server client, and the only place in the desktop app that makes a
 * network call.
 *
 * It lives in the MAIN process for a concrete reason rather than a stylistic
 * one: the server's CORS allowlist (`apps/server/src/app.ts`) admits
 * `localhost`/`127.0.0.1` origins, a packaged renderer loads from `file://` and
 * sends `Origin: null`, and neither matches. The main process sends no `Origin`
 * header at all and is never subject to CORS — the position the native mobile
 * app already occupies.
 *
 * Its real job is not "call /me". It is to turn every way that call can fail
 * into something a person can act on, which is why the failure kinds are named
 * for what the user should DO rather than for what broke.
 */

/**
 *   signed-out    — no token to send. Never reached the network.
 *   unauthorized  — the server rejected the token (401). Sign in again.
 *   unavailable   — the server cannot serve this (503). Not the user's doing.
 *   timeout       — no answer inside the budget. Retrying is reasonable.
 *   network       — the request never landed, or the answer was not JSON.
 *   server        — some other non-2xx. Retrying rarely helps.
 *   schema        — a shape this build cannot read, i.e. the client is older
 *                   than the server.
 */
export const apiErrorKindSchema = z.enum([
  "signed-out",
  "unauthorized",
  "unavailable",
  "timeout",
  "network",
  "server",
  "schema",
]);
export type ApiErrorKind = z.infer<typeof apiErrorKindSchema>;

export type ApiResult<T> =
  { ok: true; data: T } | { ok: false; kind: ApiErrorKind; message: string };

/**
 * A schema failure reduced to what is safe to log. Paths and codes only: a
 * response body carries the user's own data, and a log line is the wrong place
 * for it.
 */
export interface SchemaIssue {
  path: string;
  code: string;
}

export interface ApiClientDeps {
  baseUrl: string;
  /** Injected so tests use the same door every caller does, not a global patch. */
  fetch: typeof globalThis.fetch;
  /**
   * A FUNCTION rather than a token, because an access token expires and the
   * auth layer refreshes it. Handing over a string once would work all
   * afternoon and fail overnight.
   */
  getAccessToken: () => Promise<string | null>;
  timeoutMs?: number;
  onSchemaIssue?: (endpoint: string, issues: SchemaIssue[]) => void;
}

export interface ApiClient {
  getMe(): Promise<ApiResult<MeResponse>>;
}

/** The mobile app settled on the same budget for its list fetches. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Fixed copy: a serialized ZodError is a diagnostic, not a sentence for a user. */
const SCHEMA_MESSAGE =
  "Nova sent something this version of the app could not read.";

export function createApiClient(deps: ApiClientDeps): ApiClient {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const onSchemaIssue =
    deps.onSchemaIssue ??
    ((endpoint: string, issues: SchemaIssue[]): void => {
      console.warn(
        `[api] ${endpoint} did not match the expected shape`,
        issues,
      );
    });
  const baseUrl = deps.baseUrl.replace(/\/+$/, "");

  async function request<T>(
    endpoint: string,
    schema: z.ZodType<T>,
  ): Promise<ApiResult<T>> {
    const accessToken = await deps.getAccessToken();
    if (accessToken === null) {
      return {
        ok: false,
        kind: "signed-out",
        message: "You are not signed in.",
      };
    }

    const controller = new AbortController();
    // Marked BEFORE the abort fires, so the catch below can tell a budget
    // overrun from any other abort. Without it, a cancelled request reports
    // itself to the user as a timeout — a lie about something they just did.
    //
    // An object rather than a bare `let`: TypeScript's control flow does not
    // follow an assignment made inside a callback, so a plain boolean stays
    // narrowed to `false` at the catch and the branch reads as dead code.
    const deadline = { exceeded: false };
    const timer = setTimeout(() => {
      deadline.exceeded = true;
      controller.abort();
    }, timeoutMs);

    try {
      const response = await deps.fetch(`${baseUrl}${endpoint}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      });

      if (!response.ok) {
        return httpFailure(response.status);
      }

      // A 200 whose body is not JSON means something answered that was not the
      // Nova server — a captive portal, a proxy error page. That is a transport
      // problem, not a contract one.
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return {
          ok: false,
          kind: "network",
          message: "Nova's reply could not be read.",
        };
      }

      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        onSchemaIssue(
          endpoint,
          parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            code: issue.code,
          })),
        );
        return { ok: false, kind: "schema", message: SCHEMA_MESSAGE };
      }

      return { ok: true, data: parsed.data };
    } catch (error: unknown) {
      if (deadline.exceeded) {
        return {
          ok: false,
          kind: "timeout",
          message: "Nova took too long to respond.",
        };
      }
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        kind: "network",
        message: `Could not reach Nova (${reason}).`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    getMe: () => request("/me", meResponseSchema),
  };
}

/**
 * 401 and 503 are the two `/me` states explicitly, and they mean opposite
 * things: one asks the user to sign in again, the other says the server itself
 * is not ready and this is not about them. Keeping them apart is the reason
 * this returns a kind instead of a status code.
 */
function httpFailure(status: number): ApiResult<never> {
  if (status === 401) {
    return {
      ok: false,
      kind: "unauthorized",
      message: "That session is no longer valid. Please sign in again.",
    };
  }
  if (status === 503) {
    return {
      ok: false,
      kind: "unavailable",
      message: "Nova is not available right now.",
    };
  }
  return {
    ok: false,
    kind: "server",
    message: `Nova responded with an unexpected status (${String(status)}).`,
  };
}
