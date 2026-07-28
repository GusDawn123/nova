# Notes UI — the glass mobile surface (Phase 8.5, mobile)

> **STATUS: SPEC / awaiting Gustavo's review.** Written 2026-07-28 from Gustavo's
> `Nova Mobile glass UI design` mock (three screens, both themes, animation timings
> specified) after a code-grounded audit of what the server actually exposes.
> Ratified decisions are marked; open questions are in §11.
>
> The ADR (`adr-0010-notes-ui`) and the ARCHITECTURE/CLAUDE updates get written
> *during* implementation, per RULES §8 — this file is the source they cite.

---

## 1. Why this exists

The notes backend has been live and e2e-proven since slice 4 of Phase 8
(`docs/DESIGN/live-notes.md`), and the post-call pipeline since Phase 5. The mobile
app renders **none of it**: `apps/mobile/src` contains zero references to
`notes.update`, `live_notes`, or notes of any kind. Notes are generated, persisted,
and broadcast into a client that has no surface for them.

This spec closes that. It is a mobile-heavy phase with two small server additions.

**Source of truth for the visual design** is Gustavo's mock. Layout, spacing, colour
tokens, and animation curves come from it verbatim; this document records how each
element is wired to real data and what is deliberately cut.

---

## 2. What the server already provides

Audited 2026-07-28. The complete HTTP surface:

| Route | Status |
|---|---|
| `GET /health` | exists |
| `GET /me` | exists (adds optional `role`) |
| `DELETE /account` | exists (**see F3 in live-notes.md — 202 but no consumer**) |
| `GET /live` | WebSocket; the live spine |
| `GET /meetings/:id/notes` | exists — composes `notes` + `live_notes` + `follow_up` |
| `POST /meetings/:id/notes/regenerate` | exists — 202 queued \| 409 \| 404 |
| `POST /meetings/:id/follow-up` | exists — 200 draft \| 409 \| 429 \| 503 \| 404 |
| `POST /webhooks/revenuecat` | exists |

Relevant tables (all with select-own RLS, all soft-delete aware):

- `meetings` — `id, user_id, title, started_at, ended_at, created_at, indexed_at,
  notes jsonb, notes_status, notes_generated_at, follow_up jsonb, deleted_at`
- `transcripts` — `id, meeting_id, user_id, content, speaker, ts_ms, created_at, deleted_at`
- `live_notes` — `meeting_id, user_id, notes jsonb, rev, updated_at, deleted_at`
  (server-authored; `authenticated` gets SELECT only)

Wire events already defined in `packages/shared/src/live.ts`: `transcript.partial`,
`transcript.final`, `transcript.input`, `suggestion.start|delta|done|discard`,
`notes.update`, plus the typed close reasons.

---

## 3. Design → data mapping

The mock's detail screen lines up with `meetingNotesSchema` almost field-for-field.
This is the load-bearing table; every row below is verified against the schema.

| Mock element | Backed by | Notes |
|---|---|---|
| tl;dr card | `notes.tldr` | |
| decisions + italic quote | `decisions[].text`, `.quote` | `quote` is nullable — hide the rule when null |
| action items | `actionItems[].text`, `.owner`, `.deadlineRaw` | render `deadlineRaw` (the spoken phrase), not the ISO `deadline` |
| action-item checkbox | `note_item_state.completed_at` | **new table — see §6.3** |
| "open" card | `openQuestions[]` | |
| "risk" card | `risks[]` | |
| Professional / Warm / Brief | `followUpToneSchema` | **exactly** those three values |
| subject + body | `followUpDraftSchema` | |
| "Notes ready" / "Writing notes" | `notes_status` | `completed` → ready; `queued\|processing` → shimmer; `failed` → retry affordance |
| card summary line | `notes.tldr`, else `live_notes.tldr` | fallback gives in-progress calls a real summary |
| "sales" tag, filter chips | `notes.conversationType` | `sales \| interview \| casual` |
| "34 min" | `ended_at - started_at` | null-safe: omit when either is null |
| "12:40 PM", "today"/"earlier this week" | `started_at` | grouping is client-side, on local time |
| transcript `dana · 00:04` | `transcripts.speaker`, `.ts_ms` | `ts_ms` is call-relative; format `mm:ss` |
| "Audio is never stored" | product invariant | static copy; it is true (`[no-disk]` audits) |
| live transcript bubbles | `transcript.final` / `.partial` | |
| "What to say" card | `suggestion.start\|delta\|done\|discard` | see §5 |

