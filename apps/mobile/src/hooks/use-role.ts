import { meResponseSchema, type Role } from '@nova/shared';
import { useEffect, useState } from 'react';

import { API_BASE_URL } from '@/constants/health';
import { useAuth } from '@/hooks/use-auth';

const ME_URL = `${API_BASE_URL}/me`;

/**
 * The caller's permission role (adr-0008), resolved from `GET /me`. Deliberately
 * conservative: resolves `'customer'` while loading, on any error, when the
 * server omits the field (DB-less boot), or when signed out — so role-gated UI
 * (the Test Live tab) stays HIDDEN until the caller is proven developer/admin,
 * never flashing in and vanishing. The server enforces real permissions
 * (requireRole); this is display gating only.
 */
export function useRole(): Role {
  const auth = useAuth();
  // The role is stored WITH the token it was fetched for, and the return value
  // is DERIVED: signed-out / token-changed / not-yet-fetched all read
  // 'customer' without any state reset in an effect (React 19 cascade rule) —
  // and a stale role can never leak across an account switch.
  const [fetched, setFetched] = useState<{ token: string; role: Role } | null>(
    null,
  );

  const accessToken =
    auth.status === 'signed-in' ? auth.session.access_token : null;

  useEffect(() => {
    if (accessToken === null) return;
    const token = accessToken;
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const response = await fetch(ME_URL, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) return; // stay 'customer' — never throw for gating UI
        const body: unknown = await response.json();
        const data = meResponseSchema.parse(body);
        if (!cancelled) {
          setFetched({ token, role: data.role ?? 'customer' });
        }
      } catch {
        // Network/parse failure: stay 'customer' (hidden), no error surface —
        // the Home screen's /me proof reports connectivity problems already.
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  return accessToken !== null && fetched?.token === accessToken
    ? fetched.role
    : 'customer';
}
