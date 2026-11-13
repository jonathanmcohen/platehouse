// Build plan Task 17: the slicer link token and URL (the Slicer link
// contract; AC-041, AC-040 link half, AC-091).
//
//   token = base64url( fileId(16 bytes) || exp(uint32 BE, unix s)
//                      || HMAC-SHA256(key, "ph-link-v1"||fileId||exp)[0..16] )
//
// The key is derived from LINK_SECRET under its own HKDF label, so it is not
// the login cookie's key (auth/routes.ts loginCookieKey, derived from the
// same secret under another label): a token minted for one purpose never
// passes the other's check.
//
// No container: these are pure functions. The routes are in routes.test.ts
// (stubbed library) and delivery.test.ts (Postgres and the S3 test server).
// Every key here is random per run.
import { createHmac, randomBytes } from "node:crypto";
import { sign, unsign } from "@fastify/cookie";
import { describe, expect, test } from "vitest";
import { loginCookieKey } from "../../../src/auth/routes.js";
import type { LinkFile } from "../../../src/delivery/download.js";
import {
  LINK_LIFETIME_SECONDS,
  LINK_TOKEN_LENGTH,
  linkFileName,
  linkKey,
  linkSegment,
  mintLinkToken,
  readLinkToken,
  slicerLink,
} from "../../../src/delivery/links.js";

// Non-ASCII names are built from code points, so this file stays ASCII.
const E_ACUTE = String.fromCodePoint(0xe9);
/** "Cafe creme brulee" with its accents. */
const CREME = String.fromCodePoint(
  0x43,
  0x61,
  0x66,
  0xe9,
  0x20,
  0x63,
  0x72,
  0xe8,
  0x6d,
  0x65,
  0x20,
  0x62,
  0x72,
  0xfb,
  0x6c,
  0xe9,
  0x65,
);
/** "Cafe uber" with its accents, then two CJK characters. */
const ACCENTED = String.fromCodePoint(
  0x43,
  0x61,
  0x66,
  0xe9,
  0x20,
  0xfc,
  0x62,
  0x65,
  0x72,
  0x20,
  0x65e5,
  0x672c,
);

/** U+202E RIGHT-TO-LEFT OVERRIDE: "rlo<RLO>exe.3mf" displays as "rlofm3.exe". */
const RLO = String.fromCodePoint(0x202e);
/** The bidi embeddings, overrides (U+202A to U+202E) and isolates (U+2066 to U+2069). */
const BIDI = String.fromCodePoint(
  0x202a,
  0x202b,
  0x202c,
  0x202d,
  0x202e,
  0x2066,
  0x2067,
  0x2068,
  0x2069,
);
/** Zero-width space, non-joiner and joiner, word joiner, and the BOM. */
const ZERO_WIDTH = String.fromCodePoint(0x200b, 0x200c, 0x200d, 0x2060, 0xfeff);
/** More of \p{Cf}: soft hyphen, Arabic letter mark, LRM, RLM and a tag character. */
const OTHER_FORMAT = String.fromCodePoint(0xad, 0x61c, 0x200e, 0x200f, 0xe0041);

const RUN_SECRET = randomBytes(32).toString("hex");
/** The link key for RUN_SECRET. */
function key(): Buffer {
  return linkKey(RUN_SECRET);
}
const ORIGIN = "https://platehouse.test";
const FILE_A = "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f";
const FILE_B = "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8ea0";
const T0 = new Date("2026-11-12T10:00:00.250Z");
const EXP = Math.ceil(T0.getTime() / 1000) + LINK_LIFETIME_SECONDS;

function file(over: Partial<LinkFile> = {}): LinkFile {
  return { id: FILE_A, name: "Cube.3mf", originalName: "Cube.3mf", kind: "3mf", ...over };
}

function link(f: LinkFile = file(), now: Date = T0) {
  return slicerLink({ key: key(), file: f, now, absoluteUrl: (p) => `${ORIGIN}${p}` });
}

/** The token in a link URL: the segment after /s/. */
function tokenOf(url: string): string {
  const parts = new URL(url).pathname.split("/");
  expect(parts[1]).toBe("s");
  return parts[2] ?? "";
}

/** A token built by hand from its parts, MAC'd with any key. */
function handToken(key: Buffer | string, fileId: string, exp: number): string {
  const id = Buffer.from(fileId.replaceAll("-", ""), "hex");
  const e = Buffer.alloc(4);
  e.writeUInt32BE(exp);
  const mac = createHmac("sha256", key)
    .update(Buffer.concat([Buffer.from("ph-link-v1"), id, e]))
    .digest()
    .subarray(0, 16);
  return Buffer.concat([id, e, mac]).toString("base64url");
}

