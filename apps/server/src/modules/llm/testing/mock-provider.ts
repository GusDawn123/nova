import { LlmError } from "../errors.js";
import type {
  ChatRequest,
  LlmProvider,
  LlmStreamEvent,
  ProviderId,
} from "../ports.js";

/**
 * A scriptable {@link LlmProvider} for behaviour tests. The router's failover /
 * timeout / breaker logic (Task 2) is driven entirely through providers whose
 * every timing and failure mode is scripted here — no vendor calls, no network.
 *
 * ## Fake-timer compatibility (a hard requirement for Task 2)
 *
 * All delays route through an injectable `sleep(ms, signal)` that DEFAULTS to a
 * `globalThis.setTimeout`-backed implementation. Under `vi.useFakeTimers()` that
 * global is replaced, so `vi.advanceTimersByTimeAsync(ms)` drives every delay
 * with zero real waiting. `neverYield` deliberately does NOT use a timer (a
 * clamped huge `setTimeout` would fire immediately) — it awaits abort only.
 */

/** Injected clock. Rejects with an `aborted` LlmError if/when `signal` fires. */
export type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>;

/**
 * One scripted call. Consecutive `stream()` invocations consume successive
 * scripts (the last one repeating). Fields are intentionally a flat scripting
 * record — the domain unions live in ports/errors; this is test scaffolding.
 *
 * Evaluation order within a call:
 *   1. `firstTokenDelayMs` — models time-to-first-token (TTFT).
 *   2. `failBeforeFirstToken` — throw the classified error (after any TTFT wait).
 *   3. `neverYield` — hang until aborted (ignores `events`).
 *   4. `events` — emitted in order, `interTokenDelayMs` between them, until
 *      `failAfterTokens` tokens have been yielded, then throw (mid-stream death).
 */
export interface MockCallScript {
  /** The happy-path events to emit (tokens, usually closed by a `done`). */
  events?: LlmStreamEvent[];
  /** Delay before the first event/failure — the TTFT control. */
  firstTokenDelayMs?: number;
  /** Delay between successive events — the stall control. */
  interTokenDelayMs?: number;
  /** Fail before any token, classified as `auth`, `invalid`, or `transient`. */
  failBeforeFirstToken?: { kind: "auth" | "invalid" | "transient" };
  /** Emit this many tokens, then throw — mid-stream death. */
  failAfterTokens?: number;
  /** Kind thrown by `failAfterTokens` (default `transient`). */
  failAfterKind?: "transient" | "stall";
  /** Yield nothing; hang until `signal` aborts. */
  neverYield?: boolean;
}

/** What the harness records about each `stream()` invocation, for assertions. */
export interface MockCall {
  readonly request: ChatRequest;
  aborted: boolean;
  tokensYielded: number;
}

/** An `LlmProvider` plus its recorded call log. */
export interface MockProvider extends LlmProvider {
  readonly calls: MockCall[];
}

/** Optional dependency injection — swap the clock in tests if desired. */
export interface MockProviderOptions {
  sleep?: SleepFn;
}

/** Default clock: a real `setTimeout` that vitest fake timers can drive. */
export const defaultSleep: SleepFn = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(LlmError.aborted());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(LlmError.aborted());
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });

/** Resolve never; reject with an `aborted` LlmError when `signal` fires. */
function waitUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(LlmError.aborted());
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        reject(LlmError.aborted());
      },
      { once: true },
    );
  });
}

/**
 * Build a scriptable provider. `script` is one call-script or a list consumed
 * across consecutive `stream()` calls, the last entry repeating for any further
 * calls.
 */
export function makeMockProvider(
  id: ProviderId,
  script: MockCallScript | MockCallScript[],
  options?: MockProviderOptions,
): MockProvider {
  const scripts = Array.isArray(script) ? script : [script];
  if (scripts.length === 0) {
    throw new Error("makeMockProvider: at least one call script is required");
  }
  const sleep = options?.sleep ?? defaultSleep;
  const calls: MockCall[] = [];
  let callIndex = 0;

  return {
    id,
    calls,
    stream(
      req: ChatRequest,
      signal: AbortSignal,
    ): AsyncIterable<LlmStreamEvent> {
      const current =
        scripts[Math.min(callIndex, scripts.length - 1)] ?? scripts[0];
      callIndex += 1;
      const call: MockCall = {
        request: req,
        aborted: false,
        tokensYielded: 0,
      };
      calls.push(call);
      return runScript(current ?? {}, signal, call, sleep);
    },
  };
}

/** The scripted stream for a single call. */
async function* runScript(
  script: MockCallScript,
  signal: AbortSignal,
  call: MockCall,
  sleep: SleepFn,
): AsyncGenerator<LlmStreamEvent> {
  const onAbort = (): void => {
    call.aborted = true;
  };
  if (signal.aborted) {
    call.aborted = true;
    throw LlmError.aborted();
  }
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    if (script.firstTokenDelayMs) {
      await sleep(script.firstTokenDelayMs, signal);
    }

    if (script.failBeforeFirstToken) {
      const kind = script.failBeforeFirstToken.kind;
      if (kind === "auth") {
        throw LlmError.auth("mock auth failure");
      }
      if (kind === "invalid") {
        throw LlmError.invalid("mock invalid failure");
      }
      throw LlmError.transient("mock transient failure");
    }

    if (script.neverYield) {
      await waitUntilAborted(signal);
    }

    const events = script.events ?? [];
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i];
      if (event === undefined) {
        continue;
      }
      if (i > 0 && script.interTokenDelayMs) {
        await sleep(script.interTokenDelayMs, signal);
      }
      if (
        script.failAfterTokens !== undefined &&
        call.tokensYielded >= script.failAfterTokens
      ) {
        throw script.failAfterKind === "stall"
          ? LlmError.stall("mock stall after tokens")
          : LlmError.transient("mock mid-stream failure");
      }
      if (event.type === "token") {
        call.tokensYielded += 1;
      }
      yield event;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
