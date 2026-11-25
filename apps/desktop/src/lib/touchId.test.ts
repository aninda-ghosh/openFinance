import { describe, expect, it } from "vitest";
import { touchIdEnableMessage, touchIdUnlockMessage } from "./touchId";

describe("touchIdUnlockMessage", () => {
  it("says nothing on a plain cancel", () => {
    expect(touchIdUnlockMessage("cancelled")).toBeNull();
    expect(touchIdUnlockMessage("not_enabled")).toBeNull();
  });

  it("explains an invalidation in one line", () => {
    expect(touchIdUnlockMessage("biometry_changed")).toMatch(
      /fingerprints changed/
    );
    expect(touchIdUnlockMessage("invalidated")).toMatch(/turned off/);
  });

  it("falls back to a calm generic message", () => {
    expect(touchIdUnlockMessage("failed")).toMatch(/Enter your password/);
    expect(touchIdUnlockMessage(new Error("boom"))).toMatch(
      /Enter your password/
    );
  });
});

describe("touchIdEnableMessage", () => {
  it("says nothing on a plain cancel", () => {
    expect(touchIdEnableMessage("cancelled")).toBeNull();
  });

  it("names a wrong password", () => {
    expect(touchIdEnableMessage("wrong_password")).toBe(
      "That password is wrong."
    );
  });
});
