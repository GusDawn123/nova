import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFileSessionStore,
  type SessionStoreIssue,
} from "./session-store";

/**
 * The store is the one piece of this chunk that meets a real filesystem, so it
 * is tested against one rather than a mock: a temp directory per test, and the
 * failure cases (absent, corrupt, unwritable) produced for real instead of
 * simulated. Every one of them must degrade to signed-out without throwing —
 * supabase-js treats a throwing storage as a fatal client error, so a full disk
 * would otherwise take the whole app down instead of showing a sign-in form.
 */

const FILE_NAME = "auth-session.json";

let directory: string;
let issues: SessionStoreIssue[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "nova-session-store-"));
  issues = [];
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function store(at: string = directory) {
  return createFileSessionStore(at, (issue) => issues.push(issue));
}

describe("createFileSessionStore", () => {
  it("round-trips a value through the file, not just memory", async () => {
    await store().setItem("sb-token", "refresh-me");

    // A SECOND store over the same directory — proves the value survived the
    // process, which is the entire point of persisting it.
    const reopened = store();
    expect(await reopened.getItem("sb-token")).toBe("refresh-me");
    expect(issues).toEqual([]);
  });

  it("writes the file as a flat JSON string map", async () => {
    await store().setItem("sb-token", "refresh-me");

    const raw = await readFile(join(directory, FILE_NAME), "utf8");
    expect(JSON.parse(raw)).toEqual({ "sb-token": "refresh-me" });
  });

  it("removes a key without disturbing its neighbours", async () => {
    const subject = store();
    await subject.setItem("keep", "yes");
    await subject.setItem("drop", "no");

    await subject.removeItem("drop");

    expect(await subject.getItem("drop")).toBeNull();
    expect(await subject.getItem("keep")).toBe("yes");
    expect(await store().getItem("keep")).toBe("yes");
  });

  it("reads a missing file as empty, and does not call it a problem", async () => {
    // The first run of a freshly installed app. Signed out is the right answer
    // and there is nothing to report.
    expect(await store().getItem("sb-token")).toBeNull();
    expect(issues).toEqual([]);
  });

  it("degrades to signed-out on unparseable JSON", async () => {
    await writeFile(join(directory, FILE_NAME), "{ not json", "utf8");

    expect(await store().getItem("sb-token")).toBeNull();
    expect(issues).toEqual([
      { kind: "corrupt", message: `${FILE_NAME} is not a string map` },
    ]);
  });

  it("degrades to signed-out on JSON of the wrong shape", async () => {
    // Valid JSON, wrong contract — a nested object where a string belongs.
    await writeFile(
      join(directory, FILE_NAME),
      JSON.stringify({ "sb-token": { access: "nested" } }),
      "utf8",
    );

    expect(await store().getItem("sb-token")).toBeNull();
    expect(issues[0]?.kind).toBe("corrupt");
  });

  it("overwrites a corrupt file on the next write instead of staying broken", async () => {
    await writeFile(join(directory, FILE_NAME), "]]]", "utf8");

    const subject = store();
    await subject.setItem("sb-token", "fresh");

    expect(await store().getItem("sb-token")).toBe("fresh");
  });

  it("keeps working in memory when the directory cannot be written", async () => {
    // A path whose PARENT is a file, so `mkdir -p` and the write both fail —
    // the portable stand-in for an unwritable location (a read-only directory
    // is not reliably enforced for the owner on Windows).
    const blocker = join(directory, "blocker");
    await writeFile(blocker, "not a directory", "utf8");
    const subject = store(join(blocker, "nested"));

    await subject.setItem("sb-token", "refresh-me");

    // Never threw, and the value is still readable for THIS run. Only
    // persistence was lost, and it was reported.
    expect(await subject.getItem("sb-token")).toBe("refresh-me");
    expect(issues.map((issue) => issue.kind)).toEqual(["unwritable"]);
  });

  it("serializes overlapping writes so the last one wins on disk", async () => {
    const subject = store();

    await Promise.all([
      subject.setItem("a", "1"),
      subject.setItem("b", "2"),
      subject.setItem("c", "3"),
    ]);

    const raw = await readFile(join(directory, FILE_NAME), "utf8");
    expect(JSON.parse(raw)).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("leaves no temp file behind", async () => {
    await store().setItem("sb-token", "refresh-me");

    const { readdir } = await import("node:fs/promises");
    expect(await readdir(directory)).toEqual([FILE_NAME]);
  });
});
