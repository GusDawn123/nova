import { describe, expect, it } from "vitest";

import {
  enforceChunk,
  enforceSpoken,
  repairToSayBlock,
  speakableStats,
  validateSayFormat,
} from "./enforce.js";

/**
 * The voice guarantee's behavior contract (Gustavo-ratified 2026-08-20):
 * the Nova fence INVERSION (```text and bare fences are SPEECH, language-
 * tagged fences are protected code), every mechanical rewrite (dashes,
 * semicolons, narration, coaching, idioms, trailing offers), detection-only
 * word tells, idempotence over every fixture, the Say-format validator +
 * repair wrap, speakable stats, the streaming chunk pass, and the < 5ms
 * micro-bench. This module is the product's spoken-voice floor — the tests
 * are deliberately exhaustive.
 */

const say = (body: string): string => `Say:\n\`\`\`text\n${body}\n\`\`\``;

/** Every input exercised below rides the idempotence loop at the end. */
const FIXTURES: string[] = [];
const fixture = (text: string): string => {
  FIXTURES.push(text);
  return text;
};

describe("modules/prompt [enforce] the fence inversion", () => {
  it("[enforce] rewrites an em dash inside a ```text body", () => {
    const input = fixture(
      say("The rollout took three weeks — about half the usual time."),
    );
    const result = enforceSpoken(input);
    expect(result.text).toBe(
      say("The rollout took three weeks, about half the usual time."),
    );
    expect(result.changed).toBe(true);
    expect(result.violations).toContain("em-dash");
  });

  it("[enforce] rewrites inside a BARE fence — today's Brain A output", () => {
    const input = fixture("Say:\n```\nIt cut costs — a lot.\n```");
    expect(enforceSpoken(input).text).toBe(
      "Say:\n```\nIt cut costs, a lot.\n```",
    );
  });

  it("[enforce] never touches the same dash inside a ```python body", () => {
    const input = fixture(
      'Say:\n```text\nUse the helper below.\n```\nCode:\n```python\nlabel = "a — b"  # em dash; stays\n```',
    );
    const result = enforceSpoken(input);
    expect(result.text).toBe(input);
    expect(result.changed).toBe(false);
    // Code-fence content is not a speakable segment — nothing to report.
    expect(result.violations).toEqual([]);
  });

  it("[enforce] protects inline code and inline math inside speech", () => {
    const input = fixture(say("Compare `a — b` with $c — d$ and note x — y."));
    const result = enforceSpoken(input);
    expect(result.text).toBe(
      say("Compare `a — b` with $c — d$ and note x, y."),
    );
    expect(result.violations).toContain("em-dash");
  });

  it("[enforce] spoken money is never mistaken for math", () => {
    const input = fixture(say("The tiers are $47,500 and $40 — pick one."));
    expect(enforceSpoken(input).text).toBe(
      say("The tiers are $47,500 and $40, pick one."),
    );
  });

  it("[enforce] enforces stray prose outside any fence, labels untouched", () => {
    const input = fixture(
      "Say:\n```text\nFine as is.\n```\nThe answer is 42 — trust me.",
    );
    expect(enforceSpoken(input).text).toBe(
      "Say:\n```text\nFine as is.\n```\nThe answer is 42, trust me.",
    );
  });
});

describe("modules/prompt [enforce] punctuation mechanics", () => {
  it("[enforce] numeric ranges survive as hyphens; compounds and flags survive", () => {
    const input = fixture(
      say(
        "Give me 10-15 minutes, ideally 3—5, run --dry-run for real-time checks on 10 - 15 rows.",
      ),
    );
    const result = enforceSpoken(input);
    expect(result.text).toBe(
      say(
        "Give me 10-15 minutes, ideally 3-5, run --dry-run for real-time checks on 10 - 15 rows.",
      ),
    );
    expect(result.violations).toEqual(["em-dash"]);
  });

  it("[enforce] typewriter dash and spaced ASCII dash become commas", () => {
    const input = fixture(
      say(
        "The fix was simple -- a cache, and the tradeoff was cost - benefit.",
      ),
    );
    const result = enforceSpoken(input);
    expect(result.text).toBe(
      say("The fix was simple, a cache, and the tradeoff was cost, benefit."),
    );
    expect(result.violations).toContain("double-dash");
    expect(result.violations).toContain("ascii-dash");
  });

  it("[enforce] semicolons split into sentences with capitalization", () => {
    const input = fixture(say("We shipped it; the team loved it; done;"));
    const result = enforceSpoken(input);
    expect(result.text).toBe(say("We shipped it. The team loved it. Done."));
    expect(result.violations).toContain("semicolon");
  });
});

