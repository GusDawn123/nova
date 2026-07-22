/**
 * Deterministic generator for the long-call notes fixture (Phase 5 Task 4).
 *
 * Emits a ~90-minute, two-speaker, sales-ish diarized transcript with FOUR planted
 * facts: a distinctive decision + action item in the FIRST ten minutes and a
 * DIFFERENT decision + action item in the LAST ten minutes, surrounded by realistic
 * but non-colliding filler (none of the filler contains a planted keyword, so a
 * fact-check can attribute a hit only to the plant). It powers two bars:
 *   - the mock-provider planted-facts test (map-reduce must not lose a first- or
 *     last-chunk fact at a chunk boundary), and
 *   - the key-gated live long-call accuracy case (real models, run in Task 6).
 *
 * DETERMINISTIC by construction: a seeded `mulberry32` PRNG, a fixed call start,
 * and integer time steps — NO `Date.now`, NO `Math.random`. Re-running reproduces
 * byte-identical output, so the committed `fixtures/notes/long-call.json` +
 * `long-call.expected.json` are stable.
 *
 * Run: `npx tsx apps/server/scripts/make-long-call-fixture.ts` (writes the two
 * files under apps/server/fixtures/notes/). Commit the output.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Seeded PRNG — the only source of "randomness" (reproducible).
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0x5eed_c0de;
const rand = mulberry32(SEED);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)] as T;

// ---------------------------------------------------------------------------
// Call shape.
// ---------------------------------------------------------------------------

const CALL_TITLE = "Northwind renewal & expansion call";
const CALL_START = "2026-07-20T15:00:00Z"; // a Monday — anchors relative deadlines
const TOTAL_MS = 90 * 60 * 1000; // ~90 minutes
const FIRST_PLANT_MS = 4 * 60 * 1000; // ~minute 4 (first 10 min)
const LAST_PLANT_MS = 85 * 60 * 1000; // ~minute 85 (last 10 min)

const SPEAKER_A = "Alex"; // the account exec
const SPEAKER_B = "Morgan"; // the customer

// Filler clauses — DELIBERATELY free of every planted keyword so a keyword hit in
// the fact-check can only come from a plant, never from ambient chatter.
const OPENERS: readonly string[] = [
  "On the analytics side,",
  "Looking at the current setup,",
  "From an integration standpoint,",
  "Regarding the reporting workflow,",
  "As for the migration plan,",
  "On the topic of team access,",
  "About the API limits,",
  "For the pilot group,",
  "In terms of the budget cycle,",
  "On the data-retention question,",
  "Coming back to performance,",
  "When we think about scale,",
];

const CLAUSES: readonly string[] = [
  "the dashboards refresh every few minutes and the latency has stayed well within range.",
  "we can map the existing fields across without much manual cleanup on your side.",
  "the webhook events line up closely with what your team already tracks today.",
  "we'd stage the rollout across two regions before opening it up more widely.",
  "the current tool starts to struggle once you push past a few thousand records.",
  "your admins keep full control over roles and permissions throughout.",
  "the rate ceiling is generous enough for the volume you're projecting next year.",
  "we usually see adoption climb once the shared templates are in place.",
  "the finance review tends to land near the very end of the period.",
  "records stay available for the entire contracted window with no extra steps.",
  "the sync runs incrementally so the load on your database stays light.",
  "most teams get comfortable with the interface inside a couple of sessions.",
];

// ---------------------------------------------------------------------------
// The four planted facts (exact spoken lines — the fact-check quotes match these).
// ---------------------------------------------------------------------------

const FIRST_DECISION_LINE =
  "Okay, we've talked it through internally and we're going with the Enterprise tier for the full rollout.";
const FIRST_ACTION_LINE =
  "I'll send over the signed order form by this Friday and loop in your procurement lead.";
const LAST_DECISION_LINE =
  "Great, then it's settled — we'll schedule the technical onboarding for the first week of next quarter.";
const LAST_ACTION_LINE =
  "I'll email you the security questionnaire by next Wednesday so legal can get started on their side.";

interface Turn {
  speaker: string;
  text: string;
  tsMs: number;
}

/** One filler line: opener + two clauses, ~40-55 estimated tokens. */
function fillerText(): string {
  const first = pick(CLAUSES);
  let second = pick(CLAUSES);
  while (second === first) second = pick(CLAUSES);
  return `${pick(OPENERS)} ${first} And ${second}`;
}

function build(): { turns: Turn[]; positions: Record<string, number> } {
  const turns: Turn[] = [];
  const positions: Record<string, number> = {};
  let tsMs = 0;
  let speakerIsA = true;
  let firstPlanted = false;
  let lastPlanted = false;

  while (tsMs < TOTAL_MS) {
    // Plant the first-10-min pair the moment we cross the target.
    if (!firstPlanted && tsMs >= FIRST_PLANT_MS) {
      positions.firstDecisionMs = tsMs;
      turns.push({ speaker: SPEAKER_B, text: FIRST_DECISION_LINE, tsMs });
      tsMs += 9000;
      positions.firstActionMs = tsMs;
      turns.push({ speaker: SPEAKER_A, text: FIRST_ACTION_LINE, tsMs });
      tsMs += 11000;
      firstPlanted = true;
      continue;
    }
    // Plant the last-10-min pair.
    if (!lastPlanted && tsMs >= LAST_PLANT_MS) {
      positions.lastDecisionMs = tsMs;
      turns.push({ speaker: SPEAKER_A, text: LAST_DECISION_LINE, tsMs });
      tsMs += 9000;
      positions.lastActionMs = tsMs;
      turns.push({ speaker: SPEAKER_B, text: LAST_ACTION_LINE, tsMs });
      tsMs += 11000;
      lastPlanted = true;
      continue;
    }

    turns.push({
      speaker: speakerIsA ? SPEAKER_A : SPEAKER_B,
      text: fillerText(),
      tsMs,
    });
    speakerIsA = !speakerIsA;
    // Seeded 8–15s step between turns.
    tsMs += 8000 + Math.floor(rand() * 7000);
  }

  return { turns, positions };
}

// ---------------------------------------------------------------------------
// Emit.
// ---------------------------------------------------------------------------

const { turns, positions } = build();

const fixture = {
  meta: { title: CALL_TITLE, startedAt: CALL_START },
  turns,
};

const manifest = {
  meta: { title: CALL_TITLE, startedAt: CALL_START },
  totalTurns: turns.length,
  firstFact: {
    positionMs: positions.firstActionMs,
    decisionKeyword: "enterprise tier",
    decisionQuote: FIRST_DECISION_LINE,
    actionItemKeyword: "signed order form",
    actionQuote: FIRST_ACTION_LINE,
    ownerKeyword: "alex",
    deadlineRawKeyword: "friday",
  },
  lastFact: {
    positionMs: positions.lastActionMs,
    decisionKeyword: "technical onboarding",
    decisionQuote: LAST_DECISION_LINE,
    actionItemKeyword: "security questionnaire",
    actionQuote: LAST_ACTION_LINE,
    ownerKeyword: "morgan",
    deadlineRawKeyword: "wednesday",
  },
};

const outDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "notes",
);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "long-call.json"), `${JSON.stringify(fixture, null, 2)}\n`);
writeFileSync(
  join(outDir, "long-call.expected.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

const totalChars = turns.reduce((n, t) => n + t.text.length, 0);
console.log(
  `wrote long-call.json (${String(turns.length)} turns, ~${String(
    Math.round(totalChars / 4 / 1000),
  )}k est tokens) + long-call.expected.json`,
);
