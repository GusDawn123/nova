import { afterEach, describe, expect, it, vi } from "vitest";
import { RagError } from "../ports.js";
import type { RagHit } from "../ports.js";
import {
  embeddingsBody,
  jsonResponse,
  rerankBody,
  vec,
  voyageTestConfig as config,
} from "../testing/voyage-fixtures.js";
import { createVoyageAdapter } from "./voyage.js";
import { MAX_RETRY_ATTEMPTS, type VoyageBackoffLog } from "./voyage.retry.js";

/**
 * Voyage 429 RATE-LIMIT retry policy (adr-0005 §8): background-tier calls back
 * off and retry, query embeds stay fail-fast. Vendor HTTP is stubbed.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("voyage — rate-limit retry (429)", () => {
  // adr-0005 §8: background calls back off on 429; the hot-path query never waits.
  const hit: RagHit = {
    chunkId: "a",
    content: "derivatives pricing",
    header: "",
    score: 0.1,
    contextDocId: "d",
    meetingId: null,
  };

  it("retries a document embed on 429 then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "rate" }, 429))
      .mockResolvedValueOnce(
        jsonResponse(
          embeddingsBody([{ index: 0, embedding: vec(0.2) }], "voyage-4"),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const logBackoff = vi.fn<(entry: VoyageBackoffLog) => void>();
    const { embedder } = createVoyageAdapter({
      apiKey: "k",
      config,
      logBackoff,
    });

    const settled = embedder.embed(["a document"], { kind: "document" });
    // First 429 waits (equal-jitter, ≤2s for attempt 1); drive past it.
    await vi.advanceTimersByTimeAsync(3_000);
    const res = await settled;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.vectors).toHaveLength(1);
    expect(logBackoff).toHaveBeenCalledTimes(1);
    expect(logBackoff.mock.calls[0]?.[0]).toMatchObject({
      vendor: "voyage",
      model: "voyage-4",
      attempt: 1,
    });
  });

  it("honors the Retry-After header value (seconds) as the wait", async () => {
    vi.useFakeTimers();
    const rateLimited = new Response(JSON.stringify({ error: "rate" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "3" },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(
        jsonResponse(
          embeddingsBody([{ index: 0, embedding: vec(0.2) }], "voyage-4"),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const logBackoff = vi.fn<(entry: VoyageBackoffLog) => void>();
    const { embedder } = createVoyageAdapter({
      apiKey: "k",
      config,
      logBackoff,
    });

    const settled = embedder.embed(["a document"], { kind: "document" });
    // Not yet resolved just before the 3s Retry-After elapses...
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // ...and the second attempt fires exactly at 3s.
    await vi.advanceTimersByTimeAsync(1);
    await settled;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logBackoff.mock.calls[0]?.[0].wait_ms).toBe(3_000);
  });

  it("exhausts max attempts on persistent 429 → EMBEDDER_FAILED", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: "rate" }, 429));
    vi.stubGlobal("fetch", fetchMock);
    const logBackoff = vi.fn<(entry: VoyageBackoffLog) => void>();
    const { embedder } = createVoyageAdapter({
      apiKey: "k",
      config,
      logBackoff,
    });

    const settled = embedder
      .embed(["a document"], { kind: "document" })
      .catch((e: unknown) => e);
    // Each wait is ≤30s; MAX_RETRY_ATTEMPTS-1 of them drive the loop to exhaustion.
    for (let i = 0; i < MAX_RETRY_ATTEMPTS; i += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
    }
    const err = await settled;

    expect(err).toBeInstanceOf(RagError);
    expect((err as RagError).code).toBe("EMBEDDER_FAILED");
    expect(fetchMock).toHaveBeenCalledTimes(MAX_RETRY_ATTEMPTS);
    // One warn line per wait: attempts 1..(MAX-1).
    expect(logBackoff).toHaveBeenCalledTimes(MAX_RETRY_ATTEMPTS - 1);
  });

  it("does NOT retry a query embed on 429 — one call, immediate typed failure", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: "rate" }, 429));
    vi.stubGlobal("fetch", fetchMock);
    const logBackoff = vi.fn<(entry: VoyageBackoffLog) => void>();
    const { embedder } = createVoyageAdapter({
      apiKey: "k",
      config,
      logBackoff,
    });

    await expect(
      embedder.embed(["x"], { kind: "query" }),
    ).rejects.toMatchObject({
      code: "EMBEDDER_FAILED",
    });
    // Hot-path law: no wait, no retry, no backoff line (adr-0005 §8).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logBackoff).not.toHaveBeenCalled();
  });

  it("retries a rerank on 429 then succeeds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "rate" }, 429))
      .mockResolvedValueOnce(jsonResponse(rerankBody(0, 0.5)));
    vi.stubGlobal("fetch", fetchMock);
    const logBackoff = vi.fn<(entry: VoyageBackoffLog) => void>();
    const { reranker } = createVoyageAdapter({
      apiKey: "k",
      config,
      logBackoff,
    });

    const settled = reranker.rerank("q", [hit], 1);
    await vi.advanceTimersByTimeAsync(3_000);
    const out = await settled;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(1);
    expect(logBackoff.mock.calls[0]?.[0].model).toBe("rerank-2.5-lite");
  });
});
