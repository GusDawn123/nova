import { deletionResponseSchema } from '@nova/shared';
import { useCallback, useState } from 'react';

import { API_BASE_URL } from '@/constants/health';
import { useAuth } from '@/hooks/use-auth';

const ACCOUNT_URL = `${API_BASE_URL}/account`;

/**
 * State of the `DELETE /account` round trip. Discriminated union so the screen
 * renders one branch at a time (mirrors `use-me` / `use-health`). There is no
 * `success` branch: a successful delete signs the user out, which unmounts the
 * screen (the auth guard redirects to sign-in), so nothing renders after.
 */
export type DeleteAccountState =
  | { status: 'idle' }
  | { status: 'deleting' }
  | { status: 'error'; message: string };

export interface UseDeleteAccount {
  state: DeleteAccountState;
  /** Fire the deletion. Idempotent server-side; on success it signs the user out. */
  deleteAccount: () => Promise<void>;
}

/**
 * Smart hook: calls the server's protected `DELETE /account` with the caller's
 * Supabase access token, zod-parses the response with the shared
 * `deletionResponseSchema`, and on success calls `signOut()` (the account is
 * queued for deletion + the profile tombstoned server-side). Typed error state
 * on failure so the dumb screen just renders the branch. Plain fetch + useState.
 */
export function useDeleteAccount(accessToken: string): UseDeleteAccount {
  const { signOut } = useAuth();
  const [state, setState] = useState<DeleteAccountState>({ status: 'idle' });

  const deleteAccount = useCallback(async (): Promise<void> => {
    setState({ status: 'deleting' });
    try {
      const response = await fetch(ACCOUNT_URL, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        throw new Error(`server returned HTTP ${response.status}`);
      }
      const body: unknown = await response.json();
      // Validate the boundary even though we only need the 2xx — a shape
      // surprise means the contract drifted and we should not sign out blindly.
      deletionResponseSchema.parse(body);
      // Success: sign out. This unmounts the screen (auth guard redirects), so
      // we deliberately do NOT setState afterward — avoids a stale update.
      await signOut();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'request failed';
      setState({ status: 'error', message });
    }
  }, [accessToken, signOut]);

  return { state, deleteAccount };
}
