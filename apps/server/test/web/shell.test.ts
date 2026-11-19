// Build plan Task 18, AC-070: the server writes the theme into the HTML
// shell, so the right palette applies on the first paint with no script and
// no flash. data-theme on the html element and the color-scheme meta come
// from the ph_theme cookie; Dark is the default and anything that is not
// dark, light or system is dark. Only those two places change.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { patternClass } from "../../src/auth/gate.js";
import {
  ACCENT_COOKIE,
  ACCENTS,
  DEFAULT_ACCENT,
  defaultWebDir,
  parseShellTemplate,
  registerWeb,
  resolveAccent,
  resolveTheme,
  SHELL_PAGES,
  ShellTemplateError,
  THEME_COOKIE,
} from "../../src/web/shell.js";

const TEMPLATE = [
  "<!doctype html>",
  '<html lang="en" data-theme="dark" data-accent="bambu-green">',
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

function accentOf(html: string): string | undefined {
  return /<html\b[^>]*\sdata-accent="([^"]*)"/.exec(html)?.[1];
}

/** The twelve accent ids as the web app lists them in src/shell/accent.ts. */
function webAccents(): { ids: string[]; fallback: string | undefined; cookie: string | undefined } {
  const source = readFileSync(new URL("../../../web/src/shell/accent.ts", import.meta.url), "utf8");
  const list = /export const ACCENTS\b[^=]*=\s*\[([\s\S]*?)\]/.exec(source)?.[1] ?? "";
  return {
    ids: [...list.matchAll(/"([^"]*)"/g)].map((m) => m[1] as string),
    fallback: /export const DEFAULT_ACCENT\b[^=]*=\s*"([^"]*)"/.exec(source)?.[1],
    cookie: /export const ACCENT_COOKIE\b[^=]*=\s*"([^"]*)"/.exec(source)?.[1],
  };
}

