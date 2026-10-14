import { afterEach, describe, expect, it, vi } from "vitest";
import { parseGoogleReturn } from "../src/google-return";

describe("parseGoogleReturn", () => {
  afterEach(() => vi.unstubAllGlobals());
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

  it("routes Classroom outcomes only to Classroom, leaving Calendar unchanged", () => {
    expect(parseGoogleReturn("#classroom=connected")).toBeNull();
    expect(parseGoogleReturn("#classroom=connected", "classroom")).toEqual({ ok: true });
    expect(parseGoogleReturn("#google=connected", "classroom")).toBeNull();
    expect(parseGoogleReturn("#classroom=error&message=School%20approval%20required", "classroom"))
      .toEqual({ ok: false, message: "School approval required" });
  });

  it("opens Settings after Classroom returns, cleans the address, and consumes only its matching outcome", async () => {
    vi.resetModules();
    vi.stubGlobal("window", { location: { hash: "#classroom=connected", pathname: "/", search: "?existing=1" } });
    const replaceState = vi.fn();
    vi.stubGlobal("history", { replaceState });
    const module = await import("../src/google-return");
    expect(module.hasGoogleReturn()).toBe(true);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/?existing=1");
    expect(module.takeGoogleReturn()).toBeNull(); // Calendar must not consume it
    expect(module.hasGoogleReturn()).toBe(true);
    expect(module.takeGoogleReturn("classroom")).toEqual({ ok: true });
    expect(module.takeGoogleReturn("classroom")).toBeNull();
    expect(module.hasGoogleReturn()).toBe(false);
  });
});