function at(ms: number): Date {
  return new Date(T0.getTime() + ms);
}

describe("the link token", () => {
  test("is the contract's bytes: file id, expiry, then 16 bytes of HMAC", () => {
    const minted = mintLinkToken(key(), FILE_A, EXP);
    expect(minted).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(minted).toHaveLength(LINK_TOKEN_LENGTH);
    const bytes = Buffer.from(minted, "base64url");
    expect(bytes).toHaveLength(36);
    expect(bytes.subarray(0, 16).toString("hex")).toBe(FILE_A.replaceAll("-", ""));
    expect(bytes.readUInt32BE(16)).toBe(EXP);
    expect(minted).toBe(handToken(key(), FILE_A, EXP));
  });

  test("reads back to its file id while it is live", () => {
    expect(readLinkToken(key(), mintLinkToken(key(), FILE_A, EXP), T0)).toBe(FILE_A);
    expect(readLinkToken(key(), mintLinkToken(key(), FILE_B, EXP), T0)).toBe(FILE_B);
  });

  test("a link minted now works at 9:59 and is refused at 10:01", () => {
    const minted = tokenOf(link().url);
    expect(readLinkToken(key(), minted, at(0))).toBe(FILE_A);
    expect(readLinkToken(key(), minted, at(9 * 60_000 + 59_000))).toBe(FILE_A);
    expect(readLinkToken(key(), minted, at(10 * 60_000 + 1_000))).toBeUndefined();
    expect(readLinkToken(key(), minted, at(24 * 3_600_000))).toBeUndefined();
  });

  test("expiresAt is ten minutes on, never less", () => {
    const l = link();
    const expires = new Date(l.expiresAt).getTime();
    expect(expires - T0.getTime()).toBeGreaterThanOrEqual(LINK_LIFETIME_SECONDS * 1000);
    expect(expires - T0.getTime()).toBeLessThanOrEqual(LINK_LIFETIME_SECONDS * 1000 + 1000);
    expect(readLinkToken(key(), tokenOf(l.url), new Date(expires - 1))).toBe(FILE_A);
    expect(readLinkToken(key(), tokenOf(l.url), new Date(expires))).toBeUndefined();
  });

  test("refuses an altered one: every byte flipped, cut, padded or re-cased", () => {
    const minted = tokenOf(link().url);
    const bytes = Buffer.from(minted, "base64url");
    for (let i = 0; i < bytes.length; i += 1) {
      const altered = Buffer.from(bytes);
      altered[i] = (altered[i] ?? 0) ^ 0x01;
      expect(readLinkToken(key(), altered.toString("base64url"), T0), `byte ${i}`).toBeUndefined();
    }
    const others = [
      "",
      minted.slice(0, -1),
      `${minted}A`,
      `${minted}=`,
      minted.toUpperCase(),
      minted.replace(/^./, (c) => (c === "A" ? "B" : "A")),
      `${minted.slice(0, 20)}+${minted.slice(21)}`,
      `${minted.slice(0, 20)}/${minted.slice(21)}`,
      Buffer.from(minted, "base64url").toString("base64"),
      "x".repeat(LINK_TOKEN_LENGTH),
    ];
    for (const other of others) {
      if (other === minted) continue;
      expect(readLinkToken(key(), other, T0), other).toBeUndefined();
    }
  });

  test("refuses a later expiry written into a real one", () => {
    const bytes = Buffer.from(tokenOf(link().url), "base64url");
    bytes.writeUInt32BE(bytes.readUInt32BE(16) + 86_400, 16);
    expect(readLinkToken(key(), bytes.toString("base64url"), T0)).toBeUndefined();
  });

  test("one for file A cannot be turned into one for file B", () => {
    const bytes = Buffer.from(tokenOf(link().url), "base64url");
    Buffer.from(FILE_B.replaceAll("-", ""), "hex").copy(bytes, 0);
    expect(readLinkToken(key(), bytes.toString("base64url"), T0)).toBeUndefined();
  });

  test("refuses one minted under another LINK_SECRET", () => {
    const other = linkKey(randomBytes(32).toString("hex"));
    expect(readLinkToken(key(), mintLinkToken(other, FILE_A, EXP), T0)).toBeUndefined();
  });
});

