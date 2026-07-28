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
real, populated data. Ruling: render `typeInsights` as one additional card below
"open"/"risk", styled identically, titled by kind. `overview` is left unrendered —
`tldr` covers the same ground in the space available.

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
5. **Action-item checkboxes have no persistence.** **Ruling:** render them as
   non-interactive state indicators. Interactive-but-unsaved is the one option to
   refuse — it silently loses user input.
6. **Search has no backend.** **Ruling: cut** the search field from this PR.
7. **"18 this month".** Cheap on the server (`count` with a date predicate). **Ruling:**
   include it in the list response.

---

## 5. The live-notes surface

The mock shows **no live notes on the Live screen** — every notes surface is
post-call. That is better than what `live-notes.md` assumed, and it needs no design
change, because the server read model already prefers `notes` when non-null and falls
back to `live_notes`.

So the live-notes surface is: a meeting whose `notes_status` is `queued|processing`
shows the shimmer "Writing notes" pill in the list; opening it renders the detail
screen from `live_notes`, subscribed to `notes.update` for as long as that meeting is
the active session.

**Client rule (from `live.ts:269`, non-negotiable):** drop any `notes.update` whose
`rev` is ≤ the last seen rev. Out-of-order delivery across a reconnect is the failure
this guards.

---

## 6. Server work

Two new routes. Both live in a new `modules/meetings/` module following the standard
anatomy (`ports.ts` / `routes.ts`), reusing the `db/notes-source.ts` reader patterns.

### `GET /meetings` — the list model

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

### `GET /meetings/:id/transcript`

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
| `(app)/index.tsx` | unchanged (account: health, `/me`, sign-out, delete) |
| `(app)/explore.tsx` | **deleted** — Expo starter template cruft |

### 7.3 Tab bar

The mock replaces the native tab bar with a floating glass pill (Live · Meetings),
with a pulsing rec dot on Live. That means moving from `NativeTabs` to `Tabs` with a
custom `tabBar`. The existing role gate (`use-role`, Test Live is developer/admin
only) is preserved. See §11.1 for where Account lives.

### 7.4 Features — `src/features/`

- `features/meetings/` — `meeting-card.tsx`, `meeting-list.tsx`, `status-pill.tsx`,
  `filter-chips.tsx`, `section-grouping.ts` (pure)
- `features/notes/` — `notes-panel.tsx`, `decision-item.tsx`, `action-item.tsx`,
  `insight-cards.tsx`, `follow-up-panel.tsx`, `transcript-panel.tsx`
- `features/live-call/` — existing files restyled; the mic orb is new

### 7.5 Hooks

- `use-meetings()` — list + `month_count`, refetch on focus
- `use-meeting-notes(id)` — the notes read model; polls while `queued|processing`
- `use-live-notes(meetingId)` — subscribes to `notes.update`, enforces the rev rule
- `use-follow-up(id)` — POST per tone, caches per tone, maps 409/429/503 to typed UI states

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

**Server (vitest, existing harness):**
- `GET /meetings` — projection shape, ordering, soft-delete exclusion, user scoping,
  `tldr` fallback to `live_notes`, `month_count`, the 100 cap
- `GET /meetings/:id/transcript` — ordering, uniform 404 for missing/foreign/deleted
- RLS integration tests for both, against real Postgres

**Manual:** iOS simulator, both themes, a real session end to end.

---

## 10. Out of scope

Search backend · "grounded in" chips · participant names · interactive checkboxes ·
prompt changes · real mic capture (Phase 9) · moving meeting creation off supabase-js ·
the `DELETE /account` purge consumer (pre-launch blocker, tracked in live-notes.md §13 F3)

---

## 11. Open questions for Gustavo

1. **Where does Account live?** The mock shows two tabs (Live, Meetings) but the app
   has a real account screen (health, `/me`, sign-out, delete account). Options: a
   third tab; a header button on Meetings; a sheet. **Recommendation:** header button
   on Meetings — keeps the mock's two-tab bar exactly as drawn.
2. **Does the Live tab stay role-gated?** Without mic capture a customer cannot start
   a call, so Live is unusable for them until Phase 9. **Recommendation:** keep the
   gate; customers see Meetings + Account. Revisit in Phase 9.
3. **`overview` and `typeInsights`** — §3 rules them into an extra card. Confirm, or
   cut `typeInsights` too.
4. **Delete `explore.tsx`?** It is unmodified Expo starter content. **Recommendation:**
   delete.

---

## 12. Slicing

Each slice is a commit; `npm run check` green at every one.

| # | Slice |
|---|---|
| 1 | Server: `GET /meetings` + `GET /meetings/:id/transcript`, shared schemas, tests, RLS integration |
| 2 | Mobile test harness (vitest + RNTL) wired into root `npm run test` |
| 3 | Design system: tokens, glass primitives, motion, reduced-motion |
| 4 | Tab bar: `Tabs` + custom floating glass bar, role gate preserved, `explore.tsx` removed |
| 5 | Meetings list: hook, card, pills, filters, grouping, empty/error states |
| 6 | Detail — Notes tab: tl;dr, decisions, action items, open/risk, insights |
| 7 | Detail — Follow-up + Transcript tabs, incl. the typed error states |
| 8 | Live screen restyle: mic orb, transcript bubbles, "What to say" card |
| 9 | Live notes: `use-live-notes`, the rev rule, wired into detail |
| 10 | Docs: `adr-0010-notes-ui`, ARCHITECTURE, CLAUDE, this file's build status |

The pre-existing CodeRabbit critical in `use-live-session.ts` (`start()` does not
re-check for unmount after the async meeting insert resolves) is fixed in slice 8,
where that file is already being touched.
