import type { LiveLogger, LiveMetering } from "./ports.js";

/**
 * Session-scoped STT usage accounting + mid-stream quota cadence (Phase 6,
 * adr-0007 §3/§4), split out of `session.ts` (RULES §2 file cap). One instance
 * per started session, constructed only when the metering seam + owner are wired
 * (the persister-optional posture): bills RELAYED audio bytes (16kHz mono PCM16
 * → bytes/32000 = seconds), flushing one `stt_seconds` span per vendor stretch:
 * on vendor switch, on disposal (the session's disposer calls {@link flush}),
 * and at each quota-recheck tick of METERED AUDIO — so a crash loses at most one
 * tick of attribution.
 */

/** PCM sample rate of the mic feed handed to the STT vendor (design doc: 16 kHz). */
export const STT_SAMPLE_RATE_HZ = 16000;
/** PCM16 is 2 bytes/sample → relayed-audio seconds = bytes / this (adr-0007 §3). */
const STT_BYTES_PER_SECOND = STT_SAMPLE_RATE_HZ * 2;
/** Mid-stream quota recheck cadence default, in seconds of METERED audio. */
export const DEFAULT_QUOTA_RECHECK_SECONDS = 15;

/**
 * Session-start quota gate (adr-0007 §4): true = the start must be REFUSED
 * (typed `quota_exceeded` + policy close before any STT vendor connects). A
 * FAILING check logs and admits the call (fail open — the checker itself already
 * fails open; this guards a misbehaving seam), unlike the ownership guard which
 * fails closed: quota protects spend, not tenancy.
 */
export async function isOverSttQuotaAtStart(
  metering: LiveMetering,
  userId: string,
  meetingId: string,
  logger: LiveLogger | null,
): Promise<boolean> {
  try {
    return await metering.isOverSttQuota(userId);
  } catch (err: unknown) {
    logger?.error(
      { user_id: userId, meeting_id: meetingId, err },
      "live.quota_check_failed",
    );
    return false;
  }
}

export interface SttUsageMeterDeps {
  readonly metering: LiveMetering;
  readonly userId: string;
  readonly meetingId: string;
  /** First vendor of the configured lineup (pre-failover attribution). */
  readonly initialVendor: string;
  readonly quotaRecheckSeconds: number;
  readonly logger: LiveLogger | null;
  /** The session is already torn down (skip cuts and late checks). */
  readonly isDisposed: () => boolean;
  /** Mid-stream recheck found the quota spent → typed error + policy close. */
  readonly onQuotaExceeded: () => void;
}

export class SttUsageMeter {
  private readonly deps: SttUsageMeterDeps;
  private readonly recheckBytes: number;
  /** The vendor currently being billed; updated on every `provider_switched`. */
  private vendor: string;
  private bytesSinceFlush = 0;
  private bytesSinceRecheck = 0;
  /** Re-entrancy latch for the async mid-stream quota check. */
  private checkInFlight = false;

  constructor(deps: SttUsageMeterDeps) {
    this.deps = deps;
    this.vendor = deps.initialVendor;
    this.recheckBytes = deps.quotaRecheckSeconds * STT_BYTES_PER_SECOND;
  }

  /**
   * Account one relayed frame (synchronous — the audio hot path). Crossing a
   * recheck tick flushes the accumulated span and kicks the async quota check.
   */
  onRelayedBytes(byteLength: number): void {
    this.bytesSinceFlush += byteLength;
    this.bytesSinceRecheck += byteLength;
    if (this.bytesSinceRecheck >= this.recheckBytes) {
      this.bytesSinceRecheck = 0;
      // Flush at every tick so a crash loses at most one tick of attribution.
      this.flush();
      this.recheckQuota();
    }
  }

  /**
   * Attribution split (adr-0007 §3): everything relayed so far billed to the
   * OLD vendor, everything after to the new one.
   */
  onVendorSwitch(to: string): void {
    this.flush();
    this.vendor = to;
  }

  /**
   * Flush the accumulated relayed-audio bytes as one `stt_seconds` span billed
   * to the CURRENT vendor. Fire-and-forget: the metering service never fails the
   * metered op, and the extra `.catch` keeps a misbehaving seam off the hot path.
   */
  flush(): void {
    if (this.bytesSinceFlush <= 0) return;
    const { metering, userId, meetingId } = this.deps;
    const seconds = this.bytesSinceFlush / STT_BYTES_PER_SECOND;
    this.bytesSinceFlush = 0;
    void metering
      .recordSttSeconds({ userId, meetingId, vendor: this.vendor, seconds })
      .catch((err: unknown) => {
        this.deps.logger?.error(
          { user_id: userId, meeting_id: meetingId, err },
          "live.stt_usage_record_failed",
        );
      });
  }

  /**
   * Mid-stream quota recheck (adr-0007 §4) — cadenced on METERED AUDIO, not wall
   * clock ({@link onRelayedBytes} triggers it per tick of relayed bytes). Over →
   * flush the in-flight tail then hand the cut to the session (typed
   * `quota_exceeded` + policy close). A failing check logs and lets the call
   * continue (fail open — quota protects spend, not tenancy).
   */
  private recheckQuota(): void {
    const { metering, userId, meetingId } = this.deps;
    if (this.checkInFlight || this.deps.isDisposed()) return;
    this.checkInFlight = true;
    void metering
      .isOverSttQuota(userId)
      .then((over) => {
        if (!over || this.deps.isDisposed()) return;
        // Bill anything relayed while the check was in flight, then cut.
        this.flush();
        this.deps.onQuotaExceeded();
      })
      .catch((err: unknown) => {
        this.deps.logger?.error(
          { user_id: userId, meeting_id: meetingId, err },
          "live.quota_recheck_failed",
        );
      })
      .finally(() => {
        this.checkInFlight = false;
      });
  }
}
