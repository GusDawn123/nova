import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Session persistence for the main process.
 *
 * The renderer's `localStorage` — what supabase-js uses on the web, and what the
 * mobile app falls back to under Expo Web — is not reachable from here, and this
 * app deliberately keeps auth out of the renderer entirely. So the session lives
 * in a file under Electron's `userData`.
 *
 * The contract that matters: NOTHING here throws. supabase-js treats a throwing
 * storage as a fatal client error, so a full disk or a corrupt file would take
 * the whole app down rather than showing a sign-in form. Every failure degrades
 * to signed-out and is reported through `onIssue` instead.
 *
 * AT REST THIS IS PLAINTEXT, and the file holds a refresh token — enough to mint
 * access tokens until it expires. That is what every Electron app without
 * keychain integration does, and it is a deliberate deferral rather than an
 * oversight: Electron's own `safeStorage` (DPAPI on Windows, Keychain on macOS)
 * would encrypt it with no native dependency, which keeps it compatible with the
 * Node-API-only rule chunk 2 sets for the C++ addon. It belongs before we ship.
 */

/** A problem worth reporting that did NOT stop the app from working. */
export interface SessionStoreIssue {
  kind: "corrupt" | "unwritable";
  message: string;
}

/** The storage shape `@supabase/supabase-js` expects for session persistence. */
export interface SessionStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const SESSION_FILE_NAME = "auth-session.json";

/** Anything that is not a flat `Record<string, string>` is not our file. */
function asStringMap(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      return null;
    }
    result[key] = entry;
  }
  return result;
}

export function createFileSessionStore(
  directory: string,
  onIssue: (issue: SessionStoreIssue) => void = () => undefined,
): SessionStore {
  const filePath = join(directory, SESSION_FILE_NAME);
  const tempPath = `${filePath}.tmp`;

  let entries: Record<string, string> | null = null;
  /** Memoised so concurrent callers share ONE disk read rather than racing. */
  let loading: Promise<void> | null = null;
  /**
   * Writes are serialised. supabase-js can begin writing a refreshed token while
   * an earlier write is still in flight, and two concurrent writers on one path
   * can interleave into a file that parses as neither state.
   */
  let writeQueue: Promise<void> = Promise.resolve();

  async function readFromDisk(): Promise<Record<string, string>> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch {
      // Absent is the ordinary first run, and every other read failure has the
      // same remedy — start empty and let the user sign in. Neither is worth
      // reporting as a problem.
      return {};
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }

    const map = asStringMap(parsed);
    if (map === null) {
      onIssue({
        kind: "corrupt",
        message: `${SESSION_FILE_NAME} is not a string map`,
      });
      return {};
    }
    return map;
  }

  function ensureLoaded(): Promise<void> {
    loading ??= readFromDisk().then((loaded) => {
      entries = loaded;
    });
    return loading;
  }

  async function persist(snapshot: Record<string, string>): Promise<void> {
    await mkdir(directory, { recursive: true });
    // Write-then-rename, so a crash mid-write cannot leave a half-written file
    // where a valid session used to be. Rename is atomic within a filesystem,
    // and it consumes the temp file rather than leaving one behind.
    await writeFile(tempPath, JSON.stringify(snapshot), "utf8");
    await rename(tempPath, filePath);
  }

  function enqueueWrite(snapshot: Record<string, string>): Promise<void> {
    writeQueue = writeQueue.then(async () => {
      try {
        await persist(snapshot);
      } catch (error: unknown) {
        // Losing the write costs persistence across restarts and nothing else:
        // the in-memory session is still good, so the user is not thrown out of
        // the session they are in the middle of.
        const reason = error instanceof Error ? error.message : String(error);
        onIssue({
          kind: "unwritable",
          message: `could not write ${SESSION_FILE_NAME} (${reason})`,
        });
      }
    });
    return writeQueue;
  }

  return {
    async getItem(key: string): Promise<string | null> {
      await ensureLoaded();
      return entries?.[key] ?? null;
    },

    async setItem(key: string, value: string): Promise<void> {
      await ensureLoaded();
      // `entries` is read AFTER the await, never captured from before it.
      // Concurrent callers all resume from the same load, and reading the live
      // field is what lets each one see the previous one's write instead of
      // overwriting it from a stale copy.
      const next = { ...entries, [key]: value };
      entries = next;
      await enqueueWrite(next);
    },

    async removeItem(key: string): Promise<void> {
      await ensureLoaded();
      const next: Record<string, string> = {};
      for (const [entryKey, entryValue] of Object.entries(entries ?? {})) {
        if (entryKey !== key) {
          next[entryKey] = entryValue;
        }
      }
      entries = next;
      await enqueueWrite(next);
    },
  };
}
