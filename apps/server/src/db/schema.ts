import { z } from "zod";

/**
 * Shared `_smoke` contract for the db adapter: the runtime validator (zod) plus a
 * minimal `Database` type for `@supabase/supabase-js`. Kept in one place so the
 * client's SDK typing and the smoke functions' validation never drift. A real
 * project regenerates the `Database` type with `supabase gen types`; this is the
 * hand-written minimum for the single scaffold table.
 */

/** Runtime shape of a `_smoke` row, validated on every read (vendor output is hostile). */
export const smokeRowSchema = z.object({
  id: z.string().uuid(),
  note: z.string(),
  created_at: z.string(),
  deleted_at: z.string().nullable(),
});

export type SmokeRow = z.infer<typeof smokeRowSchema>;

export interface Database {
  public: {
    Tables: {
      _smoke: {
        Row: SmokeRow;
        Insert: {
          note: string;
          id?: string;
          created_at?: string;
          deleted_at?: string | null;
        };
        Update: Partial<SmokeRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
