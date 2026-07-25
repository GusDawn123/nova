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
 */
function functionBlocks(src: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const re = /^(?:async )?function (\w+)/gm;
  const marks: { name: string; start: number }[] = [];
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    marks.push({ name: m[1] ?? "", start: m.index });
  }
  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    if (!mark) continue;
    const end = marks[i + 1]?.start ?? src.length;
    blocks.set(mark.name, src.slice(mark.start, end));
  }
  return blocks;
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
        if (src.includes(site.defines)) continue; // the declaring module
        if (!site.seam.test(src)) {
          offenders.push(`${file.slice(SRC_ROOT.length + 1)} builds ${site.what} without ${String(site.seam)}`);
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
      expect(
        body,
        `metering-wiring function ${name} builds a router without meterFor`,
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
