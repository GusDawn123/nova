import { identifyNotes, type MeetingNotes, type NotesContent } from "@nova/shared";
import { describe, expect, it } from "vitest";

import { reconcileIds } from "./reconcile-ids.js";

/**
 * The swap at call end IS the forbidden teleport unless retained items keep their
 * identity (§3). These tests are about ids and nothing else — the content of the
 * final notes is authoritative and must come through untouched.
 */

function notesWith(over: Partial<NotesContent>, source: "generated" | "live"): MeetingNotes {
  return identifyNotes(
    {
      conversationType: "casual",
      title: "Acme call",
      tldr: "A call happened.",
      overview: "Some things were said on the call.",
      decisions: [],
      actionItems: [],
      openQuestions: [],
      risks: [],
      typeInsights: { kind: "casual" },
      ...over,
    },
    source,
  );
}

describe("reconcileIds", () => {
  it("returns the final notes untouched when there is no live preview", () => {
    const final = notesWith({ risks: ["Budget freeze"] }, "generated");
    expect(reconcileIds(null, final)).toBe(final);
  });

  it("carries the live id onto an identical final item", () => {
    const live = notesWith(
      { risks: ["Budget freeze", "Legal review", "Timeline slip"] },
      "live",
    );
    // The post-call pass re-derived the same three, in a different order.
    const final = notesWith(
      { risks: ["Timeline slip", "Budget freeze", "Legal review"] },
      "generated",
    );

    const out = reconcileIds(live, final);
    const byText = new Map(out.risks.map((r) => [r.text, r.id]));
    expect(byText.get("Budget freeze")).toBe("r1");
    expect(byText.get("Legal review")).toBe("r2");
    expect(byText.get("Timeline slip")).toBe("r3");
    // The FINAL order is preserved — only ids are rewritten.
    expect(out.risks.map((r) => r.text)).toEqual([
      "Timeline slip",
      "Budget freeze",
      "Legal review",
    ]);
  });

  it("matches through the rewording the post-call pass applies", () => {
    const live = notesWith(
      { risks: ["the budget has not been approved yet"] },
      "live",
    );
    const final = notesWith(
      { risks: ["The budget has not been approved"] },
      "generated",
    );
    expect(reconcileIds(live, final).risks[0]?.id).toBe("r1");
  });

  it("mints fresh for a genuinely new item, above every carried id", () => {
    const live = notesWith({ risks: ["Budget freeze", "Legal review"] }, "live");
    const final = notesWith(
      { risks: ["Budget freeze", "Legal review", "Something nobody said live"] },
      "generated",
    );
    const out = reconcileIds(live, final);
    expect(out.risks.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("never collides a fresh mint with a carried id", () => {
    // Only the THIRD live item survives, so the carried id is r3 — a naive
    // 1-based mint for the new items would collide with it.
    const live = notesWith({ risks: ["gone a", "gone b", "kept"] }, "live");
    const final = notesWith({ risks: ["brand new", "kept"] }, "generated");
    const out = reconcileIds(live, final);
    expect(out.risks.find((r) => r.text === "kept")?.id).toBe("r3");
    const ids = out.risks.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not let two final items claim the same live id", () => {
    const live = notesWith({ risks: ["the budget is a concern"] }, "live");
    const final = notesWith(
      { risks: ["The budget is a concern", "the budget is a concern too"] },
      "generated",
    );
    const out = reconcileIds(live, final);
    const ids = out.risks.map((r) => r.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("prefers an exact match over a merely-similar one", () => {
    const live = notesWith(
      { risks: ["the budget has not been approved", "the budget"] },
      "live",
    );
    const final = notesWith({ risks: ["the budget"] }, "generated");
    // r2 is the exact match; r1 is similar. The exact one must win.
    expect(reconcileIds(live, final).risks[0]?.id).toBe("r2");
  });

  it("never migrates an id between lists", () => {
    const live = notesWith({ risks: ["Budget freeze"] }, "live");
    const final = notesWith({ openQuestions: ["Budget freeze"] }, "generated");
    // Same text, different list → a fresh mint under the openQuestions prefix.
    expect(reconcileIds(live, final).openQuestions[0]?.id).toBe("q1");
  });

  it("carries ids across the itemized object lists too", () => {
    const live = notesWith(
      { decisions: [{ text: "Proceed with a pilot", quote: null }] },
      "live",
    );
    const final = notesWith(
      {
        decisions: [
          { text: "Proceed with a pilot", quote: "let's do a pilot" },
        ],
      },
      "generated",
    );
    const out = reconcileIds(live, final);
    expect(out.decisions[0]?.id).toBe("d1");
    // The FINAL content wins — reconcile only ever rewrites ids.
    expect(out.decisions[0]?.quote).toBe("let's do a pilot");
  });

  it("mints fresh for an arm the live notes never had", () => {
    const live = notesWith({ risks: ["Budget freeze"] }, "live"); // casual
    const final = identifyNotes(
      {
        conversationType: "sales",
        title: "Acme call",
        tldr: "A call happened.",
        overview: "Some things were said.",
        decisions: [],
        actionItems: [],
        openQuestions: [],
        risks: ["Budget freeze"],
        typeInsights: {
          kind: "sales",
          objections: ["too expensive"],
          buyingSignals: ["asked for a pilot"],
        },
      },
      "generated",
    );
    const out = reconcileIds(live, final);
    expect(out.risks[0]?.id).toBe("r1"); // carried
    const insights = out.typeInsights;
    if (insights.kind !== "sales") throw new Error("expected the sales arm");
    expect(insights.objections[0]?.id).toBe("ob1"); // minted
  });

  it("keeps the final notes' own source and narrative", () => {
    const live = notesWith({ risks: ["x"] }, "live");
    const final = notesWith({ risks: ["x"] }, "generated");
    const out = reconcileIds(live, final);
    expect(out.source).toBe("generated");
    expect(out.version).toBe(2);
  });
});
