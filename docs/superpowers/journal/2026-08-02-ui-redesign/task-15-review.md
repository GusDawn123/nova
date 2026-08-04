# Task 15 review — Meetings list: refresh on focus + poll while notes are writing

Reviewed: `4cd5d1e..3323228` (one commit, 3 files, +386/−4).
Reviewer method: read the full diff in context, opened all three touched files,
re-ran the gate, then **mutation-tested the hook against its own suite** (10
mutations) and wrote a throwaway probe suite to prove five behaviours the
committed tests do not assert. All probe/mutation edits were reverted; working
tree is identical to `3323228`.

## Verdicts

- **Spec: ✅** — every required behaviour is implemented, in the right place, and
  mechanically proven. One caveat, below: the brief's clause *"No behavior change
  for error/signed-out states"* is violated on a path the brief did not
  anticipate (Important-1).
- **Quality: needs-fixes** — one user-visible regression on the failure path
  (Important-1/-2, one shared fix) and one test-honesty gap (Important-3).
  No Critical findings. The design itself is sound and unusually well reasoned;
  the refs-vs-state choices, the stable `refetch` identity, the boolean poll gate
  and the exhaustive `Record<NotesStatus, boolean>` are all correct and I
  confirmed each one is load-bearing by breaking it.

## Verification I ran myself (not taken from the report)

| Check | Result |
| --- | --- |
| `npm run check` (root) | PASS — typecheck + lint + **1250 passed / 210 skipped / 0 failed**, 146 files. Matches the report exactly. |
| `npx vitest run apps/mobile` | 45 files, 448 passed |
| `npx vitest run apps/mobile/src/hooks/use-meetings.test.ts` | 9 passed |
| `apps/mobile` `npx tsc --noEmit` | clean (no `any`, strict) |
| `apps/mobile` `npx expo lint` | clean |
| New dependency? | **No** — `@testing-library/react@^16.3.2` already in `apps/mobile/package.json:42` |
| Test under `apps/mobile/src/app/`? | **No** — new test is `src/hooks/`; `testing/router-directory.test.ts` guard passes |
| File size cap | `use-meetings.ts` 244 lines (cap ~400) |
| Public `UseMeetings` interface | unchanged |
| zod boundary | untouched (`meetingListResponseSchema.safeParse`, field-paths-only warn preserved) |

### Mutation testing — 9 of 10 mutations caught

I reverted each mutation after running it.

| Mutation | Suite | 
| --- | --- |
| Remove the focus refetch | ✅ caught (1 fail) |
| Drop the `!focused` guard from the poll | ✅ caught |
| Focus refetch sets `refreshing` | ✅ caught |
| `failed: true` in the working set | ✅ caught |
| `none: true` in the working set | ✅ caught |
| Remove the `settled.current` mount guard | ✅ caught (8 fails) |
| Delete the `clearInterval` cleanup | ✅ caught |
| Poll ignores `writingNotes` | ✅ caught |
| `POLL_INTERVAL_MS` 5000 → **20000** | ✅ caught |
| `POLL_INTERVAL_MS` 5000 → **1000** | ❌ **PASSES** — see Important-3 |

Read positively: the suite is honest about *whether* a request happens and about
every teardown path. It is not honest about the poll's *rate* from below.

---

## Findings

### Critical

None.

### Important

#### Important-1 — A failing SILENT refetch destroys the visible list and replaces it with the full-screen error card

`apps/mobile/src/hooks/use-meetings.ts:170-176` (the `catch` in `load()`), consumed
by `apps/mobile/src/app/(app)/(tabs)/index.tsx:109-115`.

The `catch` writes `{ status: 'error' }` unconditionally. Before this commit, the
only fetches that could reach it were the mount fetch and a *user-initiated*
`refresh()` — so an error card was always the answer to something the user did.
This commit adds two fetches the user never asked for, and they inherit the same
destructive failure handling.

**Proven** (throwaway probe, since deleted):

- P1: success (`processing`) → the 5 s poll returns HTTP 500 → `state.status`
  becomes `'error'`.
- P2: success (`completed`) → focus refetch rejects (`Network request failed`) →
  `state.status` becomes `'error'`.

**Failure scenario.** The user is watching the card they came here for —
`WRITING NOTES` — and the phone hands off Wi-Fi to LTE, or the access token
expires and the poll gets a 401, or the server 500s once. With no touch and no
gesture, the entire archive vanishes and is replaced by
`COULD NOT LOAD YOUR CALLS` / `server returned HTTP 500`. `sections` also goes
empty because `state.status !== 'success'`, so there is nothing left on screen
but the error card. The same thing happens simply by returning to the Meetings
tab on a flaky connection.

