// The web shell (build plan Task 18, AC-070; the Route classes contract).
//
// The web app (apps/web) is a Vite single-page app; vite build writes
// index.html and its hashed files under assets/ into apps/web/dist. This
// module serves that build:
//
// - The shell pages (SHELL_PAGES, the sidebar's sections) answer GET and
//   HEAD with index.html. They are session-class, so the route-class gate
//   (auth/gate.ts) sends a page request without a session to /auth/login
//   before this handler runs. The theme reaches the first paint with no
//   script: the html element's data-theme and the color-scheme meta are
//   written in from the ph_theme cookie (dark, light or system; anything
//   else is dark, the default). System resolves in CSS with
//   prefers-color-scheme. The accent colour scheme (Jon, 2026-11-19) is
//   written the same way: the html element's data-accent comes from the
//   ph_accent cookie (one of the twelve ACCENTS; anything else is
//   DEFAULT_ACCENT), so the right colour is on the first paint too. The
//   answer is never cached, since it follows the cookies. A page path no
//   task has registered stays a 404. The language (Jon, 2026-11-19) is
//   written the same way: the html element's lang is the language the page
//   is shown in, from the ph_lang cookie, else the browser's
//   Accept-Language, else English (locales/locales.ts resolve), so the web
//   app loads that language's messages before its first render.
// - /assets/* serves dist/assets/ with @fastify/static. It is public-class
//   (hashed build output), so the browser fetches the script and stylesheet
//   for the login redirect's return without a session, and each file is
//   cached for a year: its name changes when its bytes do. Nothing outside
//   dist/assets/ is reachable through it, and dotfiles are refused.
// - The favicons, app icons and web manifest (ROOT_FILES) are answered at
//   their root paths from the root of dist/, where Vite copies
//   apps/web/public/, each with its own content type and cached for a day,
//   since their names do not change when they are regenerated. They are
//   public-class at exactly these paths (auth/gate.ts, Jon's decision A-1):
//   a signed-out browser loads them on the auth pages, and the manifest,
//   which browsers fetch without cookies, loads with no session.
//
// index.html is read when the app is built, and again on a page request
// while it is missing, so a server started before the web app was built
// picks the build up. Until then a shell page answers 503 with one fixed
// sentence and no path, and the server logs one warning at startup naming
// the index.html it looked for. The server still starts, and /healthz
// answers as Task 30 defines it unless WebDeps.required is set: then
// app.ts also needs built(), so /healthz is 503 while the build is missing
// and a health check sees what every page shows.
// A built index.html without the two dark defaults the server rewrites is
// refused (ShellTemplateError) rather than served with the wrong theme.
//
// The cookie name and the color-scheme values are repeated in the web app's
// src/shell/theme.ts, which writes the cookie; a test checks the name. The
// accent ids, default and cookie name are repeated in src/shell/accent.ts;
// a test checks those too.
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import { canonicalLocale, LANG_COOKIE, SOURCE_LOCALE } from "@platehouse/i18n";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Locales } from "../locales/locales.js";

export const THEMES = ["dark", "light", "system"] as const;

export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = "dark";

/** The cookie the web app's theme switch writes. */
export const THEME_COOKIE = "ph_theme";

/**
 * The paths that answer with the shell: the sidebar's sections. Tasks 19 to
 * 21 add their own pages here (the model page, trash, settings). A test
 * checks every SECTIONS path in the web app's Sidebar.tsx is listed here.
 * /models/:id is the model page (Task 20): any id answers with the shell,
 * and the page itself asks the model's app API, which says 404 for a model
 * that is not in the library.
 */
export const SHELL_PAGES: readonly string[] = Object.freeze([
  "/",
  "/creators",
  "/collections",
  "/tags",
  "/trash",
  "/activity",
  "/settings",
  "/models/:id",
]);

/** Where the hashed build output is served from (public in the Route classes table). */
export const ASSETS_PREFIX = "/assets/";

/** A hashed asset's Cache-Control: its name changes whenever its bytes do. */
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * The favicons, app icons and web manifest, each with its content type.
 * Vite copies apps/web/public/ into the root of the build, and each file is
 * answered at its root path. A test checks this is exactly public/'s list.
 */
export const ROOT_FILES: Readonly<Record<string, string>> = Object.freeze({
  "/favicon.ico": "image/x-icon",
  "/favicon.svg": "image/svg+xml",
  "/apple-touch-icon.png": "image/png",
  "/icon-192.png": "image/png",
  "/icon-512.png": "image/png",
  "/icon-maskable-512.png": "image/png",
  "/site.webmanifest": "application/manifest+json",
});

/**
 * A root file's Cache-Control. Its name stays the same when it is
 * regenerated (a new accent), so it is cached for a day, not for a year.
 */
export const ROOT_FILE_CACHE_CONTROL = "public, max-age=86400";

/** What a shell page says while the web app is not built. */
export const NOT_BUILT = "The Platehouse web app is not built.";

/** One of THEMES; DEFAULT_THEME for anything else, a wrong case included. */
export function resolveTheme(value: unknown): Theme {
  return (THEMES as readonly unknown[]).includes(value) ? (value as Theme) : DEFAULT_THEME;
}

