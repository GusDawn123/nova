import { describe, expect, it, vi } from "vitest";

import { createScreenPrivacy, type ProtectableWindow } from "./screen-privacy";

/**
 * The service is the flag's single owner, and these tests pin the two moments
 * that matter: what a window is BORN as, and what every live window becomes
 * when the state flips. Both were real bugs in this category of app — an
 * overlay that flashes into a share before its exclusion lands, and a UI that
 * reports stored intent while some window missed the change.
 */

function stubWindow(destroyed = false): ProtectableWindow & {
  setContentProtection: ReturnType<typeof vi.fn>;
} {
  return {
    isDestroyed: () => destroyed,
    setContentProtection: vi.fn(),
  };
}

describe("createScreenPrivacy", () => {
  it("starts detectable — the ratified launch state", () => {
    expect(createScreenPrivacy().get()).toBe(false);
  });

  it("applies the current state to a window the moment it attaches", () => {
    const privacy = createScreenPrivacy();
    privacy.set(true);

    const late = stubWindow();
    privacy.attach(late);

    // Born hidden, not born visible and hidden a tick later.
    expect(late.setContentProtection).toHaveBeenCalledTimes(1);
    expect(late.setContentProtection).toHaveBeenCalledWith(true);
  });

  it("applies a change to every attached window and reports the new state", () => {
    const privacy = createScreenPrivacy();
    const pill = stubWindow();
    const settings = stubWindow();
    privacy.attach(pill);
    privacy.attach(settings);

    expect(privacy.set(true)).toBe(true);

    expect(pill.setContentProtection).toHaveBeenLastCalledWith(true);
    expect(settings.setContentProtection).toHaveBeenLastCalledWith(true);
    expect(privacy.get()).toBe(true);
  });

  it("refuses to attach a window that is already destroyed", () => {
    const privacy = createScreenPrivacy();
    const dead = stubWindow(true);

    privacy.attach(dead);
    privacy.set(true);

    // Never called — neither at attach nor on the later change.
    expect(dead.setContentProtection).not.toHaveBeenCalled();
  });

  it("drops a window destroyed after attaching instead of calling into it", () => {
    const privacy = createScreenPrivacy();
    let destroyed = false;
    const window: ProtectableWindow & {
      setContentProtection: ReturnType<typeof vi.fn>;
    } = {
      isDestroyed: () => destroyed,
      setContentProtection: vi.fn(),
    };
    privacy.attach(window);
    destroyed = true;
    window.setContentProtection.mockClear();

    privacy.set(true);
    privacy.set(false);

    expect(window.setContentProtection).not.toHaveBeenCalled();
  });
});
