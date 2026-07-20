// URL polyfill must load before supabase-js on native (React Native's URL is
// incomplete). No-op on web. Kept at the top so it runs on import.
import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';
import { z } from 'zod';

/**
 * The ONE module allowed to import the Supabase vendor SDK (guardrails: vendor
 * SDKs live behind a single seam). Everything else in the app talks to auth
 * through `hooks/use-auth`, never `@supabase/supabase-js` directly.
 *
 * Config comes from `EXPO_PUBLIC_*` env, inlined into the bundle by Expo at
 * build time and zod-parsed here (same boundary-parse posture as
 * `constants/health.ts`). Missing/invalid config is NOT a crash: `supabase` is
 * `null` and the auth layer surfaces a typed "unavailable" state instead.
 *
 * Session storage is platform-conditional (per Supabase's Expo docs):
 *   - native: AsyncStorage, which persists the session across app restarts.
 *   - web: supabase-js's own default (browser `localStorage`), which persists
 *     across reloads AND is SSR-safe — Expo web static-renders each route in
 *     Node, where AsyncStorage's `getItem` would throw, so we must NOT hand it
 *     to the client on web.
 * `autoRefreshToken` + `persistSession` are on for both.
 */
const authStorage = Platform.OS === 'web' ? undefined : AsyncStorage;
const envSchema = z.object({
  url: z.string().url(),
  anonKey: z.string().min(1),
});

const parsed = envSchema.safeParse({
  url: process.env.EXPO_PUBLIC_SUPABASE_URL,
  anonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
});

/** The client when config is present and valid; `null` otherwise. */
export const supabase: SupabaseClient | null = parsed.success
  ? createClient(parsed.data.url, parsed.data.anonKey, {
      auth: {
        storage: authStorage,
        autoRefreshToken: true,
        persistSession: true,
        // No OAuth redirect callback in this build (email/password only), so
        // there is never a session to detect in the URL. Avoids the web client
        // trying to parse the hash on every load.
        detectSessionInUrl: false,
      },
    })
  : null;

/** Human-readable reason the client is unavailable, or `null` when it is ready. */
export const supabaseConfigError: string | null = parsed.success
  ? null
  : 'Supabase is not configured (set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY).';
