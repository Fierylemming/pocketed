import { describe, expect, it } from "vitest";
import { parseGoogleReturn } from "../src/google-return";

describe("parseGoogleReturn", () => {
  it("reads the outcome Google's redirect leaves in the address", () => {
    expect(parseGoogleReturn("#google=connected")).toEqual({ ok: true });
    expect(parseGoogleReturn("#google=error&message=Google%20sign-in%20was%20cancelled.")).toEqual({
      ok: false,
      message: "Google sign-in was cancelled.",
    });
    expect(parseGoogleReturn("#google=error")).toEqual({ ok: false, message: "Google sign-in failed." });
    expect(parseGoogleReturn("")).toBeNull();
    expect(parseGoogleReturn("#section=work")).toBeNull();
  });
});
