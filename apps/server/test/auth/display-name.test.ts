// Issue #322: the display name a session records at sign-in, which a new API
// token copies as its creator's name. It comes from the claims: name, else
// preferred_username, else email; trimmed, at most MAX_DISPLAY_NAME
// characters, and null when none of them is a usable string.
import { describe, expect, test } from "vitest";
import { displayNameOf, MAX_DISPLAY_NAME } from "../../src/auth/oidc.js";

describe("displayNameOf", () => {
  test("prefers name, then preferred_username, then email", () => {
    expect(
      displayNameOf({ name: "Synthetic Person", preferred_username: "sp", email: "sp@x.test" }),
    ).toBe("Synthetic Person");
    expect(displayNameOf({ preferred_username: "sp", email: "sp@x.test" })).toBe("sp");
    expect(displayNameOf({ email: "sp@x.test" })).toBe("sp@x.test");
  });

  test("skips a claim that is blank or not a string", () => {
    expect(displayNameOf({ name: "   ", preferred_username: "sp" })).toBe("sp");
    expect(displayNameOf({ name: 42, preferred_username: ["sp"], email: "sp@x.test" })).toBe(
      "sp@x.test",
    );
  });

  test("is null when no claim names the user", () => {
    expect(displayNameOf({})).toBeNull();
    expect(displayNameOf({ name: "", email: null })).toBeNull();
  });

  test("trims and caps the name", () => {
    expect(displayNameOf({ name: "  Synthetic  " })).toBe("Synthetic");
    const long = displayNameOf({ name: "x".repeat(MAX_DISPLAY_NAME + 50) });
    expect(long).toHaveLength(MAX_DISPLAY_NAME);
  });

  test("drops control characters, so a name cannot break a log line or the page", () => {
    expect(displayNameOf({ name: "Synthetic\nPerson\u0000" })).toBe("Synthetic Person");
  });
});
