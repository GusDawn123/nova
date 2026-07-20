import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
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

const STT_DIR = dirname(fileURLToPath(import.meta.url));
/** The live transport layer that feeds audio into the engine (sibling module). */
const LIVE_DIR = join(STT_DIR, "..", "live");
/** Every directory the static guarantee scans (stt engine + adapters + live layer). */
const SCANNED_DIRS = [STT_DIR, LIVE_DIR];

/**
 * Filesystem-write surfaces that would mean audio could hit disk. Covers the
 * `fs`/`fs/promises` write APIs plus stream/handle openers — extended in Task 5
 * to also catch `node:fs` imports and the promise-API `writeFile`.
 */
const FORBIDDEN =
  /\bfs\.|from ["']node:fs["']|require\(["']node:fs["']\)|\bwriteFile\b|\bwriteFileSync\b|\bappendFile\b|\bappendFileSync\b|createWriteStream|\bopenSync\b|\bwriteSync\b/;

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
  it("[no-disk] contains no filesystem-write usage in stt (incl. adapters) or the live layer", () => {
    const files = SCANNED_DIRS.flatMap((dir) => collectSources(dir));
    expect(files.length).toBeGreaterThan(0); // guard: the scan actually found sources

    // Sanity: the scan must actually reach the vendor adapters + the live layer.
    expect(files.some((f) => f.includes(`${sep}adapters${sep}`))).toBe(true);
    expect(files.some((f) => f.includes(`${sep}live${sep}`))).toBe(true);

    const offenders = files.filter((file) =>
      FORBIDDEN.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