Note this is *not* the superseded-request case — a poll that is aborted by a
newer poll has `cancelled === true` and correctly stays silent
(`use-meetings.ts:171`). This is a genuine single failure.

Against the brief: *"the list re-fetches **silently**: in place"* and *"No
behavior change for error/signed-out states, except that a focus refetch
naturally retries a previously errored fetch."* The granted exception is
errored → retried. Success → silently errored is a new behaviour, and it is the
opposite of "in place".

**Fix (shared with Important-2).** A fetch the user did not ask for must not be
allowed to demote a good `success` state. Thread the user-initiated-ness alongside
the nonce (e.g. `const [req, setReq] = useState({ n: 0, silent: false })`, or a
`silentRef` set by `refetch()` and cleared by `refresh()`), and in the `catch`:

```ts
if (!cancelled) {
  // A refetch the user did not ask for may not take away a list they are reading.
  if (silent && fetchedRef.current.status === 'success') {
    // keep the last good data; the next poll or focus heals it
  } else {
    setFetched({ status: 'error', message: ... });
  }
}
```

Then extend the suite with the two probes above, inverted: *a failed silent
refetch leaves `state.status === 'success'` and the previous meetings intact*,
and *a failed manual `refresh()` still shows the error card*.

#### Important-2 — One transient blip permanently stops the poll

`apps/mobile/src/hooks/use-meetings.ts:218-232`.

`writingNotes` is derived from `fetched`, so the moment Important-1 flips
`fetched` to `error`, `writingNotes` goes false and the interval effect's cleanup
clears the ticker. It never restarts on its own.

**Proven** (P3): `processing` list polling normally → one poll rejects → fetch
count is 2 and stays 2 across a further **60 s**. The `WRITING NOTES` → `NOTES
READY` transition — the entire reason this task exists — is dead until the user
pulls to refresh or leaves and re-enters the tab.

The implementer flagged this as a deliberate conservative choice (report concern
3). I disagree that it should ship as-is: it is only "conservative" because the
error state is destructive, and it silently defeats the feature. Note that
Important-1's fix dissolves this one — if a silent failure leaves the last good
data alone, `writingNotes` stays true and the poll simply continues at its 5 s
cadence, which is exactly what a poll is for. If a retry storm against a dead
server is a worry, cap it (e.g. stop after N consecutive silent failures); do not
buy it by throwing the list away.

#### Important-3 — The suite does not pin the poll interval from below; a 1 s poll ships green

`apps/mobile/src/hooks/use-meetings.test.ts:204-228`.

Mutating `POLL_INTERVAL_MS` from `5_000` to `1_000` leaves **all 9 tests
passing**. (20 000 is caught, so only the lower bound is unguarded.)

The reason is subtle and worth recording: inside a single
`act(async () => vi.advanceTimersByTimeAsync(5000))`, the five interval
callbacks all call `refetch()` → `setNonce(n => n + 1)`, and React 18 batches
those five updates into **one** re-render, so the fetch effect runs once. The
test's `toHaveBeenCalledTimes(2)` therefore cannot distinguish 5000 ms from
1000 ms — it is measuring batched renders, not the timer.

**Failure scenario.** A later edit (or a bad merge) drops the interval to 1 s.
The brief's own justification for 5000 — battery and bill on a phone on cellular
— is violated 5× over, and CI is green.

**Fix, verified against the current code.** Split the advance in
`'polls for a queued meeting too'`:

```ts
await tick(4999);
expect(fetchMock).toHaveBeenCalledTimes(1); // observed: 1
await tick(1);
expect(fetchMock).toHaveBeenCalledTimes(2); // observed: 2
```

I ran exactly this against the shipped hook (probe P4) and it holds: 1 call at
t=4999, 2 at t=5000. Three lines, and the interval is then pinned on both sides.

### Minor

#### Minor-1 — No floor between focus refetches; flicking tabs is one GET per return

`apps/mobile/src/hooks/use-meetings.ts:203-211`. Proven (P5): five
blur/focus cycles produce five extra `GET /meetings` (6 total). Concurrency is
bounded — the effect cleanup aborts the superseded request, so they never stack —
so this is bandwidth, not corruption, and it matches how `refetchOnWindowFocus`
behaves elsewhere in the industry. Worth a staleness floor eventually (skip a
focus refetch within ~1 s of the last landed one); not a blocker.

