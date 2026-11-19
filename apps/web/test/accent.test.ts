// The accent colour scheme (Jon, 2026-11-19): twelve schemes, picked per
// browser beside the Dark / Light / System theme. The choice lives in the
// ph_accent cookie; the server writes it into the html element's data-accent
// before the page is sent, so the first paint is already right, and the app
// only reads it back. Picking writes the cookie and the attribute together,
// with no reload. The cookie only ever holds one of the twelve ids; anything
// else is the default. The document here is a stand-in that records what is
// written to it and fails on a reload.
import { describe, expect, test } from "vitest";
import {
  ACCENT_COOKIE,
  ACCENTS,
  type AccentDocument,
  accentCookie,
  applyAccent,
  DEFAULT_ACCENT,
  readAccent,
  resolveAccent,
  SCHEMES,
} from "../src/shell/accent";
import { ACCENT_NAMES } from "../src/shell/accentLabels";

interface FakeDocument extends AccentDocument {
  attributes: Map<string, string>;
  cookies: string[];
  reloads: number;
  location: { protocol: string; reload(): void };
}

function fakeDocument(opts: { accent?: string; protocol?: string } = {}) {
  const attributes = new Map<string, string>();
  if (opts.accent !== undefined) attributes.set("data-accent", opts.accent);
  const doc: FakeDocument = {
    attributes,
    cookies: [],
    reloads: 0,
    documentElement: {
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => {
        attributes.set(name, value);
      },
    },
    get cookie() {
      return doc.cookies.join("; ");
    },
    set cookie(value: string) {
      doc.cookies.push(value);
    },
    location: {
      protocol: opts.protocol ?? "https:",
      reload: () => {
        doc.reloads++;
      },
    },
  };
  return doc;
}

const IDS = [
  "bambu-green",
  "workshop-green",
  "filament-orange",
  "spool-teal",
  "blueprint-indigo",
  "pla-violet",
  "coral",
  "amber",
  "sky-blue",
  "magenta",
  "graphite",
  "lime",
];

/** Values that are not an accent id: wrong case, padding, cookie syntax, markup, prototype names. */
const NOT_IDS: unknown[] = [
  undefined,
  null,
  "",
  "Coral",
  "CORAL",
  " coral",
  "coral ",
  "coral; Domain=evil.example",
  'coral" onload="x',
  "coral><script>",
  "green",
  "bambu",
  "toString",
  "__proto__",
  "constructor",
  42,
  {},
  ["coral"],
];

