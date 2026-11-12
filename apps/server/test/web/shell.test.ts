// Build plan Task 18, AC-070: the server writes the theme into the HTML
// shell, so the right palette applies on the first paint with no script and
// no flash. data-theme on the html element and the color-scheme meta come
// from the ph_theme cookie; Dark is the default and anything that is not
// dark, light or system is dark. Only those two places change.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { patternClass } from "../../src/auth/gate.js";
import {
  defaultWebDir,
  parseShellTemplate,
  resolveTheme,
  SHELL_PAGES,
  ShellTemplateError,
  THEME_COOKIE,
} from "../../src/web/shell.js";

const TEMPLATE = [
  "<!doctype html>",
  '<html lang="en" data-theme="dark">',
  "  <head>",
  '    <meta charset="utf-8" />',
  '    <meta name="color-scheme" content="dark" />',
  '    <script type="module" crossorigin src="/assets/index-AbC123.js"></script>',
  '    <link rel="stylesheet" crossorigin href="/assets/index-DeF456.css">',
  "  </head>",
  '  <body><div id="root"></div></body>',
  "</html>",
  "",
].join("\n");

function themeOf(html: string): string | undefined {
  return /<html\b[^>]*\sdata-theme="([^"]*)"/.exec(html)?.[1];
}

function schemeOf(html: string): string | undefined {
  return /<meta name="color-scheme" content="([^"]*)"/.exec(html)?.[1];
}

describe("the shell renders data-theme from the cookie, with dark as the default", () => {
  const shell = parseShellTemplate(TEMPLATE);

  test.each([
    [undefined, "dark", "dark"],
    ["dark", "dark", "dark"],
    ["light", "light", "light"],
    ["system", "system", "light dark"],
  ])("ph_theme=%s renders data-theme %s and color-scheme %s", (cookie, theme, scheme) => {
    const html = shell.render(cookie);
    expect(themeOf(html)).toBe(theme);
    expect(schemeOf(html)).toBe(scheme);
  });

  test.each(["", "Light", "SYSTEM", " light", "sepia", 'light" onload="x', "light><script>"])(
    "ph_theme=%j is dark",
    (cookie) => {
      const html = shell.render(cookie);
      expect(themeOf(html)).toBe("dark");
      expect(schemeOf(html)).toBe("dark");
      if (cookie !== "") expect(html).not.toContain(cookie);
    },
  );

  test("changes nothing but the html element's data-theme and the color-scheme meta", () => {
    const html = shell.render("light");
    expect(html).toBe(
      TEMPLATE.replace('data-theme="dark"', 'data-theme="light"').replace(
        '<meta name="color-scheme" content="dark" />',
        '<meta name="color-scheme" content="light" />',
      ),
    );
    expect(shell.render(undefined)).toBe(TEMPLATE);
  });

  test("leaves the same words elsewhere in the page alone", () => {
    const template = TEMPLATE.replace(
      '<div id="root"></div>',
      '<div id="root"></div><script>const a = \'data-theme="dark"\';</script>',
    );
    const html = parseShellTemplate(template).render("light");
    expect(themeOf(html)).toBe("light");
    expect(html).toContain("const a = 'data-theme=\"dark\"';");
  });
});

describe("parseShellTemplate", () => {
  test.each([
    ["no data-theme on the html element", TEMPLATE.replace(' data-theme="dark"', "")],
    ["a data-theme other than dark", TEMPLATE.replace('data-theme="dark"', 'data-theme="light"')],
    [
      "no color-scheme meta",
      TEMPLATE.replace('    <meta name="color-scheme" content="dark" />\n', ""),
    ],
    [
      "two color-scheme metas",
      TEMPLATE.replace(
        '<meta charset="utf-8" />',
        '<meta charset="utf-8" /><meta name="color-scheme" content="dark" />',
      ),
    ],
    ["two html elements", `${TEMPLATE}<html data-theme="dark">`],
    ["no html at all", ""],
  ])("refuses a template with %s", (_name, template) => {
    expect(() => parseShellTemplate(template)).toThrow(ShellTemplateError);
  });

  test("accepts the web app's own index.html", () => {
    const source = readFileSync(new URL("../../../web/index.html", import.meta.url), "utf8");
    const shell = parseShellTemplate(source);
    expect(themeOf(shell.render("system"))).toBe("system");
    expect(schemeOf(shell.render("system"))).toBe("light dark");
  });
});

describe("defaultWebDir", () => {
  test("is apps/web/dist beside the server, run from source or from its build", () => {
    expect(defaultWebDir("file:///srv/ph/apps/server/src/web/shell.ts")).toBe(
      "/srv/ph/apps/web/dist",
    );
    expect(defaultWebDir("file:///srv/ph/apps/server/dist/src/web/shell.js")).toBe(
      "/srv/ph/apps/web/dist",
    );
  });

  test("from this module, is this checkout's apps/web/dist", () => {
    expect(defaultWebDir()).toBe(fileURLToPath(new URL("../../../web/dist", import.meta.url)));
  });
});

describe("constants", () => {
  test("the cookie is ph_theme, the same one the web app writes", () => {
    expect(THEME_COOKIE).toBe("ph_theme");
    const web = readFileSync(new URL("../../../web/src/shell/theme.ts", import.meta.url), "utf8");
    expect(web).toMatch(/THEME_COOKIE = "ph_theme"/);
  });

  test.each([
    ["dark", "dark"],
    ["light", "light"],
    ["system", "system"],
    [undefined, "dark"],
    ["DARK", "dark"],
  ])("resolveTheme(%s) is %s", (value, theme) => {
    expect(resolveTheme(value)).toBe(theme);
  });

  test("the shell pages are the sidebar's sections, each a session-class page", () => {
    expect([...SHELL_PAGES]).toEqual(["/", "/creators", "/collections", "/tags"]);
    for (const page of SHELL_PAGES) expect(patternClass(page), page).toBe("session");
  });
});