#### Minor-2 — `settled` is "anything landed", not "the mount focus already fetched"

`apps/mobile/src/hooks/use-meetings.ts:110, 206`. If the Meetings screen ever
mounts **unfocused** (a preloaded tab, or a future `TabSlot` render function),
the mount fetch sets `settled.current = true` and the first real focus then fires
a second `GET` immediately — the double-fetch the ref exists to prevent, just
shifted. Today Meetings is the initial route of `expo-router/ui`'s `Tabs`
(`apps/mobile/src/components/app-tabs.tsx:89-105`), so it mounts focused and the
guard works. Flagging the assumption, not a live bug.

#### Minor-3 — The poll follows navigation focus, not app foreground

`apps/mobile/src/hooks/use-meetings.ts:222-232`. Backgrounding the app with the
Meetings tab focused and a meeting `processing` leaves the interval armed; there
is no `AppState` gate. iOS suspends JS within seconds and RN throttles background
timers, so the practical cost is near zero, and the brief did not ask for it.
Note only.

#### Minor-4 — `refreshing` can stick `true` if the session disappears mid-pull

`apps/mobile/src/hooks/use-meetings.ts:126-129, 135`. `refresh()` sets
`refreshing`, then sign-out changes `accessToken` → the effect re-runs and
early-returns at line 135 before the `finally` that would clear it. **Pre-existing**
(not introduced by this diff), and the signed-out branch does not render the list,
so it is unobservable today. Recorded for completeness.

#### Minor-5 — The report's "Prettier clean" line is vacuous evidence

`apps/mobile/` is listed in `.prettierignore`, and the root eslint config ignores
it too (mobile is covered by `expo lint`, which I ran clean). Nothing to fix in
the code — just do not read that line as a check that passed. Everything that
does apply (mobile `tsc --noEmit`, `expo lint`, the full `npm run check`) is
green, verified above.

#### Out of scope, noted once

After sign-out → sign-in as a *different* user, `fetched` still holds the previous
user's meetings until the new fetch lands. Pre-existing, unchanged by this diff,
and the new focus refetch marginally shortens the window. Belongs to the spec §10
wire workstream, not here.

---

## The implementer's own concerns — my judgement

1. **Not verified on device/simulator** — correct and unavoidable; jsdom cannot
   prove `expo-router`'s real `useFocusEffect` fires on a native tab return. Low
   risk: `index.tsx` has been calling the same `useFocusEffect` import for the
   clock since before this task, and Gustavo's bug report ("the meeting is
   missing until reload") is itself evidence that the screen stays mounted and
   focus events are the right hook. The stated simulator check is the right one.
   **⚠️ Cannot verify from diff.**
2. **The narrow `none` race** — agree, not a defect. `none` is also the permanent
   state of a meeting that never connected; polling it would arm a timer that can
   never stop. Self-heals on the next focus. Leave it.
3. **An errored poll stops polling** — **this one IS a defect.** Promoted to
   Important-2; see above. It is not conservative, it is the feature failing
   closed on a network blip, and it is caused by Important-1 rather than chosen
   independently.
4. **`useMeetings` is now navigator-bound** — accurate and acceptable. Its only
   consumer is `(app)/(tabs)/index.tsx`, and the one screen test that renders
   that screen mocks `@/hooks/use-meetings` wholesale
   (`apps/mobile/src/screen-tests/tabs-index.test.tsx:36`), so no test renders the
   real hook outside a navigator. Confirmed by grep: no other consumer exists.

## Spec compliance, clause by clause

