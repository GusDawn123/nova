import { type HealthResponse } from '@nova/shared';
import { z } from 'zod';

const DEFAULT_API_BASE_URL = 'http://127.0.0.1:3000';

/**
 * Base URL of the Nova server. `EXPO_PUBLIC_API_URL` is inlined into the bundle
 * by Expo at build time; zod-parse the env boundary (guardrails) and fall back
 * to the local dev server on a missing/invalid value so `expo start` works out
 * of the box.
 */
export const API_BASE_URL = z
  .string()
  .url()
  .catch(DEFAULT_API_BASE_URL)
  .parse(process.env.EXPO_PUBLIC_API_URL);

export const HEALTH_ENDPOINT = '/health';

/** Full URL the app fetches on mount to prove the app↔server round trip. */
export const HEALTH_URL = `${API_BASE_URL}${HEALTH_ENDPOINT}`;

export type MobileHealthResponse = HealthResponse;
