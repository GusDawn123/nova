# Modes, Context & the Two-Brain Prompt Engine — design

**Date:** 2026-08-16 · **Status:** RATIFIED — Gustavo approved the design and
ordered implementation to begin (2026-08-16). §7's "Open" list is what
ratification deliberately left open; everything else is in force.
**Scope:** the modes/prompts/context/RAG system (engine + wiring), the two-base
prompt architecture, screen capture, and request routing. UI visuals for the
Modes tab arrive as a separate Gustavo-authored UI spec; this doc defines the
machinery that UI talks to.

This spec follows the house convention (`2026-08-11-desktop-pivot-design.md`):
it records ratified decisions and the ordered chunk list. It is deliberately
**not** an implementation plan — each chunk gets its own branch, its own plan,
its own review.

---

## 1. The two source prompts are the constitution

Everything in this design bends around two authored, word-for-word prompt files.
Code assembles them; code never rewrites, paraphrases, or "improves" them
(RULES §9, the Phase-7 verbatim constraint, held by snapshot tests).

| File | Identity | Job |
|---|---|---|
| `docs/prompts/nova-meeting-enterprise.md` | **Brain A** — the live-meeting co-pilot | The default system prompt whenever a meeting is running: answer the question at the end of the transcript, define terms, advance the conversation, handle objections, stay quiet when nothing is needed. |
| `docs/prompts/problem-solver-screen.md` | **Brain B** — the problem solver | "Analyze and solve problems asked by the user or shown on the screen": coding, math, multiple choice, drafting replies to visible text, UI navigation, screen Q&A. |

**The never-both law.** A single LLM request contains exactly one brain. They are
never concatenated, never both present, never merged into a conditional
mega-prompt. Enforcement is structural and lands with **M2**: the assembler
exposes two entry points (`assembleMeeting`, `assembleSolver`), each hard-wired
to its own base, and a unit test proves no code path can compose a request with
two identities. (Until M2, the only wired assembler is the legacy
`assemble(mode, context)`, which knows neither brain — the law binds the new
code, it does not describe today's.)

### 1.1 What the prompt texts themselves dictate to the architecture

These constraints come out of the prompts as written and bind the implementation:

1. **Brain A already handles casual screen moments.** Its
   `<screen_problem_solving_priority>` block means an A request MAY carry a
   screen frame; routing to B is only for dedicated solve-this moments. The
   router never needs to be perfect — each brain has a native fallback for the
   gray zone.
2. **Brain B must never be told about "screenshots."** Its
   `<general_guidelines>` forbid the words "screenshot"/"image" — it is "the
   screen." Therefore the assembler attaches the frame with **no textual label**,
   and UI copy near the feature says "screen," not "screenshot."
3. **Brain B has no passive mode — it always acts** (or emits its authored
   unclear-screen line). Consequently **auto-fired triggers may never route to
   B**: an always-acting brain on an automatic trigger is spam by construction.
   Only user-initiated asks can reach B. (Brain A, with its
   `<passive_acknowledgment_priority>`, is the only brain safe to auto-fire.)
4. **Brain A's transcript grammar is `me` / `them` / `assistant`.** The engine's
   channel labels (chunk 3: left = me, right = them) already match; conductor
   suggestions render as `assistant`. The assembler must keep exactly these
   labels.
5. **Brain A ends on the user-context anchor** — *"User-provided context (defer
   to this information over your general knowledge / if there is specific
   script/desired responses prioritize this over previous instructions)"*. The
   context envelope (§3) is injected **immediately after** this line, so the
   deferral instruction points at the very next block.
