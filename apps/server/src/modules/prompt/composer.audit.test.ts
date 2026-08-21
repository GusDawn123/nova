import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * [composer-audit] STATIC envelope-ownership audit (2026-08-20 prompt-stack
 * redesign; mirrors the metering-wiring house pattern — it reads sources, it
 * never runs them). The composer is the ONE place the turn envelope is
 * rendered and therefore the one boundary where dynamic text is XML-escaped.
 * A second emitter anywhere else would be a second escaping boundary — the
 * exact double-owner drift the V3 lesson bans — so any other non-test source
 * under `apps/server/src` that emits an envelope tag fails the build.
 *
 * The second check pins the LEGACY side: `two-brain.ts` is the flag-off
 * fallback and must stay byte-identical, so it may never grow the composer's
 * tags, and its own envelope-tag set stays exactly the four it shipped with.
 */

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const COMPOSER_TS = join(SRC_ROOT, "modules", "prompt", "composer.ts");
const TWO_BRAIN_TS = join(SRC_ROOT, "modules", "prompt", "two-brain.ts");

/** The composer-owned envelope tags no other module may emit. */
const COMPOSER_TAGS = [
  "<evidence_set",
  "<previous_responses",
  "<current_turn",
] as const;

/**
 * Every non-test `.ts` under `apps/server/src`, excluding `testing/` harness
 * directories — same walk the metering audit trusts.
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

describe("modules/prompt [composer-audit] envelope ownership", () => {
  it("[composer-audit] NO source outside composer.ts emits an envelope tag", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file === COMPOSER_TS) continue;
      const src = readFileSync(file, "utf8");
      for (const tag of COMPOSER_TAGS) {
        if (src.includes(tag)) {
          offenders.push(
            `${file.slice(SRC_ROOT.length + 1)} emits ${tag} — the composer is the one envelope renderer`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("[composer-audit] composer.ts itself emits all three envelope tags", () => {
    // The offenders check above would pass vacuously if the tags were renamed
    // everywhere; this pins that the composer really is the owner.
    const src = readFileSync(COMPOSER_TS, "utf8");
    for (const tag of COMPOSER_TAGS) {
      expect(src).toContain(tag);
    }
  });

  it("[composer-audit] two-brain.ts gains no envelope tags beyond its legacy set", () => {
    const src = readFileSync(TWO_BRAIN_TS, "utf8");
    // None of the composer's tags — nor the envelope's other sections — may
    // creep into the frozen fallback.
    for (const tag of [...COMPOSER_TAGS, "<recent_transcript", "<task>"]) {
      expect(src, `two-brain.ts must never emit ${tag}`).not.toContain(tag);
    }
    // Its own tag set stays exactly the four it shipped with (the alternation
    // is the single source its neutralizer and its renderers both draw from).
    expect(src).toContain(
      "(user_provided_context|user_script|reference_files|user_memory)",
    );
  });
});
