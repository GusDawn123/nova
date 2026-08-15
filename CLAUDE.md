# CLAUDE.md — Nova

Guidance for AI coding agents working in this repo.

## What this is

**Nova** — a mobile AI call copilot. Phone mic (speakerphone/acoustic capture) →
streaming STT with diarization → live text suggestions + post-call structured notes,
grounded in per-user RAG memory. Company-held API keys; users pay subscription.
Silent text copilot: no TTS, no bots joining calls, transcript-only storage.

**Stack:** npm-workspaces monorepo — `apps/server` (Node/TS, Fastify),
`apps/mobile` (React Native + Expo), `packages/shared` (zod schemas/types),
`supabase/` (Postgres + RLS + pgvector migrations).

**Status: Phase 6 metering/quotas/billing built on `dev-claude-metering` (branched off
`development@9407425`, which carries Phases 0-5 via PRs #1-#6). `modules/metering` is now REAL:
the append-only `usage_events` ledger (migration `20260722130000`, select_own RLS, service-role
writes, priced at write time from a zod price book), per-call llm meters (`stream(req, {meter})`
+ `meterFor(userId, meetingId)` threaded through the notes pipeline, follow-up, and the Voyage
sinks — the static audit `modules/metering/metering.audit.test.ts` proves no vendor path runs
unmetered), live STT billed by relayed bytes (spans flush on vendor switch/disposal/quota tick,
±5% fixture bar), plan quotas over `profiles.plan` free|pro (session start + mid-stream →
typed `quota_exceeded` close; notes claim → dead-letter; follow-up → 429), REST rate limiting
(@fastify/rate-limit 100/min, `/live` excluded), ONE live session per user (typed
`concurrent_session`), the $50/day global kill-switch (refuse-new/finish-in-flight, one alert
per UTC day — the external-TestFlight gate, E2E-proven against a seeded ledger), the llm
`invalid` error class (400/404/422 → failover once + breaker counts; the anthropic credit-400
fix), and the token-gated RevenueCat webhook (fixture-proven free→pro/downgrade/idempotent;
live RC account = Phase 8/Gustavo). Session-start gate order: concurrency → daily cap →
ownership (fail-CLOSED) → quota (fail-OPEN — ratified posture, adr-0007 amendments). GREEN
2026-07-22 stack-up: 617 passed / 19 skipped / 0 failed. New env: `REVENUECAT_WEBHOOK_TOKEN`
(optional — unset means the webhook route does not exist).
ANTHROPIC IS DISABLED (2026-07-22 cost decision): the adapter/config/smoke code is KEPT and the
price book still prices claude-haiku-4-5, but the key is commented out in `apps/server/.env` —
the factory builds no anthropic provider and its live smoke self-skips. Re-enable = uncomment
the key. Working LLM set: OpenAI + Google (groq unkeyed).**
**Phase 7 live copilot loop is built on `dev-claude-live-copilot` (branched off `development`
after Phase 6). NEW: the llm `latencyTier: "live"` cheapest-first cascade (`liveOrder`
google→groq→openai→anthropic + `liveLlmConfig()` tight TTFT/stall — reasoning stays OFF at the
adapter layer); `modules/prompt` — one pure `assemble(mode, context) → { stablePrefix,
dynamicSuffix }` over Gustavo's VERBATIM system prompt (extracted byte-for-byte from
`docs/prompts/nova-prompts-source.md` by `scripts/gen-live-prompt.mjs` into
`content/system-prompt.ts`; byte-stable prefix snapshot-pinned; dynamicSuffix = hard-guarded user
context + RAG snippets under a token budget + windowed transcript LAST); `modules/live` conductor
(`conductor.ts` + pure `trigger.ts`/`speculation.ts`) — rolling transcript, tiered trigger gate
OFF the LLM hot path (quiet in small talk), speculation on confident partials with jaccard
adopt-or-discard reconcile (never a zombie), streaming suggestion.start/delta/done coalesced
~50ms/batch, deadline-ladder active abort, RAG grounding raced against a deadline (shrink, never
delay), threading `metering.meterFor`. Wired into `LiveSession` (a `createConductor` factory built
by `metering-wiring.ts::maybeCreateLiveConductorFactory`, consumed in `modules/live/routes.ts`);
the static metering audit gained a live-router case (no unmetered live LLM path). NEW (Gustavo's
2026-07-22 follow-up): the `transcript.input` typed-utterance wire event (additive) — the server
treats typed text exactly like a final "them" STT utterance (echo down + conductor + persistence;
`input_before_start` before ready; no new vendor site — rides the metered conductor path). Mobile:
`use-live-session` owns socket+meeting+state — PRIMARY path `start()` creates a meeting via the
supabase seam and connects the REAL authed socket, `sendInput()` asks typed questions and gets
REAL streamed answers; the copilot surface is a scrollable HISTORY (start APPENDS an entry,
deltas stream into it once/frame, discard removes only that entry, auto-scroll pinned unless the
user scrolled up), compact transcript strip on top, scripted replay demoted to a labeled
secondary button. Real mic capture is Phase 8/9; durable copilot-history context = Phase 8+
design item (see DESIGN/live-pipeline.md §Mobile). GATES (2026-07-22): latency
question→first-token p50=800ms p95=1450ms (<2000/<4000), speculation-hit p50=0ms (<500),
final→visible p50=800ms (<1500); relevance 9/10 (bar ≥7, OpenAI+Google); grounding contains the
stored `$47,500` fact (Voyage+DB); quiet 11/11 small-talk silent; typed-input E2E over the real
socket+LLM: deltas=6, answer_len=883, echoed as "them", persisted (~1.9s). Live gates are
key-gated (skipIf) — keyless CI self-skips.
ROLES (2026-07-23, adr-0008): `profiles.role` developer|admin|customer (migration
`20260723100000` — which ALSO fixes a live privilege hole: profiles UPDATE re-granted
column-scoped `display_name, deleted_at` only, so a user JWT can no longer self-set
plan='pro'/role='admin'; proven in `db/profiles-grants.integration.test.ts`). Seams:
`db/roles.ts` RoleReader (missing/deleted → 'customer'; DB error rejects), `/me` gains
optional `role` (display, best-effort), `plugins/role.ts` `createRequireRole` (403 fail
CLOSED, 503 unwired, no consumers yet), `scripts/set_user_role.ts <email|uuid> <role>`
(service-role assignment; auto-loads apps/server/.env). Mobile: `use-role` (resolves
'customer' until proven — no flash) hides the "Test Live" tab (renamed from "Live",
label-only — route file stays `live.tsx`) for customers via the SDK 57 native-tabs
`hidden` prop.
MODEL REFRESH (2026-07-23, adr-0004 addendum): default models are now `gpt-5.4-mini`
($0.75/$4.50 per 1M, VERIFIED on OpenAI's pricing page; reasoning pinned OFF via
`reasoning_effort: "none"` — the model REJECTS 'minimal') and `gemini-3.5-flash-lite`
($0.30/$2.50 per 1M; the lite model REJECTS thinkingConfig — non-thinking by default, the
knob removed from the adapter). Price book swapped in lockstep (old ids dropped —
historical usage_events keep their stamped costs). Live smokes green on the new ids.
PROMPT FREEDOM (2026-07-23, Gustavo-ratified — see the source-doc AMENDMENT banner):
"the AI always answers; context shapes answers, never limits them" — passive mode now
never triggers on a question of any kind (hypothetical/sales/role-play/design included),
"Not sure what you need help with right now" is scoped to genuinely-empty moments, and
content constraints bind fabrication to the user's OWN data while general knowledge is
always fair game. Regen via scripts/gen-live-prompt.mjs + snapshot repin (the sanctioned
path). Trigger fix: a substantial question (ends "?" + ≥6 words) is re-tested behind its
filler prefix — "Okay, so how would you price this?" fires; "Hey, how are you doing
today?" stays quiet. GATES on the new models + prompt (2026-07-23): relevance **10/10**
(the 9/10 passive-mode miss is gone), grounding still cites the stored $47,500 (no
fabrication regression), typed-input E2E deltas=6/787 chars ~1.9s, smokes openai 881ms /
google 845ms, notes accuracy 5/5, latency p50=800ms p95=1450ms, quiet 11/11 + 3
filler-prefix fixtures.**
**MODES (2026-08-01, `dev-claude-notes-ui`): the user PICKS the copilot prompt on the
Live screen. `liveModeSchema` (`packages/shared/src/live.ts`) is the one source of
truth — `general | behavioral | technical | finance` — re-exported by
`modules/prompt/ports.ts` as `promptModeSchema`, drift-tested against the library's
`MODES` keys, and rendered by `apps/mobile/src/features/live-call/mode-picker.tsx`
(labels are a `Record<LiveMode, string>`, order from the enum). `session.start` gains
an OPTIONAL `mode` (additive, protocol still `v: 1`; omitted = general; an unknown
value FAILS the parse → existing `invalid_event`). It threads
`session.ts::onSessionStart` → `ConductorFactoryArgs.mode` (required — a transport
that forgets it does not compile) → `createLiveConductor` closure →
`assemble(mode, ctx)`; never module state, so two concurrent calls cannot swap
prompts. `assemble()` now composes `library/SYSTEM_PROMPT` + the picked mode's
directive/answer-structure/few-shot; snapshot pins are per mode (4) plus an
all-distinct assertion, and mode-LEAKAGE tests assert each mode contains its own
directive and no other's. LEGACY + UNWIRED (kept on disk, banner-marked):
`modules/prompt/content/system-prompt.ts` and `scripts/gen-live-prompt.mjs`.
VOICE (2026-08-01, the reference study — commits `ed7fc08..32b9733`): the library
now defaults to SPOKEN first-person prose. The source doc's headline+bullets card
and the `**Objection: [Name]**` coaching label are GONE (both fought the
teleprompter register on every answer); the default shape is a speakable paragraph
with 1-3 bolded key terms as the glance aid (bold is never spoken), structure only
for code/notes/explicit requests. Added: the em-dash/semicolon spoken-punctuation
ban, the 15-30s length law, opener rotation, silent context, speakable
admissions, a position-pinned FINAL CHECK (recency anchor — a test asserts it
stays last), per-mode voice anchors, and re-voiced few-shots (the model believes
the demonstration over the instruction). Behavioral = a four-beat spoken story;
technical splits by what the output IS (code structured, prose spoken); finance
says the calculation inline. (Live notes WAS inverse-leakage-tested — the spoken
register kept out of its prompt — until the feature's 2026-08-04 removal took the
prompt and the test with it.) Reference learning is
techniques-only — prompt text stays Nova-authored, never transcribed (RULES §9).
NOT DONE: the paid live gates (relevance/grounding/quiet) have NOT been re-run
against any of the 2026-08-01 prompt text — those numbers above are the legacy
prompt's. Field check 2026-08-01 (Gustavo, simulator): answers read natural.**
**UI REDESIGN (2026-08-02, `dev-claude-ui-design`): the mobile app is redrawn
ground-up against `docs/superpowers/specs/2026-08-02-nova-ui-design.md` (ratified
mockup by mockup; the HTML in `docs/superpowers/mockups/2026-08-02-nova-ui/` is
the visual source of truth). STRICT DUOTONE — one blue `#0002DA`, one white, two
mirror themes (cobalt/paper, picked in Account); every other value is an opacity of
the theme's ink, and `apps/mobile/src/design/tokens.ts` is the whole vocabulary:
seven colour tokens, three type voices (Orbitron display / Inter body / Space Mono
labels), one scale. A third colour is a spec violation — risk and failure are said in
WORDS (`testing/duotone.ts::expectDuotoneOnly` fails a screen test that paints one).
Control language: chamfered = actionable (`design/chamfer.tsx`, SVG polygon — RN has
no `clip-path`), soft radii = readable. The mascot is drawn live
(`features/mascot/`), the copilot's answers arrive by character drain
(`features/stream/`), and every loop is reduced-motion gated. DECORATIVE-A11Y RULING
(final review, binding on every future component): every purely-decorative layer
ships hidden from assistive tech — spread `design/decorative.ts` on the highest
wholly-decorative container (mascot stage incl. sparkles, chamfer's SVG layer,
scanlines, ring orbit, light sweep, the stream caret), never on a wrapper that also
holds content; all three props, because react-native-web 0.21 forwards neither native
one and `aria-hidden` is the only form a test can see. Five screens rebuilt
(auth, meetings, meeting detail, live cockpit, account) plus a three-tab floating bar
(`▤ MEETINGS · ◉ LIVE · ◌ ACCOUNT`; Live still role-gated, Account now a tab). The
glass era is fully retired: `design/glass.tsx`, the LEGACY palette block, Spline Sans,
`expo-glass-effect` and `expo-linear-gradient` are gone. MVP BRIDGE: mic capture is
still Phase 9, so the Live screen's steer field is how a question reaches the
copilot. WIRE WORKSTREAM the redesign surfaced (spec §10 — backend, NOT done here):
the notes read model carries no meeting title/`started_at`/duration (detail header
degraded); no mobile regenerate hook for failed notes (the POST exists server-side);
follow-up POST unwired (4 of 5 kinds unreachable); `use-meeting-notes` still lacks the
timeout + `safeParse` the transcript hook got; `useLiveSession` exposes no meeting id
at session end (the ended state can only link home); each refused quota retry mints a
`meetings` row (reaper stamps `ended_at` — noise, not corruption); and `/me` carries
no plan tier, so Account's ACTIVE chip is a placeholder. NOT DONE: simulator
verification is Gustavo's (jsdom + react-native-web prove structure and colour, never
native layout or how a blur lands).**
**LIVE NOTES REMOVED (2026-08-04, `dev-nova-remove-live-notes`, Gustavo-ratified): the
mid-call streaming notes fold is GONE — fold machinery (`live-fold*.ts`, `prompts/live-fold.ts`,
`reconcile-ids.ts`), the notes conductor + trigger + config, `db/live-notes.ts`,
`maybeCreateLiveNotesConductorFactory`, `canUseLiveNotes`, the `notes.update` wire event,
the `live_notes`/`live_notes_rev` read-model fields and every fallback that read them
(meetings-list tldr, detail preview banner), and the mobile LIVE NOTES tab (capture card is
now a plain transcript strip; `useLiveSession` lost `liveNotes`/`markNotesSeen`). Rationale:
the fold paid metered LLM tokens all call for a draft the post-call pass supersedes;
post-call notes are moving to a reasoning tier instead (notes v3 — adaptive `sections`,
gpt-5.6-terra at medium effort, in flight on the next branch). The `live_notes` TABLE and
its migrations remain (dropping is a deferred contract migration); adr-0009 is Superseded;
`docs/DESIGN/live-notes.md` is banner-tombstoned.**
Phase 5 (`modules/notes`, merged via PR #6): the durable `jobs` queue (SKIP LOCKED claim,
lease+reaper recovery, sweep backstop), classify → single-pass|map-reduce →
structured-output-ladder → quote-verify pipeline, follow-up drafts (cites notes by
construction), the authed notes REST surface (uniform 404, 202|409, 200|409|503), the
stale-call reaper. Live LLM accuracy gates green 2026-07-22. `NOTES_WORKER_ENABLED=true` opts
the background worker in (off by default; needs `SUPABASE_DB_URL` + ≥1 LLM key).
Phase 4 RAG memory is merged: `modules/rag` (chunker, four ports, Voyage + pgvector-hybrid-RRF
adapters, `RagService`, marker-and-sweep indexer over `chunks`/`embeddings`, halfvec 1024 HNSW).
GREEN incl. the freshness bar (~0.7s vs <60s), the store latency bar (`npm run bench:rag` p95
7.2ms vs <300ms), and the LIVE Voyage smoke + top-3 retrieval accuracy gates (2026-07-22 —
`acme-pricing` #1 both tiers, user-B isolation 0 snippets, all rows `voyage-4`/1024). Voyage 429s
retry with backoff on the background tier only; query embeds stay fail-fast (adr-0005 §8).
Phase 3 streaming STT gateway is done and merged: live accuracy gates RAN and GREEN (word-overlap
87.8–96.3% vs 80/70 bars, both vendors ≥2 speakers, dead-vendor failover proven; turn-boundary
alignment per-vendor, real-audio re-test rides Phase 9). Phase 2 `modules/llm` live smoke PASSED
(anthropic + openai + google on `gemini-2.5-flash`; groq unkeyed → skips). The live-call spine —
the shared WebSocket wire protocol (`packages/shared/src/live.ts`), an authenticated `GET /live`
socket + per-call `LiveSession` (`modules/live/`), and the `modules/stt` failover/reconnect/silence
engine (AssemblyAI + Deepgram adapters) — all lives in this tree; raw audio is **never persisted**
(static + runtime `[no-disk]` audits). All vendor keys (STT, LLM, Voyage) are OPTIONAL: the server
boots without them and the affected path degrades to a typed error. Phase 1 carry-overs still hold:
Apple/Google sign-in deferred (needs Gustavo's dev accounts), Supabase **local-only** (cloud project
deferred), iOS-simulator verification deferred (Expo web + Playwright instead). Phases 6+ of
`docs/LOOP_PLAYBOOK.md` build the rest of the product on top.
**HANDOFF (2026-08-03, `dev-nova-handoff`): the laptop-only knowledge moved into the
repo. NEW: `docs/BUSINESS/unit-economics.md` (pricing $60 Premium / $120 Ultra, weekly
caps 7/35 hrs from the $40-profit-floor formula, the $0.40/streamed-hr worst-case
constant, prepaid-hour-pack overage architecture, concurrency/capacity playbook),
`docs/DESIGN/audio-capture.md` (Phase 9 pre-spec: acoustic speakerphone capture, both
voices via one mic + vendor diarization, AudioRecord/AVAudioEngine mechanics behind one
AudioCapture port), `docs/DESIGN/staging-and-distribution.md` (ratified: Railway +
Supabase cloud + EAS APK sideload on Android = staging; store checklists), `art/`
(brand source art incl. the original logo), `docs/superpowers/mockups/2026-08-02-nova-ui/`
(the ratified mockup HTMLs — moved out of the gitignored brainstorm dir), and
`docs/superpowers/journal/2026-08-02-ui-redesign/` (the build ledger with the
next-branch work list, final review, CodeRabbit reports).**

## Working agreements (Gustavo)

- Nova is **Gustavo's personal proprietary product**. TC Interactive Group is his
  employer, NOT the owner — never present it as Nova's company. No entity yet
  (planned later; store accounts are INDIVIDUAL until then).
- Orchestrate, don't solo-implement: delegate implementation to subagents (ONE
  implementer at a time, never parallel), review each task's diff before moving on.
