import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { chunker } from "./chunker.js";
import { ragConfig } from "./config.js";
import { createRagService, type RagService } from "./index.js";
import { createPgPool, createPgVectorStore } from "./adapters/pgvector.js";
import { voyageAdapterFromEnv } from "./adapters/voyage.js";

/**
 * KEY + DB-GATED RAG accuracy gate — the Phase 4 exit bar (playbook VERIFY). It
 * ingests the committed 20-doc fixture corpus for user A through the REAL Voyage
 * embedder + REAL pgvector store, then proves the playbook's three hard bars:
 *   1. top-3 retrieval — "what pricing did we offer Acme?" (deliberate tier) puts a
 *      snippet from the `acme-pricing` doc in the TOP-3 by source id;
 *   2. tenant isolation — the SAME query for user B returns ZERO snippets;
 *   3. embedding versioning — every stored embedding row has a non-empty `model`
 *      text and `dims === 1024` (adr-0005 §2).
 * It also runs the query at the `live` tier and PRINTS its top-3 as a soft report
 * line (reported honestly; the hard top-3 bar is on deliberate).
 *
 * Runs ONLY with BOTH a Voyage key AND the local Supabase stack up (`describe.skipIf`),
 * so CI and keyless local runs skip it cleanly while the mock suite carries
 * correctness. Every bar prints its measured value so the run can be quoted verbatim.
 */

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fixtures",
  "rag",
  "context-docs.json",
);

const voyageKey = process.env.VOYAGE_API_KEY;
const dbUrl = process.env.SUPABASE_DB_URL;
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const canRun = Boolean(voyageKey && dbUrl && url && serviceRoleKey);

const ACME_DOC = "acme-pricing";
const QUERY = "what pricing did we offer Acme?";
const EMBED_DIMS = 1024;

const fixtureSchema = z.array(
  z.object({ id: z.string(), title: z.string(), content: z.string() }),
);
type FixtureDoc = z.infer<typeof fixtureSchema>[number];

function loadFixtures(): FixtureDoc[] {
  const raw: unknown = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  return fixtureSchema.parse(raw);
}

const noPersist = { auth: { persistSession: false, autoRefreshToken: false } } as const;

// ---------------------------------------------------------------------------
// Fixture guard — ALWAYS ON. The accuracy suite below is key-gated (skips on CI),
// so a broken fixture path would fail silently there; this cheap check runs
// everywhere and fails loudly if the corpus moves, shrinks, or the target drifts.
// ---------------------------------------------------------------------------