`notes.overview` and `notes.typeInsights` (sales: objections/buyingSignals;
interview: questionsAsked/answersToRevisit) have **no home in the mock**. They are
real, populated data.

**Ruling (Gustavo, 2026-07-28):** `typeInsights` gets a **"coming soon" placeholder
card** in the slot below open/risk — full glass styling, correct position and
proportions, but the insight data is not rendered until the prompts behind it are
refined. The card is titled by conversation kind so the layout is exercised, and
turning it on later is a render swap inside one component, not a layout change.

The placeholder appears only when `typeInsights.kind` is `sales` or `interview` — a
`casual` call has no insights arm and shows nothing, rather than promising something
that will never arrive.

`overview` is left unrendered — `tldr` covers the same ground in the space available.

---

## 4. Gaps — where the mock has no data behind it

Each is a ruling, not an open question, unless §11 says otherwise.

1. **The mic orb has nothing to toggle.** Real capture is Phase 9. **Ruling:** build
   the orb with its full animation set and drive it from *socket* state —
   connected → "Capturing both sides", disconnected/paused → "Capture paused". The
   component's props are already the right shape for Phase 9; swapping the source is
   a one-line change with no visual delta.
2. **"Grounded in: Acme · Mar 2026" chips have no data.** RAG snippets are retrieved
   server-side and never sent to the client. **Ruling: cut.** Adding them means a new
   wire field carrying snippet provenance — a follow-up, not this PR. Faking them is
   not an option.
3. **The suggestion is free-form text, not `{headline, lines[], grounds[]}`.**
   `suggestion.delta` carries a markdown-ish string. **Ruling:** style it through the
   existing `markdown-lite` renderer — first paragraph takes the headline treatment,
   list items take the accent-dot bullets. Same look, real data, no prompt change
   (prompt work is explicitly deferred).
4. **No participant name.** "Dana Whitfield" is not in the schema. **Ruling: cut** the
   subtitle. A `participant` column is a later migration if wanted.
