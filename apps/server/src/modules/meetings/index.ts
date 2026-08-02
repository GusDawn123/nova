/**
 * `modules/meetings` — the authed meetings read surface (Phase 8.5,
 * `docs/DESIGN/notes-ui.md` §6). Standard module anatomy: `ports.ts` (seams),
 * `project.ts` (the pure row→card projection), `routes.ts` (the REST surface).
 *
 * No adapters live here: the only vendor seam is Supabase, and its adapter belongs
 * with the other DB adapters in `db/meetings.ts` (the `modules/notes` precedent).
 */
export { DEFAULT_LIST_LIMIT, createMeetingsRoutes } from "./routes.js";
export type { MeetingsRoutesDeps } from "./routes.js";
export { toListItem, toListItems } from "./project.js";
export type {
  MeetingListRow,
  MeetingsLogger,
  MeetingsReader,
} from "./ports.js";