describe("modules/prompt [enforce] voice scrubs", () => {
  it("[enforce] strips sentence-initial source narration, recapitalized", () => {
    const input = fixture(
      say(
        "Based on my resume, I led the rewrite. According to the notes, we shipped in May.",
      ),
    );
    const result = enforceSpoken(input);
    expect(result.text).toBe(say("I led the rewrite. We shipped in May."));
    expect(result.violations).toContain("narration");
  });

  it("[enforce] stacked narration unwinds fully in ONE call", () => {
    const input = fixture(
      say("Based on my notes, based on my resume, I led the rewrite."),
    );
    expect(enforceSpoken(input).text).toBe(say("I led the rewrite."));
  });

  it("[enforce] strips a coaching prefix at the answer start", () => {
    const input = fixture(
      say("Here's what you could say: we grew revenue 40 percent."),
    );
    const result = enforceSpoken(input);
    expect(result.text).toBe(say("We grew revenue 40 percent."));
    expect(result.violations).toContain("coaching-prefix");
  });

  it("[enforce] nested coaching prefixes unwrap in ONE call", () => {
    const input = fixture(say("Answer: Say this: it ships Tuesday."));
    expect(enforceSpoken(input).text).toBe(say("It ships Tuesday."));
  });

  it.each([
    ["a proven track record", "I've done this before"],
    ["move the needle", "make a real difference"],
    ["actionable insights", "things the team can actually use"],
    ["a unique blend of skills", "the useful part of my background is"],
    ["best-in-class support", "as good as it gets support"],
    ["real synergy here", "working well together"],
    ["clear synergies emerged", "working well together"],
    ["let's circle back tomorrow", "come back to this tomorrow"],
    ["we should touch base soon", "we should talk soon"],
  ])("[enforce] idiom drop-in: %s", (phrase, plain) => {
    const input = fixture(say(`They want ${phrase} for the team.`));
    const result = enforceSpoken(input);
    expect(result.text).toContain(plain);
    expect(result.violations.some((v) => v.startsWith("idiom:"))).toBe(true);
  });

  it("[enforce] absorbs an existing 'to this' so the drop-in never doubles", () => {
    const input = fixture(say("Let's circle back to this after the demo."));
    expect(enforceSpoken(input).text).toBe(
      say("Let's come back to this after the demo."),
    );
  });

  it("[enforce] strips a trailing offer sentence and ends clean", () => {
    const input = fixture(
      say(
        "The price lands at $40 a seat. Let me know if you want the annual math.",
      ),
    );
    const result = enforceSpoken(input);
    expect(result.text).toBe(say("The price lands at $40 a seat."));
    expect(result.violations).toContain("filler-ending");
  });

  it("[enforce] peels stacked trailing filler sentences", () => {
    const input = fixture(
      say("It works. I hope this helps. Let me know if you have questions."),
    );
    expect(enforceSpoken(input).text).toBe(say("It works."));
  });

  it("[enforce] keeps a filler-shaped sentence that is NOT the ending", () => {
    const input = fixture(
      say("Feel free to push back on price. The floor is $40."),
    );
    const result = enforceSpoken(input);
    expect(result.text).toBe(input);
    expect(result.changed).toBe(false);
    expect(result.violations).not.toContain("filler-ending");
  });
});

describe("modules/prompt [enforce] violations — logged, not rewritten", () => {
  it("[enforce] word-class tells are detected and the text stays byte-identical", () => {
    const input = fixture(
      say(
        "Let's delve into the intricate tapestry and leverage the platform. Moreover, it's important to note this is a great question. Certainly!",
      ),
    );
    const result = enforceSpoken(input);
    expect(result.text).toBe(input);
    expect(result.changed).toBe(false);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        "banned-word:delve",
        "banned-word:intricate",
        "banned-word:tapestry",
        "banned-word:leverage",
        "banned-word:moreover",
        "banned-word:it's important to note",
        "banned-word:great question",
        "banned-word:certainly!",
      ]),
    );
  });

  it("[enforce] the rest of the banned list is covered too", () => {
    const input = fixture(
      say(
        "Furthermore, we navigate the landscape in the realm of AI in today's fast-paced world.",
      ),
    );
    expect(enforceSpoken(input).violations).toEqual(
      expect.arrayContaining([
        "banned-word:furthermore",
        "banned-word:navigate the",
        "banned-word:in the realm of",
        "banned-word:in today's fast-paced world",
      ]),
    );
  });

  it("[enforce] 'leverage' as a NOUN is not flagged (verb best-effort)", () => {
    const input = fixture(say("That deal gives us leverage."));
    expect(enforceSpoken(input).violations).toEqual([]);
  });

  it("[enforce] tells inside code fences and inline code are never flagged", () => {
    const input = fixture(
      say("Run `delve — debug;` now.") +
        "\nCode:\n```go\n// delve — the debugger; leverage the tooling\n```",
    );
    expect(enforceSpoken(input).violations).toEqual([]);
  });
});