5. **Action-item checkboxes have no persistence.** **Ruling (Gustavo, 2026-07-28 —
   overrides the first draft's "display only"):** build the persistence. A checkbox
   that unchecks itself on refresh is bad UX, and display-only checkboxes invite the
   tap anyway. Full design in §6.3.
6. **Search has no backend.** **Ruling: cut** the search field from this PR.
7. **"18 this month".** Cheap on the server (`count` with a date predicate). **Ruling:**
   include it in the list response.

---

## 5. The live-notes surface

Live notes appear in **two** places.

### 5.1 During the call — the capture card is tabbed

**Ruling (Gustavo, 2026-07-28 — supersedes the first draft, which had no live-notes
surface on the Live screen at all):** the capture card's content area splits into two
tabs, **Transcript** and **Live notes**, switched the same way the Live/Meetings bar
switches screens.

Three constraints, all binding:

- **The card does not change size.** It keeps the mock's `min-height: 120 /
  max-height: 176`. Whichever tab is showing scrolls inside that fixed frame.
- **Both tabs keep updating while hidden.** Neither is a mount-on-demand view.
  Implementation: both panels stay mounted and are toggled with `display: 'none'`,
  which preserves scroll position and internal state for free. State lives in the
  hooks (`use-live-session`, `use-live-notes`) regardless, so even a remount loses
  nothing — the `display` toggle is about scroll position, not correctness.
- **They switch independently of the main tab bar.** Leaving the Live screen and
  coming back does not reset which sub-tab was showing.

Because a hidden tab still updates, the inactive tab shows an unread affordance — a
small accent dot — when new content has landed since it was last visible. That is the
whole reason to keep both live.

**Live notes in 176px** cannot be the full detail layout. The in-call panel is a
condensed view: the `tldr` paragraph, then decisions and action items as single-line
compact rows, scrollable. Newly changed items animate in with `riseIn`. Everything
else (quotes, owners, deadlines, open/risk, insights) is post-call only, in the detail
screen — where there is room for it.

### 5.2 After the call — the detail screen

The read model already prefers `notes` when non-null and falls back to `live_notes`,
so a meeting whose `notes_status` is `queued|processing` shows the shimmer "Writing
notes" pill in the list, and opening it renders the detail screen from `live_notes`,
subscribed to `notes.update` while that meeting is the active session.

### 5.3 The rev rule

**Non-negotiable, from `live.ts:269`:** drop any `notes.update` whose `rev` is ≤ the
last seen rev. Out-of-order delivery across a reconnect is the failure this guards.
One implementation (`applyNotesUpdate`) serves both surfaces; both read the same hook.

---

## 6. Server work

Three new routes. They live in a new `modules/meetings/` module following the standard
anatomy (`ports.ts` / `routes.ts`), reusing the `db/notes-source.ts` reader patterns.

### 6.1 `GET /meetings` — the list model

Returns a **projection**, never the raw notes blob. Rationale, in order of weight:

1. `meetings.notes` holds two schema versions. `storedNotesSchema` + `upcastNotesV1`
   normalise v1 rows on read, and that boundary lives on the server. A client reading
   the column directly would break on every pre-slice-1 row.
2. The card fields (`tldr`, `conversationType`, `actionItems.length`) are inside the
   jsonb. Projecting server-side keeps schema knowledge out of the app.
3. `GET /meetings/:id/notes` already goes through the server to compose three sources
   behind a uniform 404. A second read path for the same table splits that.
4. Search/filter/paging land cheaply as query params later.

Response item shape (new schema in `packages/shared`):

```ts
export const meetingListItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  notes_status: notesStatusSchema,
  tldr: z.string().nullable(),            // notes.tldr ?? live_notes.tldr ?? null
  conversation_type: conversationTypeSchema.nullable(),
  action_item_count: z.number().int().nonnegative(),
  has_follow_up: z.boolean(),
});

