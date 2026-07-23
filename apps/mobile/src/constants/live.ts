import { API_BASE_URL } from '@/constants/health';

/**
 * The live-call WebSocket endpoint. Derived from the same `API_BASE_URL` the REST
 * client uses (http→ws / https→wss) so a single `EXPO_PUBLIC_API_URL` configures
 * both. The React Native client authenticates with the `?token=` query fallback
 * (the server strips it from logs); a header would also work but a query param is
 * simpler on RN's WebSocket.
 */
const WS_BASE_URL = API_BASE_URL.replace(/^http/, 'ws');

/** Build the authenticated `GET /live` socket URL for a Supabase access token. */
export function liveSocketUrl(accessToken: string): string {
  return `${WS_BASE_URL}/live?token=${encodeURIComponent(accessToken)}`;
}
