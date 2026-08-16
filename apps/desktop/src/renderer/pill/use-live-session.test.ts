/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LiveSessionEvent } from "../../main/ipc/contract";
import { useLiveSession } from "./use-live-session";

/**
 * The transcript merge rules live in this hook: finals accumulate, one
 * in-flight partial per speaker, rows in timestamp order, and session
 * boundaries reset or discard hypotheses. Each rule is pinned here.
 */

let listener: ((event: LiveSessionEvent) => void) | null = null;
const unsubscribe = vi.fn();

beforeEach(() => {
  listener = null;
  unsubscribe.mockClear();
  // Only the one bridge member the hook touches (the full NovaBridge is
  // main-process wiring a renderer test cannot construct); defineProperty
  // because the real bridge is declared read-only.
  Object.defineProperty(window, "novaBridge", {
    configurable: true,
    value: {
      onLiveEvent: (fn: (event: LiveSessionEvent) => void) => {
        listener = fn;
        return unsubscribe;
      },
    },
  });
});

function push(event: LiveSessionEvent): void {
  act(() => {
    listener?.(event);
  });
}

const partial = (
  speaker: string | null,
  text: string,
  ts_ms: number,
): LiveSessionEvent => ({ kind: "transcript", final: false, speaker, text, ts_ms });

const final = (
  speaker: string | null,
  text: string,
  ts_ms: number,
): LiveSessionEvent => ({ kind: "transcript", final: true, speaker, text, ts_ms });

describe("useLiveSession", () => {
  it("replaces a speaker's previous partial instead of appending", () => {
    const { result } = renderHook(() => useLiveSession());
    push(partial("me", "hel", 100));
    push(partial("me", "hello th", 200));
    expect(result.current.rows).toHaveLength(1);
    expect(result.current.rows[0]).toMatchObject({
      text: "hello th",
      final: false,
    });
  });

  it("keeps one in-flight partial per speaker — me and them coexist", () => {
    const { result } = renderHook(() => useLiveSession());
    push(partial("me", "one thing", 100));
    push(partial("them", "another", 200));
    expect(result.current.rows).toHaveLength(2);
  });

  it("a final adopts its in-flight partial's key — the row commits in place", () => {
    const { result } = renderHook(() => useLiveSession());
    push(partial("me", "hel", 100));
    // The shape is pinned FIRST: with optional chaining alone, an empty rows
    // array would sail through both key assertions as undefined === undefined.
    expect(result.current.rows).toHaveLength(1);
    const partialKey = result.current.rows[0]?.key;
    expect(partialKey).toBeDefined();
    push(final("me", "hello there", 200));
    // Same key = same DOM row: the grey hypothesis eases into the record
    // instead of remounting (and replaying the entrance animation).
    expect(result.current.rows).toHaveLength(1);
    expect(result.current.rows[0]?.key).toBe(partialKey);
    // The speaker's NEXT partial is a new row with a new key.
    push(partial("me", "and next", 300));
    expect(result.current.rows).toHaveLength(2);
    expect(result.current.rows[1]?.key).toBeDefined();
    expect(result.current.rows[1]?.key).not.toBe(partialKey);
  });

  it("a final appends and evicts only its OWN speaker's partial", () => {
    const { result } = renderHook(() => useLiveSession());
    push(partial("me", "hel", 100));
    push(partial("them", "so about", 150));
    push(final("me", "hello there", 200));
    expect(result.current.rows).toHaveLength(2);
    expect(result.current.rows.map((row) => row.text)).toEqual([
      "so about",
      "hello there",
    ]);
  });

  it("orders rows by timestamp, not by final-vs-partial bucket", () => {
    const { result } = renderHook(() => useLiveSession());
    // `them` is mid-sentence (older) when `me` finishes a newer sentence —
    // the normal two-speaker case, and bucket order would draw it wrong.
    push(partial("them", "still talking", 1000));
    push(final("me", "done", 1200));
    expect(result.current.rows.map((row) => row.tsMs)).toEqual([1000, 1200]);
  });

  it("a connecting status starts a fresh transcript", () => {
    const { result } = renderHook(() => useLiveSession());
    push(final("me", "from the last call", 100));
    push({ kind: "status", state: "connecting" });
    expect(result.current.state).toBe("connecting");
    expect(result.current.rows).toEqual([]);
  });

  it.each(["ended", "error"] as const)(
    "discards in-flight partials when the session hits %s",
    (state) => {
      const { result } = renderHook(() => useLiveSession());
      push(final("me", "kept", 100));
      push(partial("them", "half a sen", 200));
      push({ kind: "status", state });
      // The unconfirmed hypothesis must not read as the record of the call.
      expect(result.current.rows).toHaveLength(1);
      expect(result.current.rows[0]).toMatchObject({ text: "kept" });
    },
  );

  it("a notice changes neither state nor rows", () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { result } = renderHook(() => useLiveSession());
    push(final("me", "line", 100));
    push({ kind: "notice", message: "device switched" });
    expect(result.current.state).toBe("idle");
    expect(result.current.rows).toHaveLength(1);
  });

  it("cleans up by calling the bridge's unsubscribe", () => {
    const { unmount } = renderHook(() => useLiveSession());
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
