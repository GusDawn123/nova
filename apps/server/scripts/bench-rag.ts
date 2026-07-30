/**
 * RAG store latency benchmark — the last Phase 4 playbook exit bar (VERIFY).
 *
 * Measures the wall-clock latency of `VectorStore.search` (the hybrid RRF hot
 * path, adr-0005 §5) against the LIVE local Supabase Postgres at a realistic
 * corpus size, and asserts the playbook bar `p95 < 300ms` — the STORE-level
 * budget only. Query-embed latency is vendor-side (Voyage) and is reported
 * separately by the key-gated live smoke; this bench deliberately needs NO
 * vendor key: every vector is a deterministic seeded pseudo-random unit vector,
 * so the numbers are reproducible on any machine with the stack up.
 *
 * DB-REQUIRED. Reads SUPABASE_DB_URL (the pool the adapter uses) plus
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (to mint the bench users through the
 * admin API, exactly as the integration suites do — chunks.user_id FKs
 * profiles(id), auto-created on auth.users insert). If the stack is down it
 * prints a clear message and exits non-zero (a benchmark that cannot run is not
 * a pass).
 *
 * Shape: seed 10,000 chunks for bench user A + 30,000 noise chunks spread over
 * 3 other users (so A's filtered-ANN scan is a small slice of a big global
 * table — the production tenancy shape), run 100 hybrid searches (50
 * vector+text, 50 vector-only) with pre-computed query vectors, print
 * p50/p95/max + corpus size + PASS/FAIL, then HARD-DELETE its own seeded rows
 * and users. The hard delete is the deliberate exception RULES §3 reserves for
 * scripts/ purge-style tooling: this is a benchmark purging ONLY the derived
 * data it just created for its own throwaway users (spirit of scripts/purge),
 * never product data.
 *
 * Run: `npm run bench:rag --workspace apps/server` (with the stack up).
 */
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";

import {
  createPgPool,
  createPgVectorStore,
} from "../src/modules/rag/adapters/pgvector.js";
import { ragConfig } from "../src/modules/rag/config.js";
import type { EmbeddedChunk, VectorStore } from "../src/modules/rag/ports.js";

// ---------------------------------------------------------------------------
// Bench parameters (the mandated corpus — never shrink these to pass a bar).
// ---------------------------------------------------------------------------

const DIMS = 1024;
/** The embedding-space id every seeded row + query filters on (adr-0005 §2). */
const MODEL = "bench-voyage-4-1024";

const BENCH_CHUNKS = 10_000; // user A — the tenant we search.
const NOISE_USERS = 3;
const NOISE_CHUNKS_EACH = 10_000; // 3 × 10k = 30k noise across other tenants.
/** Rows per replaceSource call — bounded well under Postgres' 65535 bind-param
 * ceiling (1000 × 7 chunk cols = 7000) and a sane statement size for 1024-dim
 * literals. Each call is its own source (context_doc) so batches accumulate
 * instead of soft-deleting one another. */
const BATCH = 1000;

const QUERIES = 100;
const HYBRID_QUERIES = 50; // the rest are vector-only (empty text).
const WARMUP = 5; // primes pool connections + OS/page cache before timing.
/** Live tier k — the latency-sensitive hot path the p95 bar governs. */
const K = ragConfig.kLive;

/** Playbook exit bar: store-level p95 must stay under this. NEVER weakened. */
const BAR_MS = 300;

/** Retrieval knobs the adapter reads — the process defaults, untuned. */
const STORE_CONFIG = {
  candidatesPerLeg: ragConfig.candidatesPerLeg,
  rrfK: ragConfig.rrfK,
};

// ---------------------------------------------------------------------------
// Deterministic seeded RNG + realistic content.
// ---------------------------------------------------------------------------

/** mulberry32 — a tiny, fast, deterministic PRNG (same seed → same stream). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One standard-normal sample (Box–Muller) from a [0,1) source. */
function gaussian(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * A pseudo-random UNIT vector of {@link DIMS} dimensions: Gaussian components
 * (uniform direction on the sphere) normalized to length 1, rounded to 6 dp to
 * keep the halfvec literal compact. Cosine-ready.
 */
function unitVector(rand: () => number): number[] {
  const v = new Array<number>(DIMS);
  let sumSq = 0;
  for (let i = 0; i < DIMS; i++) {
    const g = gaussian(rand);
    v[i] = g;
    sumSq += g * g;
  }
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < DIMS; i++) {
    v[i] = Math.round(((v[i] ?? 0) / norm) * 1e6) / 1e6;
  }
  return v;
}

