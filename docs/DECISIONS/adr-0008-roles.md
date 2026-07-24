# ADR-0008 — Permission roles (developer / admin / customer) + the profiles UPDATE-grant fix

Status: accepted 2026-07-23. Context: Gustavo asked for role-based permissions structured
properly from the start (the only prior axis was the SUBSCRIPTION tier `profiles.plan`
free|pro — orthogonal to permissions). First consumer: the "Test Live" tab (the Phase 7
typed-question playground) is internal-only. During design we found a live privilege hole
that ships fixed in the same migration.

## Decisions

1. **Roles live in a `profiles.role` column, not a JWT claim.**
   `role text not null default 'customer' check (role in ('developer','admin','customer'))`
   (migration `20260723100000`). Rationale:
   - mirrors the existing `db/plans.ts` PlanReader seam (a one-file twin, `db/roles.ts`);
   - `auth/verify-token.ts` deliberately parses only `{sub, email?}` — custom JWT claims
     need Supabase auth-hook configuration, and the cloud project is still deferred;
   - a column change takes effect on the NEXT REQUEST — revocation matters for admin
     demotion, where an already-minted JWT claim would live until expiry;
   - assignment is a plain service-role write (`scripts/set_user_role.ts`), no token churn.

2. **The closed set is `developer | admin | customer`.** `customer` is the default everyone
   (including every existing row) gets; `developer` = internal builders (test surfaces,
   future debug tooling); `admin` = operational control (future user management). The DB
   CHECK is the source of truth; the shared zod `roleSchema` and the reader's row parse
   mirror it.

3. **SECURITY FIX (shipped with the column): the blanket `UPDATE` grant on `profiles` for
   `authenticated` is revoked and re-granted COLUMN-SCOPED to `display_name, deleted_at`.**
   `create_profiles` granted table-wide UPDATE; RLS policies check the ROW
   (`id = auth.uid()`), not the COLUMNS — so any signed-in user could
   `update profiles set plan='pro'` on their own row (a live free→pro self-upgrade), and
   could have self-assigned `role='admin'` the moment the column landed. After the fix, a
   user JWT gets `42501 permission denied` for `plan`/`role`/anything else, while
   display-name edits and the soft-delete tombstone keep working. `plan` stays writable
   only via service_role (the RevenueCat webhook), `role` only via service_role (the
   assignment script / future admin surface). Proven by
   `db/profiles-grants.integration.test.ts`.

4. **Failure postures.**
   - `RoleReader` (data): missing/soft-deleted profile → `'customer'` (least privilege,
     the PlanReader 'free' posture); a DB error REJECTS.
   - `requireRole` (the privilege gate, `plugins/role.ts`): reader throw → **403 fail
     CLOSED** (a privilege gate never fail-opens — the ownership posture, NOT quota's
     fail-open, which protects spend rather than access); reader unwired (DB-less boot) →
     503; missing `request.user` (requireAuth not composed) → 401.
   - `/me` `role` field (display data): best-effort — DB-less boot or read failure OMITS
     the field; clients treat absent as `'customer'`. The real gate is `requireRole`.
   - Mobile `use-role` (display gating): resolves `'customer'` while loading/on any
     error, so role-gated UI stays hidden until proven — no flash. The tab uses the SDK 57
     native-tabs `hidden` prop (the sanctioned conditional-trigger mechanism).

5. **No consumers of `requireRole` yet — it is the seam.** Server-side enforcement of the
   live playground itself is not needed today (the socket is auth- and quota-gated and
   every user may hold live sessions); the tab visibility is a product-surface decision.
   Future admin/developer REST routes compose `[requireAuth, requireRole([...])]`.

## Notes

- `plan` (billing tier) and `role` (permissions) remain SEPARATE axes on purpose — a
  developer can be on the free plan; a pro customer is still a customer.
- The generated-types stand-in `db/schema.ts` gained the column; a real
  `supabase gen types` regeneration replaces it when the cloud project lands.
