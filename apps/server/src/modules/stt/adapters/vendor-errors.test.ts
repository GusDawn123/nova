import { describe, expect, it } from "vitest";

import { SttAuthError, SttProtocolError, SttTransientError } from "../ports.js";
import {
  classifyVendorClose,
  classifyVendorErrorText,
  messageOf,
  toSttError,
} from "./vendor-errors.js";

describe("classifyVendorErrorText", () => {
  it("flags credentials/billing failures as auth", () => {
    for (const text of [
      "Unauthorized",
      "invalid API key",
      "Authentication failed",
      "insufficient funds to start session",
      "HTTP 401 from vendor",
      "429 Too Many Requests",
    ]) {
      expect(classifyVendorErrorText(text)).toBe("auth");
    }
  });

  it("flags contract/shape failures as protocol", () => {
    expect(classifyVendorErrorText("failed to parse message")).toBe("protocol");
    expect(classifyVendorErrorText("unexpected message frame")).toBe(
      "protocol",
    );
  });

  it("defaults everything else to transient", () => {
    expect(classifyVendorErrorText("socket hang up")).toBe("transient");
    expect(classifyVendorErrorText("ECONNRESET")).toBe("transient");
    expect(classifyVendorErrorText("")).toBe("transient");
  });
});

describe("classifyVendorClose", () => {
  it("treats known auth close codes as auth", () => {
    expect(classifyVendorClose(4001)).toBe("auth");
    expect(classifyVendorClose(4008, "quota exceeded")).toBe("auth");
    expect(classifyVendorClose(1008)).toBe("auth");
  });

  it("falls back to the reason text for other codes", () => {
    expect(classifyVendorClose(1011, "invalid api key")).toBe("auth");
    expect(classifyVendorClose(1006, "abnormal closure")).toBe("transient");
    expect(classifyVendorClose(1000)).toBe("transient");
  });
});

describe("messageOf", () => {
  it("extracts message from Error, string, and unknown", () => {
    expect(messageOf(new Error("boom"))).toBe("boom");
    expect(messageOf("plain")).toBe("plain");
    expect(messageOf({ weird: true })).toBe("unknown vendor error");
  });
});

describe("toSttError", () => {
  it("maps auth text to SttAuthError with a vendor-prefixed message and preserved cause", () => {
    const cause = new Error("Unauthorized");
    const mapped = toSttError("assemblyai", cause);
    expect(mapped).toBeInstanceOf(SttAuthError);
    expect(mapped.kind).toBe("auth");
    expect(mapped.message).toBe("assemblyai: Unauthorized");
    expect(mapped.cause).toBe(cause);
  });

  it("maps protocol text to SttProtocolError", () => {
    expect(
      toSttError("deepgram", new Error("unparseable frame")),
    ).toBeInstanceOf(SttProtocolError);
  });

  it("maps unknown text to SttTransientError", () => {
    expect(toSttError("deepgram", new Error("socket hang up"))).toBeInstanceOf(
      SttTransientError,
    );
  });

  it("lets an authoritative close code override transient text", () => {
    const mapped = toSttError("deepgram", "socket closed", 4001);
    expect(mapped).toBeInstanceOf(SttAuthError);
    expect(mapped.message).toBe("deepgram: socket closed");
  });
});