// Jon, 2026-11-19: the accent colour scheme, a second per-browser choice
// beside the theme. data-accent on the html element comes from the
// ph_accent cookie the same way data-theme comes from ph_theme, so the first
// paint already has the right colour. Anything that is not one of the twelve
// ids is the default, and only a known id is ever written into the page.
describe("the shell renders data-accent from the cookie, with the default for anything else", () => {
  const shell = parseShellTemplate(TEMPLATE);

  test.each([...ACCENTS])("ph_accent=%s renders data-accent %s", (id) => {
    const html = shell.render("light", id);
    expect(accentOf(html)).toBe(id);
    expect(themeOf(html)).toBe("light");
    expect(schemeOf(html)).toBe("light");
  });

  test("no accent cookie renders the default", () => {
    expect(accentOf(shell.render(undefined))).toBe(DEFAULT_ACCENT);
    expect(accentOf(shell.render("system", undefined))).toBe(DEFAULT_ACCENT);
  });

  test.each([
    "",
    "Coral",
    "CORAL",
    " coral",
    "coral ",
    "sepia",
    "green",
    "toString",
    "__proto__",
    'coral" onload="x',
    "coral><script>",
    "coral; Domain=evil.example",
  ])("ph_accent=%j renders the default and is not echoed", (cookie) => {
    const html = shell.render("dark", cookie);
    expect(accentOf(html)).toBe(DEFAULT_ACCENT);
    expect(html.match(/data-accent=/g)).toHaveLength(1);
    // Anything that is not plain lower-case words (markup, cookie syntax,
    // another case) never reaches the page.
    if (/[^a-z-]/.test(cookie)) expect(html).not.toContain(cookie);
  });

  test("changes nothing but data-theme, data-accent and the color-scheme meta", () => {
    const html = shell.render("light", "coral");
    expect(html).toBe(
      TEMPLATE.replace(
        'data-theme="dark" data-accent="bambu-green"',
        'data-theme="light" data-accent="coral"',
      ).replace(
        '<meta name="color-scheme" content="dark" />',
        '<meta name="color-scheme" content="light" />',
      ),
    );
  });

  test("the attribute order in the html element does not matter", () => {
    const template = TEMPLATE.replace(
      '<html lang="en" data-theme="dark" data-accent="bambu-green">',
      '<html data-accent="bambu-green" lang="en" data-theme="dark">',
    );
    const html = parseShellTemplate(template).render("system", "lime");
    expect(html).toContain('<html data-accent="lime" lang="en" data-theme="system">');
  });

  test("any known id in the template is a placeholder: the cookie or the default replaces it", () => {
    const template = TEMPLATE.replace('data-accent="bambu-green"', 'data-accent="coral"');
    const placeholder = parseShellTemplate(template);
    expect(accentOf(placeholder.render(undefined))).toBe(DEFAULT_ACCENT);
    expect(accentOf(placeholder.render(undefined, "amber"))).toBe("amber");
  });

  test("leaves the same words elsewhere in the page alone", () => {
    const template = TEMPLATE.replace(
      '<div id="root"></div>',
      '<div id="root"></div><script>const a = \'data-accent="bambu-green"\';</script>',
    );
    const html = parseShellTemplate(template).render("dark", "coral");
    expect(accentOf(html)).toBe("coral");
    expect(html).toContain("const a = 'data-accent=\"bambu-green\"';");
  });

  test("a template with no data-accent gets one, right after data-theme", () => {
    const template = TEMPLATE.replace(' data-accent="bambu-green"', "");
    const plain = parseShellTemplate(template);
    expect(plain.render("light", "coral")).toBe(
      template
        .replace('data-theme="dark"', 'data-theme="light" data-accent="coral"')
        .replace(
          '<meta name="color-scheme" content="dark" />',
          '<meta name="color-scheme" content="light" />',
        ),
    );
    expect(accentOf(plain.render(undefined))).toBe(DEFAULT_ACCENT);
  });

  test.each([
    [
      "a data-accent that is not a known id",
      TEMPLATE.replace('data-accent="bambu-green"', 'data-accent="sepia"'),
    ],
    [
      "two data-accent attributes",
      TEMPLATE.replace(
        'data-accent="bambu-green"',
        'data-accent="bambu-green" data-accent="coral"',
      ),
    ],
  ])("refuses a template with %s", (_name, template) => {
    expect(() => parseShellTemplate(template)).toThrow(ShellTemplateError);
  });
});

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
    // With no accent cookie the default replaces the template's data-accent,
    // so the template here already carries the default.
    const template = TEMPLATE.replace(
      'data-accent="bambu-green"',
      `data-accent="${DEFAULT_ACCENT}"`,
    );
    const plain = parseShellTemplate(template);
    expect(plain.render("light")).toBe(
      template
        .replace('data-theme="dark"', 'data-theme="light"')
        .replace(
          '<meta name="color-scheme" content="dark" />',
          '<meta name="color-scheme" content="light" />',
        ),
    );
    expect(plain.render(undefined)).toBe(template);
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
    expect(accentOf(shell.render("system", "coral"))).toBe("coral");
    expect(accentOf(shell.render("system"))).toBe(DEFAULT_ACCENT);
  });

  // The server parses the BUILT index.html, not the source one above, and a
  // template it refuses stops buildApp, so the whole server fails to start.
  // A Vite or plugin upgrade, or an HTML transform added later, could rewrite
  // the html element or the color-scheme meta while the source file stays
  // the same. This runs the web app's real vite build (its own vite.config.ts)
  // into a temporary folder and parses what it writes.
  test("accepts the index.html that vite build writes", { timeout: 120_000 }, async () => {
    const web = fileURLToPath(new URL("../../../web/", import.meta.url));
    const out = await mkdtemp(join(tmpdir(), "platehouse-web-build-"));
    try {
      await promisify(execFile)(
        process.execPath,
        [join(web, "node_modules/vite/bin/vite.js"), "build", "--outDir", out, "--emptyOutDir"],
        { cwd: web },
      );
      const built = await readFile(join(out, "index.html"), "utf8");
      // It is the build's output, not a copy of the source: the entry script
      // is now a hashed file under /assets/.
      expect(built).not.toContain("/src/main.tsx");
      expect(built).toMatch(/src="\/assets\/[^"]+\.js"/);
      const shell = parseShellTemplate(built);
      // The build carries no data-accent; render adds it after data-theme
      // and changes nothing else.
      expect(shell.render("dark", "magenta")).toBe(
        built.replace('data-theme="dark"', 'data-theme="dark" data-accent="magenta"'),
      );
      expect(accentOf(shell.render(undefined))).toBe(DEFAULT_ACCENT);
      for (const [cookie, theme, scheme] of [
        ["dark", "dark", "dark"],
        ["light", "light", "light"],
        ["system", "system", "light dark"],
      ]) {
        const html = shell.render(cookie);
        expect(themeOf(html)).toBe(theme);
        expect(schemeOf(html)).toBe(scheme);
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
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

  test("the accent cookie, the twelve ids and the default are the web app's", () => {
    const web = webAccents();
    expect(ACCENT_COOKIE).toBe("ph_accent");
    expect(web.cookie).toBe(ACCENT_COOKIE);
    expect(web.ids).toHaveLength(12);
    expect([...ACCENTS]).toEqual(web.ids);
    expect(web.fallback).toBe(DEFAULT_ACCENT);
  });

  test("the default accent is Blueprint indigo (Jon, 2026-11-19)", () => {
    expect(DEFAULT_ACCENT).toBe("blueprint-indigo");
  });

  test.each([
    ["coral", "coral"],
    ["lime", "lime"],
    [undefined, DEFAULT_ACCENT],
    ["Coral", DEFAULT_ACCENT],
    ["hasOwnProperty", DEFAULT_ACCENT],
  ])("resolveAccent(%s) is %s", (value, id) => {
    expect(resolveAccent(value)).toBe(id);
  });

  test("the shell pages are the sidebar's sections and the model page, each a session-class page", () => {
    // Task 21 adds the trash and settings pages, Task 20 the model page.
    expect([...SHELL_PAGES]).toEqual([
      "/",
      "/creators",
      "/collections",
      "/tags",
      "/trash",
      "/settings",
      "/models/:id",
    ]);
    for (const page of SHELL_PAGES) expect(patternClass(page), page).toBe("session");
  });

  // The web app's own list of sections is SECTIONS in Sidebar.tsx. A section
  // the server does not list works by in-app navigation but is a 404 on a
  // reload or a direct link, so every one of them must be a shell page.
  test("every section in the web app's sidebar is a shell page", () => {
    const sidebar = readFileSync(
      new URL("../../../web/src/shell/Sidebar.tsx", import.meta.url),
      "utf8",
    );
    const list = /export const SECTIONS\b[^=]*=\s*\[([\s\S]*?)\];/.exec(sidebar)?.[1];
    expect(list, "no SECTIONS list in Sidebar.tsx").toBeDefined();
    const paths = [...(list as string).matchAll(/\bto:\s*"([^"]*)"/g)].map((m) => m[1]);
    expect(paths.length, "no paths read from SECTIONS").toBeGreaterThan(0);
    for (const path of paths) expect(SHELL_PAGES, path).toContain(path);
  });
});

describe("registerWeb without a web build", () => {
  const INDEX =
    '<html lang="en" data-theme="dark" data-accent="bambu-green"><meta name="color-scheme" content="dark" />';

  async function withApp(
    run: (args: { dir: string; lines: string[]; app: ReturnType<typeof Fastify> }) => Promise<void>,
  ) {
    const root = await mkdtemp(join(tmpdir(), "platehouse-web-missing-"));
    const lines: string[] = [];
    const app = Fastify({ logger: { level: "info", stream: { write: (l) => lines.push(l) } } });
    try {
      await run({ dir: join(root, "dist"), lines, app });
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  }

  test("logs one warning at startup naming the index.html it looked for", async () => {
    await withApp(async ({ dir, lines, app }) => {
      await registerWeb(app, { dir });
      // @fastify/static adds its own warning that assets/ is missing.
      const warnings = lines
        .map((l) => JSON.parse(l))
        .filter((l) => l.level === 40 && String(l.msg).includes("not built"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0].msg).toContain(join(dir, "index.html"));
    });
  });

  test("logs no warning when the build is there", async () => {
    await withApp(async ({ dir, lines, app }) => {
      await mkdir(join(dir, "assets"), { recursive: true });
      await writeFile(join(dir, "index.html"), INDEX);
      await registerWeb(app, { dir });
      expect(lines.map((l) => JSON.parse(l)).filter((l) => l.level >= 40)).toEqual([]);
    });
  });

  test("built() is false while index.html is missing and true once it is there", async () => {
    await withApp(async ({ dir, app }) => {
      const web = await registerWeb(app, { dir });
      expect(await web.built()).toBe(false);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "index.html"), INDEX);
      expect(await web.built()).toBe(true);
    });
  });

  test("built() is false, not an error, for a build that appears malformed", async () => {
    await withApp(async ({ dir, app }) => {
      const web = await registerWeb(app, { dir });
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "index.html"), "<html><body></body></html>");
      expect(await web.built()).toBe(false);
    });
  });
});