describe("the link key and the login cookie's key are kept apart", () => {
  test("the two derived from one LINK_SECRET differ, and neither equals the secret", () => {
    const login = loginCookieKey(RUN_SECRET);
    expect(key()).toHaveLength(32);
    expect(key().equals(login)).toBe(false);
    expect(key().equals(Buffer.from(RUN_SECRET, "utf8"))).toBe(false);
    expect(linkKey(RUN_SECRET).equals(key())).toBe(true);
  });

  test("refuses a link token MAC'd with the login cookie's key", () => {
    const forged = handToken(loginCookieKey(RUN_SECRET), FILE_A, EXP);
    expect(readLinkToken(key(), forged, T0)).toBeUndefined();
  });

  test("refuses a link token MAC'd with LINK_SECRET itself", () => {
    expect(readLinkToken(key(), handToken(RUN_SECRET, FILE_A, EXP), T0)).toBeUndefined();
  });

  test("a value signed with the link key does not pass as a login cookie", () => {
    const login = loginCookieKey(RUN_SECRET);
    const minted = mintLinkToken(key(), FILE_A, EXP);
    // What the login cookie's check accepts: a value signed with its key.
    expect(unsign(sign(minted, login), login).valid).toBe(true);
    // The same value signed with the link key, and the link token itself.
    expect(unsign(sign(minted, key()), login).valid).toBe(false);
    expect(unsign(minted, login).valid).toBe(false);
    const mac = Buffer.from(minted, "base64url").subarray(20).toString("base64");
    expect(unsign(`${minted}.${mac}`, login).valid).toBe(false);
  });

  test("a login cookie's signature does not pass as a link token's MAC", () => {
    const login = loginCookieKey(RUN_SECRET);
    const id = Buffer.from(FILE_A.replaceAll("-", ""), "hex");
    const e = Buffer.alloc(4);
    e.writeUInt32BE(EXP);
    const body = Buffer.concat([Buffer.from("ph-link-v1"), id, e]).toString("latin1");
    const signature = sign(body, login).slice(body.length + 1);
    const mac = Buffer.from(signature, "base64").subarray(0, 16);
    const forged = Buffer.concat([id, e, mac]).toString("base64url");
    expect(readLinkToken(key(), forged, T0)).toBeUndefined();
  });
});

describe("the link URL", () => {
  test("is https on PUBLIC_ORIGIN with no query string and the name as its last segment", () => {
    const l = link();
    const url = new URL(l.url);
    expect(url.origin).toBe(ORIGIN);
    expect(url.protocol).toBe("https:");
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
    expect(l.url).not.toContain("?");
    expect(url.pathname).toMatch(/^\/s\/[A-Za-z0-9_-]{48}\/Cube\.3mf$/);
  });

  test("open URLs are the contract's three, each carrying the encoded link", () => {
    const l = link();
    const enc = encodeURIComponent(l.url);
    expect(l.open).toEqual({
      orca: `orcaslicer://open?file=${enc}`,
      bambuMac: `bambustudioopen://${enc}`,
      bambuOther: `bambustudio://open?file=${enc}`,
    });
  });

  test("carries no secret: the token is the only thing between /s/ and the name", () => {
    const l = link();
    expect(l.url).not.toContain(RUN_SECRET);
    expect(l.url).not.toContain(key().toString("hex"));
    expect(l.url).not.toContain(key().toString("base64url"));
  });
});

