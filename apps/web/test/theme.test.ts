// Build plan Task 18, AC-070: the theme switch sets the ph_theme cookie and
// the html element's data-theme (and the color-scheme meta) at once, with no
// reload. Dark is the default; System resolves in CSS. The document here is
// a stand-in that records what is written to it and fails on a reload.
import { describe, expect, test } from "vitest";
import {
  applyTheme,
  colorSchemeFor,
  DEFAULT_THEME,
  readTheme,
  resolveTheme,
  THEME_COOKIE,
  THEMES,
  type ThemeDocument,
  themeCookie,
} from "../src/shell/theme";

interface FakeDocument extends ThemeDocument {
  attributes: Map<string, string>;
  meta: Map<string, string>;
  cookies: string[];
  reloads: number;
  location: { protocol: string; reload(): void };
}

function fakeDocument(opts: { theme?: string; protocol?: string; meta?: boolean } = {}) {
  const attributes = new Map<string, string>();
  if (opts.theme !== undefined) attributes.set("data-theme", opts.theme);
  const meta = new Map<string, string>([["content", "dark"]]);
  const doc: FakeDocument = {
    attributes,
    meta,
    cookies: [],
    reloads: 0,
    documentElement: {
      getAttribute: (name) => attributes.get(name) ?? null,
      setAttribute: (name, value) => {
        attributes.set(name, value);
      },
    },
    querySelector: (selector) =>
      opts.meta === false || selector !== 'meta[name="color-scheme"]'
        ? null
        : {
            setAttribute: (name, value) => {
              meta.set(name, value);
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

describe("resolveTheme", () => {
  test("the three themes are Dark, Light and System, and Dark is the default", () => {
    expect(THEMES).toEqual(["dark", "light", "system"]);
    expect(DEFAULT_THEME).toBe("dark");
    expect(THEME_COOKIE).toBe("ph_theme");
  });

  test.each([
    ["dark", "dark"],
    ["light", "light"],
    ["system", "system"],
    [undefined, "dark"],
    [null, "dark"],
    ["", "dark"],
    ["Light", "dark"],
    ["SYSTEM", "dark"],
    [" light", "dark"],
    ["light; Path=/", "dark"],
    ["blue", "dark"],
  ])("%s resolves to %s", (value, expected) => {
    expect(resolveTheme(value)).toBe(expected);
  });
});

test.each([
  ["dark", "dark"],
  ["light", "light"],
  ["system", "light dark"],
] as const)("the color-scheme for %s is %s", (theme, scheme) => {
  expect(colorSchemeFor(theme)).toBe(scheme);
});

describe("readTheme", () => {
  test("reads the theme the server wrote into the html element", () => {
    expect(readTheme(fakeDocument({ theme: "light" }))).toBe("light");
    expect(readTheme(fakeDocument({ theme: "system" }))).toBe("system");
  });

  test("anything else is dark", () => {
    expect(readTheme(fakeDocument())).toBe("dark");
    expect(readTheme(fakeDocument({ theme: "sepia" }))).toBe("dark");
  });
});

describe("themeCookie", () => {
  test("is remembered for a year on the whole site, SameSite=Lax, Secure on https", () => {
    expect(themeCookie("light", true)).toBe(
      "ph_theme=light; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
    );
    expect(themeCookie("system", false)).toBe(
      "ph_theme=system; Path=/; Max-Age=31536000; SameSite=Lax",
    );
  });
});

describe("applyTheme", () => {
  test.each(THEMES)("%s sets the cookie, data-theme and color-scheme at once", (theme) => {
    const doc = fakeDocument({ theme: theme === "dark" ? "light" : "dark" });
    applyTheme(theme, doc);
    expect(doc.attributes.get("data-theme")).toBe(theme);
    expect(doc.meta.get("content")).toBe(colorSchemeFor(theme));
    expect(doc.cookies).toEqual([themeCookie(theme, true)]);
  });

  test("never reloads the page", () => {
    const doc = fakeDocument({ theme: "dark" });
    for (const theme of ["light", "system", "dark"] as const) applyTheme(theme, doc);
    expect(doc.cookies).toHaveLength(3);
    expect(doc.reloads).toBe(0);
  });

  test("leaves Secure off on plain http (a local dev server)", () => {
    const doc = fakeDocument({ theme: "dark", protocol: "http:" });
    applyTheme("light", doc);
    expect(doc.cookies).toEqual([themeCookie("light", false)]);
  });

  test("still sets the cookie and data-theme when the color-scheme meta is missing", () => {
    const doc = fakeDocument({ theme: "dark", meta: false });
    applyTheme("system", doc);
    expect(doc.attributes.get("data-theme")).toBe("system");
    expect(doc.cookies).toEqual([themeCookie("system", true)]);
  });

  test("writes only a known theme, whatever it is handed", () => {
    const doc = fakeDocument({ theme: "light" });
    applyTheme("dark; Domain=evil.example" as never, doc);
    expect(doc.attributes.get("data-theme")).toBe("dark");
    expect(doc.cookies).toEqual([themeCookie("dark", true)]);
  });
});
