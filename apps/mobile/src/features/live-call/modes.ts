import { liveModeSchema, type LiveMode } from '@nova/shared';

/**
 * How the four copilot modes are named on screen, and in what order.
 *
 * A `Record<LiveMode, string>` on purpose: a mode added to the wire enum fails to
 * compile here until it has a label, so the picker cannot silently offer three of
 * four modes. The ORDER comes from the enum itself, so the row and the wire cannot
 * disagree about which mode is which.
 *
 * Both the picker and the HUD rail read from here — the rail names the mode the call
 * is locked to, and two spellings of "Behavioral" would be two claims about the same
 * session.
 */
export const MODE_LABELS: Record<LiveMode, string> = {
  general: 'General',
  behavioral: 'Behavioral',
  technical: 'Technical',
  finance: 'Finance',
};

export const MODE_ORDER: readonly LiveMode[] = liveModeSchema.options;