/** A small business/sales vocabulary so the full-text leg matches real tokens. */
const VOCAB = [
  "pricing",
  "renewal",
  "discount",
  "contract",
  "quota",
  "onboarding",
  "invoice",
  "migration",
  "rollout",
  "roadmap",
  "integration",
  "support",
  "enterprise",
  "seat",
  "tier",
  "budget",
  "procurement",
  "stakeholder",
  "timeline",
  "proposal",
  "demo",
  "pilot",
  "expansion",
  "churn",
  "retention",
  "escalation",
  "compliance",
  "security",
  "latency",
  "throughput",
  "dashboard",
  "analytics",
  "forecast",
  "pipeline",
  "deployment",
  "sla",
] as const;

/** A realistic ~12-word content line drawn deterministically from the vocab. */
function content(rand: () => number): string {
  const n = 8 + Math.floor(rand() * 8); // 8–15 words.
  const words: string[] = [];
  for (let i = 0; i < n; i++) {
    words.push(VOCAB[Math.floor(rand() * VOCAB.length)] ?? "pricing");
  }
  return words.join(" ");
}

/** Build `count` embedded chunks from a seeded stream (content + unit vector). */
function makeChunks(
  rand: () => number,
  count: number,
  docLabel: string,
): EmbeddedChunk[] {
  const chunks: EmbeddedChunk[] = [];
  for (let i = 0; i < count; i++) {
    const text = content(rand);
    chunks.push({
      content: text,
      header: `Doc: ${docLabel}`,
      chunkIndex: i,
      tokenCount: text.split(" ").length + 2,
      embedding: unitVector(rand),
      model: MODEL,
      dims: DIMS,
    });
  }
  return chunks;
}

/** Nearest-rank percentile (p in [0,100]) over an ascending-sorted array. */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx] ?? 0;
}

// ---------------------------------------------------------------------------
// Env gate.
// ---------------------------------------------------------------------------

interface StackEnv {
  dbUrl: string;
  url: string;
  serviceRoleKey: string;
}

function readStackEnv(): StackEnv | null {
  const dbUrl = process.env.SUPABASE_DB_URL;
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!dbUrl || !url || !serviceRoleKey) return null;
  return { dbUrl, url, serviceRoleKey };
}

const noPersist = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

// ---------------------------------------------------------------------------
// Seed one user's corpus through the pgvector adapter, in accumulating batches.
// ---------------------------------------------------------------------------

