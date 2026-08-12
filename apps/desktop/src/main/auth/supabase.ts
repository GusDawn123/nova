import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { app } from "electron";
import { z } from "zod";

import {
  createFileSessionStore,
  type SessionStoreIssue,
} from "./session-store";

/**
 * The ONE module allowed to import the Supabase vendor SDK (RULES: vendor SDKs
 * live behind a single seam — the mobile app draws the same line in
 * `src/lib/supabase.ts`). Everything else reaches auth through `auth/service`.
 *
 * Config arrives on `import.meta.env.NOVA_*`, inlined at build time by
 * electron-vite into the MAIN bundle only, and is zod-parsed here. Missing or
 * invalid config is NOT a crash: the client is `null` and the service reports a
 * typed `unavailable` state, so a misconfigured build explains itself instead of
 * showing a sign-in form that could never succeed.
 */
const envSchema = z.object({
  url: z.string().url(),
  anonKey: z.string().min(1),
});

export interface SupabaseSeam {
  /** The client when config is present and valid; `null` otherwise. */
  client: SupabaseClient | null;
  /** Human-readable reason it is unavailable, or `null` when ready. */
  configError: string | null;
}

const MISSING_CONFIG_MESSAGE =
  "Nova is not configured to sign in. Set NOVA_SUPABASE_URL and NOVA_SUPABASE_ANON_KEY in apps/desktop/.env.";

/**
 * Built on demand rather than at module scope: the session directory comes from
 * `app.getPath("userData")`, which is only meaningful after Electron is ready,
 * and importing this file must not have side effects that early.
 */
export function createSupabaseSeam(
  onStoreIssue: (issue: SessionStoreIssue) => void = (issue) => {
    console.warn(`[session-store] ${issue.message}`);
  },
): SupabaseSeam {
  const parsed = envSchema.safeParse({
    url: import.meta.env.NOVA_SUPABASE_URL,
    anonKey: import.meta.env.NOVA_SUPABASE_ANON_KEY,
  });

  if (!parsed.success) {
    return { client: null, configError: MISSING_CONFIG_MESSAGE };
  }

  // Assigning our file-backed store into the SDK's `storage` slot is what
  // proves `SessionStore` still matches what supabase-js expects; the
  // structurally-declared interface has no other check on it.
  const storage = createFileSessionStore(app.getPath("userData"), onStoreIssue);

  return {
    client: createClient(parsed.data.url, parsed.data.anonKey, {
      auth: {
        storage,
        autoRefreshToken: true,
        persistSession: true,
        // No OAuth redirect in this build (email/password only), and the main
        // process has no URL to inspect in any case.
        detectSessionInUrl: false,
      },
    }),
    configError: null,
  };
}
