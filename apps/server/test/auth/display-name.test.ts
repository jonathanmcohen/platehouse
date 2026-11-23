// Issue #322: the display name a session records at sign-in, which a new API
// token copies as its creator's name. It comes from the claims: name, else
// preferred_username, else email; trimmed, at most MAX_DISPLAY_NAME
// characters, and null when none of them is a usable string.
import { describe, expect, test } from "vitest";
import { cleanName } from "../../src/auth/names.js";
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

  test("strips bidirectional marks and other format characters", () => {
    expect(displayNameOf({ name: "Syn\u200etheti\u200fc" })).toBe("Synthetic");
    expect(displayNameOf({ name: "\u202aSyn\u202b\u202c\u202d\u202ethetic" })).toBe("Synthetic");
    expect(displayNameOf({ name: "\u2066Syn\u2067\u2068the\u2069tic" })).toBe("Synthetic");
    expect(displayNameOf({ name: "Syn\u200bthe\ufeffti\u00adc" })).toBe("Synthetic");
  });

  test("a name of only format characters is null, and the next claim is used", () => {
    expect(displayNameOf({ name: "\u202e\u2066\u200f" })).toBeNull();
    expect(displayNameOf({ name: "\u202e\u200f", email: "sp@x.test" })).toBe("sp@x.test");
  });

  test("keeps the zero-width non-joiner and joiner, which some scripts and emoji need", () => {
    expect(displayNameOf({ name: "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645" })).toBe(
      "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645",
    );
    expect(displayNameOf({ name: "a\u200db" })).toBe("a\u200db");
    expect(displayNameOf({ name: "\u200c\u200d", email: "sp@x.test" })).toBe("sp@x.test");
  });

  test("a name of only joiners and white space is null, and the next claim is used", () => {
    expect(displayNameOf({ name: "\u200d \u200d" })).toBeNull();
    expect(displayNameOf({ name: "\u200d \u200d", email: "sp@x.test" })).toBe("sp@x.test");
    expect(displayNameOf({ name: "\u200c\u202e \u200d", email: "sp@x.test" })).toBe("sp@x.test");
    expect(displayNameOf({ name: "\u200d\t\u200c", email: "sp@x.test" })).toBe("sp@x.test");
  });
});

describe("cleanName", () => {
  test("a stored name of only joiners and white space reads back as no name", () => {
    expect(cleanName("\u200d \u200d")).toBeNull();
    expect(cleanName("\u200d \u200c")).toBeNull();
    expect(cleanName("a\u200d b")).toBe("a\u200d b");
  });
});
