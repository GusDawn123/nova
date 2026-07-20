import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * [no-disk] Static guarantee (RULES §3 / design doc §modules/stt): raw audio is
 * NEVER written to disk. This is a crude but binding grep over every non-test
 * source file in `modules/stt/` for any filesystem-write API. It passes today
 * (the stub + harness touch no disk) and MUST keep passing as Task 4 fills in the
 * engine and Task 5 adds vendor adapters — a regression here is a legal/privacy
 * incident, not a style nit. Task 5's storage audit extends this.
 *
 * (This is a static invariant, not a behavior-on-stub test, so it is GREEN now;
 * the other STT behavior tests are intentionally RED until Task 4.)
 */

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Filesystem-write surfaces that would mean audio could hit disk. */
const FORBIDDEN =
  /\bfs\.|\bwriteFile\b|\bwriteFileSync\b|\bappendFile\b|\bappendFileSync\b|createWriteStream|\bopenSync\b/;

/** Recursively collect non-test `.ts` sources under `dir`. */
function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSources(full));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue; // tests may reference fs (e.g. THIS file)
    out.push(full);
  }
  return out;
}

describe("modules/stt never writes raw audio to disk", () => {
  it("[no-disk] contains no filesystem-write usage in any non-test source", () => {
    const files = collectSources(MODULE_DIR);
    expect(files.length).toBeGreaterThan(0); // guard: the scan actually found sources

    const offenders = files.filter((file) =>
      FORBIDDEN.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