export const meetingListResponseSchema = z.object({
  meetings: z.array(meetingListItemSchema),
  month_count: z.number().int().nonnegative(),
});
```

Ordering: `started_at desc nulls last, created_at desc`. Soft-deleted rows excluded.
User-scoped. Capped at 100 items for now — **and the cap is logged**, not silent.

### 6.2 `GET /meetings/:id/transcript`

Separate from the notes route on purpose: notes is polled while a call is folding,
transcripts are opened on demand and can be large. Lazy-loaded when the tab is tapped.

```ts
export const transcriptTurnSchema = z.object({
  speaker: z.string().nullable(),
  ts_ms: z.number().int().nonnegative().nullable(),
  content: z.string().min(1),
});
export const transcriptResponseSchema = z.object({
  turns: z.array(transcriptTurnSchema),
});
```

Same uniform-404 posture as the notes routes: missing, foreign, or soft-deleted
meetings are indistinguishable. Ordered by `ts_ms asc nulls last, created_at asc`.

### 6.3 Action-item completion — `note_item_state` + the write route

The hard part is not storing a boolean. It is **which item the boolean belongs to.**

Note ids (`a1`, `a2`, …) are positional counters minted server-side, not durable
identities. `POST /meetings/:id/notes/regenerate` re-runs the whole pipeline, so `a2`
after a regenerate can be a different action item than `a2` before it. Keying
completion on the id alone would silently move a user's checkmark onto a different
task — worse than losing it.

The codebase already solved this exact problem class. `reconcile-ids.ts` carries live
ids onto post-call items by **jaccard similarity ≥ `RECONCILE_THRESHOLD` (0.6)** over
`normalizeForMatch` word sets, so an hour of accrued items does not blink out and
re-mint at hangup. Completion reuses that mechanism rather than inventing a hash.

**The table** (new migration; RLS ships with it, RULES §4.9):

```sql
create table public.note_item_state (
  meeting_id   uuid not null references public.meetings (id),
  user_id      uuid not null references public.profiles (id),
  item_id      text not null,          -- 'a1', 'a2' — positional, not durable
  item_text    text not null,          -- the text as it was when checked
  completed_at timestamptz,            -- null = explicitly uncompleted
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  primary key (meeting_id, item_id)
);
create index note_item_state_user_id_idx on public.note_item_state (user_id);
```

**Posture: server-authored writes, same as `live_notes`.** `authenticated` gets
`select` only — no insert/update policy, no insert/update grant. This codebase has
been bitten twice by blanket client write grants (`profiles` self-setting
`plan`/`role`, `meetings` and its `indexed_at` vendor-spend vector). `note_item_state`
carries no privilege-bearing column, so a client write grant would be *defensible*
here — but going through the server also lets it reject `item_id`s that do not exist
in the meeting's notes, which keeps the table free of junk rows. That validation is
worth the ~40 lines.

**Write:** `PUT /meetings/:id/notes/items/:itemId` with `{ completed: boolean }`.
Behind `requireAuth`, uniform 404 for missing/foreign/soft-deleted meetings, 404 when
`itemId` is not an action item in the current notes. The server reads the item's
current text and stores it alongside — the client never supplies `item_text`, so it
cannot desync the guard.

**Read:** `GET /meetings/:id/notes` merges completion onto each action item, so the
client renders a plain boolean and holds no matching logic:

```ts
// added to noteActionItemSchema's read model (response only, never stored in notes)
completed: z.boolean(),
```

**The staleness rule**, applied at merge time: a stored row counts as completed only
when its `item_text` still matches the current item at that `item_id` at jaccard ≥
0.6. Below the threshold the item is treated as *different*, and it renders unchecked.
Rewording survives; replacement does not. Self-healing, and honest either way — the
alternative is a checkmark that quietly migrates to a task the user never finished.

Rows are never hard-deleted here; `deleted_at` and the purge-list obligation apply
exactly as for `live_notes` (§7 of live-notes.md).

**Not in scope:** moving meeting *creation* off supabase-js in `use-live-session`. It
is a trivial insert with no projection or versioning concern. Noted as a follow-up.

---

## 7. Mobile architecture

### 7.1 Design system — `src/design/`

The current `constants/theme.ts` carries five colours and a spacing scale. The mock
needs a full token set. New files:

- `design/tokens.ts` — the complete light/dark token pair transcribed from the mock:
  `accent`, `accent2`, `accentSoft`, `accentGlow`, `hot`, `screen`, `ink/ink2/ink3`,
  `glass`, `glassHi`, `stroke`, `stroke2`, `sheen`, `shadow`, plus radii and type scale.
  oklch values converted to hex/rgba at authoring time (React Native has no `oklch()`).
- `design/glass.tsx` — `<GlassCard>`, `<GlassPill>`, `<GlassButton>` over
  `expo-glass-effect` (already a dependency), with a documented non-blur fallback.
- `design/motion.ts` — the reanimated equivalents of the mock's keyframes:
  `riseIn`, `cardIn`, `shimmer`, `recDot`, `dotWave`, `ring`, `starPulse`, `caret`.
  Durations and cubic-beziers copied from the mock exactly.

`constants/theme.ts` is kept and re-exports from `design/tokens.ts` so existing
screens keep working; it is not rewritten in this PR.

**Reduced-motion:** every looping animation respects `AccessibilityInfo.isReduceMotionEnabled`.
The mock's animations are decorative — none carries information that is lost when stilled.

### 7.2 Screens

| Route | State |
|---|---|
| `(app)/live.tsx` | **restyled** to the mock; keeps `useLiveSession`, keeps the role gate |
| `(app)/meetings.tsx` | **new** — list |
| `(app)/meetings/[id].tsx` | **new** — detail, three tabs |
| `(app)/account.tsx` | **moved** from `index.tsx` — reached from the Meetings header |
| `(app)/explore.tsx` | **deleted** — Expo starter template cruft |

### 7.3 Tab bar and Account

The mock replaces the native tab bar with a floating glass pill (Live · Meetings),
with a pulsing rec dot on Live. That means moving from `NativeTabs` to `Tabs` with a
custom `tabBar`.

**Account (Gustavo, 2026-07-28):** a glass avatar button in the **Meetings header**
pushes the account screen. The tab bar stays exactly two pills, as drawn. The existing
screen keeps its content unchanged (health, `/me`, sign-out, delete account) and is
only restyled and rehomed; `index.tsx` becomes the Meetings list so the app opens
there.

**Live stays role-gated (Gustavo, 2026-07-28).** Without mic capture a customer cannot
start a call, so shipping a Live tab whose orb does nothing is worse than not shipping
it. `use-role` continues to hide it for customers, who see Meetings + Account. Phase 9
removes the gate when the orb becomes real.

### 7.4 Features — `src/features/`

- `features/meetings/` — `meeting-card.tsx`, `meeting-list.tsx`, `status-pill.tsx`,
  `filter-chips.tsx`, `section-grouping.ts` (pure)
- `features/notes/` — `notes-panel.tsx`, `decision-item.tsx`, `action-item.tsx`,
  `insight-cards.tsx`, `follow-up-panel.tsx`, `transcript-panel.tsx`
- `features/live-call/` — existing files restyled; new: `mic-orb.tsx`,
  `capture-card.tsx` (the fixed-height tabbed frame from §5.1), `sub-tabs.tsx`
  (the Transcript/Live-notes switcher with its unread dot), `live-notes-panel.tsx`
  (the condensed in-call view)

### 7.5 Hooks

- `use-meetings()` — list + `month_count`, refetch on focus
- `use-meeting-notes(id)` — the notes read model; polls while `queued|processing`
- `use-live-notes(meetingId)` — subscribes to `notes.update`, enforces the rev rule,
  and exposes `hasUnseen` so a hidden tab can show its accent dot. Serves both §5.1
  and §5.2 — one subscription, one rev guard, two renderers.
- `use-follow-up(id)` — POST per tone, caches per tone, maps 409/429/503 to typed UI states
- `use-item-completion(meetingId)` — optimistic toggle over
  `PUT /meetings/:id/notes/items/:itemId`, reverting on failure

Screens stay dumb; hooks own state (RULES §10).

### 7.6 Pure logic — extracted for testability

`features/**/**.ts` (non-tsx) holds everything worth a unit test:
`groupMeetingsByRecency`, `formatDuration`, `formatCallClock`, `statusToPill`,
`applyNotesUpdate` (the rev rule), `groupTranscriptBySpeaker`, `parseSuggestionShape`.

---

## 8. Error and empty states

The mock shows only happy paths. Required additions, styled to match:

| State | Treatment |
|---|---|
| No meetings yet | Glass card: what Nova does + how a call starts |
| `notes_status: failed` | Card with a retry button → `POST .../regenerate` |
| Notes read fails | Inline error inside the glass frame; retry |
| Follow-up 429 (quota) | Paywall copy, no retry loop |
| Follow-up 503 (`daily_cap_reached`) | "Temporarily unavailable" — not the user's fault |
| Follow-up 409 (`notes_not_ready`) | Tone buttons disabled + explanation |
| Socket closed `quota_exceeded` / `concurrent_session` | Typed banner on Live |
| Offline | Cached list where available; a plain banner otherwise |

---

## 9. Testing

`apps/mobile` has **no test infrastructure today**. This PR adds vitest + React
Native Testing Library, wired into the root `npm run test`.

**Unit (pure, no renderer):**
- `applyNotesUpdate` — accepts rev+1, **drops rev ≤ last**, drops out-of-order
- `groupMeetingsByRecency` — today / this week / earlier, across a local midnight
- `formatDuration` — null `started_at`, null `ended_at`, sub-minute, multi-hour
- `statusToPill` — all five `notes_status` values
- `groupTranscriptBySpeaker` — null speaker, null `ts_ms`, consecutive same-speaker
- `parseSuggestionShape` — headline/bullet split over a mid-stream partial delta,
  a body with no list items, and a body that is a bare paragraph

**Component (RNTL):**
- Meeting card renders each status pill
- Notes panel with null quotes, empty arrays, both `typeInsights` kinds
- Follow-up panel renders 409/429/503 states
- List renders the empty state
- Action item reflects `completed`, and an optimistic toggle reverts on a failed write
- **Capture card (§5.1):** the hidden tab still receives updates; switching tabs does
  not remount or reset scroll; the unread dot appears on the hidden tab and clears on
  reveal; the card's height is unchanged by either tab's content volume

**Server (vitest, existing harness):**
- `GET /meetings` — projection shape, ordering, soft-delete exclusion, user scoping,
  `tldr` fallback to `live_notes`, `month_count`, the 100 cap
- `GET /meetings/:id/transcript` — ordering, uniform 404 for missing/foreign/deleted
- `PUT /meetings/:id/notes/items/:itemId` — 404 for an `itemId` absent from the notes,
  404 for foreign/deleted meetings, idempotent re-check, uncheck writes null
- **The staleness rule (§6.3):** completion survives a reworded item at jaccard ≥ 0.6,
  and is dropped when the item at that id is replaced by a dissimilar one — asserted
  against a real regenerate, not a hand-built row
- RLS integration tests for all three, incl. proof that `authenticated` cannot write
  `note_item_state` directly (mirroring `live-notes-rls.integration.test.ts`)

**Manual:** iOS simulator, both themes, a real session end to end.

---

## 10. Out of scope

Search backend · "grounded in" chips · participant names · prompt changes · real mic
capture (Phase 9) · moving meeting creation off supabase-js · the `DELETE /account`
purge consumer (pre-launch blocker, tracked in live-notes.md §13 F3)

`note_item_state` must be added to the purge-job table list when that job is written.

---

## 11. Decisions

All open questions were settled by Gustavo on 2026-07-28. Nothing here is pending.

| # | Decision | Where |
|---|---|---|
| 1 | Action-item completion is **built**, not cut | §6.3 |
| 2 | The in-call capture card is **tabbed** Transcript / Live notes | §5.1 |
| 3 | `typeInsights` ships as a **"coming soon" placeholder** card | §3 |
| 4 | Account lives behind a **header button on Meetings** | §7.3 |
| 5 | The Live tab **stays role-gated** until Phase 9 | §7.3 |
| 6 | `explore.tsx` is **deleted** | §7.2 |
| 7 | Meetings/transcript reads go through **new server routes**, not supabase-js | §6 |

---

## 12. Slicing

Each slice is a commit; `npm run check` green at every one.

| # | Slice |
|---|---|
| 1 | Server: `GET /meetings` + `GET /meetings/:id/transcript`, shared schemas, tests, RLS integration |
| 2 | Server: `note_item_state` migration + RLS, the jaccard staleness merge, `PUT .../items/:itemId`, `completed` on the read model |
| 3 | Mobile test harness (vitest + RNTL) wired into root `npm run test` |
| 4 | Design system: tokens, glass primitives, motion, reduced-motion |
| 5 | Tab bar: `Tabs` + custom floating glass bar, role gate preserved, `explore.tsx` removed |
| 6 | Meetings list: hook, card, pills, filters, grouping, empty/error states |
| 7 | Detail — Notes tab: tl;dr, decisions, action items **with working checkboxes**, open/risk, insights |
| 8 | Detail — Follow-up + Transcript tabs, incl. the typed error states |
| 9 | Live screen restyle: mic orb, "What to say" card, and the **tabbed capture card** (§5.1) |
| 10 | Live notes: `use-live-notes`, the rev rule, the unread dot, wired into both surfaces |
| 11 | Docs: `adr-0010-notes-ui`, ARCHITECTURE, CLAUDE, this file's build status |

The pre-existing CodeRabbit critical in `use-live-session.ts` (`start()` does not
re-check for unmount after the async meeting insert resolves) is fixed in slice 8,
where that file is already being touched.
