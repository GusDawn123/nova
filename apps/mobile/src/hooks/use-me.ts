import { meResponseSchema, type MeResponse } from '@nova/shared';
import { useEffect, useState } from 'react';

import { API_BASE_URL } from '@/constants/health';

const ME_URL = `${API_BASE_URL}/me`;

/**
 * State of the authenticated `GET /me` round trip. Discriminated union so the
 * screen renders one branch at a time (mirrors `use-health`).
 */
export type MeState =
  | { status: 'loading' }
  | { status: 'success'; data: MeResponse }
  | { status: 'error'; message: string };

/**
 * Smart hook: calls the server's protected `GET /me` with the caller's Supabase
 * access token, zod-parses the response with the shared `meResponseSchema`, and
 * exposes loading/success/error. Re-runs whenever the token changes (e.g. a
 * silent refresh), so the proof stays valid. Plain fetch + useState — YAGNI.
 */
export function useMe(accessToken: string): MeState {
  const [state, setState] = useState<MeState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const response = await fetch(ME_URL, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) {
          throw new Error(`server returned HTTP ${response.status}`);
        }
        const body: unknown = await response.json();
        const data = meResponseSchema.parse(body);
        if (!cancelled) {
          setState({ status: 'success', data });
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'request failed';
          setState({ status: 'error', message });
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  return state;
}
