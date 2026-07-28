import { describe, expect, it } from "vitest";
import type { MeetingNotes } from "@nova/shared";

import {
  applyFold,
  deriveSeqCounters,
  emptyLiveNotes,
  foldResultSchema,
  initialFoldState,
  type FoldContext,
  type FoldResult,
  type FoldState,
} from "./live-fold.js";

/**
 * The non-teleport proof (docs/DESIGN/live-notes.md §10). These are ADVERSARIAL
 * fixtures on purpose: a reducer tested only against well-behaved model output
 * tests your fixtures, not the reducer. Every case here is something an LLM
 * actually does — hallucinated ids, the same id twice, a wholesale rewrite, a
 * reshuffled array, an arm that does not exist for this conversation type — and
 * every one must be CLAMPED, never thrown.
 */

const CONFIG = {
  maxChurnPerFold: 3,
  churnFraction: 0.25,
  maxItemsPerList: 40,
} as const;

function ctxWith(
  state: FoldState,
  over: Partial<FoldContext> = {},
): FoldContext {
  return {
    config: CONFIG,
    state,
    narrativeOpen: false,
    transcriptSoFar: "",
    canLatchType: true,
    ...over,
  };
}

/** Fold a sequence of model responses, threading state the way the loop does. */
function foldAll(
  start: MeetingNotes,
  responses: FoldResult[],
  over: Partial<FoldContext> = {},
): { notes: MeetingNotes; state: FoldState } {
  let notes = start;
  let state = initialFoldState(start);
  for (const response of responses) {
    const out = applyFold(notes, response, ctxWith(state, over));
    notes = out.notes;
    state = out.state;
  }
  return { notes, state };
}

/** `n` add-ops against one list. */
function adds(list: string, texts: string[]): FoldResult {
  return foldResultSchema.parse({
    ops: texts.map((text) => ({ op: "add", list, item: { text } })),
  });
}