describe("the schemes", () => {
  test("there are twelve, in the order Jon listed them, each with a unique id", () => {
    expect([...ACCENTS]).toEqual(IDS);
    expect(new Set(ACCENTS).size).toBe(12);
    expect(SCHEMES.map((s) => s.id)).toEqual(IDS);
  });

  test("Bambu green, today's colour, is the default", () => {
    expect(DEFAULT_ACCENT).toBe("bambu-green");
    expect(ACCENTS).toContain(DEFAULT_ACCENT);
  });

  test("the cookie is ph_accent", () => {
    expect(ACCENT_COOKIE).toBe("ph_accent");
  });

  test("every id is safe to put in a cookie and an html attribute as it is", () => {
    for (const id of ACCENTS) expect(id).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
  });

  test("each scheme has its name, and the twelve names are the ones Jon gave", () => {
    expect(ACCENTS.map((id) => ACCENT_NAMES[id])).toEqual([
      "Bambu green",
      "Workshop green",
      "Filament orange",
      "Spool teal",
      "Blueprint indigo",
      "PLA violet",
      "Coral",
      "Amber",
      "Sky blue",
      "Magenta",
      "Graphite",
      "Lime",
    ]);
  });

  test("every token is a #rrggbb colour", () => {
    for (const scheme of SCHEMES) {
      for (const theme of ["light", "dark"] as const) {
        for (const [token, value] of Object.entries(scheme[theme])) {
          expect(value, `${scheme.id} ${theme} ${token}`).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
    }
  });

  test("the default's dark tokens are today's dark palette, exactly", () => {
    const green = SCHEMES.find((s) => s.id === "bambu-green");
    expect(green?.dark).toEqual({
      accent: "#00ae42",
      accentText: "#33d17a",
      accentSoft: "#173027",
      brand: "#00ae42",
    });
  });

  test("the default's light text and soft are today's, and its fill is Jon's button green", () => {
    const green = SCHEMES.find((s) => s.id === "bambu-green");
    expect(green?.light).toEqual({
      accent: "#00873a",
      accentText: "#007a2f",
      accentSoft: "#e7f7ed",
      brand: "#00ae42",
    });
  });
});

describe("resolveAccent", () => {
  test.each(IDS)("%s is itself", (id) => {
    expect(resolveAccent(id)).toBe(id);
  });

  test.each(NOT_IDS.map((v) => [v]))("%j is the default", (value) => {
    expect(resolveAccent(value)).toBe(DEFAULT_ACCENT);
  });
});

describe("readAccent", () => {
  test("reads the accent the server wrote into the html element", () => {
    expect(readAccent(fakeDocument({ accent: "coral" }))).toBe("coral");
    expect(readAccent(fakeDocument({ accent: "lime" }))).toBe("lime");
  });

  test("a missing or unknown attribute is the default", () => {
    expect(readAccent(fakeDocument())).toBe(DEFAULT_ACCENT);
    expect(readAccent(fakeDocument({ accent: "sepia" }))).toBe(DEFAULT_ACCENT);
    expect(readAccent(fakeDocument({ accent: "Coral" }))).toBe(DEFAULT_ACCENT);
  });
});

describe("accentCookie", () => {
  test("is remembered for a year on the whole site, SameSite=Lax, Secure on https", () => {
    expect(accentCookie("coral", true)).toBe(
      "ph_accent=coral; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
    );
    expect(accentCookie("sky-blue", false)).toBe(
      "ph_accent=sky-blue; Path=/; Max-Age=31536000; SameSite=Lax",
    );
  });

  test.each(NOT_IDS.map((v) => [v]))("holds the default, never %j", (value) => {
    expect(accentCookie(value as never, true)).toBe(accentCookie(DEFAULT_ACCENT, true));
  });
});

describe("applyAccent", () => {
  test.each(IDS)("%s sets the cookie and data-accent at once", (id) => {
    const doc = fakeDocument({ accent: id === "coral" ? "lime" : "coral" });
    applyAccent(id as never, doc);
    expect(doc.attributes.get("data-accent")).toBe(id);
    expect(doc.cookies).toEqual([accentCookie(id as never, true)]);
  });

  test("never reloads the page", () => {
    const doc = fakeDocument({ accent: "coral" });
    for (const id of ACCENTS) applyAccent(id, doc);
    expect(doc.cookies).toHaveLength(12);
    expect(doc.reloads).toBe(0);
  });

  test("leaves Secure off on plain http (a local dev server)", () => {
    const doc = fakeDocument({ protocol: "http:" });
    applyAccent("amber", doc);
    expect(doc.cookies).toEqual([accentCookie("amber", false)]);
  });

  test("leaves the theme alone", () => {
    const doc = fakeDocument({ accent: "coral" });
    doc.attributes.set("data-theme", "light");
    applyAccent("lime", doc);
    expect(doc.attributes.get("data-theme")).toBe("light");
  });

  test.each(NOT_IDS.map((v) => [v]))("writes only a known id when handed %j", (value) => {
    const doc = fakeDocument({ accent: "coral" });
    applyAccent(value as never, doc);
    expect(doc.attributes.get("data-accent")).toBe(DEFAULT_ACCENT);
    expect(doc.cookies).toEqual([accentCookie(DEFAULT_ACCENT, true)]);
    const value_ = /^ph_accent=([^;]*);/.exec(doc.cookies[0] ?? "")?.[1];
    expect(ACCENTS).toContain(value_);
  });
});
