// Checks over the source that keep the translations whole (the maintainer,
// 2026-11-19): every key the code names is in the English catalog, every
// English key is used somewhere, no message is set as raw HTML, and no
// component shows words that bypass the catalogs.
//
// That last check parses each .tsx (oxc, through Vite's parseSync) and
// flags any text with two letters in a row, other than a name in NAMES:
// - JSX text, wherever it sits: on its own line or inline between tags,
//   with commas, apostrophes or digits;
// - a string or template literal given as a JSX child ({"..."}), including
//   either side of a ?: or an && / ||;
// - the same in a user-facing attribute (USER_FACING), whether written
//   attr="..." or attr={"..."} or attr={`...`}.
// Text built elsewhere and passed in by a variable is not seen; t() and
// rich() are the way words reach a component.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { type ESTree, parseSync, Visitor } from "vite";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WEB_SRC = join(ROOT, "apps/web/src");
const SERVER_SRC = join(ROOT, "apps/server/src");
const EN = JSON.parse(readFileSync(join(ROOT, "packages/i18n/locales/en.json"), "utf8")) as Record<
  string,
  unknown
>;
const KEYS = Object.keys(EN).filter((k) => k !== "$meta");

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path, ext);
    return ext.test(entry.name) ? [path] : [];
  });
}

const webFiles = files(WEB_SRC, /\.(ts|tsx)$/);
const serverFiles = files(SERVER_SRC, /\.ts$/);
const source = new Map([...webFiles, ...serverFiles].map((f) => [f, readFileSync(f, "utf8")]));

