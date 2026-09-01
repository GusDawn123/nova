import { z } from "zod";
import {
  followUpDraftSchema,
  meetingListResponseSchema,
  meetingTranscriptResponseSchema,
  meResponseSchema,
  notesReadResponseSchema,
  regenerateResponseSchema,
  type FollowUpDraft,
  type FollowUpTone,
  type MeetingListResponse,
  type MeetingTranscriptResponse,
  type MeResponse,
  type NotesReadResponse,
  type RegenerateResponse,
} from "@nova/shared";

import type { ApiResult } from "./errors";

export type { ApiErrorKind, ApiResult } from "./errors";

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
  listMeetings(): Promise<ApiResult<MeetingListResponse>>;
  meetingNotes(meetingId: string): Promise<ApiResult<NotesReadResponse>>;
  meetingTranscript(
    meetingId: string,
  ): Promise<ApiResult<MeetingTranscriptResponse>>;
  regenerateNotes(meetingId: string): Promise<ApiResult<RegenerateResponse>>;
  followUpDraft(
    meetingId: string,
    tone: FollowUpTone,
  ): Promise<ApiResult<FollowUpDraft>>;
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

  interface RequestOptions {
    method?: "POST";
    body?: unknown;
    /**
     * Route-specific words for statuses the generic table would flatten into
     * "unexpected status" — a 409 on regenerate means "already running", and
     * that sentence belongs to the route that knows it.
     */
    statusMessages?: Readonly<Record<number, string>>;
  }

  async function request<T>(
    endpoint: string,
    // The third parameter stays `unknown`: a response schema may carry
    // `.default()` fields, whose INPUT type is looser than what they infer to.
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    options: RequestOptions = {},
  ): Promise<ApiResult<T>> {
    // Inside its own guard: `getAccessToken` reaches into supabase-js, which
    // refreshes an expired token over the network and rejects when that fails.
    // Left unguarded, that rejection would escape `ApiResult` entirely and
    // reject a promise every caller was told always resolves.
    let accessToken: string | null;
    try {
      accessToken = await deps.getAccessToken();
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        kind: "network",
        message: `Could not refresh your session (${reason}).`,
      };
    }

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
        method: options.method ?? "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(options.body === undefined
            ? {}
            : { "Content-Type": "application/json" }),
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const routeMessage = options.statusMessages?.[response.status];
        if (routeMessage !== undefined) {
          return { ok: false, kind: "server", message: routeMessage };
        }
        return httpFailure(response.status);
      }

      // A 200 whose body is not JSON means something answered that was not the
      // Nova server — a captive portal, a proxy error page. That is a transport
      // problem, not a contract one.
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        // The deadline covers the BODY too, not just the headers. A server that
        // answers 200 and then stalls mid-stream aborts the read, and calling
        // that "unreadable" would hide the fact that it was simply too slow.
        if (deadline.exceeded) {
          return {
            ok: false,
            kind: "timeout",
            message: "Nova took too long to respond.",
          };
        }
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
    listMeetings: () => request("/meetings", meetingListResponseSchema),
    meetingNotes: (meetingId) =>
      request(
        `/meetings/${encodeURIComponent(meetingId)}/notes`,
        notesReadResponseSchema,
      ),
    meetingTranscript: (meetingId) =>
      request(
        `/meetings/${encodeURIComponent(meetingId)}/transcript`,
        meetingTranscriptResponseSchema,
      ),
    regenerateNotes: (meetingId) =>
      request(
        `/meetings/${encodeURIComponent(meetingId)}/notes/regenerate`,
        regenerateResponseSchema,
        {
          method: "POST",
          statusMessages: {
            409: "Notes are already being regenerated for this meeting.",
            503: "Notes generation is not available right now.",
          },
        },
      ),
    followUpDraft: (meetingId, tone) =>
      request(
        `/meetings/${encodeURIComponent(meetingId)}/follow-up`,
        followUpDraftSchema,
        {
          method: "POST",
          body: { tone },
          statusMessages: {
            409: "Notes are not ready yet — the follow-up needs them first.",
            503: "Follow-up drafting is not available right now.",
          },
        },
      ),
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