describe("modules/prompt [enforce] validateSayFormat", () => {
  it("[enforce] accepts the canonical one-block and two-block shapes", () => {
    expect(validateSayFormat(say("Hello there.")).ok).toBe(true);
    const two = `${say("Lead answer.")}\nIf they push back:\n\`\`\`text\nFallback.\n\`\`\``;
    expect(validateSayFormat(two)).toEqual({ ok: true, issues: [] });
  });

  it("[enforce] flags a missing Say: label before the first fence", () => {
    expect(validateSayFormat("```text\nHi.\n```").issues).toContain(
      "missing-say-label",
    );
    expect(validateSayFormat("Answer:\n```text\nHi.\n```").issues).toContain(
      "missing-say-label",
    );
  });

  it("[enforce] flags more than two fence blocks", () => {
    const three = `${say("A.")}\nAlso:\n\`\`\`text\nB.\n\`\`\`\nAnd:\n\`\`\`text\nC.\n\`\`\``;
    expect(validateSayFormat(three).issues).toContain("too-many-blocks");
  });

  it("[enforce] enforces label discipline: short, colon-terminated, present", () => {
    const longLabel =
      "This label line keeps going far past the forty character bound:";
    const tooLong = `${say("A.")}\n${longLabel}\n\`\`\`text\nB.\n\`\`\``;
    expect(validateSayFormat(tooLong).issues).toContain("label-too-long");

    const noColon = `${say("A.")}\nHere is another\n\`\`\`text\nB.\n\`\`\``;
    expect(validateSayFormat(noColon).issues).toContain("label-missing-colon");

    const unlabeled = `${say("A.")}\n\n\`\`\`text\nB.\n\`\`\``;
    expect(validateSayFormat(unlabeled).issues).toContain("unlabeled-block");
  });

  it("[enforce] flags an unclosed fence and a fence-free answer", () => {
    expect(validateSayFormat("Say:\n```text\nA.").issues).toContain(
      "unclosed-fence",
    );
    expect(validateSayFormat("Just prose, no fence.")).toEqual({
      ok: false,
      issues: ["no-fence"],
    });
  });
});

describe("modules/prompt [enforce] repairToSayBlock", () => {
  it("[enforce] wraps a fence-free answer into the canonical Say block", () => {
    expect(repairToSayBlock("  Plain spoken answer. ")).toBe(
      say("Plain spoken answer."),
    );
  });

  it("[enforce] never nests — text with a fence comes back untouched", () => {
    const already = say("Already fine.");
    expect(repairToSayBlock(already)).toBe(already);
  });
});

describe("modules/prompt [enforce] speakableStats", () => {
  it("[enforce] counts speakable words only — labels, code, inline code are silent", () => {
    const input =
      "Say:\n```text\nOne two three four five six seven.\n```\nCode:\n```js\nconst a = 1;\n```";
    expect(speakableStats(input)).toEqual({ words: 7, seconds: 2.5 });
  });

  it("[enforce] excludes inline code and math from the spoken count", () => {
    expect(speakableStats(say("Run `npm test` now")).words).toBe(2);
    expect(speakableStats(say("So $x^2 + y$ holds true")).words).toBe(3);
  });

  it("[enforce] never trims — stats are advisory in v1", () => {
    const long = say("word ".repeat(400).trim());
    const result = enforceSpoken(long);
    expect(result.text).toBe(long);
    expect(speakableStats(long).words).toBe(400);
  });
});

describe("modules/prompt [enforce] enforceChunk — streaming-safe subset", () => {
  it("[enforce] swaps dashes mid-chunk", () => {
    expect(enforceChunk("takes three — maybe four")).toBe(
      "takes three, maybe four",
    );
    expect(enforceChunk("a -- b")).toBe("a, b");
    expect(enforceChunk("pages 3—5 today")).toBe("pages 3-5 today");
  });

  it("[enforce] leaves flags and code-looking chunks alone", () => {
    expect(enforceChunk("use --dry-run here")).toBe("use --dry-run here");
    expect(enforceChunk("git log --oneline")).toBe("git log --oneline");
    expect(enforceChunk("")).toBe("");
  });
});

describe("modules/prompt [enforce] idempotence — f(f(x)) === f(x)", () => {
  it("[enforce] every fixture is a fixpoint after one pass", () => {
    expect(FIXTURES.length).toBeGreaterThan(20);
    for (const input of FIXTURES) {
      const once = enforceSpoken(input);
      const twice = enforceSpoken(once.text);
      expect(twice.text).toBe(once.text);
      expect(twice.changed).toBe(false);
    }
  });
});

