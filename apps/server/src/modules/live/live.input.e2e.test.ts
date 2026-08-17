import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { ServerLiveEvent } from "@nova/shared";

import { buildApp } from "../../app.js";

/**
 * Minimal hand-written `Database` (house pattern of the sibling DB suites) so
 * `.from(...)` stays type-safe under strict-type-checked eslint. MUST be `type`
 * aliases, not `interface`s (supabase-js's `GenericTable` constraint).
 */
type MeetingRow = {
  id: string;
  user_id: string;
  title: string;
};
type TranscriptRow = {
  id: string;
  meeting_id: string;
  user_id: string;
  content: string;
  speaker: string | null;
};
type Database = {
  public: {
    Tables: {
      meetings: {
        Row: MeetingRow;
        Insert: { user_id: string; title: string };
        Update: Partial<MeetingRow>;
        Relationships: [];
      };
      transcripts: {
        Row: TranscriptRow;
        Insert: { meeting_id: string; user_id: string; content: string };
        Update: Partial<TranscriptRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

/**
 * KEY + DB-GATED end-to-end proof of the typed-input path (Phase 7 follow-up,
 * decision 2026-07-22): a REAL authed WebSocket against the REAL app — real
 * Supabase JWT, real session gates, real conductor, real live-tier router
 * (OpenAI + Google keys; anthropic stays disabled) — sends `transcript.input`
 * with a question and asserts the REAL streamed answer under the manual
 * posture (2026-08-17, no auto-response — the utterance alone fires nothing;
 * the Answer key is what spends):
 *   transcript.input → transcript.final echo (speaker "them") →
 *   suggest.now → suggestion.start → suggestion.delta+ → suggestion.done.
 * This is exactly what the pill's typed-utterance + Answer-key flow drives.
 * Runs ONLY with the local stack + an LLM key (`describe.skipIf`); keyless CI
 * skips cleanly.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const stackUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const hasLlm = Boolean(
  process.env.OPENAI_API_KEY || process.env.GOOGLE_API_KEY,
);
const canRun = Boolean(stackUrl && serviceRoleKey && anonKey && hasLlm);

const noPersist = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

const QUESTION = "Can you explain what Kubernetes is used for?";
/** ANY-of rubric — the streamed answer must reference the topic. */
const KEYWORDS = ["kubernetes", "container", "orchestrat", "cluster", "pod"];

describe.skipIf(!canRun)(
  "live typed-input e2e (real socket + real LLM)",
  () => {
    let app: FastifyInstance;
    let wsUrl: string;
    let admin: SupabaseClient<Database>;
    let userId = "";
    let token = "";
    let meetingId = "";

    beforeAll(async () => {
      if (!stackUrl || !serviceRoleKey || !anonKey) {
        throw new Error("stack env missing");
      }
      admin = createClient<Database>(stackUrl, serviceRoleKey, noPersist);

      const email = `live-input-${randomUUID()}@nova.test`;
      const password = `Pw-${randomUUID()}`;
      const created = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (created.error) throw new Error(created.error.message);
      userId = created.data.user.id;

      const anon = createClient(stackUrl, anonKey, noPersist);
      const signIn = await anon.auth.signInWithPassword({ email, password });
      if (signIn.error) throw new Error(signIn.error.message);
      token = signIn.data.session.access_token;

      const meeting = await admin
        .from("meetings")
        .insert({ user_id: userId, title: "typed-input e2e" })
        .select("id")
        .single();
      if (meeting.error) throw new Error(meeting.error.message);
      meetingId = meeting.data.id;

      app = buildApp({ logger: false });
      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address() as AddressInfo;
      wsUrl = `ws://127.0.0.1:${String(address.port)}/live`;
    });

    afterAll(async () => {
      await app.close();
      if (userId !== "") {
        await admin.from("transcripts").delete().eq("user_id", userId);
        await admin.from("meetings").delete().eq("user_id", userId);
        await admin.auth.admin.deleteUser(userId);
      }
    });

    it("[typed-e2e] a typed question streams a real suggestion over the socket", async () => {
      const events: ServerLiveEvent[] = [];
      const ws = new WebSocket(wsUrl, {
        headers: { authorization: `Bearer ${token}` },
      });
      ws.on("error", () => undefined);

      const result = await new Promise<{
        answer: string;
        deltas: number;
        echoed: boolean;
      }>((resolve, reject) => {
        let deltas = 0;
        let echoed = false;
        const timeout = setTimeout(() => {
          reject(
            new Error(`timed out; events so far: ${JSON.stringify(events)}`),
          );
        }, 90_000);

        ws.on("open", () => {
          ws.send(
            JSON.stringify({
              v: 1,
              type: "session.start",
              meeting_id: meetingId,
            }),
          );
        });
        ws.on("message", (data: Buffer) => {
          const event = JSON.parse(data.toString("utf8")) as ServerLiveEvent;
          events.push(event);
          if (event.type === "session.ready") {
            ws.send(
              JSON.stringify({
                v: 1,
                type: "transcript.input",
                text: QUESTION,
              }),
            );
          }
          if (event.type === "transcript.final" && event.text === QUESTION) {
            echoed = event.speaker === "them";
            // The utterance fires nothing on its own now — press Answer.
            ws.send(JSON.stringify({ v: 1, type: "suggest.now" }));
          }
          if (event.type === "suggestion.delta") {
            deltas += 1;
          }
          if (event.type === "suggestion.done") {
            clearTimeout(timeout);
            resolve({ answer: event.text, deltas, echoed });
          }
          if (event.type === "error") {
            clearTimeout(timeout);
            reject(new Error(`typed error: ${event.code} ${event.message}`));
          }
        });
      }).finally(() => {
        ws.terminate();
      });

      console.log(
        `[typed-e2e] deltas=${String(result.deltas)} answer_len=${String(
          result.answer.length,
        )} echoed_as_them=${String(result.echoed)} answer="${result.answer.slice(0, 160)}"`,
      );

      expect(result.echoed).toBe(true); // the typed input came back as a "them" final
      expect(result.deltas).toBeGreaterThan(0); // streamed, not buffered-until-done
      expect(result.answer.length).toBeGreaterThan(0);
      const lower = result.answer.toLowerCase();
      expect(KEYWORDS.some((k) => lower.includes(k))).toBe(true);

      // The typed utterance persisted like any final transcript row.
      const rows = await admin
        .from("transcripts")
        .select("content, speaker")
        .eq("meeting_id", meetingId);
      expect(rows.error).toBeNull();
      const persisted = rows.data ?? [];
      expect(
        persisted.some((r) => r.content === QUESTION && r.speaker === "them"),
      ).toBe(true);
    });
  },
);
