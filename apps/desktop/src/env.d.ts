/**
 * Types for the env variables this workspace reads through `import.meta.env`.
 *
 * electron-vite ships its own `ImportMetaEnv` (MODE/DEV/PROD only) via the
 * `electron-vite/node` types both tsconfigs list; TypeScript merges this
 * declaration into it. Without the merge every `import.meta.env.NOVA_*` read is
 * a type error, which is the point — a variable that is not declared here is a
 * variable nobody wired.
 *
 * `string | undefined`, never `string`: vite only substitutes the keys that were
 * actually present in the `.env` at build time, so an unset variable arrives as
 * `undefined` and every reader has to zod-parse the boundary rather than trust
 * the type. See `main/auth/supabase.ts` and `main/api/client.ts`.
 *
 * why the file is not named `env.ts`-adjacent anything: `src/env.ts` does not
 * exist, so this `.d.ts` is safe to include — see the note in
 * `src/preload/global.d.ts` for the rule that bit the scaffold.
 */
interface ImportMetaEnv {
  /**
   * Base URL of the Nova server (e.g. `http://127.0.0.1:3000`). Optional —
   * `main/api/client.ts` falls back to the local dev server.
   */
  readonly NOVA_API_URL?: string;
  /** Supabase project URL the desktop app authenticates against. */
  readonly NOVA_SUPABASE_URL?: string;
  /** Supabase anon (publishable) key. Never a service-role key. */
  readonly NOVA_SUPABASE_ANON_KEY?: string;
}
