import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import Fastify, { type FastifyInstance } from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  contextDocsListResponseSchema,
  createContextDocResponseSchema,
} from "@nova/shared";

import { createContextDocsStore } from "../../db/context-docs.js";
import { RagError, type RagIngestSource } from "../rag/index.js";

import { createContextDocsRoutes } from "./routes.js";

/**
 * Route integration suite (playbook VERIFY) for the knowledge base — REAL local
 * Supabase Postgres through the real store, REAL Supabase-issued JWTs through
 * `requireAuth`, and a RECORDING rag fake: the chunk pipeline has its own
 * suites, so what these routes owe is the contract AROUND it — rows always
 * save, indexing degrades in words, deletes retire chunks before the row, and
 * nothing of user A's is ever visible to user B.
 *
 * Self-skips without the stack env so `npm run test` stays green (isolation-
 * suite convention).
 */

const dbUrl = process.env.SUPABASE_DB_URL;
const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const hasStack = Boolean(dbUrl && url && serviceRoleKey && anonKey);

const noPersist = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

/** A rag double that records every ingest, in order, and can be told to fail. */
function recordingRag(behavior: "ok" | "too-large" = "ok") {
  const ingests: { userId: string; source: RagIngestSource }[] = [];
  return {
    ingests,
    rag: {
      ingest: (userId: string, source: RagIngestSource) => {
        ingests.push({ userId, source });
        if (behavior === "too-large") {
          return Promise.reject(
            RagError.sourceTooLarge("this document is too large to index"),
          );
        }
        return Promise.resolve({ chunks: source.kind === "context_doc" && source.content === "" ? 0 : 3 });
      },
      query: () => Promise.reject(new Error("query is not under test")),
    },
  };
}

const silentLogger = { error: () => {} };

describe.skipIf(!hasStack)("context-docs REST routes (local stack)", () => {
  let pool: Pool;
  let admin: ReturnType<typeof createClient>;

  let tokenA: string;
  let userAId: string;
  let tokenB: string;
  const userIds: string[] = [];

  async function createUser(
    label: string,
  ): Promise<{ id: string; token: string }> {
    if (!url || !anonKey) throw new Error("stack env missing");
    const email = `kb-${label}-${randomUUID()}@nova.test`;
    const password = `Pw-${randomUUID()}`;
    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (created.error) throw new Error(`createUser: ${created.error.message}`);
    const anon = createClient(url, anonKey, noPersist);
    const signIn = await anon.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`signIn: ${signIn.error.message}`);
    return {
      id: created.data.user.id,
      token: signIn.data.session.access_token,
    };
  }

  async function appWith(
    rag: ReturnType<typeof recordingRag>["rag"] | null,
    maxDocs?: number,
  ): Promise<FastifyInstance> {
    const app = Fastify();
    await app.register(
      createContextDocsRoutes({
        store: createContextDocsStore(),
        rag,
        logger: silentLogger,
        ...(maxDocs === undefined ? {} : { maxDocs }),
      }),
    );
    return app;
  }

  beforeAll(async () => {
    if (!hasStack || !url || !serviceRoleKey || !dbUrl) return;
    pool = new Pool({ connectionString: dbUrl });
    admin = createClient(url, serviceRoleKey, noPersist);
    const a = await createUser("a");
    const b = await createUser("b");
    tokenA = a.token;
    userAId = a.id;
    tokenB = b.token;
    userIds.push(a.id, b.id);
  });

  afterAll(async () => {
    if (!hasStack) return;
    // Hard delete is fine HERE: this is the suite's own seeded data, not app code.
    await pool.query("delete from context_docs where user_id = any($1)", [
      userIds,
    ]);
    for (const id of userIds) {
      await admin.auth.admin.deleteUser(id);
    }
    await pool.end();
  });

  it("saves, indexes, and lists a document — and B never sees it", async () => {
    const { rag, ingests } = recordingRag();
    const app = await appWith(rag);

    const created = await app.inject({
      method: "POST",
      url: "/context-docs",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { title: "Pricing playbook", content: "Always anchor high." },
    });
    expect(created.statusCode).toBe(200);
    const body = createContextDocResponseSchema.parse(created.json());
    expect(body.doc.indexed).toBe(true);
    expect(body.note).toBeNull();
    expect(ingests[0]?.userId).toBe(userAId);

    const listA = await app.inject({
      method: "GET",
      url: "/context-docs",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const docsA = contextDocsListResponseSchema.parse(listA.json()).docs;
    expect(docsA.map((d) => d.title)).toContain("Pricing playbook");

    const listB = await app.inject({
      method: "GET",
      url: "/context-docs",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const docsB = contextDocsListResponseSchema.parse(listB.json()).docs;
    expect(docsB.map((d) => d.title)).not.toContain("Pricing playbook");

    await app.close();
  });

  it("an indexing failure still saves the row and says so in words", async () => {
    const { rag } = recordingRag("too-large");
    const app = await appWith(rag);

    const created = await app.inject({
      method: "POST",
      url: "/context-docs",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { title: "Huge dump", content: "x".repeat(500) },
    });
    expect(created.statusCode).toBe(200);
    const body = createContextDocResponseSchema.parse(created.json());
    expect(body.doc.indexed).toBe(false);
    expect(body.note).toContain("too large");

    await app.close();
  });

  it("a boot with no embedder saves unindexed and says so", async () => {
    const app = await appWith(null);

    const created = await app.inject({
      method: "POST",
      url: "/context-docs",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { title: "Keyless upload", content: "Still worth keeping." },
    });
    const body = createContextDocResponseSchema.parse(created.json());
    expect(body.doc.indexed).toBe(false);
    expect(body.note).toContain("not searchable");

    await app.close();
  });

  it("the doc limit answers 409 in its own name", async () => {
    const { rag } = recordingRag();
    const app = await appWith(rag, 1);

    // One live doc already exists for A from the earlier cases; the cap of 1
    // is therefore already met.
    const refused = await app.inject({
      method: "POST",
      url: "/context-docs",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { title: "One too many", content: "nope" },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: "doc_limit" });

    await app.close();
  });

  it("delete retires the chunks before the row, and B cannot reach A's doc", async () => {
    const { rag, ingests } = recordingRag();
    const app = await appWith(rag);

    const created = await app.inject({
      method: "POST",
      url: "/context-docs",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { title: "To be removed", content: "Ephemeral." },
    });
    const docId = createContextDocResponseSchema.parse(created.json()).doc.id;

    const foreign = await app.inject({
      method: "DELETE",
      url: `/context-docs/${docId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(foreign.statusCode).toBe(404);

    const gone = await app.inject({
      method: "DELETE",
      url: `/context-docs/${docId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(gone.statusCode).toBe(200);

    const clearing = ingests.at(-1);
    expect(clearing?.source).toMatchObject({
      kind: "context_doc",
      contextDocId: docId,
      content: "",
    });

    const again = await app.inject({
      method: "DELETE",
      url: `/context-docs/${docId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(again.statusCode).toBe(404);

    await app.close();
  });

  it("a non-uuid id is a uniform 404, never a 400", async () => {
    const app = await appWith(null);
    const res = await app.inject({
      method: "DELETE",
      url: "/context-docs/not-a-uuid",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