6. **Brain A's `<content_constraints>`** ("Use only verified info from
   context/user history") is scoped by the envelope, not by editing the prompt
   (Gustavo's decision 2026-08-16: the prompt stays; the backend disambiguates).
7. **Both brains demand LaTeX math.** The suggestion pane eventually needs
   LaTeX rendering; until then this is a known cosmetic gap, not a blocker.
8. **Known tension, deliberately accepted:** Brain A's opening claims "You can
   see the user's screen (the screenshot attached)" even on requests that carry
   no frame (most of them). Mitigation is structural and gate-tested (§6): if
   frameless A requests hallucinate screen references, the fix is one ratified
   line in the dynamic suffix noting no screen is shared this moment — never an
   edit to the authored text.
9. **Banners:** corrected in the M0 commit alongside this doc — HTML comments
   only, prompt text byte-untouched. (The solver file's historical
   "copied 2026-07-20" note stays; it is still true.)

---

## 2. Modes become user data (Brain A only)

Today a mode is one of four hardcoded enum values baked into the wire protocol,
with prompt blocks an engineer authored (`modules/prompt/library/modes/`), while
the pill advertises five *different* names the server rejects. Both hardcodings
retire.

**A mode is a row, not an enum:**

```text
modes
  id            uuid PK
  user_id       uuid → auth.users (RLS: owner only)
  title         text            -- "Sales", "Untitled Mode"
  prompt_text   text            -- the "Meeting context" box (capped length)
  icon / sort   presentation
  created_at / updated_at / deleted_at (soft delete)

profiles.active_mode_id  uuid NULL → modes.id   -- the checkmark; NULL = General
```

- **General is the absence of a mode** (NULL): Brain A + envelope, no mode text —
  matching the reference UI's promise, "leave it blank to use the default
  prompt." A mode whose `prompt_text` is blank and has no files behaves
  identically to General.
- **Starter modes ship as seed templates in their own read-only relation**
  (`mode_templates`: global read policy, no user-owned rows exposed through
  it), listed alongside the user's modes and copied into the user's own
  `modes` rows in one transaction on first edit (copy-on-edit; empty states
  sell badly). Owner-only RLS on `modes` stays intact — templates are never
  rows in that table. Their text is Gustavo-authored seed content — the
  current library blocks (`behavioral` / `technical` / `finance`) are raw
  material he can adapt or discard, not code anymore. M3's proof includes a
  fresh account seeing the templates and a first edit landing in its own rows.
- **Wire change:** `session.start.mode` goes from the closed enum to
  `mode_id: uuid | null`. The server loads the row at session start and **locks
  a copy for the call** — mid-call edits or deletion of the mode never disturb a
  running session (value semantics), and the assembled prefix stays byte-stable
  per (brain, mode revision), which is what keeps the vendor prompt cache warm.
- **Same-owner invariant, enforced — never assumed:** `profiles.active_mode_id`
  may only ever point at a mode the same user owns. The FK to `modes.id` alone
  does not say that, so the schema backs it (composite FK on
  `(user_id, id)` or an equivalent trigger), set-active validates owner match
  under RLS, and the session-start load re-checks owner even where server code
  runs with elevated access. Soft-deleting a mode clears any
  `active_mode_id` pointing at it in the same transaction → General on the
  next call.
- **Brain B is mode-less.** Modes, envelopes, and RAG are Brain-A concepts. B
  gets the frame, the ask, and (decision §7) a short labeled transcript tail.

### 2.1 Files & context (the drag-and-drop)

The RAG spine (`modules/rag`: chunker, Voyage embeddings, pgvector hybrid-RRF,
per-user RLS, auto-indexed calls) already exists and is proven. What's missing
is the doorway:

- **Upload endpoint** per mode: extract text (v1: PDF, txt, md; reject anything
  else with a visible per-file `failed` status — never silently half-indexed),
  then ingest through the existing pipeline with a `mode_id` tag on the doc.
  V1 resource limits, enforced and surfaced in the UI when hit: **20 MB per
  file, 300 PDF pages, a 60 s extraction timeout, 3 concurrent uploads per
  user**. Oversize and timed-out files land in the same terminal `failed`
  status — a bounded 200-page PDF is fine; an unbounded anything is not.
- **Retrieval scoping is a hard filter, then ranking:** candidates are limited
  to `user_id = current_user AND (mode_id = active_mode_id OR mode_id IS NULL)`
  BEFORE hybrid ranking — an inactive mode's documents can never leak into a
  live request, however well they score. Within the candidates, the active
  mode's docs rank ahead of the global ones. (M4 gate fixture: a distinctive
  fact planted in an INACTIVE mode's doc must not be retrievable.) Whole files
  are never injected — retrieval picks moment-relevant snippets, so context
  stays bounded no matter what a user drags in.
- **Mid-call file adds take effect immediately** (retrieval is per-moment; only
  the mode's `prompt_text` is start-locked).

---

## 3. The context envelope (how the backend scopes "context")

Gustavo's ruling: the enterprise prompt is good as written; the **backend** must
make "context/user history" unambiguously mean *the data the user provided*.
The mechanism is one structural contract in the assembler:

```text
[Brain A, byte-for-byte, ending with its user-context anchor line]

<user_provided_context>
  <user_script>       …the active mode's prompt_text…            </user_script>
  <reference_files>   …retrieved snippets from the mode's docs…  </reference_files>
  <user_memory>       …relevant snippets from past calls…        </user_memory>
</user_provided_context>

[transcript window, me/them/assistant]
[frame, when attached — no textual label]
```

- The envelope **always appears**, even empty. Empty form:
  `<user_provided_context> (none provided for this call) </user_provided_context>`
  — the "(none provided…)" words are the **only new authored text** this design
  introduces; Gustavo ratifies them once and they freeze like everything else.
  An explicitly-empty envelope is what flips the model to its general-knowledge
  baseline instead of deflecting ("is context supposed to be here?" is answered).
- **Two trust grades, one envelope — and the typed contract keeps them apart.**
  `<user_script>` is the user's own typed instructions — the "specific
  script/desired responses" the anchor line says to prioritize.
  `<reference_files>` and `<user_memory>` are **facts-grade**: a dragged PDF
  may contain a third party's text ("ignore your instructions"), so file
  content informs answers but is never treated as instructions. M2's context
  schema therefore carries three SEPARATE fields (`user_script`,
  `reference_files`, `user_memory`) — never a merged snippet list like the
  legacy `ragSnippets` — so provenance survives all the way into the
  assembled prompt.
- **Serialization safety at assembly.** Typed fields alone do not make the
  envelope safe: a dragged file can itself contain `</reference_files>` or a
  fake `<user_script>` opener and break out of its tag. The assembler
  neutralizes envelope tag sequences in facts-grade content before wrapping
  it (escape or strip — M2 picks the mechanism and pins it with tests).
- Behavior is **proven, not argued** (§6 gates): empty envelope + general
  question → real answer; empty envelope + own-data question → honest "I don't
  have that."

---

## 4. Screen capture: capture-on-ask

**Ratified 2026-08-16, following Cluely's public UX** (their docs expose no
screenshot hotkey — Ctrl/Cmd+Enter is "Ask AI anything about your screen,
audio, or chat"; capture is implicit in the ask):

- **When an ask fires and the screen toggle is ON, the app captures ONE frame at
  that instant**, uses it for that one request, and discards it. Whatever the
  user is looking at at the moment of asking is, by definition, what the AI sees.
- **No retention policy exists because no retention exists.** No ambient loop,
  no timer, no disk writes, nothing to expire. The frame lives in memory for the
  lifetime of one request. This extends the "transcript-only storage" trust
  stance to pixels.
- **One-frame law, enforced structurally (built in M5):** the assembler accepts
  a single optional frame; a request with two images cannot be constructed
  (typed + tested), so "never feed multiple pictures" is not a model
  instruction — it is physics.
- **The screen toggle is consent.** Toggle off → no capture can occur, ever.
- Capture failure (locked screen, permission) → the request proceeds frameless
  with a small UI note; Brain B's own `<unclear_or_empty_screen>` text handles
  a useless frame gracefully.
- Nova can never appear in its own frame — OS-level capture exclusion (chunk 4)
  covers our own capture path too.
- **Screen-gated attach for Brain A:** during a meeting, when the tier-1 regex
  hears screen-reference language ("look at this," "on my screen," "this
  page…"), the next A request captures and attaches a frame at that moment —
  code decides via deterministic regex, never the model mid-generation. A
  requests without such language stay frameless (image tokens are ~1–1.5k
  each; the live loop fires often).
- **Deferred, deliberately:** the ambient capture loop, and a manual
  "pin this screen" hotkey (the alt-tab-then-ask case). Both are additive later
  without rearchitecting; neither earns its complexity in v1.

---

## 5. Routing: three rules and one regex

The prompts cannot pick the lane — something upstream chooses which text to
send. That something is almost entirely the UI state the pill already exposes
(`pill-bar.tsx` askLabel logic: meeting / screen / call):

| # | Situation | Route | Grounding |
|---|---|---|---|
| R1 | No meeting session running; user asks (Answer key / ask box) | **B**, frame attached if toggle on | Nova outside a call IS the problem solver; the pill's own label reads "Ask anything about your screen." |
| R2 | Meeting running; suggestion auto-fires off the transcript | **A**, always | §1.1(3): B always acts, so auto-triggers must never reach it. |
| R3 | Meeting running; user asks, toggle OFF | **A**, frameless | No frame can exist; it is a conversation question. |
| R4 | Meeting running; user asks, toggle ON | **the one ambiguous cell:** tier-1 regex over the ask text — solve/act-on-artifact intent ("solve this," "what's the answer," code/math phrasings, "where do I click") → **B** with frame; otherwise → **A** (screen-gated frame per §4) | The pill's own label biases this cell to "about the meeting"; A is the safe default because its ladder includes casual screen help. |

- Total routing cost: ~0ms in every case. No SLM, no LLM routing call, ever.
- **Regex families are derived from Brain B's own sections** — one family per
  block it was authored to solve: `<technical_problems>`, `<math_problems>`,
  `<multiple_choice_questions>`, `<emails_messages>`, `<ui_navigation>`.
- **Force-B override (chunk 5 hotkeys):** mirroring Cluely's second combo
  ("Get Answer"), a dedicated hotkey bypasses R4's regex entirely — the
  power-user's deterministic mid-meeting "just solve what's on my screen."
- **Tier-3 seam:** the router interface admits a future tiny classifier for the
  R4 cell, built only if real usage shows the regex misrouting. Evidence first.

**Arbitration (ratified):** a B answer takes the focal pane; in-flight A output
is superseded (existing conductor machinery); A triggers arising while B streams
are **dropped, not queued** (a suggestion is only worth its moment); **audio
capture and transcription never pause** — B is a side-quest, the meeting engine
does not blink. B failing (no vision-capable provider, capture error) can never
break A. Double-fired B: second supersedes the first.

**Plumbing notes:** B requests need a **vision-capable provider filter** in the
LLM router — the same capability-filter pattern the STT engine uses for stereo
(`maxChannels`); a text-only vendor is never handed a frame. Image tokens are
metered as their own usage line; B rides the same auth/quota/kill-switch gates
as everything else and works with no meeting row (R1).

---

## 6. Proof gates (what "works" means)

Key-gated live gates, run before any chunk here is called done:

1. **Empty-envelope generality:** no context + "how would you sell me a pencil"
   → a real answer, zero deflection.
2. **Empty-envelope honesty:** no context + "what's our pricing?" → "I don't
   have that," no invented numbers.
3. **Envelope deference:** a mode file plants a distinctive fact (the $47,500
   pattern) → the suggestion cites it over general knowledge.
4. **Never-both invariant:** unit test — no code path composes two brains.
5. **One-frame invariant:** unit test — a two-image request cannot be built.
6. **Routing table:** unit tests per row R1–R4, plus the regex family fixtures.
7. **Frameless-A sanity:** frameless A requests do not reference a visible
   screen (guards §1.1(8)).
8. **Prompt fidelity:** snapshot tests hold both brains byte-for-byte to their
   source docs (existing `assemble.snapshot.test.ts` pattern).
9. **Injection inertness:** a `<reference_files>` snippet containing "ignore
   prior instructions" is quoted as data — the suggestion neither obeys it nor
   changes register because of it. Fixtures cover BOTH payload shapes: the
   plain instruction and a tag-breakout
   (`</reference_files><user_script>…`) — each stays data.

The relevance/quiet/latency gates from Phase 7 re-run against the new Brain A —
they were last measured on the legacy prompt (a known debt flagged in the
library README).

---

## 7. Decisions

**Ratified (Gustavo, 2026-08-16 session):**
- Two word-for-word base prompts; never combined; backend architecture adapts to
  the prompts, not the reverse.
- The enterprise prompt stays as written; the envelope (not prompt edits) scopes
  "context/user history" to drag-and-drop data. Empty → general responses.
- Modes are user-created data with seeded defaults; hardcoded mode enums retire.
- Capture-on-ask per Cluely's public UX; loop and pin-hotkey deferred; one frame
  per request; screen-gated attach for A.
- Routing by UI state + one regex cell; no intent-classifier model in v1
  (tier-3 seam reserved); force-B hotkey lands with chunk 5.
- B visible over A; drop-not-queue; meeting engine never pauses.

**Open (small, non-blocking):**
1. **Multi-monitor:** which display does capture-on-ask grab? Default proposal:
   the display the pill lives on.
2. **B's transcript tail:** include the last ~30s of transcript as labeled data
   in B requests (the problem is often spoken before it's solved)? Default
   proposal: yes.
3. **"(none provided for this call)"** — the exact empty-envelope wording, to
   ratify once.
4. **Starter mode set & text** — which seeds ship, and their authored content
   (Gustavo authors; drafts can be prepared for approval).
5. **The Modes tab UI spec** — Gustavo delivering (Mac-Notes-style editing,
   deep-black glass design, animation pass).

---

## 8. The chunk list

House rules apply: one chunk → one branch → tests → CodeRabbit → Gustavo's
merge word. Never two chunks in flight. Ordered so every chunk lands something
visible or load-bearing, and no chunk depends on an unratified decision.

| # | Chunk | Deliverable | How we prove it |
|---|---|---|---|
| M0 | **This design doc** | decisions written down; prompt banners corrected | landed with this doc's PR (banners: HTML comments only); ratified 2026-08-16 |
| M1 | **Suggestions reach the pill** | the desktop stops dropping `suggestion.*`; the conductor's stream renders live in the pill (the engine's voice becomes visible; every later chunk gets a living testbed) | live call: a real suggestion streams into the pill unprompted; supersede/discard honored |
| M2 | **The two-brain prompt engine** (server) | both authored prompts wired as the two assembler bases; envelope contract incl. empty form; never-both + fidelity enforcement; old library modes unwired | gates 1, 2, 4, 7, 8 green; Phase-7 relevance/quiet gates re-run on the new Brain A |
| M3 | **Modes as data** | `modes` table + RLS, CRUD + set-active REST, `mode_id` on the wire, start-locked mode copy, seed templates; pill mode menu reads the real list (today 4 of its 5 entries are server-rejected) | gate 3 green vs a mode's planted fact; RLS A/B isolation; pick seeded mode → its script provably shapes a live suggestion |
| M4 | **Files in** | per-mode upload endpoint, extraction (pdf/txt/md), RAG ingest tagged by mode, retrieval scoping, per-file status | drag a product PDF onto a mode → ask about its distinctive fact on a live call → the suggestion cites it; failed-extraction path visible |
| M5 | **Router + capture-on-ask + Brain B path** | routing table R1–R4 + regex families, capture-on-ask behind the toggle, one-frame law, vision provider filter, metered mode-less B request path (works with no meeting), ask box finally submits | gates 5, 6 green; the product test: leetcode on screen, toggle on, press Answer → commented solution streams; same phrase mid-meeting with toggle off → conversation answer |
| M6 | **Modes UI + design pass** | the Cluely-style Modes tab per Gustavo's UI spec (sidebar, in-place editing, drag-and-drop, Set Active) on the real M3/M4 APIs; deep-black glass + animation system across settings | create → edit → attach file → set active → start call → mode demonstrably in effect, all from the UI; Gustavo's eye on the design |

M1 precedes everything because a copilot whose suggestions are invisible cannot
prove any prompt, mode, or routing behavior in the product — headless proofs
only go so far. M5 before M6 so the UI lands on real endpoints, never on
placeholders that get rewired later.

**Interactions with the standing roadmap:** the force-B hotkey and global
summon land inside pivot chunk 5 (hotkeys); the STT single-vendor stereo gap
(Deepgram-only on desktop) is a known, separate engine debt — not expanded here.

---

## 9. Costs this design introduces

- **Image tokens:** ~1–1.5k tokens per attached frame — the reason for
  screen-gated attach (§4) instead of always-attach.
- **Vision-tier calls for B:** vision-capable models price above the cheap text
  tier the live cascade prefers; acceptable for user-initiated one-shots.
- **Seed content authoring:** starter-mode text is authored work (Gustavo),
  not engineering.
- **Extraction dependency:** one PDF-text library in the server (vetted,
  pinned); txt/md are free.
