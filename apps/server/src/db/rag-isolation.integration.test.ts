import { randomUUID } from "node:crypto";

import {
  createClient,
  type PostgrestSingleResponse,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * RAG storage A/B isolation proof — the permanent CI gate for "a user's chunks and
 * embeddings are invisible and unwritable to anyone else". Sibling to
 * rls-isolation.integration.test.ts / transcript-parentage.integration.test.ts
 * (kept separate to stay under the ~400-line file cap): same two-real-users,
 * JWT-direct-against-PostgREST approach, so the guarantee under test is the Postgres
 * RLS with-check itself, not application code.
 *
 * Covers (all against the LIVE stack):
 *   - A ingests a chunk (parented to A's context_doc) + its embedding; A can read both.
 *   - B's JWT select → zero rows on chunks AND embeddings (isolation).
 *   - B's JWT insert of a chunk parented to A's context_doc → RLS rejection (parentage).
 *   - B's JWT insert of a chunk parented to A's MEETING → RLS rejection (parentage).
 *   - B's JWT insert of an embedding for A's chunk → RLS rejection (parentage).
 *   - authenticated insert of a chunk with BOTH parents set → CHECK rejection.
 *   - authenticated insert of a chunk with NEITHER parent set → CHECK rejection.
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SUPABASE_ANON_KEY (all three
 * from `supabase status -o env`). Unless ALL are present the suite skips, so the
 * default `npm run test` stays green without a running stack.
 */

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const hasStack = Boolean(url && serviceRoleKey && anonKey);

// A 1024-dim halfvec literal in pgvector text form (`[v1,v2,...]`). Constant non-zero
// value → well-defined cosine norm (a zero vector would break cosine distance).
const EMBEDDING_DIMS = 1024;
const EMBEDDING_LITERAL = `[${Array(EMBEDDING_DIMS).fill(0.1).join(",")}]`;
const EMBEDDING_MODEL = "test-embed-1024";

// Minimal hand-written `Database` type (mirrors the sibling suites — kept local so
// `.from(...)` stays type-safe under strict-type-checked eslint). These MUST be
// `type` aliases, not `interface`s: supabase-js's `GenericTable` constrains `Row` to
// `Record<string, unknown>`, which interfaces do not satisfy (results would silently
// degrade to `never`).
type ContextDocRow = {
  id: string;
  user_id: string;
  title: string;
  content: string;
  created_at: string;
  deleted_at: string | null;
};
type MeetingRow = {
  id: string;
  user_id: string;
  title: string;
  started_at: string | null;
  ended_at: string | null;
  indexed_at: string | null;
  created_at: string;
  deleted_at: string | null;
};
type ChunkRow = {
  id: string;
  user_id: string;
  context_doc_id: string | null;
  meeting_id: string | null;
  content: string;
  header: string;
  chunk_index: number;
  token_count: number;
  created_at: string;
  deleted_at: string | null;
};
type EmbeddingRow = {
  id: string;
  chunk_id: string;
  user_id: string;
  model: string;
  dims: number;
  embedding: string;
  created_at: string;
  deleted_at: string | null;
};
type ChunkInsert = {
  user_id: string;
  context_doc_id?: string | null;
  meeting_id?: string | null;
  content: string;
  header?: string;
  chunk_index: number;
  token_count: number;
};
type EmbeddingInsert = {
  chunk_id: string;
  user_id: string;
  model: string;
  dims: number;
  embedding: string;
};
type Database = {
  public: {
    Tables: {
      context_docs: {
        Row: ContextDocRow;
        Insert: { user_id: string; title: string; content: string };
        Update: Partial<ContextDocRow>;
        Relationships: [];
      };
      meetings: {
        Row: MeetingRow;
        Insert: { user_id: string; title: string };
        Update: Partial<MeetingRow>;
        Relationships: [];
      };
      chunks: {
        Row: ChunkRow;
        Insert: ChunkInsert;
        Update: Partial<ChunkRow>;
        Relationships: [];
      };
      embeddings: {
        Row: EmbeddingRow;
        Insert: EmbeddingInsert;
        Update: Partial<EmbeddingRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};

type Db = SupabaseClient<Database>;

interface TestUser {
  id: string;
  email: string;
  password: string;
  /** A per-user client whose requests carry that user's JWT (role: authenticated). */
  client: Db;
}

/** Throw on a PostgREST error so `.single()` callers fail loudly at the boundary. */
function unwrap<T>(res: PostgrestSingleResponse<T>, ctx: string): T {
  if (res.error) throw new Error(`${ctx}: ${res.error.message}`);
  return res.data;
}

const noPersist = {
  auth: { persistSession: false, autoRefreshToken: false },
} as const;

describe.skipIf(!hasStack)("rag storage isolation (local stack)", () => {
  let apiUrl: string;
  let publishableKey: string;
  let admin: Db;
  let userA: TestUser;
  let userB: TestUser;
  const createdUserIds: string[] = [];

  // Populated by the A-ingest test, then read by the B-isolation tests.
  let aDocId: string;
  let aChunkId: string;

  /** Admin-create a confirmed user, then sign in a per-user (JWT) client for them. */
  async function createTestUser(label: string): Promise<TestUser> {
    const suffix = randomUUID();
    const email = `rag-iso-${label}-${suffix}@nova.test`;
    const password = `Pw-${randomUUID()}`;

    const created = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (created.error) {
      throw new Error(`createUser(${label}) failed: ${created.error.message}`);
    }

    const client = createClient<Database>(apiUrl, publishableKey, noPersist);
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) {
      throw new Error(`signIn(${label}) failed: ${signIn.error.message}`);
    }

    return { id: created.data.user.id, email, password, client };
  }

  /** Service-role teardown: FKs RESTRICT children, so delete deepest-child-first. */
  async function purgeUser(userId: string): Promise<void> {
    await admin.from("embeddings").delete().eq("user_id", userId);
    await admin.from("chunks").delete().eq("user_id", userId);
    await admin.from("context_docs").delete().eq("user_id", userId);
    await admin.from("meetings").delete().eq("user_id", userId);
    await admin.auth.admin.deleteUser(userId);
  }

  beforeAll(async () => {
    // skipIf guarantees these at runtime; narrow for the type checker.
    if (!url || !serviceRoleKey || !anonKey) {
      throw new Error("Supabase stack env vars missing");
    }
    apiUrl = url;
    publishableKey = anonKey;
    admin = createClient<Database>(url, serviceRoleKey, noPersist);

    userA = await createTestUser("a");
    createdUserIds.push(userA.id);
    userB = await createTestUser("b");
    createdUserIds.push(userB.id);
  });

  afterAll(async () => {
    for (const id of createdUserIds) {
      await purgeUser(id);
    }
  });

  it("[rag-ingest] A can ingest a chunk + embedding on A's own live context_doc", async () => {
    const aDoc = unwrap(
      await userA.client
        .from("context_docs")
        .insert({
          user_id: userA.id,
          title: "A doc",
          content: "A's source text",
        })
        .select()
        .single(),
      "A insert context_doc",
    );
    aDocId = aDoc.id;

    const chunk = unwrap(
      await userA.client
        .from("chunks")
        .insert({
          user_id: userA.id,
          context_doc_id: aDoc.id,
          content: "A's chunk content",
          header: "Section 1",
          chunk_index: 0,
          token_count: 4,
        })
        .select()
        .single(),
      "A insert chunk",
    );
    aChunkId = chunk.id;
    expect(chunk.context_doc_id).toBe(aDoc.id);
    expect(chunk.meeting_id).toBeNull();
    expect(chunk.user_id).toBe(userA.id);

    const embedding = unwrap(
      await userA.client
        .from("embeddings")
        .insert({
          chunk_id: chunk.id,
          user_id: userA.id,
          model: EMBEDDING_MODEL,
          dims: EMBEDDING_DIMS,
          embedding: EMBEDDING_LITERAL,
        })
        .select()
        .single(),
      "A insert embedding",
    );
    expect(embedding.chunk_id).toBe(chunk.id);
    expect(embedding.user_id).toBe(userA.id);
    expect(embedding.dims).toBe(EMBEDDING_DIMS);
  });

  it("[rag-isolation] B's JWT sees zero of A's chunks and embeddings", async () => {
    const bChunks = unwrap(
      await userB.client.from("chunks").select().eq("id", aChunkId),
      "B select chunks",
    );
    expect(bChunks).toHaveLength(0);

    const bEmbeddings = unwrap(
      await userB.client.from("embeddings").select().eq("chunk_id", aChunkId),
      "B select embeddings",
    );
    expect(bEmbeddings).toHaveLength(0);
  });

  it("[rag-parentage] B cannot INSERT a chunk parented to A's context_doc", async () => {
    // B owns the chunk row (user_id = self) but points at A's doc. The parentage
    // with-check must reject it (A's doc is not owned by B).
    const res = await userB.client
      .from("chunks")
      .insert({
        user_id: userB.id,
        context_doc_id: aDocId,
        content: "B spoofing onto A's doc",
        chunk_index: 0,
        token_count: 3,
      })
      .select();

    expect(res.error).not.toBeNull();
    expect(res.data ?? []).toHaveLength(0);

    // Nothing was written against A's doc (service role bypasses RLS to confirm).
    const children = unwrap(
      await admin.from("chunks").select().eq("context_doc_id", aDocId),
      "service-role read chunks",
    );
    // Only A's original chunk exists under A's doc.
    expect(children).toHaveLength(1);
    expect(children[0]?.user_id).toBe(userA.id);
  });

  it("[rag-parentage] B cannot INSERT a chunk parented to A's meeting", async () => {
    // Mirror of the context_doc-branch case above for the OTHER chunk parent
    // (meeting). A owns a live meeting; B owns the chunk row (user_id = self) but
    // points meeting_id at A's meeting. The meeting-branch parentage with-check
    // must reject it (A's meeting is not owned by B).
    const aMeeting = unwrap(
      await userA.client
        .from("meetings")
        .insert({ user_id: userA.id, title: "A meeting for parentage test" })
        .select()
        .single(),
      "A insert meeting",
    );

    const res = await userB.client
      .from("chunks")
      .insert({
        user_id: userB.id,
        meeting_id: aMeeting.id,
        content: "B spoofing onto A's meeting",
        chunk_index: 0,
        token_count: 3,
      })
      .select();

    expect(res.error).not.toBeNull();
    expect(res.data ?? []).toHaveLength(0);

    // Nothing was written against A's meeting (service role bypasses RLS to confirm).
    const children = unwrap(
      await admin.from("chunks").select().eq("meeting_id", aMeeting.id),
      "service-role read chunks",
    );
    expect(children).toHaveLength(0);
  });

  it("[rag-parentage] B cannot INSERT an embedding for A's chunk", async () => {
    const res = await userB.client
      .from("embeddings")
      .insert({
        chunk_id: aChunkId,
        user_id: userB.id,
        model: EMBEDDING_MODEL,
        dims: EMBEDDING_DIMS,
        embedding: EMBEDDING_LITERAL,
      })
      .select();

    expect(res.error).not.toBeNull();
    expect(res.data ?? []).toHaveLength(0);

    // Only A's own embedding exists for A's chunk.
    const children = unwrap(
      await admin.from("embeddings").select().eq("chunk_id", aChunkId),
      "service-role read embeddings",
    );
    expect(children).toHaveLength(1);
    expect(children[0]?.user_id).toBe(userA.id);
  });

  it("[rag-check] a chunk with BOTH parents set is rejected by the CHECK", async () => {
    // A owns both a doc and a meeting → RLS parentage passes; the exactly-one-parent
    // CHECK is what must reject this.
    const aMeeting = unwrap(
      await userA.client
        .from("meetings")
        .insert({ user_id: userA.id, title: "A meeting for check test" })
        .select()
        .single(),
      "A insert meeting",
    );

    const res = await userA.client
      .from("chunks")
      .insert({
        user_id: userA.id,
        context_doc_id: aDocId,
        meeting_id: aMeeting.id,
        content: "two parents",
        chunk_index: 0,
        token_count: 2,
      })
      .select();

    expect(res.error).not.toBeNull();
    // 23514 = check_violation; the message names the constraint.
    expect(res.error?.message ?? "").toContain("chunks_one_parent");
    expect(res.data ?? []).toHaveLength(0);
  });

  it("[rag-check] a chunk with NEITHER parent set is rejected", async () => {
    const res = await userA.client
      .from("chunks")
      .insert({
        user_id: userA.id,
        content: "no parents",
        chunk_index: 0,
        token_count: 2,
      })
      .select();

    // Rejected either way (both the CHECK and the parentage with-check fail with no
    // parent). Assert it does not succeed.
    expect(res.error).not.toBeNull();
    expect(res.data ?? []).toHaveLength(0);
  });
});
