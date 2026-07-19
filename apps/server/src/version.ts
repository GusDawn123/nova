import { readFileSync } from "node:fs";

import { z } from "zod";

/**
 * Single source of truth for the server version: read from this package's
 * package.json at load time and zod-parse the boundary. Resolving relative to
 * `import.meta.url` points at apps/server/package.json from both `src/` (tests)
 * and the compiled `dist/` output.
 */
const packageJsonSchema = z.object({ version: z.string().min(1) });

const packageJsonUrl = new URL("../package.json", import.meta.url);
const raw: unknown = JSON.parse(readFileSync(packageJsonUrl, "utf8"));

export const version = packageJsonSchema.parse(raw).version;
