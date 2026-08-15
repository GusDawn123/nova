import { useCallback, useEffect, useState } from "react";

/**
 * The renderer's mirror of the undetectability flag, same two-source shape as
 * use-auth-state: ASK on mount (this window may have opened after the last
 * change), PUSH for everything since (the other window's toggle must land
 * here). `request` reflects only what main REPORTS back — the UI never latches
 * a state the OS was not actually asked to apply, because the eye icon is the
 * user's answer to "am I visible in this screen share right now".
 */
export function useScreenPrivacy(): {
  enabled: boolean;
  request: (next: boolean) => void;
} {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let pushed = false;

    const unsubscribe = window.novaBridge.onScreenPrivacyChange((state) => {
      pushed = true;
      if (!cancelled) {
        setEnabled(state.enabled);
      }
    });

    void window.novaBridge.getScreenPrivacy().then((state) => {
      // A push that lands while the ask is in flight is newer than the answer.
      if (!cancelled && !pushed) {
        setEnabled(state.enabled);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const request = useCallback((next: boolean) => {
    void window.novaBridge.setScreenPrivacy(next).then((state) => {
      setEnabled(state.enabled);
    });
  }, []);

  return { enabled, request };
}
