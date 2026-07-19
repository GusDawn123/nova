import { healthResponseSchema, type HealthResponse } from '@nova/shared';
import { useEffect, useState } from 'react';

import { HEALTH_URL } from '@/constants/health';

/**
 * State of the `GET /health` round trip. Discriminated union so screens render
 * one branch at a time and never a blank/ambiguous state.
 */
export type HealthState =
  | { status: 'loading' }
  | { status: 'success'; data: HealthResponse }
  | { status: 'error'; message: string };

/**
 * Smart hook: fetches `/health` on mount, zod-parses the JSON boundary with the
 * shared `healthResponseSchema`, and exposes a loading/success/error state.
 * Screens stay dumb and just render the branch. Plain fetch + useState (no data
 * lib) — YAGNI at this phase.
 */
export function useHealth(): HealthState {
  const [state, setState] = useState<HealthState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    async function check(): Promise<void> {
      try {
        const response = await fetch(HEALTH_URL);
        if (!response.ok) {
          throw new Error(`server returned HTTP ${response.status}`);
        }
        const body: unknown = await response.json();
        const data = healthResponseSchema.parse(body);
        if (!cancelled) {
          setState({ status: 'success', data });
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'server unreachable';
          setState({ status: 'error', message });
        }
      }
    }

    void check();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