describe("foldResultSchema", () => {
  it("accepts a bare {} — 'nothing new happened' must not cost a repair round", () => {
    const parsed = foldResultSchema.safeParse({});
    expect(parsed.success).toBe(true);
  });

  it("treats a missing ops array as no ops, not as an error", () => {
    const out = applyFold(
      emptyLiveNotes("Acme call"),
      foldResultSchema.parse({}),
      ctxWith(initialFoldState(null)),
    );
    expect(out.changed).toBe(false);
    expect(out.dropped).toEqual([]);
  });

  it("rejects a response with more ops than the hard ceiling", () => {
    const tooMany = {
      ops: Array.from({ length: 51 }, () => ({
        op: "add",
        list: "risks",
        item: { text: "x" },
      })),
    };
    expect(foldResultSchema.safeParse(tooMany).success).toBe(false);
  });

  it("rejects an unknown op verb (closed set)", () => {
    const result = foldResultSchema.safeParse({
      ops: [{ op: "delete", list: "risks", id: "r1" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("applyFold — adds and ids", () => {
  it("mints list-prefixed ids from a per-list counter", () => {
    const { notes } = foldAll(emptyLiveNotes("Acme call"), [
      adds("risks", ["Budget freeze", "Legal review"]),
    ]);
    expect(notes.risks.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(notes.risks.map((r) => r.text)).toEqual([
      "Budget freeze",
      "Legal review",
    ]);
    expect(notes.source).toBe("live");
  });

  it("accepts a bare string OR {text} for the string lists", () => {
    const { notes } = foldAll(emptyLiveNotes("Acme call"), [
      foldResultSchema.parse({
        ops: [
          { op: "add", list: "openQuestions", item: "Seat count?" },
          { op: "add", list: "openQuestions", item: { text: "Timeline?" } },
        ],
      }),
    ]);
    expect(notes.openQuestions.map((q) => q.text)).toEqual([
      "Seat count?",
      "Timeline?",
    ]);
  });

  it("defaults a decision's missing quote to null rather than dropping it", () => {
    const { notes } = foldAll(emptyLiveNotes("Acme call"), [
      foldResultSchema.parse({
        ops: [{ op: "add", list: "decisions", item: { text: "Pilot in Q3" } }],
      }),
    ]);
    expect(notes.decisions).toEqual([
      { id: "d1", text: "Pilot in Q3", quote: null },
    ]);
  });

  it("drops an add whose item has no usable text", () => {
    const out = applyFold(
      emptyLiveNotes("Acme call"),
      foldResultSchema.parse({
        ops: [{ op: "add", list: "risks", item: { note: "wrong key" } }],
      }),
      ctxWith(initialFoldState(null)),
    );
    expect(out.changed).toBe(false);
    expect(out.dropped).toEqual([
      { op: "add", list: "risks", reason: "invalid_item" },
    ]);
  });
});

describe("applyFold — [non-teleport] the churn ceiling", () => {
  /** A 12-item list: budget is max(3, ceil(12 * 0.25)) = 3. */
  const twelve = foldAll(emptyLiveNotes("Acme call"), [
    adds(
      "risks",
      Array.from({ length: 12 }, (_, i) => `risk ${String(i + 1)}`),
    ),
  ]);

  it("clamps a WHOLESALE rewrite to the per-list budget", () => {
    // The model returns an update for every single item — the teleport scenario.
    const rewrite = foldResultSchema.parse({
      ops: twelve.notes.risks.map((r) => ({
        op: "update",
        list: "risks",
        id: r.id,
        item: { text: `REWRITTEN ${r.id}` },
      })),
    });
    const out = applyFold(twelve.notes, rewrite, ctxWith(twelve.state));

    const rewritten = out.notes.risks.filter((r) =>
      r.text.startsWith("REWRITTEN"),
    );
    expect(rewritten).toHaveLength(3);
    expect(
      out.dropped.filter((d) => d.reason === "churn_ceiling"),
    ).toHaveLength(9);
    // The other nine survive untouched — retained, not dropped from the list.
    expect(out.notes.risks).toHaveLength(12);
  });

  it("clamps a wholesale RETRACT the same way (an hour of notes cannot vanish)", () => {
    const purge = foldResultSchema.parse({
      ops: twelve.notes.risks.map((r) => ({
        op: "retract",
        list: "risks",
        id: r.id,
        reason: "cleanup",
      })),
    });
    const out = applyFold(twelve.notes, purge, ctxWith(twelve.state));
    expect(out.notes.risks).toHaveLength(9);
  });

  it("scales the budget to 25% on a long list", () => {
    // 40 items → budget is ceil(40 * 0.25) = 10, not the floor of 3.
    const big = foldAll(emptyLiveNotes("Acme call"), [
      adds(
        "risks",
        Array.from({ length: 40 }, (_, i) => `r${String(i + 1)}`),
      ),
    ]);
    const rewrite = foldResultSchema.parse({
      ops: big.notes.risks.map((r) => ({
        op: "update",
        list: "risks",
        id: r.id,
        item: { text: `X ${r.id}` },
      })),
    });
    const out = applyFold(big.notes, rewrite, ctxWith(big.state));
    expect(out.notes.risks.filter((r) => r.text.startsWith("X "))).toHaveLength(
      10,
    );
  });

  it("budgets each list separately, computed from PRIOR lengths", () => {
    const seeded = foldAll(emptyLiveNotes("Acme call"), [
      adds("risks", ["a", "b", "c", "d"]),
      adds("openQuestions", ["p", "q", "r", "s"]),
    ]);
    const out = applyFold(
      seeded.notes,
      foldResultSchema.parse({
        ops: [
          ...seeded.notes.risks.map((r) => ({
            op: "update",
            list: "risks",
            id: r.id,
            item: { text: `R ${r.id}` },
          })),
          ...seeded.notes.openQuestions.map((q) => ({
            op: "update",
            list: "openQuestions",
            id: q.id,
            item: { text: `Q ${q.id}` },
          })),
        ],
      }),
      ctxWith(seeded.state),
    );
    expect(out.notes.risks.filter((r) => r.text.startsWith("R "))).toHaveLength(
      3,
    );
    expect(
      out.notes.openQuestions.filter((q) => q.text.startsWith("Q ")),
    ).toHaveLength(3);
  });
});

describe("applyFold — adversarial model output", () => {
  const seeded = foldAll(emptyLiveNotes("Acme call"), [
    adds("risks", ["one", "two"]),
  ]);

  it("drops an update against an id that does not exist (no mint-as-new)", () => {
    const out = applyFold(
      seeded.notes,
      foldResultSchema.parse({
        ops: [
          { op: "update", list: "risks", id: "r99", item: { text: "ghost" } },
        ],
      }),
      ctxWith(seeded.state),
    );
    expect(out.changed).toBe(false);
    expect(out.notes.risks).toHaveLength(2);
    expect(out.dropped[0]?.reason).toBe("unknown_id");
  });

  it("drops a retract against an unknown id", () => {
    const out = applyFold(
      seeded.notes,
      foldResultSchema.parse({
        ops: [{ op: "retract", list: "risks", id: "r42", reason: "n/a" }],
      }),
      ctxWith(seeded.state),
    );
    expect(out.changed).toBe(false);
    expect(out.dropped[0]?.reason).toBe("unknown_id");
  });

  it("takes the FIRST op against a repeated id and drops the rest", () => {
    const out = applyFold(
      seeded.notes,
      foldResultSchema.parse({
        ops: [
          { op: "update", list: "risks", id: "r1", item: { text: "first" } },
          { op: "update", list: "risks", id: "r1", item: { text: "second" } },
          { op: "retract", list: "risks", id: "r1", reason: "third" },
        ],
      }),
      ctxWith(seeded.state),
    );
    expect(out.notes.risks.find((r) => r.id === "r1")?.text).toBe("first");
    expect(out.dropped.filter((d) => d.reason === "duplicate_id")).toHaveLength(
      2,
    );
  });

  it("[server-owned order] a reshuffled response cannot reorder the list", () => {
    const many = foldAll(emptyLiveNotes("Acme call"), [
      adds("risks", ["one", "two", "three"]),
    ]);
    const out = applyFold(
      many.notes,
      foldResultSchema.parse({
        // The model echoes them back in reverse; only r3 is actually changed.
        ops: [
          { op: "update", list: "risks", id: "r3", item: { text: "THREE" } },
        ],
      }),
      ctxWith(many.state),
    );
    expect(out.notes.risks.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("drops an op against an arm the conversation type does not have", () => {
    const out = applyFold(
      seeded.notes, // still 'casual' — no objections arm
      foldResultSchema.parse({
        ops: [{ op: "add", list: "objections", item: { text: "too pricey" } }],
      }),
      ctxWith(seeded.state),
    );
    expect(out.changed).toBe(false);
    expect(out.dropped[0]?.reason).toBe("list_not_in_type");
  });

  it("drops an op against a list that does not exist at all", () => {
    const out = applyFold(
      seeded.notes,
      foldResultSchema.parse({
        ops: [{ op: "add", list: "vibes", item: { text: "good" } }],
      }),
      ctxWith(seeded.state),
    );
    expect(out.dropped[0]?.reason).toBe("unknown_list");
  });

  it("drops adds once the list hits its cap", () => {
    const full = foldAll(emptyLiveNotes("Acme call"), [
      adds(
        "risks",
        Array.from({ length: 40 }, (_, i) => `r${String(i + 1)}`),
      ),
    ]);
    const out = applyFold(
      full.notes,
      adds("risks", ["one too many"]),
      ctxWith(full.state),
    );
    expect(out.notes.risks).toHaveLength(40);
    expect(out.dropped[0]?.reason).toBe("list_at_cap");
  });

  it("reports changed:false when every op was dropped", () => {
    const out = applyFold(
      seeded.notes,
      foldResultSchema.parse({
        ops: [
          { op: "update", list: "risks", id: "nope", item: { text: "x" } },
          { op: "add", list: "vibes", item: { text: "y" } },
        ],
      }),
      ctxWith(seeded.state),
    );
    expect(out.changed).toBe(false);
    expect(out.notes).toBe(seeded.notes); // the very same object — nothing rebuilt
  });
});

describe("applyFold — id stability across a scripted sequence", () => {
  it("keeps ids through updates, frees none on retract, mints fresh after", () => {
    let notes = emptyLiveNotes("Acme call");
    let state = initialFoldState(notes);
    const step = (response: FoldResult): void => {
      const out = applyFold(notes, response, ctxWith(state));
      notes = out.notes;
      state = out.state;
    };

    step(adds("risks", ["alpha", "beta", "gamma"]));
    expect(notes.risks.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);

    // An untouched item keeps its id; an updated one keeps its id with new text.
    step(
      foldResultSchema.parse({
        ops: [
          { op: "update", list: "risks", id: "r2", item: { text: "BETA" } },
        ],
      }),
    );
    expect(notes.risks.map((r) => `${r.id}:${r.text}`)).toEqual([
      "r1:alpha",
      "r2:BETA",
      "r3:gamma",
    ]);

    // A retract removes it…
    step(
      foldResultSchema.parse({
        ops: [{ op: "retract", list: "risks", id: "r2", reason: "resolved" }],
      }),
    );
    expect(notes.risks.map((r) => r.id)).toEqual(["r1", "r3"]);

    // …and the NEXT add never reuses r2 (the counter is monotonic).
    step(adds("risks", ["delta"]));
    expect(notes.risks.map((r) => r.id)).toEqual(["r1", "r3", "r4"]);
  });
});

describe("applyFold — the conversation-type latch", () => {
  const seeded = foldAll(emptyLiveNotes("Acme call"), [
    adds("risks", ["budget"]),
  ]);

  it("promotes casual → sales once and installs the empty arm", () => {
    const out = applyFold(
      seeded.notes,
      foldResultSchema.parse({ conversationType: "sales" }),
      ctxWith(seeded.state),
    );
    expect(out.changed).toBe(true);
    expect(out.notes.conversationType).toBe("sales");
    expect(out.notes.typeInsights).toEqual({
      kind: "sales",
      objections: [],
      buyingSignals: [],
    });
    // Base lists survive the arm swap.
    expect(out.notes.risks).toHaveLength(1);
    expect(out.state.typeLatched).toBe(true);
  });

  it("refuses a SECOND transition — sales → interview would drop every objection", () => {
    const sales = applyFold(
      seeded.notes,
      foldResultSchema.parse({ conversationType: "sales" }),
      ctxWith(seeded.state),
    );
    const flip = applyFold(
      sales.notes,
      foldResultSchema.parse({ conversationType: "interview" }),
      ctxWith(sales.state),
    );
    expect(flip.changed).toBe(false);
    expect(flip.notes.conversationType).toBe("sales");
  });

  it("refuses any transition before the classify threshold", () => {
    const out = applyFold(
      seeded.notes,
      foldResultSchema.parse({ conversationType: "sales" }),
      ctxWith(seeded.state, { canLatchType: false }),
    );
    expect(out.notes.conversationType).toBe("casual");
  });

  it("routes arm ops once the type is latched", () => {
    const sales = applyFold(
      seeded.notes,
      foldResultSchema.parse({ conversationType: "sales" }),
      ctxWith(seeded.state),
    );
    const out = applyFold(
      sales.notes,
      foldResultSchema.parse({
        ops: [{ op: "add", list: "objections", item: "too pricey" }],
      }),
      ctxWith(sales.state),
    );
    const insights = out.notes.typeInsights;
    if (insights.kind !== "sales") throw new Error("expected the sales arm");
    expect(insights.objections).toEqual([{ id: "ob1", text: "too pricey" }]);
  });
});

describe("applyFold — narrative gating", () => {
  const seeded = foldAll(emptyLiveNotes("Acme call"), [adds("risks", ["x"])]);
  const narrative = foldResultSchema.parse({
    narrative: {
      title: "Acme Q3 renewal",
      tldr: "Acme will pilot in Q3.",
      overview: "The buyer walked through team size and asked for a pilot.",
    },
  });

  it("ignores the narrative entirely on a CLOSED window", () => {
    const out = applyFold(seeded.notes, narrative, ctxWith(seeded.state));
    expect(out.changed).toBe(false);
    expect(out.notes.tldr).toBe(seeded.notes.tldr);
  });

  it("applies it on an OPEN window", () => {
    const out = applyFold(
      seeded.notes,
      narrative,
      ctxWith(seeded.state, { narrativeOpen: true }),
    );
    expect(out.changed).toBe(true);
    expect(out.notes.title).toBe("Acme Q3 renewal");
    expect(out.notes.tldr).toBe("Acme will pilot in Q3.");
    expect(out.state.titleLatched).toBe(true);
  });

  it("latches the title — a later narrative may rewrite tldr but not the name", () => {
    const first = applyFold(
      seeded.notes,
      narrative,
      ctxWith(seeded.state, { narrativeOpen: true }),
    );
    const second = applyFold(
      first.notes,
      foldResultSchema.parse({
        narrative: { title: "Something else entirely", tldr: "Updated." },
      }),
      ctxWith(first.state, { narrativeOpen: true }),
    );
    expect(second.notes.title).toBe("Acme Q3 renewal");
    expect(second.notes.tldr).toBe("Updated.");
  });
});

describe("applyFold — quote verification (rule 10)", () => {
  it("flags a decision whose quote is not in the transcript", () => {
    const out = applyFold(
      emptyLiveNotes("Acme call"),
      foldResultSchema.parse({
        ops: [
          {
            op: "add",
            list: "decisions",
            item: { text: "Pilot agreed", quote: "let's do a pilot" },
          },
          {
            op: "add",
            list: "decisions",
            item: { text: "Invented", quote: "we will pay a million dollars" },
          },
        ],
      }),
      ctxWith(initialFoldState(null), {
        transcriptSoFar: "Sure, let's do a pilot next quarter.",
      }),
    );
    expect(out.notes.decisions[0]?.unverified).toBeUndefined();
    expect(out.notes.decisions[1]?.unverified).toBe(true);
  });
});

describe("deriveSeqCounters / initialFoldState (hydration)", () => {
  it("recovers the high-water mark per list from stored notes", () => {
    const { notes } = foldAll(emptyLiveNotes("Acme call"), [
      adds("risks", ["a", "b", "c"]),
      adds("openQuestions", ["p"]),
    ]);
    expect(deriveSeqCounters(notes)).toMatchObject({
      risks: 3,
      openQuestions: 1,
      decisions: 0,
    });
  });

  it("starts every counter at zero for a call with no stored notes", () => {
    expect(deriveSeqCounters(null)).toMatchObject({ risks: 0, decisions: 0 });
  });

  it("treats a hydrated typed call as already latched", () => {
    const { notes, state } = foldAll(emptyLiveNotes("Acme call"), [
      foldResultSchema.parse({ conversationType: "sales" }),
    ]);
    expect(state.typeLatched).toBe(true);
    expect(initialFoldState(notes).typeLatched).toBe(true);
  });

  it("continues minting above the hydrated high-water mark", () => {
    const { notes } = foldAll(emptyLiveNotes("Acme call"), [
      adds("risks", ["a", "b", "c"]),
    ]);
    // A fresh session over the stored row: state comes only from the notes.
    const out = applyFold(
      notes,
      adds("risks", ["d"]),
      ctxWith(initialFoldState(notes)),
    );
    expect(out.notes.risks.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4"]);
  });
});