describe("rag accuracy fixtures — existence guard", () => {
  it("resolves 20 fixture docs including the acme-pricing target fact", () => {
    const docs = loadFixtures();
    expect(docs).toHaveLength(20);
    const acme = docs.find((d) => d.id === ACME_DOC);
    expect(acme, "missing acme-pricing fixture").toBeDefined();
    expect(acme?.content).toContain("$4,200 per month for the Growth plan");
    // Distractors the gate depends on must be present.
    for (const id of ["globex-pricing", "initech-pricing", "acme-hiring"]) {
      expect(docs.some((d) => d.id === id), `missing distractor: ${id}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The gate (key + DB gated).
// ---------------------------------------------------------------------------

describe.skipIf(!canRun)("rag accuracy gate (voyage + local stack)", () => {
  let pool: Pool;
  let service: RagService;
  let admin: ReturnType<typeof createClient>;
  let userA: string;
  let userB: string;
  const userIds: string[] = [];
  /** fixture slug → the context_doc uuid it was ingested under (for user A). */
  const docIdBySlug = new Map<string, string>();

  beforeAll(async () => {
    if (!dbUrl || !url || !serviceRoleKey) throw new Error("stack env missing");
    pool = createPgPool(process.env);
    const store = createPgVectorStore({ pool, config: ragConfig });
    const { embedder, reranker } = voyageAdapterFromEnv(process.env, ragConfig);
    service = createRagService({ chunker, embedder, store, reranker, config: ragConfig });
    admin = createClient(url, serviceRoleKey, noPersist);

    const mkUser = async (label: string): Promise<string> => {
      const res = await admin.auth.admin.createUser({
        email: `rag-acc-${label}-${randomUUID()}@nova.test`,
        password: `Pw-${randomUUID()}`,
        email_confirm: true,
      });
      if (res.error) throw new Error(`createUser(${label}): ${res.error.message}`);
      const id = res.data.user.id;
      userIds.push(id);
      return id;
    };
    userA = await mkUser("a");
    userB = await mkUser("b");

    // Ingest all 20 fixture docs for user A. Each doc gets a real context_doc row
    // (chunks FK to it); ingest runs the real chunk → embed → store pipeline.
    for (const doc of loadFixtures()) {
      const inserted = await pool.query<{ id: string }>(
        "insert into context_docs (user_id, title, content) values ($1, $2, $3) returning id",
        [userA, doc.title, doc.content],
      );
      const contextDocId = inserted.rows[0]?.id ?? "";
      expect(contextDocId).not.toBe("");
      docIdBySlug.set(doc.id, contextDocId);
      await service.ingest(userA, {
        kind: "context_doc",
        contextDocId,
        title: doc.title,
        content: doc.content,
      });
    }
  }, 120_000);

  afterAll(async () => {
    for (const id of userIds) {
      await pool.query("delete from embeddings where user_id = $1", [id]);
      await pool.query("delete from chunks where user_id = $1", [id]);
      await pool.query("delete from context_docs where user_id = $1", [id]);
      await admin.auth.admin.deleteUser(id);
    }
    await pool.end();
  });

  it("[top-3] deliberate query surfaces acme-pricing in the top 3 by source id", async () => {
    const acmeDocId = docIdBySlug.get(ACME_DOC);
    expect(acmeDocId).toBeDefined();

    const { snippets } = await service.query(userA, QUERY, { tier: "deliberate" });
    const top3 = snippets.slice(0, 3).map((s) => s.contextDocId);
    console.log(
      `[rag deliberate] returned=${String(snippets.length)} ` +
        `top3_doc_ids=[${top3.map((d) => d ?? "null").join(", ")}] ` +
        `acme_doc_id=${acmeDocId ?? "?"}`,
    );

    expect(top3).toContain(acmeDocId);
  }, 60_000);

  it("[isolation] the same query for user B returns zero snippets", async () => {
    const { snippets } = await service.query(userB, QUERY, { tier: "deliberate" });
    console.log(`[rag isolation] userB_returned=${String(snippets.length)}`);
    expect(snippets).toHaveLength(0);
  }, 60_000);

  it("[versioning] every stored embedding row has a model text and dims === 1024", async () => {
    const rows = await pool.query<{ model: string; dims: number }>(
      "select model, dims from embeddings where user_id = $1 and deleted_at is null",
      [userA],
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const row of rows.rows) {
      expect(typeof row.model).toBe("string");
      expect(row.model.length).toBeGreaterThan(0);
      expect(row.dims).toBe(EMBED_DIMS);
    }
    console.log(
      `[rag versioning] embedding_rows=${String(rows.rows.length)} ` +
        `model=${rows.rows[0]?.model ?? "?"} dims=${String(rows.rows[0]?.dims ?? "?")}`,
    );
  }, 60_000);

  it("[soft/live] reports the live-tier top-3 (no hard bar — live never reranks)", async () => {
    const acmeDocId = docIdBySlug.get(ACME_DOC);
    const { snippets } = await service.query(userA, QUERY, { tier: "live" });
    const top3 = snippets.slice(0, 3).map((s) => s.contextDocId);
    const acmeInTop3 = top3.includes(acmeDocId ?? "");
    console.log(
      `[rag live] returned=${String(snippets.length)} ` +
        `top3_doc_ids=[${top3.map((d) => d ?? "null").join(", ")}] ` +
        `acme_in_top3=${String(acmeInTop3)}`,
    );
    // Soft: assert only that live retrieval runs and returns something; the hard
    // top-3 bar lives on the deliberate tier.
    expect(snippets.length).toBeGreaterThan(0);
  }, 60_000);
});