| Brief clause | Verdict | Evidence |
| --- | --- | --- |
| Focus refetch is silent, in place, never sets `refreshing` | ✅ | mutation "focus refetch sets `refreshing`" is caught |
| Polls every 5000 ms while `success` && any `queued`/`processing` | ✅ code / ⚠️ test | constant is correct; lower bound unguarded (Important-3) |
| Stops when no working meetings remain | ✅ | mutation "poll ignores `writingNotes`" caught |
| Stops on sign-out | ✅ | dedicated test; `accessToken` in the effect gate |
| Stops on unmount | ✅ | mutation "delete `clearInterval`" caught |
| Stops on blur | ✅ | mutation "drop `!focused`" caught; the stub drives real blur cleanup |
| Manual `refresh()` keeps its spinner | ✅ | `true` → `false` asserted |
| Working set exactly `queued`\|`processing` | ✅ | `Record<NotesStatus, boolean>` is exhaustive; both `failed: true` and `none: true` mutations caught |
| ALL logic in the hook; screen stays dumb | ✅ | `index.tsx` diff is 4 comment lines, zero code |
| No `refresh()` added to the screen's clock effect | ✅ | confirmed |
| TS strict, no `any`; zod boundary unchanged | ✅ | `tsc --noEmit` clean; parse block byte-identical |
| No new dependencies | ✅ | `@testing-library/react` already present |
| No test under `apps/mobile/src/app/` | ✅ | guard test passes |
| ~400-line cap | ✅ | 244 lines |
| `npm run check` green | ✅ | re-run: 1250 / 210 skipped / 0 failed |
| No behaviour change for error state | ❌ | **Important-1** — a silent refetch can now create an error state with no user action |

## What I could not verify from the diff

- **⚠️ Native focus behaviour.** That `expo-router`'s `useFocusEffect` fires on
  focus and runs its cleanup on blur for `expo-router/ui` headless `Tabs` on a
  real device. The test stub models the contract faithfully but is a stub.
  Gustavo's simulator check (end a call → the meeting appears without a pull, pill
  reads `WRITING NOTES`, flips to `NOTES READY` within ~5 s, and no spinner ever
  appears at the top of the list) is the right and necessary confirmation.
- **⚠️ Whether `TabSlot` keeps the Meetings screen mounted across tab switches**
  on device. The whole premise (and Minor-2) rests on it. Strongly implied by the
  original bug report, not proven here.

## Recommendation

Fix **Important-1 + Important-2** (one change: a silent refetch must not demote a
good `success` state, with the two inverted probes added as tests) and
**Important-3** (three lines, split the timer advance). Both are small and local
to `use-meetings.ts` / `use-meetings.test.ts`. Everything else is approve-as-is,
and the Minors can ride a later task.

---

# RE-REVIEW — `3323228..db466ca` ("A refetch nobody asked for may not take the list away")

Scope: my three Important findings, plus regressions the fix itself could
introduce. Filed Minors were not re-opened. Method: read the fix diff and the
resulting file, re-ran the gate, re-ran the two mutations that previously escaped,
ran **7 new mutations** aimed at the fix's own logic, and wrote a 7-case probe
suite for the overlap/edge paths the coordinator named. All probe and mutation
edits reverted; working tree is identical to `db466ca`.

## Per-finding verdict

| Finding | Verdict | Proof |
| --- | --- | --- |
| **Important-1** — a failing silent refetch destroys the visible list | **fixed** | Deleting the preserve line fails 2 tests; flipping `refetch()` to `silent: false` fails the same 2. Probes: a 500 on a poll tick and a rejected focus refetch both leave `state.status === 'success'` with the list intact. |
| **Important-2** — one blip permanently stops the poll | **fixed** | The committed test carries it through: blip at t=5000 (fetch 2, list preserved), then `processing → completed` lands at t=10000 (fetch 3). `writingNotes` now reads a `success` state that the blip could not demote, so the gate never falls. |
| **Important-3** — poll interval unpinned from below | **fixed** | The split advance works and is tight to the millisecond: `POLL_INTERVAL_MS` → **1000** is now CAUGHT (it escaped before), and so is **4999**. |

The mechanism is the right one. `silent` riding *inside* the request object rather
than in a parallel ref is the correct call — the flag and the counter cannot
disagree about which request is which, and the `catch` reads the flag from its own
effect closure, so there is no stale-closure hazard.

### Mutation results on the fixed code (7 run)

| Mutation | Result |
| --- | --- |
| `POLL_INTERVAL_MS` 5000 → 1000 (previously escaped) | ✅ **now caught** |
| `POLL_INTERVAL_MS` 5000 → 4999 | ✅ caught |
| Delete the silent-preserve line (restore old behaviour) | ✅ caught (2 fails) |
| `refresh()` becomes `silent: true` | ✅ caught |
| `refetch()` becomes `silent: false` | ✅ caught |
| Initial request `{ n: 0, silent: true }` | escaped — **equivalent mutant** (see below) |
| Drop `&& previous.status === 'success'` | escaped — near-equivalent (see below) |

