/**
 * Pairs the engine's two mono streams into interleaved stereo frames — the
 * shape the server's 2-channel STT sessions transcribe with per-channel
 * attribution (channel 0 = "me", channel 1 = "them"; the shared protocol's
 * documented convention).
 *
 * Why pairing by byte count is sound: the native engine gap-fills BOTH streams
 * against the same wall clock, so each delivers exactly 16k samples per second
 * of timeline, forever. The queues therefore stay balanced to within the
 * engine's silence tolerance (~200 ms) — alignment error bounded well below
 * anything that matters for transcription.
 */

const BYTES_PER_SAMPLE = 2; // 16-bit PCM

interface ChannelQueue {
  chunks: Buffer[];
  bytes: number;
}

export class StereoInterleaver {
  private readonly me: ChannelQueue = { chunks: [], bytes: 0 };
  private readonly them: ChannelQueue = { chunks: [], bytes: 0 };
  private dropped = 0;

  /**
   * @param channelFrameBytes bytes of ONE channel per emitted stereo frame
   *   (the wire batch: 960 samples = 1920 bytes ≈ 60 ms).
   * @param maxBufferedBytes per-channel cap; beyond it the OLDEST audio is
   *   dropped. Only reachable if one stream stalls outright — a bug guard,
   *   not a working state.
   */
  constructor(
    private readonly channelFrameBytes: number,
    private readonly maxBufferedBytes: number = 320_000, // 10 s per channel
  ) {}

  push(stream: "me" | "them", pcm: Buffer): void {
    const queue = stream === "me" ? this.me : this.them;
    queue.chunks.push(pcm);
    queue.bytes += pcm.length;
    while (queue.bytes > this.maxBufferedBytes) {
      const oldest = queue.chunks[0];
      if (oldest === undefined) {
        break;
      }
      const excess = queue.bytes - this.maxBufferedBytes;
      if (oldest.length <= excess) {
        queue.chunks.shift();
        queue.bytes -= oldest.length;
        this.dropped += oldest.length;
      } else {
        queue.chunks[0] = oldest.subarray(excess);
        queue.bytes -= excess;
        this.dropped += excess;
      }
    }
  }

  /** Every complete interleaved stereo frame both channels can fill right now. */
  drain(): Buffer[] {
    const frames: Buffer[] = [];
    while (
      this.me.bytes >= this.channelFrameBytes &&
      this.them.bytes >= this.channelFrameBytes
    ) {
      const me = take(this.me, this.channelFrameBytes);
      const them = take(this.them, this.channelFrameBytes);
      frames.push(interleave(me, them));
    }
    return frames;
  }

  /** Total bytes discarded to the cap — 0 in healthy operation. */
  droppedBytes(): number {
    return this.dropped;
  }
}

/** Pop exactly `bytes` off the front of a queue as one contiguous Buffer. */
function take(queue: ChannelQueue, bytes: number): Buffer {
  const out = Buffer.alloc(bytes);
  let filled = 0;
  while (filled < bytes) {
    const head = queue.chunks[0];
    if (head === undefined) {
      break; // unreachable: callers check queue.bytes first
    }
    const want = bytes - filled;
    if (head.length <= want) {
      head.copy(out, filled);
      filled += head.length;
      queue.chunks.shift();
    } else {
      head.copy(out, filled, 0, want);
      queue.chunks[0] = head.subarray(want);
      filled += want;
    }
  }
  queue.bytes -= bytes;
  return out;
}

/** L/R interleave two equal-length mono PCM16 buffers (me left, them right). */
function interleave(me: Buffer, them: Buffer): Buffer {
  const samples = me.length / BYTES_PER_SAMPLE;
  const out = Buffer.alloc(me.length + them.length);
  for (let sample = 0; sample < samples; sample++) {
    const mono = sample * BYTES_PER_SAMPLE;
    const stereo = mono * 2;
    out[stereo] = me[mono] ?? 0;
    out[stereo + 1] = me[mono + 1] ?? 0;
    out[stereo + 2] = them[mono] ?? 0;
    out[stereo + 3] = them[mono + 1] ?? 0;
  }
  return out;
}
