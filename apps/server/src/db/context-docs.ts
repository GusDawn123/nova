import { z } from "zod";

import { getSupabaseClient } from "./client.js";

/**
 * Supabase adapter for the knowledge-base rows. Service-role client (bypasses
 * RLS — the trusted server-side posture); the SDK never leaks past this module
 * (RULES §5). Every read and write is user-scoped AND `deleted_at is null`, so
 * an unknown, foreign, or soft-deleted doc is indistinguishable to the caller —
 * the routes turn that into one uniform 404.
 */

const TABLE = "context_docs";

const rowSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  created_at: z.string(),
  indexed_at: z.string().nullable(),
});
export type ContextDocRow = z.infer<typeof rowSchema>;

export interface ContextDocsStore {
  list(userId: string, limit: number): Promise<ContextDocRow[]>;
  countLive(userId: string): Promise<number>;
  create(userId: string, title: string, content: string): Promise<ContextDocRow>;
  /** Null when the doc is unknown, foreign, or already soft-deleted. */
  find(userId: string, docId: string): Promise<ContextDocRow | null>;
  stampIndexed(userId: string, docId: string): Promise<void>;
  /** Soft delete (RULES §3) — the row stays, `deleted_at` is set. */
  softDelete(userId: string, docId: string): Promise<void>;
}

export function createContextDocsStore(): ContextDocsStore {
  return {
    async list(userId, limit) {
      const res = await getSupabaseClient()
        .from(TABLE)
        .select("id, title, content, created_at, indexed_at")
        .eq("user_id", userId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (res.error) {
        throw new Error(`contextDocs.list failed: ${res.error.message}`);
      }
      return res.data.map((row) => rowSchema.parse(row));
    },

    async countLive(userId) {
      const res = await getSupabaseClient()
        .from(TABLE)
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .is("deleted_at", null);
      if (res.error) {
        throw new Error(`contextDocs.count failed: ${res.error.message}`);
      }
      return res.count ?? 0;
    },

    async create(userId, title, content) {
      const res = await getSupabaseClient()
        .from(TABLE)
        .insert({ user_id: userId, title, content })
        .select("id, title, content, created_at, indexed_at")
        .single();
      if (res.error) {
        throw new Error(`contextDocs.create failed: ${res.error.message}`);
      }
      return rowSchema.parse(res.data);
    },

    async find(userId, docId) {
      const res = await getSupabaseClient()
        .from(TABLE)
        .select("id, title, content, created_at, indexed_at")
        .eq("user_id", userId)
        .eq("id", docId)
        .is("deleted_at", null)
        .maybeSingle();
      if (res.error) {
        throw new Error(`contextDocs.find failed: ${res.error.message}`);
      }
      return res.data === null ? null : rowSchema.parse(res.data);
    },

    async stampIndexed(userId, docId) {
      const res = await getSupabaseClient()
        .from(TABLE)
        .update({ indexed_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("id", docId);
      if (res.error) {
        throw new Error(`contextDocs.stamp failed: ${res.error.message}`);
      }
    },

    async softDelete(userId, docId) {
      const res = await getSupabaseClient()
        .from(TABLE)
        .update({ deleted_at: new Date().toISOString() })
        .eq("user_id", userId)
        .eq("id", docId);
      if (res.error) {
        throw new Error(`contextDocs.delete failed: ${res.error.message}`);
      }
    },
  };
}
