import type { FastifyRequest } from "fastify";
import type { MeetingNotes } from "@nova/shared";

/**
 * The two things BOTH notes route files need (`routes.ts` and
 * `item-completion-routes.ts`), extracted so neither imports the other — the
 * completion routes are registered BY `routes.ts`, so a back-import would be a
 * cycle.
 *
 * Everything here is pure or near-pure: no I/O, no clock, no throw except the one
 * unreachable invariant below.
 */

/**
 * The authenticated caller's id (requireAuth guarantees `request.user` is set).
 *
 * The throw is an invariant assertion, not an error path: `requireAuth` runs as a
 * preHandler and either populates `request.user` or replies 401/503 before any
 * handler runs. Narrowing rather than asserting keeps `any` out (RULES §1).
 */
export function userIdOf(request: FastifyRequest): string {
  const user = request.user;
  if (user === undefined) {
    // Unreachable: requireAuth either populated user or already replied.
    throw new Error("requireAuth did not populate request.user");
  }
  return user.id;
}

/**
 * WHICH notes the client is actually looking at: the post-call object when it
 * exists, else the live preview accrued during the call, else nothing.
 *
 * ONE definition, used by the notes GET (to resolve `completed_item_ids` against
 * what will render) and by the completion WRITE (to decide whether an item id is
 * checkable at all). why: those two sites implemented the same rule separately, and
 * the moment they disagree a client can check an item the read will not report back
 * — the checkbox then silently unchecks itself on refresh, which is the exact bug
 * the completion feature exists to prevent.
 *
 * Pure: both arguments are already-read values, so this never decides to READ the
 * live preview — the caller owns that (and its best-effort degradation).
 */
export function selectRenderedNotes(
  modelNotes: MeetingNotes | null,
  liveNotes: MeetingNotes | null,
): MeetingNotes | null {
  return modelNotes ?? liveNotes;
}
