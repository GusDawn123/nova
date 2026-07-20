import { describe, expect, it, vi } from "vitest";

import { createDisposer } from "./ports.js";

/**
 * The disposer is the teardown seam Tasks 4–5 hang vendor sockets on. Its one
 * binding invariant: every registered cleanup runs EXACTLY once — never zero
 * (leak), never twice (double-free).
 */
describe("createDisposer", () => {
  it("runs every cleanup once, in LIFO order", () => {
    const disposer = createDisposer();
    const order: number[] = [];
    disposer.add(() => order.push(1));
    disposer.add(() => order.push(2));
    disposer.add(() => order.push(3));

    disposer.dispose();

    expect(order).toEqual([3, 2, 1]);
  });

  it("is idempotent — a second dispose does not re-run cleanups", () => {
    const disposer = createDisposer();
    const cleanup = vi.fn();
    disposer.add(cleanup);

    disposer.dispose();
    disposer.dispose();
    disposer.dispose();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(disposer.disposed).toBe(true);
  });

  it("runs a cleanup registered after dispose immediately (no leak)", () => {
    const disposer = createDisposer();
    disposer.dispose();

    const late = vi.fn();
    disposer.add(late);

    expect(late).toHaveBeenCalledTimes(1);
  });

  it("keeps running remaining cleanups when one throws", () => {
    const disposer = createDisposer();
    const after = vi.fn();
    // registered first → runs LAST (LIFO); the throwing one must not skip it.
    disposer.add(after);
    disposer.add(() => {
      throw new Error("cleanup boom");
    });

    expect(() => {
      disposer.dispose();
    }).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
  });
});
