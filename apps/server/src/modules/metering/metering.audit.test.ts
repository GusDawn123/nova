import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { noopMeter } from "../llm/index.js";
import { createMeteringService, type MeteringServiceDeps } from "./index.js";

/**
 * [metering-wiring] STATIC audit (adr-0007 §Wire-through invariant, RULES §6): no
 * code path reaches a vendor adapter without a REAL metering sink. Mirrors the STT
 * `[no-disk]` static-grep audit — it reads `app.ts` and inspects the vendor
 * construction sites rather than running them.
 *
 * Task-2 form (app.ts wiring landed): the audit asserts POSITIVELY that
 *   1. the real sink is buildable and non-noop;
 *   2. every function in app.ts that constructs an llm router also threads the
 *      metering seam (`meterFor`) into that router's consumer — the notes
 *      pipeline and the follow-up generator both receive it;
 *   3. every RAG construction site (`createRagFromEnv`) passes a `logUsage` sink;
 *   4. app.ts builds the real metering service and never references `noopMeter`.
 * STT wiring is Task 3's flush points; this audit tightens again there.
 */

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const APP_TS = join(SRC_ROOT, "app.ts");
/** The split-out metering boot helpers app.ts calls (RULES §2 file cap). */
const WIRING_TS = join(SRC_ROOT, "metering-wiring.ts");
/** The live WS transport — the STT vendor path (Task 3 flush points). */
const LIVE_ROUTES_TS = join(SRC_ROOT, "modules", "live", "routes.ts");

/**
 * Split the source into top-level `function` blocks (name → body text). Good
 * enough for the audit: app.ts wires everything inside named top-level functions.
 *
 * `export ` IS part of the pattern, and that is load-bearing. Without it the
 * regex missed every exported function, so `metering-wiring.ts` — where all but
 * one function is exported — collapsed into a SINGLE block starting at its lone
 * unexported helper and running to end-of-file. Every per-function assertion
 * below then reduced to "somewhere in this file the word meterFor appears",
 * which is exactly the vacuous pass the notes-factory case exists to prevent
 * (design-doc §8). Found 2026-07-26 while adding that case.
 */
function functionBlocks(src: string): Map<string, string> {
  return new Map(
    functionSpans(src).map((span) => [
      span.name,
      src.slice(span.start, span.end),
    ]),
  );
}

/**
 * Each top-level function's TRUE extent, brace-matched from its signature to its
 * closing brace.
 *
 * why brace-matching rather than slicing to the next function's start: trailing
 * top-level code was being absorbed into the preceding function's block, so a
 * module-scope `createLlmRouter(...)` written AFTER any function that merely
 * mentions `meterFor` inherited that mention and passed — the same vacuity this
 * audit exists to stop, just relocated. Verified by probe (CodeRabbit round 2).
 */
function functionSpans(
  src: string,
): { name: string; start: number; end: number }[] {
  const re = /^(?:export (?:default )?)?(?:async )?function (\w+)/gm;
  const spans: { name: string; start: number; end: number }[] = [];
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    const open = src.indexOf("{", m.index);
    if (open === -1) continue;
    let depth = 0;
    let i = open;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    spans.push({
      name: m[1] ?? "",
      start: m.index,
      end: Math.min(i + 1, src.length),
    });
  }
  return spans;
}

/**
 * Every scope a vendor call could sit in: each top-level function block, PLUS a
 * synthetic `<module scope>` block holding whatever precedes the first function.
 *
 * The tree-wide backstop needs this rather than raw file text. Checking the seam
 * against a whole file lets an unrelated function's `meterFor` vouch for a call
 * site that threads nothing — the vacuous pass that let the live-copilot factory
 * ship unmetered (CodeRabbit, 2026-07-28). Module scope is included so a top-level
 * `const router = createLlmRouter({...})` cannot escape by sitting outside any
 * function.
 */
function enclosingBlocks(src: string): Map<string, string> {
  const blocks = functionBlocks(src);
  // Module scope = every byte NOT inside a top-level function body, joined —
  // before, between, and AFTER the functions. The trailing region is the part
  // that used to leak into the last function's block. Arrow-function and
  // class-method bodies fall in here too: a coarser bucket, but it errs toward
  // demanding the seam rather than toward a silent pass.
  const spans = functionSpans(src).sort((a, b) => a.start - b.start);
  let moduleScope = "";
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) moduleScope += src.slice(cursor, span.start);
    cursor = Math.max(cursor, span.end);
  }
  moduleScope += src.slice(cursor);
  if (moduleScope.trim() !== "") blocks.set("<module scope>", moduleScope);
  return blocks;
}

