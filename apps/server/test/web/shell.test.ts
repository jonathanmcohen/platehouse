// The server writes the theme into the HTML
// shell, so the right palette applies on the first paint with no script and
// no flash. data-theme on the html element and the color-scheme meta come
// from the ph_theme cookie; Dark is the default and anything that is not
// dark, light or system is dark. Only those two places change.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { installGate, patternClass, routeClass } from "../../src/auth/gate.js";
import {
  ACCENT_COOKIE,
  ACCENTS,
  DEFAULT_ACCENT,
  defaultWebDir,
  NOT_BUILT,
  parseShellTemplate,
  ROOT_FILE_CACHE_CONTROL,
  ROOT_FILES,
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

// The maintainer, 2026-11-19: the accent colour scheme, a second per-browser choice
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
      // public/ is copied to the root of the build, where ROOT_FILES serves it.
      const written = readdirSync(out);
      for (const path of Object.keys(ROOT_FILES)) expect(written, path).toContain(path.slice(1));
      // The app's CSP (web/security-headers.ts, issue #449) allows scripts
      // and styles from its own origin only: the build's module script and
      // stylesheet are same-origin paths under /assets/, and nothing is
      // inline: no script without a src, no style element, no style attribute.
      const scripts = [...built.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
      expect(scripts.length).toBeGreaterThan(0);
      for (const tag of scripts) expect(tag, tag).toMatch(/\ssrc="\/assets\/[^"/][^"]*\.js"/);
      const stylesheets = [...built.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/gi)].map(
        (m) => m[0],
      );
      expect(stylesheets.length).toBeGreaterThan(0);
      for (const tag of stylesheets) {
        expect(tag, tag).toMatch(/\shref="\/assets\/[^"/][^"]*\.css"/);
      }
      expect(built).not.toMatch(/<style\b/i);
      expect(built).not.toMatch(/\sstyle\s*=/i);
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

  test("the default accent is Blueprint indigo (the maintainer, 2026-11-19)", () => {
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
    // The trash and settings pages and the model page follow the sections, and
    // the Activity page (the maintainer, 2026-11-19) comes before Settings.
    expect([...SHELL_PAGES]).toEqual([
      "/",
      "/creators",
      "/collections",
      "/tags",
      "/trash",
      "/activity",
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

describe("registerWeb reads index.html again when it changes", () => {
  const page = (title: string) =>
    `<html lang="en" data-theme="dark" data-accent="bambu-green"><meta name="color-scheme" content="dark" /><title>${title}</title>`;
  const URL = SHELL_PAGES[0] as string;

  async function withBuild(
    run: (args: {
      app: ReturnType<typeof Fastify>;
      web: Awaited<ReturnType<typeof registerWeb>>;
      index: string;
      root: string;
    }) => Promise<void>,
  ) {
    const root = await mkdtemp(join(tmpdir(), "platehouse-web-reread-"));
    const dir = join(root, "dist");
    const index = join(dir, "index.html");
    const app = Fastify();
    try {
      await app.register(fastifyCookie);
      await mkdir(join(dir, "assets"), { recursive: true });
      await writeFile(index, page("v1"));
      const web = await registerWeb(app, { dir });
      await run({ app, web, index, root });
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  }

  const get = (app: ReturnType<typeof Fastify>) => app.inject({ method: "GET", url: URL });

  test("a replaced index.html is served once its modified time moves", async () => {
    await withBuild(async ({ app, index }) => {
      expect((await get(app)).body).toContain("<title>v1</title>");
      await writeFile(index, page("v2"));
      const later = new Date(Date.now() + 10_000);
      await utimes(index, later, later);
      expect((await get(app)).body).toContain("<title>v2</title>");
    });
  });

  test("a rewrite with the same size, inode and modified time keeps the cached page", async () => {
    await withBuild(async ({ app, index }) => {
      // A whole-second time, so restoring it later gives back the same mtimeMs.
      const fixed = new Date(Math.floor(Date.now() / 1000) * 1000);
      await utimes(index, fixed, fixed);
      expect((await get(app)).body).toContain("<title>v1</title>");
      await writeFile(index, page("v2"));
      await utimes(index, fixed, fixed);
      expect((await get(app)).body).toContain("<title>v1</title>");
    });
  });

  test("a malformed replacement fails the request and is read again once fixed", async () => {
    await withBuild(async ({ app, web, index }) => {
      expect((await get(app)).statusCode).toBe(200);
      await writeFile(index, "<html><body></body></html>");
      const bad = new Date(Date.now() + 10_000);
      await utimes(index, bad, bad);
      expect((await get(app)).statusCode).toBe(500);
      expect(await web.built()).toBe(false);
      await writeFile(index, page("v3"));
      // The same modified time as the malformed file: it was not kept.
      await utimes(index, bad, bad);
      const fixed = await get(app);
      expect(fixed.statusCode).toBe(200);
      expect(fixed.body).toContain("<title>v3</title>");
      expect(await web.built()).toBe(true);
    });
  });

  test("a deleted index.html answers 503 NOT_BUILT, not the old page", async () => {
    await withBuild(async ({ app, web, index }) => {
      expect((await get(app)).statusCode).toBe(200);
      await rm(index);
      const response = await get(app);
      expect(response.statusCode).toBe(503);
      expect(response.body).toBe(NOT_BUILT);
      expect(await web.built()).toBe(false);
    });
  });

  test("a replacement by rename (a new inode) with the same size and time is served", async () => {
    await withBuild(async ({ app, index, root }) => {
      const before = new Date(Math.floor(Date.now() / 1000) * 1000);
      await utimes(index, before, before);
      expect((await get(app)).body).toContain("<title>v1</title>");
      const next = join(root, "next.html");
      await writeFile(next, page("v2"));
      await utimes(next, before, before);
      await rename(next, index);
      expect((await get(app)).body).toContain("<title>v2</title>");
    });
  });
});

// The favicons, app icons and web manifest (the logo, the maintainer's icon A). Vite
// copies apps/web/public/ into the root of dist/, and the server answers each
// file at its root path with its own content type. They are not hashed, so
// they are cached for a day, not for a year: a regenerated icon (a new
// accent) reaches browsers by the next day.
describe("the icon files at the root", () => {
  const FILES: Array<[string, string]> = [
    ["/favicon.ico", "image/x-icon"],
    ["/favicon.svg", "image/svg+xml"],
    ["/apple-touch-icon.png", "image/png"],
    ["/icon-192.png", "image/png"],
    ["/icon-512.png", "image/png"],
    ["/icon-maskable-512.png", "image/png"],
    ["/site.webmanifest", "application/manifest+json"],
  ];

  async function withBuild(
    run: (args: { app: ReturnType<typeof Fastify>; dir: string }) => Promise<void>,
  ) {
    const dir = await mkdtemp(join(tmpdir(), "platehouse-web-icons-"));
    const app = Fastify();
    try {
      await mkdir(join(dir, "assets"), { recursive: true });
      await writeFile(
        join(dir, "index.html"),
        '<html lang="en" data-theme="dark"><meta name="color-scheme" content="dark" />',
      );
      for (const [path] of FILES) await writeFile(join(dir, path.slice(1)), `bytes of ${path}`);
      await registerWeb(app, { dir });
      await run({ app, dir });
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("ROOT_FILES lists each file with its content type", () => {
    expect(Object.entries(ROOT_FILES)).toEqual(FILES);
  });

  test.each(FILES)("GET %s answers the file as %s, cached for a day", async (path, type) => {
    await withBuild(async ({ app }) => {
      const response = await app.inject({ method: "GET", url: path });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe(type);
      expect(response.headers["cache-control"]).toBe(ROOT_FILE_CACHE_CONTROL);
      expect(response.body).toBe(`bytes of ${path}`);
    });
  });

  test("HEAD answers the headers without the body", async () => {
    await withBuild(async ({ app }) => {
      const response = await app.inject({ method: "HEAD", url: "/favicon.svg" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("image/svg+xml");
      expect(response.body).toBe("");
    });
  });

  test("a file the build lacks is a 404, and the other files still answer", async () => {
    await withBuild(async ({ app, dir }) => {
      await rm(join(dir, "favicon.ico"));
      expect((await app.inject({ method: "GET", url: "/favicon.ico" })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/favicon.svg" })).statusCode).toBe(200);
    });
  });

  // Public in the Route classes table (the maintainer, 2026-11-19, decision A-1), so
  // the browser loads them without a session: on the auth pages, before the
  // login redirect returns, and for the manifest, which browsers fetch
  // without cookies.
  test.each(FILES)("%s is public-class, as a route and as a raw path", (path) => {
    expect(patternClass(path)).toBe("public");
    expect(routeClass(path)).toBe("public");
  });

  test.each([
    "/favicon.ico/",
    "/favicon.ico/x",
    "/favicon.icox",
    "/Favicon.ico",
    "/icon-1024.png",
    "/x/favicon.svg",
    "/favicon.%69co",
  ])("%s, a near miss, stays session-class", (path) => {
    expect(patternClass(path)).toBe("session");
    expect(routeClass(path)).toBe("session");
  });

  test("with the gate installed, a signed-out browser gets each file; a page still needs a session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "platehouse-web-icons-gate-"));
    const app = Fastify();
    try {
      await mkdir(join(dir, "assets"), { recursive: true });
      await writeFile(
        join(dir, "index.html"),
        '<html lang="en" data-theme="dark"><meta name="color-scheme" content="dark" />',
      );
      for (const [path] of FILES) await writeFile(join(dir, path.slice(1)), `bytes of ${path}`);
      await app.register(fastifyCookie);
      installGate(app, {
        sessions: {
          start: async () => {
            throw new Error("not used");
          },
          find: async () => undefined,
          end: async () => {},
          signOutEverywhere: async () => ({
            sessionsEnded: 0,
            tokensRevoked: 0,
            unknownTokensRevoked: 0,
          }),
        },
        publicOrigin: "https://platehouse.test",
        absoluteUrl: (path) => `https://platehouse.test${path}`,
      });
      await registerWeb(app, { dir });
      for (const [path, type] of FILES) {
        const response = await app.inject({
          method: "GET",
          url: path,
          headers: { accept: "image/avif,image/webp,*/*" },
        });
        expect(response.statusCode, path).toBe(200);
        expect(response.headers["content-type"], path).toBe(type);
      }
      // The control: the same gate sends a signed-out page request to the login.
      const page = await app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } });
      expect(page.statusCode).toBe(302);
      expect(page.headers.location).toBe("https://platehouse.test/auth/login");
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the cache lifetime is a day, public", () => {
    expect(ROOT_FILE_CACHE_CONTROL).toBe("public, max-age=86400");
  });

  // Every file Vite copies to the root of dist/ must be answered, or the
  // browser's request for it is a 404; and every file the server lists must
  // be in public/, or it always is.
  test("ROOT_FILES is exactly the web app's public/ folder", () => {
    const listed = readdirSync(new URL("../../../web/public/", import.meta.url)).filter(
      (name) => !name.startsWith("."),
    );
    expect(listed.sort()).toEqual(
      Object.keys(ROOT_FILES)
        .map((path) => path.slice(1))
        .sort(),
    );
  });

  // The app image builds the web app from its own context, not this
  // checkout: without public/ in that context and copied into the build
  // stage, vite build writes none of these files and every one answers 404
  // in production, while the tests above still pass. Docker is not run
  // here; these read the image's build files, and docker/test-app-image.sh
  // requests each file from the running image in CI.
  test("the app image copies public/ into its build and checks every file it ships", () => {
    const root = new URL("../../../../docker/", import.meta.url);
    const lines = (name: string) =>
      readFileSync(new URL(name, root), "utf8")
        .split("\n")
        .map((line) => line.trim());
    const ignore = lines("app.Dockerfile.dockerignore");
    expect(ignore).toContain("!apps/web/public");
    const dockerfile = readFileSync(new URL("app.Dockerfile", root), "utf8");
    // The runtime stage is the last FROM.
    const runtimeAt = dockerfile.lastIndexOf("\nFROM ");
    expect(runtimeAt).toBeGreaterThan(-1);
    const build = dockerfile.slice(0, runtimeAt);
    const runtime = dockerfile.slice(runtimeAt);
    expect(build).toContain("\nCOPY apps/web/public apps/web/public\n");
    // The web app's sources go after the build, public/ with them.
    expect(build).toMatch(/\n {6}apps\/web\/src [^\n]*apps\/web\/public[^\n]*\n/);
    const script = readFileSync(new URL("test-app-image.sh", root), "utf8");
    for (const path of Object.keys(ROOT_FILES)) {
      expect(build, path).toContain(` test -f apps/web/dist${path}`);
      expect(runtime, path).toContain(` test -r /app/apps/web/dist${path}`);
    }
    // The running image is asked for exactly these files.
    const requested = /\nroot_files=\(\n((?: +\S+\n)+)\)\n/.exec(script)?.[1];
    expect(requested, "a root_files=( ... ) list, one path per line").toBeDefined();
    expect(requested?.trim().split(/\s+/).sort()).toEqual(Object.keys(ROOT_FILES).sort());
  });
});
