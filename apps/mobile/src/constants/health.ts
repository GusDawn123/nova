import { type HealthResponse } from '@nova/shared';

// Base URL of the Nova server. Overridable via EXPO_PUBLIC_API_URL (Expo inlines
// EXPO_PUBLIC_* env vars into the bundle at build time); defaults to the local
// dev server so `expo start` works out of the box.
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://127.0.0.1:3000';

export const HEALTH_ENDPOINT = '/health';

/** Full URL the app fetches on mount to prove the app↔server round trip. */
export const HEALTH_URL = `${API_BASE_URL}${HEALTH_ENDPOINT}`;

export type MobileHealthResponse = HealthResponse;