/**
 * The block with every CONDITIONAL SPREAD (`...( ... )`) removed, paren-matched.
 *
 * This is the load-bearing half of the tree-wide backstop. Presence of the seam
 * token is not enough — the live-copilot factory shipped unmetered while literally
 * containing `meterFor`, because it was threaded as
 * `...(metering ? { meter: metering.meterFor(...) } : {})`. When metering was
 * undefined the spread contributed nothing and the vendor call ran bare, yet every
 * substring check passed. Stripping conditional spreads before testing the seam
 * asks the question that actually matters: is this vendor path metered
 * UNCONDITIONALLY? A conditional meter is not a meter.
 */
function withoutConditionalSpreads(block: string): string {
  let out = "";
  for (let i = 0; i < block.length;) {
    if (block.startsWith("...(", i)) {
      let depth = 0;
      let j = i + 3; // index of the '('
      for (; j < block.length; j++) {
        const ch = block[j];
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      i = j + 1;
      continue;
    }
    out += block[i] ?? ""; // noUncheckedIndexedAccess: string | undefined
    i++;
  }
  return out;
}

/**
 * The object-literal argument text of every `<callee>({ ... })` call in the
 * source — brace-matched so nested objects don't truncate the capture.
 */
function callArgs(src: string, callee: string): string[] {
  const needle = `${callee}({`;
  const args: string[] = [];
  let from = 0;
  for (;;) {
    const start = src.indexOf(needle, from);
    if (start === -1) break;
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

/**
 * Every non-test `.ts` under `apps/server/src`, EXCLUDING any `testing/` directory —
 * those are deliberate in-repo test harnesses (e.g. `modules/llm/testing/router-harness.ts`
 * builds a bare router on purpose) and are never reachable from a production boot.
 */
function sourceFiles(dir: string = SRC_ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "testing" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (entry.name.endsWith(".test.ts")) continue;
    if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * A paid-vendor construction site and the seam token that proves it was wired.
 * `defines` marks the module that DECLARES the factory (the definition is not a
 * call site, so it is exempt from needing the seam itself).
 */
const VENDOR_SITES = [
  {
    call: "createLlmRouter(",
    seam: /meterFor|withMeter/,
    defines: "export function createLlmRouter",
    what: "an llm router",
  },
  {
    call: "createRagFromEnv(",
    seam: /logUsage/,
    defines: "export function createRagFromEnv",
    what: "a RAG service",
  },
] as const;

describe("modules/metering wiring audit", () => {
  /**
   * The TREE-WIDE backstop. The per-file checks below prove the three KNOWN
   * wiring files are correct; this one proves no FOURTH file quietly appears.
   * Without it the audit's advertised guarantee ("no vendor path runs unmetered")
   * was only ever "these three files are wired" — a new `createLlmRouter(` in any
   * other module passed clean (verified: it did).
   */
  it("[metering-wired] NO module anywhere constructs a vendor path without the seam", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const src = readFileSync(file, "utf8");
      for (const site of VENDOR_SITES) {
        if (!src.includes(site.call)) continue;
        // Scope BOTH the exemption and the seam check to the enclosing block.
        // why: this used to `continue` on the whole file when it contained
        // `site.defines`, and test `site.seam` against the entire file text — the
        // same whole-file vacuity documented on `functionBlocks` above. That is
        // precisely how the unmetered live-copilot path passed: metering-wiring.ts
        // mentions `meterFor` in a DIFFERENT function, so the file-wide regex hit
        // while the copilot factory itself threaded no meter.
        for (const [name, block] of enclosingBlocks(src)) {
          if (block.includes(site.defines)) continue; // the declaring block only
          if (!block.includes(site.call)) continue;
          // Conditional spreads stripped FIRST: a seam that only appears inside
          // `...(x ? { meter } : {})` vanishes when x is undefined, so it does not
          // count as wired. See withoutConditionalSpreads above.
          if (!site.seam.test(withoutConditionalSpreads(block))) {
            offenders.push(
              `${file.slice(SRC_ROOT.length + 1)} :: ${name} builds ${site.what} without an unconditional ${String(site.seam)}`,
            );
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

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

  it("[metering-wired] every llm-router construction site threads the metering seam", () => {
    const src = readFileSync(APP_TS, "utf8");
    const blocks = functionBlocks(src);

    // There ARE router construction sites, and each lives in a function that
    // also threads `meterFor` into the router's consumer.
    const routerBlocks = [...blocks.entries()].filter(([, body]) =>
      body.includes("createLlmRouter("),
    );
    expect(routerBlocks.length).toBeGreaterThan(0);
    for (const [name, body] of routerBlocks) {
      expect(
        body,
        `function ${name} constructs a router without meterFor`,
      ).toMatch(/meterFor/);
    }

    // The consumers RECEIVE it: every pipeline/follow-up construction includes it.
    const pipelineCalls = callArgs(src, "createNotesPipeline");
    expect(pipelineCalls.length).toBeGreaterThan(0);
    for (const args of pipelineCalls) {
      expect(args).toMatch(/meterFor/);
    }
    const followUpCalls = callArgs(src, "generateFollowUp");
    expect(followUpCalls.length).toBeGreaterThan(0);
    for (const args of followUpCalls) {
      expect(args).toMatch(/meterFor/);
    }
  });

  it("[metering-wired] every RAG construction site passes a usage sink", () => {
    const src = readFileSync(APP_TS, "utf8");
    const blocks = functionBlocks(src);
    const ragBlocks = [...blocks.entries()].filter(([, body]) =>
      body.includes("createRagFromEnv("),
    );
    expect(ragBlocks.length).toBeGreaterThan(0);
    for (const [name, body] of ragBlocks) {
      expect(
        body,
        `function ${name} builds RAG without a logUsage sink`,
      ).toMatch(/logUsage/);
    }
  });

  it("[metering-wired] the live copilot router threads the metering seam", () => {
    // Phase 7: the live-suggestion LLM path is built in metering-wiring.ts
    // (maybeCreateLiveConductorFactory). The function that constructs its router
    // must also thread `meterFor` so every streamed suggestion token is metered —
    // an unmetered live LLM path would silently spend on every trigger.
    const src = readFileSync(WIRING_TS, "utf8");
    const blocks = functionBlocks(src);
    const routerBlocks = [...blocks.entries()].filter(([, body]) =>
      body.includes("createLlmRouter("),
    );
    expect(routerBlocks.length).toBeGreaterThan(0);
    for (const [name, body] of routerBlocks) {
      // Stripped, matching the tree-wide backstop. why: raw text let a
      // reintroduced `...(metering ? { meter: meterFor(...) } : {})` satisfy this
      // per-file check — the tighter of the two — while only the tree-wide one
      // caught it. Both now ask for an UNCONDITIONAL seam.
      expect(
        withoutConditionalSpreads(body),
        `metering-wiring function ${name} builds a router without an unconditional meterFor`,
      ).toMatch(/meterFor/);
    }
    // The live transport actually consumes the factory.
    const routes = readFileSync(LIVE_ROUTES_TS, "utf8");
    expect(routes).toMatch(/maybeCreateLiveConductorFactory/);
    expect(routes).toMatch(/createConductor/);
  });

  it("[metering-wired] the live STT transport wires the usage + quota seam", () => {
    // Task-3 tightening: the WS transport must hand the session the metering
    // seam (recordSttSeconds/isOverSttQuota) built from the REAL service — an
    // unmetered STT path in the transport would silently stream for free.
    const src = readFileSync(LIVE_ROUTES_TS, "utf8");
    expect(src).toMatch(/maybeCreateLiveMetering/);
    expect(src).toMatch(/\bmetering\b/);
    expect(src).toMatch(/initialSttVendor/);
  });

  it("[metering-wired] the wiring builds the real service and never references noopMeter", () => {
    const src = readFileSync(APP_TS, "utf8") + readFileSync(WIRING_TS, "utf8");
    expect(src).toMatch(/createMeteringService/);
    expect(src).not.toMatch(/noopMeter/);
    // app.ts actually consumes the split-out builder.
    expect(readFileSync(APP_TS, "utf8")).toMatch(/maybeCreateMetering/);
  });
});