/** The color-scheme meta's content for a theme. */
export function colorSchemeFor(theme: Theme): "dark" | "light" | "light dark" {
  if (theme === "dark") return "dark";
  if (theme === "light") return "light";
  return "light dark";
}

/**
 * The accent colour schemes (Jon, 2026-11-19), in the order the picker shows
 * them. The ids, the default and the cookie name are the web app's
 * (src/shell/accent.ts); a test checks they match.
 */
export const ACCENTS = [
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
] as const;

export type Accent = (typeof ACCENTS)[number];

/** The scheme a browser with no choice gets; keep it the web app's DEFAULT_ACCENT. */
export const DEFAULT_ACCENT: Accent = "blueprint-indigo";

/** The cookie the web app's accent picker writes. */
export const ACCENT_COOKIE = "ph_accent";

/** One of ACCENTS; DEFAULT_ACCENT for anything else, a wrong case included. */
export function resolveAccent(value: unknown): Accent {
  return (ACCENTS as readonly unknown[]).includes(value) ? (value as Accent) : DEFAULT_ACCENT;
}

/** index.html lacks the dark defaults the server rewrites. */
export class ShellTemplateError extends Error {
  override name = "ShellTemplateError";
}

export interface ShellTemplate {
  /**
   * index.html with data-theme and color-scheme for this ph_theme cookie
   * value, and data-accent for this ph_accent cookie value.
   */
  render(
    themeCookie: string | undefined,
    accentCookie?: string | undefined,
    lang?: string | undefined,
  ): string;
}

const HTML_TAG = /<html\b[^>]*>/g;
const THEME_ATTRIBUTE = ' data-theme="dark"';
const ACCENT_ATTRIBUTE = /\sdata-accent="([^"]*)"/g;
const LANG_ATTRIBUTE = /\slang="([^"]*)"/g;
const COLOR_SCHEME_META = /<meta name="color-scheme" content="dark"(\s*\/?)>/g;

/** One place render writes: length characters of the template at `at` become value. */
interface Cut {
  at: number;
  length: number;
  value(theme: Theme, accent: Accent, lang: string): string;
}

/**
 * Checks index.html once and returns its renderer. The template must hold
 * exactly one html element carrying data-theme="dark" and exactly one
 * color-scheme meta reading dark, the defaults the web app ships. The html
 * element may carry one data-accent naming a known scheme, a placeholder
 * render replaces; without one, render adds data-accent right after
 * data-theme. render changes those places and nothing else.
 */
export function parseShellTemplate(html: string): ShellTemplate {
  const htmlTags = [...html.matchAll(HTML_TAG)];
  if (htmlTags.length !== 1) {
    throw new ShellTemplateError(`index.html has ${htmlTags.length} html elements, not 1`);
  }
  const htmlTag = htmlTags[0] as RegExpExecArray;
  const attributeAt = htmlTag[0].indexOf(THEME_ATTRIBUTE);
  if (attributeAt === -1 || htmlTag[0].indexOf(THEME_ATTRIBUTE, attributeAt + 1) !== -1) {
    throw new ShellTemplateError(
      'index.html\'s html element does not carry data-theme="dark" once',
    );
  }
  const metas = [...html.matchAll(COLOR_SCHEME_META)];
  if (metas.length !== 1) {
    throw new ShellTemplateError(`index.html has ${metas.length} dark color-scheme metas, not 1`);
  }
  const meta = metas[0] as RegExpExecArray;

  const themeAt = htmlTag.index + attributeAt + ' data-theme="'.length;
  const schemeAt = meta.index + '<meta name="color-scheme" content="'.length;
  const cuts: Cut[] = [
    { at: themeAt, length: "dark".length, value: (theme) => theme },
    { at: schemeAt, length: "dark".length, value: (theme) => colorSchemeFor(theme) },
  ];

  const accentMentions = htmlTag[0].split("data-accent").length - 1;
  const accents = [...htmlTag[0].matchAll(ACCENT_ATTRIBUTE)];
  if (accentMentions === 0) {
    // No placeholder: add the attribute just after data-theme's closing quote.
    cuts.push({
      at: themeAt + "dark".length + 1,
      length: 0,
      value: (_theme, accent) => ` data-accent="${accent}"`,
    });
  } else {
    const placeholder = accents[0];
    if (accentMentions !== 1 || accents.length !== 1 || placeholder === undefined) {
      throw new ShellTemplateError("index.html's html element carries more than one data-accent");
    }
    const value = placeholder[1] as string;
    if (!(ACCENTS as readonly string[]).includes(value)) {
      throw new ShellTemplateError("index.html's data-accent is not a known accent scheme");
    }
    cuts.push({
      at: htmlTag.index + placeholder.index + ' data-accent="'.length,
      length: value.length,
      value: (_theme, accent) => accent,
    });
  }

  // The language: the html element's lang, replaced; added after <html when
  // the template has none.
  const langs = [...htmlTag[0].matchAll(LANG_ATTRIBUTE)];
  if (langs.length > 1)
    throw new ShellTemplateError("index.html's html element carries more than one lang");
  const langPlaceholder = langs[0];
  if (langPlaceholder === undefined) {
    cuts.push({
      at: htmlTag.index + "<html".length,
      length: 0,
      value: (_t, _a, lang) => ` lang="${lang}"`,
    });
  } else {
    cuts.push({
      at: htmlTag.index + langPlaceholder.index + ' lang="'.length,
      length: (langPlaceholder[1] as string).length,
      value: (_t, _a, lang) => lang,
    });
  }

  // The template cut at the places render writes, in document order.
  cuts.sort((a, b) => a.at - b.at);
  const pieces: string[] = [];
  let from = 0;
  for (const cut of cuts) {
    pieces.push(html.slice(from, cut.at));
    from = cut.at + cut.length;
  }
  pieces.push(html.slice(from));

  return {
    render(themeCookie, accentCookie, lang) {
      const theme = resolveTheme(themeCookie);
      const accent = resolveAccent(accentCookie);
      // Only a canonical locale code reaches the page (letters, digits, hyphens).
      const shown = (lang === undefined ? undefined : canonicalLocale(lang)) ?? SOURCE_LOCALE;
      let out = pieces[0] as string;
      cuts.forEach((cut, i) => {
        out += cut.value(theme, accent, shown) + (pieces[i + 1] as string);
      });
      return out;
    },
  };
}