- Never drive the simulator/device — tell Gustavo where to tap and what a pass
  looks like; on-device verification is his.
- Commit in small increments as pieces go green; expressive single-line messages.
- MVP interaction model: **no auto-responses** — one RESPOND key; optional typed
  steer shapes the answer on its own prompt path (never a fake "them" turn).
- Branch names carry no "claude" (`dev-nova-<topic>`).
- Explain analogy-first, then the technical bridge with file refs, then rationale.
- Price and cap for the worst-case user (see `docs/BUSINESS/unit-economics.md`).

## Read before doing ANYTHING

1. `docs/RULES.md` — the engineering constitution. Binding. Highlights:
   - zod-parse every boundary; TS strict; no `any`
   - vendor SDKs ONLY inside `modules/*/adapters/`
   - soft delete always (`deleted_at`); hard delete only in `scripts/purge/`
   - migrations: expand→backfill→contract, never edit applied ones, RLS ships with tables
   - every PR updates the living docs it affects (ARCHITECTURE / PARITY / ADR / this file)
2. `docs/ARCHITECTURE.md` — system shape, module map, invariants
3. `docs/LOOP_PLAYBOOK.md` — the phased build plan; work happens as loop phases
4. `docs/GIT_WORKFLOW.md` — branches development→staging→main, guards, `GusDawn123`
   account. Feature work: branch `dev-<who>-<topic>` off `development`, PR back into
   `development` ONLY (never staging/main), merge development INTO the feature to
   update (never the reverse), re-test, push. Merge commits only; branches survive
   merge. AI PRs (`dev-claude-*`) wait for Gustavo's go-ahead to merge.

