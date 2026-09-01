import { describe, expect, it } from "vitest";

import { sessionEndNotice } from "./live-notice";

describe("sessionEndNotice", () => {
  it("an error speaks the server's reason", () => {
    expect(sessionEndNotice("error", "STT vendor refused the key.", false)).toBe(
      "STT vendor refused the key.",
    );
  });

  it("an error with no reason still says something", () => {
    expect(sessionEndNotice("error", null, false)).toBe(
      "The session hit an error and stopped.",
    );
  });

  it("a server-side end the user never clicked is news", () => {
    expect(sessionEndNotice("ended", null, false)).toBe(
      "The session ended on its own.",
    );
  });

  it("the user's own stop is not news", () => {
    expect(sessionEndNotice("ended", "session closed", true)).toBeNull();
  });

  it("a running or idle session has no notice", () => {
    expect(sessionEndNotice("live", null, false)).toBeNull();
    expect(sessionEndNotice("idle", null, false)).toBeNull();
    expect(sessionEndNotice("connecting", null, false)).toBeNull();
  });
});
