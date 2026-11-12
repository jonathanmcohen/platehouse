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
//   prefers-color-scheme. The answer is never cached, since it follows the
//   cookie. A page path no task has registered stays a 404.
// - /assets/* serves dist/assets/ with @fastify/static. It is public-class
//   (hashed build output), so the browser fetches the script and stylesheet
//   for the login redirect's return without a session, and each file is
//   cached for a year: its name changes when its bytes do. Nothing outside
//   dist/assets/ is reachable through it, and dotfiles are refused.
//
// index.html is read when the app is built, and again on a page request
// while it is missing, so a server started before the web app was built
// picks the build up. Until then a shell page answers 503 with one fixed
// sentence and no path, and the server starts and answers /healthz as usual.
// A built index.html without the two dark defaults the server rewrites is
// refused (ShellTemplateError) rather than served with the wrong theme.
//
// The cookie name and the color-scheme values are repeated in the web app's
// src/shell/theme.ts, which writes the cookie; a test checks the name.
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const THEMES = ["dark", "light", "system"] as const;

export type Theme = (typeof THEMES)[number];

export const DEFAULT_THEME: Theme = "dark";

/** The cookie the web app's theme switch writes. */
export const THEME_COOKIE = "ph_theme";

/**
 * The paths that answer with the shell: the sidebar's sections. Tasks 19 to
 * 21 add their own pages here (the model page, trash, settings).
 */
export const SHELL_PAGES: readonly string[] = Object.freeze([
  "/",
  "/creators",
  "/collections",
  "/tags",
]);

/** Where the hashed build output is served from (public in the Route classes table). */
export const ASSETS_PREFIX = "/assets/";

/** A hashed asset's Cache-Control: its name changes whenever its bytes do. */
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

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

/** index.html lacks the dark defaults the server rewrites. */
export class ShellTemplateError extends Error {
  override name = "ShellTemplateError";
}

export interface ShellTemplate {
  /** index.html with data-theme and color-scheme for this ph_theme cookie value. */
  render(cookie: string | undefined): string;
}

const HTML_TAG = /<html\b[^>]*>/g;
const THEME_ATTRIBUTE = ' data-theme="dark"';
const COLOR_SCHEME_META = /<meta name="color-scheme" content="dark"(\s*\/?)>/g;

/**
 * Checks index.html once and returns its renderer. The template must hold
 * exactly one html element carrying data-theme="dark" and exactly one
 * color-scheme meta reading dark, the defaults the web app ships; render
 * changes those two places and nothing else.
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

  // The template cut at the two places render writes, in document order.
  const themeAt = htmlTag.index + attributeAt + ' data-theme="'.length;
  const schemeAt = meta.index + '<meta name="color-scheme" content="'.length;
  const cuts = [
    { at: themeAt, value: (theme: Theme) => theme },
    { at: schemeAt, value: colorSchemeFor },
  ].sort((a, b) => a.at - b.at);
  const [first, second] = cuts as [(typeof cuts)[0], (typeof cuts)[0]];
  const head = html.slice(0, first.at);
  const middle = html.slice(first.at + "dark".length, second.at);
  const tail = html.slice(second.at + "dark".length);

  return {
    render(cookie) {
      const theme = resolveTheme(cookie);
      return `${head}${first.value(theme)}${middle}${second.value(theme)}${tail}`;
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
}

/** Registers the shell pages and /assets/ on the root app (after the gate). */
export async function registerWeb(app: FastifyInstance, deps: WebDeps): Promise<void> {
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
  await load();

  async function shell(request: FastifyRequest, reply: FastifyReply) {
    reply.header("cache-control", "no-store");
    const loaded = await load();
    if (loaded === undefined) {
      return reply.code(503).type("text/plain; charset=utf-8").send(NOT_BUILT);
    }
    return reply
      .type("text/html; charset=utf-8")
      .send(loaded.render(request.cookies[THEME_COOKIE]));
  }

  for (const url of SHELL_PAGES) app.get(url, shell);

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
}
