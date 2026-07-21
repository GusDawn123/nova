import { z } from "zod";

/**
 * STT engine tunables, zod-parsed at the boundary (RULES: parse every boundary).
 * Defaults are tuned for a phone call over a flaky mobile radio; every value is
 * overridable so fake-timer tests can drive fast, deterministic ladders.
 *
 * Design source: `docs/DESIGN/live-pipeline.md` §modules/stt.
 */
export const sttConfigSchema = z
  .object({
    /** How long a vendor `connect` (incl. pre-warm) may take before it's a failure. */
    connectTimeoutMs: z.number().int().positive().default(3000),
    /**
     * Reconnect backoff ladder (ms per successive same-vendor retry). Length is
     * independent of {@link maxReconnects}; once the ladder is exhausted the last
     * rung repeats. Empty array = reconnect immediately every time.
     */
    reconnectBackoffMs: z
      .array(z.number().int().nonnegative())
      .default([250, 1000, 4000]),
    /**
     * Max consecutive same-vendor reconnects before failing over to the next
     * vendor. POST-establishment knob: it only governs a vendor that has already
     * connected successfully at least once — every reconnect attempt after that
     * first success (mid-stream death, silence, or a reconnect that fails to
     * connect) counts here. Pre-establishment connect failures use
     * {@link failoverThreshold} instead.
     */
    maxReconnects: z.number().int().nonnegative().default(5),
    /**
     * If a connected vendor emits ZERO events for this long while audio keeps
     * flowing, treat the socket as dead and take the reconnect path (a silent
     * vendor is worse than a dropped one — the user hears nothing back).
     */
    vendorSilenceTimeoutMs: z.number().int().positive().default(30000),
    /**
     * Consecutive connect/first-event failures on a vendor before failover. A
     * single blip should retry the same vendor; a pattern means switch.
     * PRE-establishment knob: it only counts failures on a vendor that has NOT
     * yet connected successfully; once a vendor establishes, its churn is
     * governed by {@link maxReconnects} instead.
     */
    failoverThreshold: z.number().int().positive().default(2),
    /**
     * Bounded reconnect buffer (frames). While a vendor reconnects, inbound audio
     * frames are held in a ring buffer of this size and flushed to the new
     * connection once it's ready. On overflow the OLDEST held frame is dropped
     * (keep the freshest audio — a phone reconnect of a few hundred ms is a small,
     * bounded gap, and unbounded buffering during a long outage is a memory leak).
     */
    reconnectBufferFrames: z.number().int().nonnegative().default(64),
  })
  .strict();

/** Parsed, fully-defaulted STT config. */
export type SttConfig = z.infer<typeof sttConfigSchema>;

/** What a caller may pass before parsing (all fields optional → defaults apply). */
export type SttConfigInput = z.input<typeof sttConfigSchema>;

/** The all-defaults config; handy for production wiring and tests. */
export const defaultSttConfig: SttConfig = sttConfigSchema.parse({});