describe("the link's name segment (Review Focus 1)", () => {
  // [stored name, original name, kind, the name the link must end in]
  const cases: Array<[string, string, LinkFile["kind"], string]> = [
    ["Cube.3mf", "Cube.3mf", "3mf", "Cube.3mf"],
    ["Cube", "Cube.3mf", "3mf", "Cube.3mf"],
    ["Cube.3MF", "Cube.3MF", "3mf", "Cube.3MF"],
    ["Cube.stl", "Cube.3mf", "3mf", "Cube.stl.3mf"],
    ["Air Dry - AMS", "Air Dry - AMS.3mf", "3mf", "Air Dry - AMS.3mf"],
    ["Bracket", "bracket.STP", "step", "Bracket.stp"],
    ["Bracket.step", "bracket.stp", "step", "Bracket.step"],
    ["Bracket", "bracket.step", "step", "Bracket.step"],
    ["Bin", "bin.scad", "scad", "Bin.scad"],
    ["Bin", "bin.stl", "stl", "Bin.stl"],
    [CREME, "x.3mf", "3mf", `${CREME}.3mf`],
    ["a/b\\c", "x.3mf", "3mf", "a/b\\c.3mf"],
    ["..", "x.3mf", "3mf", "...3mf"],
    [".", "x.stl", "stl", "..stl"],
    ['say "hi" it\'s', "x.3mf", "3mf", 'say "hi" it\'s.3mf'],
  ];

  test.each(cases)("%j (%s, %s) ends in %j", (name, originalName, kind, expected) => {
    expect(linkFileName({ name, originalName, kind })).toBe(expected);
  });

  // Jon, 2026-11-12 (PR #156): the segment is the delivered name with
  // / \ % ? # ; NUL, control characters and invisible format characters
  // (\p{Cf}: bidi overrides and isolates, zero-width characters) replaced
  // by _, then percent-encoded, so a link never depends on how a proxy
  // treats an encoded slash, backslash or percent sign, and a slicer that
  // decodes the segment never shows a name reordered to read as another
  // extension. [stored name, segment]
  const hostile: Array<[string, string]> = [
    ["a b  c.3mf", "a%20b%20%20c.3mf"],
    [`${ACCENTED}.3mf`, encodeURIComponent(`${ACCENTED}.3mf`)],
    ["../../etc/passwd.3mf", ".._.._etc_passwd.3mf"],
    ["..\\..\\boot.ini.3mf", ".._.._boot.ini.3mf"],
    ["a/b/c.3mf", "a_b_c.3mf"],
    ["\"quoted\" 'single'.3mf", "%22quoted%22%20'single'.3mf"],
    ["semi;colon,comma=eq.3mf", "semi_colon%2Ccomma%3Deq.3mf"],
    ["percent %2F %00.3mf", "percent%20_2F%20_00.3mf"],
    ["hash # question ?.3mf", "hash%20_%20question%20_.3mf"],
    ["new\nline\r\ttab.3mf", "new_line__tab.3mf"],
    [
      `nul${String.fromCodePoint(0)}del${String.fromCodePoint(0x7f)}c1${String.fromCodePoint(0x85)}.3mf`,
      "nul_del_c1_.3mf",
    ],
    [`rlo${RLO}exe.3mf`, "rlo_exe.3mf"],
    [`x.3mf${RLO}`, "x.3mf_.3mf"],
    [`bidi${BIDI}.3mf`, `bidi${"_".repeat(9)}.3mf`],
    [`zero${ZERO_WIDTH}width.3mf`, `zero${"_".repeat(5)}width.3mf`],
    [`other${OTHER_FORMAT}.3mf`, `other${"_".repeat(5)}.3mf`],
    ["a/b", "a_b.3mf"],
    ["..", "...3mf"],
    [`${"x".repeat(230)}.3mf`, `${"x".repeat(230)}.3mf`],
    [`${E_ACUTE.repeat(210)}.3mf`, encodeURIComponent(`${E_ACUTE.repeat(210)}.3mf`)],
  ];

  test.each(hostile)(
    "hostile name %j: one segment %j, no unsafe character, ends in .3mf",
    (name, segment) => {
      const l = link(file({ name }));
      const url = new URL(l.url);
      expect(url.origin).toBe(ORIGIN);
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
      const parts = url.pathname.split("/");
      expect(parts).toHaveLength(4);
      const last = parts[3] ?? "";
      expect(last).toBe(segment);
      expect(linkSegment(file({ name }))).toBe(segment);
      expect(decodeURIComponent(last)).not.toMatch(/[/\\%?#;\p{Cc}\p{Cf}]/u);
      expect(last.endsWith(".3mf")).toBe(true);
      expect(l.url).toMatch(/^[\x21-\x7e]+$/);
    },
  );

  test("every invisible format character (\\p{Cf}) is replaced, and the extension stays last", () => {
    let checked = 0;
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      if (!/\p{Cf}/u.test(c)) continue;
      checked += 1;
      expect(linkSegment(file({ name: `a${c}b.3mf` })), `U+${cp.toString(16)}`).toBe("a_b.3mf");
      expect(linkSegment(file({ name: `a${c}`, kind: "stl" })), `U+${cp.toString(16)}`).toBe(
        "a_.stl",
      );
    }
    expect(checked).toBeGreaterThan(150);
  });

  test("the segment keeps the name's own extension when it already has one", () => {
    expect(linkSegment(file({ name: "Bracket.STP", kind: "step" }))).toBe("Bracket.STP");
    expect(linkSegment(file({ name: "a;b", originalName: "x.stp", kind: "step" }))).toBe("a_b.stp");
  });
});
