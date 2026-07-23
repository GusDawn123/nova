import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ServerLiveEvent } from "@nova/shared";

import {
  createLlmRouter,
  createProvidersFromEnv,
  liveLlmConfig,
  type LlmProviderEnv,
} from "../llm/index.js";
import { createPgPool, createPgVectorStore } from "../rag/adapters/pgvector.js";
import { voyageAdapterFromEnv } from "../rag/adapters/voyage.js";
import { chunker } from "../rag/chunker.js";
import { ragConfig } from "../rag/config.js";
import { createRagService, type RagService } from "../rag/index.js";

import { conductorConfigSchema } from "./conductor-config.js";
import { createLiveConductor } from "./conductor.js";

/**
 * KEY + DB-GATED live GROUNDING gate (playbook Phase 7 VERIFY). A distinctive fact
 * about the user's own history is ingested into RAG memory through the REAL Voyage
 * embedder + REAL pgvector store; a question about it is then driven through the
 * REAL conductor (RAG live-tier grounding → prompt → REAL live router). The
 * streamed suggestion must contain the stored fact — proof the copilot answers
 * from the user's memory, not just general knowledge.
 *
 * Runs ONLY with a Voyage key + the local Supabase stack + an LLM key
 * (`describe.skipIf`) — same convention as the Phase 4 rag accuracy gate; keyless
 * CI/local runs skip cleanly. ANTHROPIC IS DISABLED — cascade runs OpenAI+Google.
 */

vi.setConfig({ testTimeout: 180_000, hookTimeout: 600_000 });

const voyageKey = process.env.VOYAGE_API_KEY;
const dbUrl = process.env.SUPABASE_DB_URL;
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const hasLlm = Boolean(process.env.OPENAI_API_KEY || process.env.GOOGLE_API_KEY);
const canRun = Boolean(voyageKey && dbUrl && url && serviceRoleKey && hasLlm);

const noPersist = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

/** A very specific figure the LLM could NOT produce without the memory snippet. */
const QUOTE_FACT = "$47,500";
const QUOTE_DIGITS = "47500";

function providerEnv(): LlmProviderEnv {
  const env: LlmProviderEnv = {};
  if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (process.env.GOOGLE_API_KEY) env.GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  if (process.env.GROQ_API_KEY) env.GROQ_API_KEY = process.env.GROQ_API_KEY;
  return env;
}

function runQuestion(
  router: ReturnType<typeof createLlmRouter>,
  rag: RagService,
  userId: string,
  question: string,
): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve(text);
    };
    const conductor = createLiveConductor({
      send: (e: ServerLiveEvent) => {
        if (e.type === "suggestion.delta") text += e.text;
        if (e.type === "suggestion.done" || e.type === "suggestion.discard") done();
      },
      router,
      rag,
      userId,
      config: conductorConfigSchema.parse({
        speculationEnabled: false,
        firstTokenDeadlineMs: 30_000,
        ragDeadlineMs: 5_000, // real Voyage query-embed budget for the gate
      }),
    });
    conductor.onFinal(question, "them");
    setTimeout(done, 60_000);
  });
}

describe.skipIf(!canRun)("modules/live [grounding] live RAG grounding", () => {
  let pool: Pool;
  let rag: RagService;
  let admin: ReturnType<typeof createClient>;
  let userId = "";

  beforeAll(async () => {
    if (!url || !serviceRoleKey) throw new Error("stack env missing");
    pool = createPgPool(process.env);
    const store = createPgVectorStore({ pool, config: ragConfig });
    const { embedder, reranker } = voyageAdapterFromEnv(process.env, ragConfig);
    rag = createRagService({ chunker, embedder, store, reranker, config: ragConfig });
    admin = createClient(url, serviceRoleKey, noPersist);

    const res = await admin.auth.admin.createUser({
      email: `live-ground-${randomUUID()}@nova.test`,
      password: `Pw-${randomUUID()}`,
      email_confirm: true,
    });
    if (res.error) throw new Error(`createUser: ${res.error.message}`);
    userId = res.data.user.id;

    const content = `Acme Corp deal notes. Last quarter we quoted Acme Corp exactly ${QUOTE_FACT} for the Enterprise tier, a 12-month contract with quarterly billing. The champion was their VP of Engineering.`;
    const inserted = await pool.query<{ id: string }>(
      "insert into context_docs (user_id, title, content) values ($1,$2,$3) returning id",
      [userId, "Acme Corp deal notes", content],
    );
    const contextDocId = inserted.rows[0]?.id ?? "";
    expect(contextDocId).not.toBe("");
    await rag.ingest(userId, {
      kind: "context_doc",
      contextDocId,
      title: "Acme Corp deal notes",
      content,
    });
  });

  afterAll(async () => {
    if (userId !== "") {
      await pool.query("delete from embeddings where user_id = $1", [userId]);
      await pool.query("delete from chunks where user_id = $1", [userId]);
      await pool.query("delete from context_docs where user_id = $1", [userId]);
      await admin.auth.admin.deleteUser(userId);
    }
    await pool.end();
  });

  it("[grounding] the suggestion contains the user's stored quote fact", async () => {
    const providers = createProvidersFromEnv(providerEnv());
    const router = createLlmRouter({ providers, config: liveLlmConfig() });

    const suggestion = await runQuestion(
      router,
      rag,
      userId,
      "Remind me, what did we quote Acme Corp for the Enterprise tier last time?",
    );
    const normalized = suggestion.replace(/[\s,$\\]/g, "").toLowerCase();
    console.log(
      `[grounding] fact=${QUOTE_FACT} present=${String(
        normalized.includes(QUOTE_DIGITS),
      )} suggestion="${suggestion.slice(0, 200)}"`,
    );
    expect(normalized).toContain(QUOTE_DIGITS);
  });
});
