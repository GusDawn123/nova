import type { CreateSttEngine, SttEngine } from "./ports.js";

/**
 * STT engine — STUB. Task 4 (Phase 3.4) implements this against the behavior
 * suite in this module, turning every `[relay]`/`[interim]`/`[final]`/`[failover]`
 * /`[reconnect]`/`[reconnect-exhaust]`/`[silence]`/`[isolation]`/`[stop]` test
 * green. It is deliberately not implemented now: the whole point of this task is
 * a RED behavior suite that pins the contract before a line of engine logic.
 *
 * The stub is constructible (so tests fail on the thrown "not implemented", not on
 * an import/type error) and throws only when a session is actually started.
 */
export const createSttEngine: CreateSttEngine = (): SttEngine => {
  // Params (config, vendors) are intentionally unused until Task 4 — the typed
  // `CreateSttEngine` signature still binds callers to the real contract.
  return {
    startSession() {
      throw new Error("STT engine not implemented (Phase 3.4)");
    },
  };
};