## Hard prohibitions

- No secrets in the repo. No vendor keys in the mobile app, ever.
- No unmetered paths to paid vendor APIs — **DONE and audit-enforced as of Phase 6**: the
  unified `modules/metering` is live (llm per-call meters, STT relayed-byte spans, Voyage
  embedding/rerank sinks all land in `usage_events`), and the static wiring audit
  (`modules/metering/metering.audit.test.ts`) fails the build if any vendor construction
  site loses its sink or `noopMeter` reappears in production wiring. Keep it that way:
  new vendor paths MUST thread the metering seam and extend the audit.
- Never claim "done" without the phase's mechanical verification passing.

## Commands

Keep this current in the same PR that changes a script. Node >=22, npm >=10 (workspaces).

```
# Root (whole monorepo)
npm run check          # typecheck + lint + test — the mergeable=green gate
npm run typecheck      # tsc -b (server + shared) then apps/mobile tsc --noEmit
npm run lint           # eslint . then apps/mobile expo lint
npm run test           # vitest run (DB integration tests self-skip unless Supabase is up)
npm run format         # prettier --write .   (format:check to verify only)

# Code review — CodeRabbit (STRICT; see .coderabbit.yaml). Required before every PR.
coderabbit auth login  # once per machine (browser OAuth; `auth status` to check)
coderabbit review --agent              # all tracked changes, agent-readable findings
coderabbit review --agent --uncommitted  # pre-commit pass over staged + tracked edits
coderabbit review --agent --base development  # what the PR will actually contain
coderabbit review findings             # re-read the last review without re-running
#   In Claude Code the plugin exposes /coderabbit:review (same scopes).
#   NOT an MCP server — CodeRabbit is an MCP *client*; the integration is CLI + plugin.
#   Free tier is rate-limited (a few reviews/hour), so review the PR-shaped diff
#   (--base development) rather than burning runs on every edit.

# Local Supabase (real Postgres — never test against anything else)
npm run db:start       # supabase start  (boots the local stack)
npm run db:stop        # supabase stop
npm run db:migrate     # supabase migration up — FORWARD-applies only the PENDING
                       #   migrations and KEEPS your data. This is the default way to
                       #   pick up a new migration, and it mirrors how production
                       #   works (`db push` diffs against the
                       #   supabase_migrations.schema_migrations ledger; prod never
                       #   replays and never resets).
npm run db:reset       # supabase db reset — DROPS the database, replays all
                       #   migrations from zero, then runs supabase/seed.sql. This is
                       #   a TEST of the migrations (what CI does), not a way to apply
                       #   them. It destroys all local data INCLUDING auth.users, so
                       #   reach for db:migrate unless you specifically want the
                       #   from-scratch replay proof.
                       #   seed.sql recreates the dev account after every reset:
                       #   dev@nova.test / nova-dev-1234, role 'developer' (a
                       #   'customer' cannot see the Test Live tab).

# Server workspace (apps/server, Fastify)
npm run dev   --workspace apps/server   # tsx watch — GET /health => { ok, version }
npm run start --workspace apps/server   # node dist/index.js (after a build)
npm run bench:rag --workspace apps/server  # RAG store p95 latency bar (DB-required, no
                                           #   vendor key). Needs the stack up + its env
                                           #   exported: `eval "$(supabase status -o env)"`
                                           #   then SUPABASE_DB_URL/URL/SERVICE_ROLE_KEY.
                                           #   Seeds 40k chunks, prints p50/p95/max vs <300ms,
                                           #   non-zero exit on FAIL, cleans up after itself.

# Mobile workspace (apps/mobile, Expo)
npm run start --workspace apps/mobile   # expo start (add --web / --ios / --android)

# STT test fixtures (rare; needs macOS `say` + ffmpeg). Regenerates the committed
# two-speaker WAVs under apps/server/fixtures/stt/ for the key-gated accuracy suite.
./scripts/make-stt-fixtures.sh
```