Neither escape is a real gap. The initial request's `silent: false` is *redundant*
for the first load, because `previous.status` is `'loading'` there and the success
guard already fails — the flag is doing nothing on that path. Dropping the success
guard only changes a cosmetic case (a repeat silent failure over an existing error
would freeze the old message instead of updating it); the shipped code updates it
correctly, which I confirmed (probe Q3: 500 → focus retry 503 → the card reads
503). Not worth a test.

## Regressions the fix could have introduced — all clear

Every one of these was run as a probe against `db466ca`:

- **Q1 — pull started while a poll request is in flight.** The pull supersedes the
  poll, its own 500 is reported, `refreshing` returns to `false`. Correct.
- **Q2 — poll tick supersedes an in-flight pull.** No stuck spinner, no lost data,
  no wrong error: `refreshing` clears and the list stands. See Minor-6 for the one
  wrinkle.
- **Q3 — silent failure while `previous` is `error`.** Falls through to the error
  branch and refreshes the message (503 replaces 500). Correct.
- **Q4 — healing.** Error → focus refetch succeeds → `success`. The brief's
  "a failed list heals by being looked at again" still holds.
- **Q5 — no render/fetch runaway from the object dep.** 1 fetch across 60 s idle.
  `useState` keeps the initial `{ n: 0, silent: false }` identity, so `request` is
  referentially stable until something calls `setRequest`. No loop.
- **`previous` can never be `signed-out`** — `fetched` is only ever `loading`,
  `success` or `error`; `signed-out` stays derived. The functional setter's
  branches are exhaustive over what can actually be in there.
- `refreshing` never sticks in any ordering I could construct.

## New findings

**New Critical / Important: none.**

#### Minor-6 (new) — a pull whose request is superseded by a poll tick has its failure swallowed

`apps/mobile/src/hooks/use-meetings.ts:137-147, 190-202`. Proven (probe Q2): with a
`processing` meeting, pull to refresh, let the request still be in flight when the
5 s tick fires; the tick's silent request supersedes it and then fails. Result:
spinner stops, list unchanged, no error card — the user's pull silently did
nothing. Requires the pull to outlive a tick *and* the superseding request to fail,
so it is narrow; nothing is lost and a second pull works. Not worth a fix now.

#### Minor-7 (new) — the `silent` flag is sticky, so a token-rotation refetch inherits it

`apps/mobile/src/hooks/use-meetings.ts:219` (`}, [accessToken, request]`).

The effect also re-runs when `accessToken` changes, and that run reuses whatever
`request.silent` was last set to. Nobody asked for that fetch, but it can be loud.

**Proven.** Probe Q6: cold open → one successful pull-to-refresh (flag now
`false`) → Supabase rotates the token → that refetch 500s → the list is replaced
by the error card. Probe Q7 is the same sequence after a tab switch (flag `true`)
and the list correctly survives. `use-auth.tsx:85` subscribes to
`onAuthStateChange`, so `TOKEN_REFRESHED` really does mint a new `access_token`
and re-run the effect — this path is live, typically on app resume, which is
exactly when the network is least reliable. Note the default flag out of the box
is `false`, so a user who never leaves the Meetings tab sits on the loud setting.

**Why this is Minor and not a regression.** Before `3323228` *every* failure wiped
the list, so `db466ca` is strictly an improvement and introduces nothing here; this
is a pre-existing trigger the new mechanism does not classify. The blast radius is
a transient error card with a working RETRY, not lost data.

**Fix when it is next touched** (also collapses both escaped mutants): stop storing
loudness and derive it — *a failure may only reach the screen when the user asked
for it or when there is nothing good to keep*:

```ts
if (previous.status === 'success' && !userAsked) return previous;
```

where `userAsked` is set only by `refresh()` and consumed by the run it belongs to.
The first load is then loud for free (`previous` is `loading`), the initial flag
becomes unnecessary, and a token-rotation refetch is silent by default.

## Gate, re-run

`npm run check` from the repo root: **PASS — 1253 passed / 210 skipped / 0 failed**,
146 files. Matches the implementer's claim exactly. `use-meetings.test.ts` is 12
tests (was 9). `apps/mobile` `tsc --noEmit` and `expo lint` clean.

## Final verdict

**approve.** All three Important findings are genuinely fixed, each proven by a
mutation that the new tests catch rather than by assertion. The three added tests
are honest — every one of them fails when the behaviour it describes is broken.
The two new Minors are narrow, one of them pre-existing, and neither blocks the
merge. The ⚠️ device-verification items from the first review still stand
unchanged: Gustavo's simulator pass is still the last gate.
