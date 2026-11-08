// The search cursor (build plan Task 14): an opaque base64url string that
// carries where the last page stopped. Pure functions, so no database here.
import { describe, expect, test } from "vitest";
import { uuidv7 } from "../../src/db/ids.js";
import { decodeCursor, encodeCursor, InvalidCursor } from "../../src/library/search.js";

describe("search cursor", () => {
  test("a cursor decodes to the position it was made from", () => {
    const position = { rank: 412_345, name: 'Lid, final / v2 "quoted"', id: uuidv7() };
    const cursor = encodeCursor(position);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor)).toEqual(position);
  });

  test("names outside ASCII survive the round trip", () => {
    // Built from code points so the source stays ASCII: u-umlaut, sharp s and two CJK characters.
    const name = `Zahnrad ${String.fromCodePoint(0xfc, 0xdf)} ${String.fromCodePoint(0x6f22, 0x5b57)}`;
    const position = { rank: 0, name, id: uuidv7() };
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

  test.each([
    ["an empty string", ""],
    ["text that is not base64url", "not a cursor!"],
    ["base64url that is not JSON", Buffer.from("{{{").toString("base64url")],
    ["an object instead of a list", b64({ rank: 1, name: "a", id: uuidv7() })],
    ["a list of the wrong length", b64([1, "a"])],
    ["a rank that is not a whole number", b64([1.5, "a", uuidv7()])],
    ["a negative rank", b64([-1, "a", uuidv7()])],
    ["a rank over a million", b64([1_000_001, "a", uuidv7()])],
    ["a name that is not text", b64([1, 2, uuidv7()])],
    ["an id that is not a uuid", b64([1, "a", "x"])],
    ["base64 padding", `${b64([1, "a", uuidv7()])}=`],
  ])("%s is refused as InvalidCursor", (_label, cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(InvalidCursor);
  });

  test("InvalidCursor says the cursor is not valid without echoing it", () => {
    const bad = b64([1, "a", "x"]);
    try {
      decodeCursor(bad);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCursor);
      expect((error as Error).message).toBe("The cursor is not valid");
      expect((error as Error).message).not.toContain(bad);
    }
  });
});
