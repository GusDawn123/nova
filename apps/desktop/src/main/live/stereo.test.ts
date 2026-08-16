import { describe, expect, it } from "vitest";

import { StereoInterleaver } from "./stereo";

/** A mono PCM16 buffer of `samples` copies of `value`. */
function tone(samples: number, value: number): Buffer {
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    out.writeInt16LE(value, i * 2);
  }
  return out;
}

describe("StereoInterleaver", () => {
  it("emits nothing until BOTH channels can fill a frame", () => {
    const interleaver = new StereoInterleaver(8); // 4-sample frames
    interleaver.push("me", tone(10, 1));
    expect(interleaver.drain()).toHaveLength(0);
    interleaver.push("them", tone(3, 2));
    expect(interleaver.drain()).toHaveLength(0); // them has 3 of 4 samples
    interleaver.push("them", tone(1, 2));
    expect(interleaver.drain()).toHaveLength(1);
  });

  it("interleaves me left, them right, sample by sample", () => {
    const interleaver = new StereoInterleaver(4); // 2-sample frames
    interleaver.push("me", tone(2, 1111));
    interleaver.push("them", tone(2, -2222));
    const frames = interleaver.drain();
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    if (frame === undefined) throw new Error("expected a frame");
    expect([
      frame.readInt16LE(0),
      frame.readInt16LE(2),
      frame.readInt16LE(4),
      frame.readInt16LE(6),
    ]).toEqual([1111, -2222, 1111, -2222]);
  });

  it("carries partial frames across pushes and preserves sample order", () => {
    const interleaver = new StereoInterleaver(4);
    // Sequential values so any reordering or loss is visible.
    const seq = Buffer.alloc(12);
    for (let i = 0; i < 6; i++) seq.writeInt16LE(i + 1, i * 2);
    interleaver.push("me", seq.subarray(0, 6)); // samples 1,2,3
    interleaver.push("me", seq.subarray(6)); // samples 4,5,6
    interleaver.push("them", tone(6, 0));
    const frames = interleaver.drain();
    expect(frames).toHaveLength(3);
    const left = frames.flatMap((f) => [f.readInt16LE(0), f.readInt16LE(4)]);
    expect(left).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("drops the OLDEST audio past the cap and counts it", () => {
    const interleaver = new StereoInterleaver(4, 8); // cap: 4 samples buffered
    interleaver.push("me", tone(4, 1)); // fills the cap exactly
    interleaver.push("me", tone(2, 2)); // pushes 2 oldest samples out
    expect(interleaver.droppedBytes()).toBe(4);
    interleaver.push("them", tone(4, 9));
    const frames = interleaver.drain();
    expect(frames).toHaveLength(2);
    const first = frames[0];
    if (first === undefined) throw new Error("expected a frame");
    // The two surviving 1s lead; the 2s follow — oldest dropped, order kept.
    expect([first.readInt16LE(0), first.readInt16LE(4)]).toEqual([1, 1]);
  });
});