/**
 * The web app's build folder when nothing else is given: apps/web/dist
 * beside the server package, whether the server runs from its TypeScript
 * source (apps/server/src/web) or from its build (apps/server/dist/src/web).
 */
export function defaultWebDir(moduleUrl: string = import.meta.url): string {
  const here = dirname(fileURLToPath(moduleUrl));
  const src = resolve(here, "..");
  const serverRoot =
    basename(resolve(src, "..")) === "dist" ? resolve(src, "../..") : resolve(src, "..");
  return resolve(serverRoot, "../web/dist");
}

export interface WebDeps {
  /** The web app's build folder: index.html and assets/. */
  dir: string;
  /**
   * The server is not healthy without the build: /healthz answers 503 while
   * index.html is missing. Left out, a missing build fails only the shell
   * pages, so a server or test without a web build still reports healthy.
   */
  required?: boolean;
}

export interface WebShell {
  /** Whether a usable index.html is there now; it is read again while missing. */
  built(): Promise<boolean>;
}

/** Registers the shell pages and /assets/ on the root app (after the gate). */
export async function registerWeb(
  app: FastifyInstance,
  deps: WebDeps,
  locales?: Pick<Locales, "resolve">,
): Promise<WebShell> {
  const indexPath = join(deps.dir, "index.html");
  let template: ShellTemplate | undefined;

  async function load(): Promise<ShellTemplate | undefined> {
    if (template !== undefined) return template;
    let html: string;
    try {
      html = await readFile(indexPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    template = parseShellTemplate(html);
    return template;
  }

  // A build that is there but malformed fails buildApp, not a page request.
  if ((await load()) === undefined) {
    app.log.warn(
      `The web app is not built: there is no ${indexPath}, so every shell page answers 503 until it is there.`,
    );
  }

  async function shell(request: FastifyRequest, reply: FastifyReply) {
    reply.header("cache-control", "no-store");
    const loaded = await load();
    if (loaded === undefined) {
      return reply.code(503).type("text/plain; charset=utf-8").send(NOT_BUILT);
    }
    return reply
      .type("text/html; charset=utf-8")
      .send(
        loaded.render(
          request.cookies[THEME_COOKIE],
          request.cookies[ACCENT_COOKIE],
          locales === undefined
            ? SOURCE_LOCALE
            : await locales
                .resolve(request.cookies[LANG_COOKIE], request.headers["accept-language"])
                .catch(() => SOURCE_LOCALE),
        ),
      );
  }

  for (const url of SHELL_PAGES) app.get(url, shell);

  // Read on each request, so a rebuilt icon is served without a restart; a
  // file the build lacks is a plain 404.
  for (const [url, type] of Object.entries(ROOT_FILES)) {
    const path = join(deps.dir, url.slice(1));
    app.get(url, async (_request, reply) => {
      let body: Buffer;
      try {
        body = await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return reply.callNotFound();
        throw error;
      }
      return reply.header("cache-control", ROOT_FILE_CACHE_CONTROL).type(type).send(body);
    });
  }

  await app.register(fastifyStatic, {
    root: join(deps.dir, "assets"),
    prefix: ASSETS_PREFIX,
    decorateReply: false,
    index: false,
    list: false,
    dotfiles: "deny",
    cacheControl: false,
    setHeaders(reply) {
      reply.header("cache-control", ASSET_CACHE_CONTROL);
    },
  });

  return {
    async built() {
      try {
        return (await load()) !== undefined;
      } catch {
        // A build replaced by a malformed one, or an unreadable file: the
        // health check says unavailable rather than failing with the error.
        return false;
      }
    },
  };
}
