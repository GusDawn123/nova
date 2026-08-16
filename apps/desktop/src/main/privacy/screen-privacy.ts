/**
 * Screen-capture exclusion — the reason this product exists as an overlay.
 *
 * The whole mechanism is Electron's `win.setContentProtection(enabled)`
 * (macOS: NSWindowSharingNone, proven on macOS 26.5.2; Windows:
 * SetWindowDisplayAffinity WDA_EXCLUDEFROMCAPTURE, proven live on Windows 11
 * 2026-08-15 — see docs/DESIGN/desktop-screen-privacy-notes.md).
 *
 * This service exists so the flag has exactly one owner. Every window is
 * `attach`ed at creation and receives the CURRENT state at that moment — a
 * settings window opened while the app is hidden must be born hidden, never
 * flash into a running screen share and then duck. The renderer can only ASK
 * for a change over IPC; only this process can act.
 *
 * State starts DETECTABLE (false) by explicit product decision (Gustavo,
 * 2026-08-15): the first Windows test is "launch visible, toggle live", which
 * exercises the risky lazy-apply path the notes doc flagged.
 */

/** The slice of BrowserWindow this service touches — structural, so the unit
 * test can hand in a plain object instead of mocking Electron. */
export interface ProtectableWindow {
  isDestroyed(): boolean;
  setContentProtection(enabled: boolean): void;
}

export interface ScreenPrivacyService {
  /** Register a window and apply the current state to it immediately. */
  attach(window: ProtectableWindow): void;
  /** Apply `enabled` to every live attached window; returns the new state. */
  set(enabled: boolean): boolean;
  get(): boolean;
}

export function createScreenPrivacy(): ScreenPrivacyService {
  let enabled = false;
  const windows = new Set<ProtectableWindow>();

  function apply(window: ProtectableWindow): void {
    window.setContentProtection(enabled);
  }

  return {
    attach(window) {
      // A window can already be destroyed by the time it is attached (a
      // failed renderer load tears one down mid-creation) — calling into it
      // would throw, and keeping it would pin a dead object in the set.
      if (window.isDestroyed()) {
        return;
      }
      windows.add(window);
      apply(window);
    },

    set(next) {
      enabled = next;
      for (const window of windows) {
        // Destroyed windows are dropped rather than skipped: a closed settings
        // window would otherwise pin its object here for the app's lifetime,
        // and calling into a destroyed BrowserWindow throws.
        if (window.isDestroyed()) {
          windows.delete(window);
          continue;
        }
        apply(window);
      }
      return enabled;
    },

    get: () => enabled,
  };
}