describe("modules/prompt [enforce] performance", () => {
  it("[latency] a ~1,500-word two-block answer averages under 5ms", () => {
    const sentence =
      "Honestly the migration cut deploy time from 40 minutes to 5 — the " +
      "hard part was schema drift; we fixed it with versioned contracts and " +
      "moved on to the next milestone without much drama at all. ";
    const block = sentence.repeat(25).trim();
    const answer = `Say:\n\`\`\`text\n${block}\n\`\`\`\nIf they push back:\n\`\`\`text\n${block}\n\`\`\``;
    const words = answer.split(/\s+/).length;
    expect(words).toBeGreaterThan(1200);

    enforceSpoken(answer); // warm-up: regex + JIT
    const start = Date.now();
    for (let i = 0; i < 100; i += 1) enforceSpoken(answer);
    const avg = (Date.now() - start) / 100;
    console.log(
      `[latency] enforceSpoken ${String(words)} words: avg=${avg.toFixed(2)}ms over 100 calls (bar <5ms)`,
    );
    expect(avg).toBeLessThan(5);
  });
});

describe("modules/prompt [enforce] humanizer v2 (2026-08-21)", () => {
  const say = (body: string): string => "Say:\n```text\n" + body + "\n```";
  const spoken = (out: string): string =>
    out.split("```text\n")[1]?.split("\n```")[0] ?? "";

  it("swaps the safe fillers and keeps the sentence grammatical", () => {
    const r = enforceSpoken(
      say(
        "In order to move fast we skipped it. Due to the fact that budget was tight, we waited. At this point in time it works. The team has the ability to run it.",
      ),
    );
    const body = spoken(r.text);
    expect(body).toContain("To move fast");
    expect(body).toContain("Because budget was tight");
    expect(body).toContain("Now it works");
    expect(body).toContain("The team can run it");
    expect(r.violations).toContain("filler:in order to");
  });

  it("straightens curly quotes and apostrophes", () => {
    const r = enforceSpoken(say("He said “we’re in” and meant it."));
    expect(spoken(r.text)).toBe('He said "we\'re in" and meant it.');
    expect(r.violations).toContain("curly-quotes");
  });

  it("DETECTS the new bands without rewriting their words", () => {
    const cases: [string, string][] = [
      ["Our platform boasts a seamless rollout.", "ad-speak"],
      ["It serves as your first responder.", "serves-as"],
      ["It's not just a tool, it's a system.", "not-just-x"],
      ["We handle calls, texts, and email.", "forced-three"],
      ["It could potentially help.", "qualifier-stack"],
      ["The real question is whether you grow.", "fake-depth"],
      ["Let's dive into the numbers.", "staged-opener"],
      ["The future looks bright for you.", "generic-ending"],
      ["Speed is the currency of trust.", "formulaic-saying"],
      ["That was a pivotal moment for us.", "inflation"],
      ["This is a crucial part of the rollout.", "banned-word:crucial"],
    ];
    for (const [body, band] of cases) {
      const r = enforceSpoken(say(body));
      expect(r.violations, `${band} for: ${body}`).toContain(band);
      // Word-class and shape tells are logged, never rewritten.
      expect(spoken(r.text)).toBe(body);
    }
  });

  it("flags a wall of same-length sentences, not a single long answer", () => {
    const even = enforceSpoken(
      say(
        "We answer every inbound call within two rings of it arriving. Your team keeps the conversations that actually need a person. The system handles the repetitive questions that come in daily. Nothing slips through when the front desk gets busy.",
      ),
    );
    expect(even.violations).toContain("uniform-rhythm");

    const varied = enforceSpoken(
      say(
        "Totally fair. We answer every inbound call within two rings, so nothing slips when the desk gets busy. Your team keeps the real conversations. That's the whole trade.",
      ),
    );
    expect(varied.violations).not.toContain("uniform-rhythm");
  });

  it("tellScore counts distinct bands, and stays 0 on clean speech", () => {
    const clean = enforceSpoken(
      say(
        "Totally fair. If after-hours volume is low, I wouldn't anchor there either. The stronger case is daytime overflow.",
      ),
    );
    expect(clean.tellScore).toBe(0);
    expect(clean.violations).toEqual([]);

    const messy = enforceSpoken(
      say("Our platform boasts a seamless fit — it could potentially help."),
    );
    expect(messy.tellScore).toBe(messy.violations.length);
    expect(messy.tellScore).toBeGreaterThanOrEqual(3);
  });

  it("stays idempotent with every new rule on", () => {
    const input = say(
      "In order to be clear — the team has the ability to ship; due to the fact that it’s ready.",
    );
    const once = enforceSpoken(input).text;
    const twice = enforceSpoken(once);
    expect(twice.text).toBe(once);
    expect(twice.changed).toBe(false);
  });
});