CI (`.github/workflows/ci.yml`) runs, on every PR: typecheck, lint, then boots the local
Supabase stack (`supabase start` — which replays every migration, the **shadow migration
replay**) BEFORE the test step, so the DB integration suites (RLS isolation, /me, /account)
run against real Postgres instead of self-skipping. `npm run check` is the local mirror
(typecheck + lint + test; run `npm run db:start` first for the same integration coverage).

## Conventions

- Branches: `dev-<who>-<topic>` (e.g. `dev-claude-rls-policies`); scripts verb-first
  (`backfill_*`). Style rules: docs/RULES.md §10 (Prettier + typescript-eslint
  strict-type-checked; discriminated unions over boolean flags; async/await only;
  screens dumb / hooks smart; tokens-only styling; snake_case SQL)
- Module anatomy: `ports.ts / adapters/ / service.ts / routes.ts`; module-local zod
  lives in `ports.ts` (shared wire types in `packages/shared`); tests are co-located
  `*.test.ts` beside the code; fixtures under `apps/server/fixtures/`
- ONE exception to co-location: **no `*.test.*` under `apps/mobile/src/app/`** — Expo
  Router makes every file there a route, so a co-located screen test is bundled into
  the running app and crashes it at launch while vitest/tsc/lint all stay green. Screen
  tests live in `apps/mobile/src/screen-tests/` (see its README); enforced by
  `apps/mobile/src/testing/router-directory.test.ts`
- Soft cap ~400 lines/file — split before you blow past it
- Structured errors + logs with `request_id`/`user_id`; never log secrets or raw
  transcripts at info level
