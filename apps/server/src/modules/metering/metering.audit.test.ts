import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { noopMeter } from "../llm/index.js";
import { createMeteringService, type MeteringServiceDeps } from "./index.js";

/**
 * [metering-wiring] STATIC audit (adr-0007 §Wire-through invariant, RULES §6): no
 * code path reaches a vendor adapter without a REAL metering sink. Mirrors the STT
 * `[no-disk]` static-grep audit — it reads `app.ts` and inspects the llm-router
 * construction sites rather than running them.
 *
 * TASK-1 HONESTY (my choice): app.ts wiring is Task 2/3's job, so this audit does NOT
 * yet assert the router sites pass a meter. Instead it:
 *   1. proves the real sink is BUILDABLE now (createMeteringService → a non-noop
 *      Meter) — so the invariant is satisfiable, not vapourware; and
 *   2. pins the CURRENT unwired state (every createLlmRouter site omits `meter`, so
 *      the router falls back to its internal noopMeter). This assertion is the
 *      RED-then-GREEN forcing function: when Task 2 threads `metering.meterFor(...)`
 *      into the router sites, THIS test goes red and must be flipped to the positive
 *      invariant below (the `it.todo`).
 */

const APP_TS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "app.ts",
);

/**
 * The object-literal argument text of every `createLlmRouter({ ... })` call in the
 * source — brace-matched so nested objects (e.g. `config: llmConfigSchema.parse({})`)
 * don't truncate the capture.
 */
function llmRouterCallArgs(src: string): string[] {
  const needle = "createLlmRouter({";
  const args: string[] = [];
  let from = 0;
  for (;;) {
    const start = src.indexOf(needle, from);
    if (start === -1) break;
    // Walk from the opening brace of the argument object to its match.
    let depth = 0;
    let i = start + needle.length - 1; // index of the '{'
    const open = i;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    args.push(src.slice(open, i + 1));
    from = i + 1;
  }
  return args;
}

describe("modules/metering wiring audit", () => {
  it("[metering-buildable] the real metering sink is a non-noop Meter", () => {
    // A minimal stub DB — the audit only needs the service to construct + hand back a
    // meter, not to persist.
    const db: MeteringServiceDeps["db"] = {
      insert: () => Promise.resolve(),
      sumAmountForUser: () => Promise.resolve(0),
      sumCostSince: () => Promise.resolve(0),
    };
    const logger: MeteringServiceDeps["logger"] = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    };
    const meter = createMeteringService({ db, logger }).meterFor("u1", "m1");
    expect(meter).not.toBe(noopMeter);
    expect(typeof meter.recordUsage).toBe("function");
  });

  it("[metering-not-yet-wired] app.ts llm-router sites omit a meter (Task 2 flips this)", () => {
    const src = readFileSync(APP_TS, "utf8");
    const calls = llmRouterCallArgs(src);
    // There ARE router construction sites to eventually wire.
    expect(calls.length).toBeGreaterThan(0);
    // Task-1 state: none threads a `meter` yet. When Task 2 wires
    // `metering.meterFor(...)`, this expectation fails → flip to the positive
    // invariant (the `it.todo`) and delete this placeholder.
    for (const args of calls) {
      expect(args).not.toMatch(/\bmeter\b/);
    }
  });

  // The invariant this audit enforces once app.ts is wired (Task 2/3). Flip the
  // placeholder above into this once `metering.meterFor(...)` reaches every site.
  it.todo(
    "[metering-wired] every createLlmRouter site in app.ts passes a non-noop meter",
  );
});
