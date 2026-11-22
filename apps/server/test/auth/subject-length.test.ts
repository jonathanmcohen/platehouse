// Issue #378: one rule for how long an OIDC subject may be. OpenID Connect
// Core limits sub to 255 ASCII characters, so admit() refuses a sign-in whose
// sub is longer than MAX_SUBJECT_LENGTH characters, with the reason
// subject_too_long and the length (never the subject) on the error. Every
// column and index that stores a subject then holds at most 255 characters
// (migration 0013). 0.1.0 took any non-empty string as sub, so nothing else
// is refused: a subject of up to 255 characters of any script still signs in.
// Characters are counted as Postgres's char_length counts them, by code
// point, not by UTF-16 unit.
import { describe, expect, test } from "vitest";
import { admit, LoginError, MAX_SUBJECT_LENGTH } from "../../src/auth/oidc.js";

const GROUP = "platehouse";

/** Claims that admit() lets in, apart from the subject. */
function claims(sub: string): Record<string, unknown> {
  return { sub, email_verified: true, groups: [GROUP] };
}

/** The LoginError admit() throws for these claims, or undefined when it lets them in. */
function refusal(sub: string): LoginError | undefined {
  try {
    admit(claims(sub), GROUP);
    return undefined;
  } catch (error) {
    if (error instanceof LoginError) return error;
    throw error;
  }
}

describe("the subject length rule", () => {
  test("is 255 characters, as OpenID Connect Core allows", () => {
    expect(MAX_SUBJECT_LENGTH).toBe(255);
  });

  test("a 255-character subject signs in", () => {
    const sub = "s".repeat(255);
    expect(admit(claims(sub), GROUP)).toEqual({ subject: sub });
  });

  test("a 256-character subject is refused as subject_too_long, with its length and not its value", () => {
    const sub = `subject-${"z".repeat(248)}`;
    expect(sub).toHaveLength(256);
    const error = refusal(sub);
    expect(error?.failure).toBe("subject_too_long");
    expect(error?.subjectLength).toBe(256);
    expect(error?.message).not.toContain(sub);
    expect(error?.message).toContain("255");
  });

  test("is checked before the group, so a long subject is never let in", () => {
    const error = (() => {
      try {
        admit({ sub: "q".repeat(300), email_verified: true, groups: ["other"] }, GROUP);
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect((error as LoginError).failure).toBe("subject_too_long");
  });

  test("counts characters, not UTF-16 units: 255 characters outside ASCII still sign in", () => {
    // 0.1.0 took any non-empty string, so a subject that is not ASCII but
    // within 255 characters is not refused now either.
    const accented = String.fromCodePoint(0xe9).repeat(255);
    expect(admit(claims(accented), GROUP)).toEqual({ subject: accented });
    // 255 characters outside the Basic Multilingual Plane: 510 UTF-16 units.
    const astral = String.fromCodePoint(0x1f600).repeat(255);
    expect(astral.length).toBe(510);
    expect(admit(claims(astral), GROUP)).toEqual({ subject: astral });
    expect(refusal(`${astral}x`)?.subjectLength).toBe(256);
  });
});