async function seedUser(
  store: VectorStore,
  pool: Pool,
  userId: string,
  total: number,
  rand: () => number,
): Promise<void> {
  let done = 0;
  let docIx = 0;
  while (done < total) {
    const n = Math.min(BATCH, total - done);
    // A fresh context_doc per batch: replaceSource wipes-then-inserts a source,
    // so distinct sources let batches accumulate rather than overwrite.
    const doc = await pool.query<{ id: string }>(
      "insert into context_docs (user_id, title, content) values ($1, $2, $3) returning id",
      [userId, `Bench source ${String(docIx)}`, "bench seed"],
    );
    const contextDocId = doc.rows[0]?.id;
    if (contextDocId === undefined)
      throw new Error("bench: context_doc insert returned no id");
    const chunks = makeChunks(rand, n, `bench-${String(docIx)}`);
    await store.replaceSource(
      userId,
      { kind: "context_doc", contextDocId },
      chunks,
    );
    done += n;
    docIx += 1;
  }
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const env = readStackEnv();
  if (env === null) {
    console.error(
      "bench-rag: the local Supabase stack is not reachable.\n" +
        "  This benchmark is DB-required. Bring the stack up and export its env, e.g.:\n" +
        "    npm run db:start\n" +
        '    eval "$(supabase status -o env)"\n' +
        "    export SUPABASE_DB_URL=$DB_URL SUPABASE_URL=$API_URL SUPABASE_SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY\n" +
        "  Missing one of SUPABASE_DB_URL / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.",
    );
    process.exit(1);
  }

  const pool = createPgPool(process.env);
  const store = createPgVectorStore({ pool, config: STORE_CONFIG });
  const admin = createClient(env.url, env.serviceRoleKey, noPersist);
  const userIds: string[] = [];

  try {
    // --- mint bench users (A first, then noise) ---------------------------
    for (let u = 0; u < 1 + NOISE_USERS; u++) {
      const created = await admin.auth.admin.createUser({
        email: `bench-rag-${randomUUID()}@nova.test`,
        password: `Pw-${randomUUID()}`,
        email_confirm: true,
      });
      if (created.error)
        throw new Error(`createUser: ${created.error.message}`);
      userIds.push(created.data.user.id);
    }
    const [userA, ...noiseUsers] = userIds;
    if (userA === undefined) throw new Error("bench: no bench user minted");

    // --- seed (deterministic streams; a distinct seed per user) -----------
    console.log(
      `bench-rag: seeding ${String(BENCH_CHUNKS)} chunks (user A) + ` +
        `${String(NOISE_USERS)}×${String(NOISE_CHUNKS_EACH)} noise …`,
    );
    const seedStart = performance.now();
    await seedUser(store, pool, userA, BENCH_CHUNKS, mulberry32(1));
    for (let i = 0; i < noiseUsers.length; i++) {
      const noiseId = noiseUsers[i];
      if (noiseId === undefined) continue;
      await seedUser(
        store,
        pool,
        noiseId,
        NOISE_CHUNKS_EACH,
        mulberry32(1000 + i),
      );
    }
    const totalChunks = BENCH_CHUNKS + NOISE_USERS * NOISE_CHUNKS_EACH;
    console.log(
      `bench-rag: seeded ${String(totalChunks)} chunks in ` +
        `${(performance.now() - seedStart).toFixed(0)}ms`,
    );

    // --- pre-compute query vectors + texts --------------------------------
    const queryRand = mulberry32(777);
    const queries = Array.from({ length: QUERIES }, (_, i) => ({
      vector: unitVector(queryRand),
      // First HYBRID_QUERIES carry text (vector+text); the rest are vector-only.
      text:
        i < HYBRID_QUERIES
          ? `${VOCAB[Math.floor(queryRand() * VOCAB.length)] ?? "pricing"} ${
              VOCAB[Math.floor(queryRand() * VOCAB.length)] ?? "renewal"
            }`
          : "",
    }));

    // --- warm up (not timed) ----------------------------------------------
    for (let i = 0; i < WARMUP; i++) {
      const q = queries[i % queries.length];
      if (q === undefined) continue;
      await store.search(userA, {
        vector: q.vector,
        text: q.text,
        model: MODEL,
        k: K,
      });
    }

    // --- timed run ---------------------------------------------------------
    const durations: number[] = [];
    for (const q of queries) {
      const t0 = performance.now();
      await store.search(userA, {
        vector: q.vector,
        text: q.text,
        model: MODEL,
        k: K,
      });
      durations.push(performance.now() - t0);
    }

    // --- report ------------------------------------------------------------
    const sorted = [...durations].sort((a, b) => a - b);
    const p50 = percentile(sorted, 50);
    const p95 = percentile(sorted, 95);
    const max = percentile(sorted, 100);
    const pass = p95 < BAR_MS;

    console.log("");
    console.log(
      "RAG store latency benchmark — pgvector hybrid RRF (adr-0005 §5)",
    );
    console.log(
      `  corpus:  ${String(BENCH_CHUNKS)} chunks (user A) + ` +
        `${String(NOISE_USERS * NOISE_CHUNKS_EACH)} noise = ${String(totalChunks)} total`,
    );
    console.log(
      `  queries: ${String(QUERIES)} (${String(HYBRID_QUERIES)} vector+text, ` +
        `${String(QUERIES - HYBRID_QUERIES)} vector-only), k=${String(K)}, ` +
        `candidates/leg=${String(STORE_CONFIG.candidatesPerLeg)}`,
    );
    console.log(`  p50 = ${p50.toFixed(1)} ms`);
    console.log(`  p95 = ${p95.toFixed(1)} ms`);
    console.log(`  max = ${max.toFixed(1)} ms`);
    console.log(
      `  BAR: p95 < ${String(BAR_MS)} ms  →  ${pass ? "PASS" : "FAIL"} ` +
        `(measured p95 = ${p95.toFixed(1)} ms)`,
    );
    console.log("");

    if (!pass) {
      console.error(
        `bench-rag: FAIL — p95 ${p95.toFixed(1)}ms exceeds the ${String(BAR_MS)}ms bar. ` +
          "Report the number; do NOT weaken the bar (tuning ef_search/candidates is the orchestrator's call).",
      );
      process.exitCode = 1;
    }
  } finally {
    // Hard delete (RULES §3 scripts/ purge exception): remove ONLY this bench's
    // own throwaway users and their derived rows. Children first (FK order):
    // embeddings → chunks → context_docs → auth user.
    for (const id of userIds) {
      await pool
        .query("delete from embeddings where user_id = $1", [id])
        .catch(() => undefined);
      await pool
        .query("delete from chunks where user_id = $1", [id])
        .catch(() => undefined);
      await pool
        .query("delete from context_docs where user_id = $1", [id])
        .catch(() => undefined);
      await admin.auth.admin.deleteUser(id).catch(() => undefined);
    }
    await pool.end();
  }
}

await main();
