// The built-in catalogs, read from disk (Node only; the web app imports the
// JSON files through its bundler). A built-in language is any <code>.json in
// the package's locales folder, so a contributor adds a language by adding
// its file (docs/translations/contributing.md), with no list to edit.
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalLocale } from "./negotiate.js";

/**
 * The package's locales folder, whether this module runs from its
 * TypeScript source (packages/i18n/src) or its build
 * (packages/i18n/dist/src).
 */
export function builtinLocalesDir(moduleUrl: string = import.meta.url): string {
  const here = dirname(fileURLToPath(moduleUrl));
  const pkg = basename(resolve(here, "..")) === "dist" ? resolve(here, "../..") : resolve(here, "..");
  return join(pkg, "locales");
}

/** The code a catalog file is named for (es for es.json), or undefined for any other name. */
export function localeOfFileName(name: string): string | undefined {
  if (!name.endsWith(".json")) return undefined;
  const code = name.slice(0, -".json".length);
  const canonical = canonicalLocale(code);
  return canonical === code ? canonical : undefined;
}

/** Every built-in catalog, parsed, by locale code; English is always there. */
export function readBuiltinCatalogs(dir: string = builtinLocalesDir()): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const name of readdirSync(dir).sort()) {
    const code = localeOfFileName(name);
    if (code === undefined) continue;
    out.set(code, JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown);
  }
  if (!out.has("en")) throw new Error(`there is no en.json in ${dir}`);
  return out;
}