describe("the catalog keys", () => {
  it("finds the source it checks", () => {
    expect(webFiles.length).toBeGreaterThan(40);
    expect(KEYS.length).toBeGreaterThan(300);
  });

  it("every key a t() or rich() call names is an English key", () => {
    const unknown: string[] = [];
    for (const [file, text] of source) {
      for (const m of text.matchAll(/\b(?:t|rich)\(\s*"([a-zA-Z0-9_.]+)"/g)) {
        if (!Object.hasOwn(EN, m[1] as string)) unknown.push(`${relative(ROOT, file)}: ${m[1]}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("every English key is named somewhere in the source", () => {
    const all = [...source.values()].join("\n");
    const unused = KEYS.filter((key) => !all.includes(`"${key}"`));
    expect(unused).toEqual([]);
  });
});

describe("the components", () => {
  it("set no raw HTML but the sanitised description", () => {
    const html = webFiles
      .filter((f) => (source.get(f) ?? "").includes("dangerouslySetInnerHTML"))
      .map((f) => relative(WEB_SRC, f));
    expect(html).toEqual(["model/AboutTab.tsx"]);
  });

  // The API reference's body stays English in 0.1.0 (the maintainer's decision 6).
  const SKIP = ["api-docs/"];

  it("show no bare English text in JSX or in a user-facing attribute", () => {
    const found: string[] = [];
    for (const file of webFiles.filter((f) => f.endsWith(".tsx"))) {
      const rel = relative(WEB_SRC, file);
      if (SKIP.some((s) => rel.startsWith(s))) continue;
      found.push(...bareText(rel, source.get(file) ?? ""));
    }
    expect(found).toEqual([]);
  });

  it("the bare text check catches every shape a sentence can take in JSX", () => {
    // Each of these is English a Spanish or French page would show as is.
    const missed = [
      "<p>Could not load the library, try again.</p>",
      "<p>\n  Don't close this tab.\n</p>",
      "<p>Loading the library</p>",
      "<p>Step 3 of 4</p>",
      "<p>{t('a.b')} Saved</p>",
      '<p>{"Nothing here yet"}</p>',
      "<p>{`Nothing here yet`}</p>",
      '<p>{busy ? "Saving" : t("a.b")}</p>',
      '<p>{failed && "It failed"}</p>',
      '<button aria-label={"Close"} />',
      "<input placeholder={`Search models`} />",
      '<img alt="A plate" />',
      '<section aria-description="Your printers" />',
    ].filter((jsx) => bareText("probe.tsx", `const x = ${jsx};`).length !== 1);
    expect(missed).toEqual([]);
  });

  it("the bare text check leaves catalog text, names, markup and single letters alone", () => {
    const flagged = [
      '<p>{t("a.b")}</p>',
      '<p>{rich("a.b", {}, {})}</p>',
      "<span>OrcaSlicer</span>",
      "<p>{t('a.b')} / {t('c.d')}</p>",
      '<span aria-hidden="true">x</span>',
      '<div className="studio-row ph-small" role="alert" />',
      "<input list={`${id}-suggestions`} type=\"text\" />",
      '<button aria-label={t("a.b", { name })} />',
    ].filter((jsx) => bareText("probe.tsx", `const x = ${jsx};`).length !== 0);
    expect(flagged).toEqual([]);
  });
});

// Words that are names, not sentences: they stay as they are in every language.
const NAMES = new Set([
  "Platehouse",
  "OrcaSlicer",
  "OpenSCAD",
  "Bambu Studio",
  "STL",
  "STEP",
  "SCAD",
  "3MF",
]);

/** Attributes a user reads or a screen reader says. */
const USER_FACING = new Set([
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "aria-placeholder",
  "aria-valuetext",
  "title",
  "placeholder",
  "alt",
  "label",
]);

/** Text a user would read as words: two letters in a row. */
const WORDS = /[A-Za-z]{2}/;

/** The literal text an expression shows: a string, a template's fixed parts, either side of ?: or && / ||. */
function literalText(node: ESTree.Node | null | undefined): Array<{ start: number; text: string }> {
  if (node === null || node === undefined) return [];
  switch (node.type) {
    case "Literal":
      return typeof node.value === "string" ? [{ start: node.start, text: node.value }] : [];
    case "TemplateLiteral":
      return node.quasis.map((q) => ({ start: q.start, text: q.value.cooked ?? q.value.raw }));
    case "ConditionalExpression":
      return [...literalText(node.consequent), ...literalText(node.alternate)];
    case "LogicalExpression":
      return [...literalText(node.left), ...literalText(node.right)];
    case "ParenthesizedExpression":
      return literalText(node.expression);
    default:
      return [];
  }
}

/** Every piece of text in file's JSX that does not come from the catalogs, as "file:line: text". */
function bareText(file: string, text: string): string[] {
  const { program, errors } = parseSync(file, text, { lang: "tsx" });
  if (errors.length > 0) throw new Error(`${file} does not parse: ${errors[0]?.message}`);
  const found: string[] = [];
  const flag = (start: number, words: string) => {
    const shown = words.replace(/\s+/g, " ").trim();
    if (!WORDS.test(shown) || NAMES.has(shown)) return;
    found.push(`${file}:${text.slice(0, start).split("\n").length}: ${shown}`);
  };
  const children = (node: ESTree.JSXElement | ESTree.JSXFragment) => {
    for (const child of node.children) {
      if (child.type === "JSXExpressionContainer" && child.expression.type !== "JSXEmptyExpression") {
        for (const piece of literalText(child.expression)) flag(piece.start, piece.text);
      }
    }
  };
  new Visitor({
    JSXText(node) {
      flag(node.start, node.value);
    },
    JSXElement: children,
    JSXFragment: children,
    JSXAttribute(node) {
      if (node.name.type !== "JSXIdentifier" || !USER_FACING.has(node.name.name)) return;
      const value = node.value;
      if (value === null) return;
      if (value.type === "Literal") flag(value.start, String(value.value));
      else if (value.type === "JSXExpressionContainer" && value.expression.type !== "JSXEmptyExpression") {
        for (const piece of literalText(value.expression)) flag(piece.start, piece.text);
      }
    },
  }).visit(program);
  return found;
}
