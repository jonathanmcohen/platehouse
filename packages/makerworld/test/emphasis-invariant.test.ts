// @vitest-environment jsdom
/// <reference lib="dom" />
import { describe, expect, it } from "vitest";
import { createMarkdownIt, htmlToMarkdown } from "../src/markdown.js";

// What bold and italic the converter must keep (0.1.0 release review of PR
// #334, issues #346, #348 and #352). The review rounds kept finding inputs
// whose emphasis markdown-it paired differently from the HTML: one emphasis's
// close with the next one's open (round 1), and an italic nested in an italic
// rendered as bold (#352). Each fix checked one level deeper than the last.
// This file checks the property itself, character by character:
//
// - intended: the formatting the HTML gives each visible character, read
//   through the DOM (jsdom), so an element inside one of its own kind adds
//   nothing (<i><i>x</i></i> is italic), and misnested tags read as a browser
//   reads them.
// - rendered: the formatting markdown-it gives each visible character of the
//   converter's markdown, read from its tokens, with the setup
//   renderMarkdown uses.
//
// Then, for every input:
//   (a) no character is rendered bold or italic unless the HTML made it so:
//       emphasis is never added and never changes kind;
//   (b) the visible text is the HTML's text, so no mark the converter wrote
//       ever shows as an asterisk;
//   (c) no intended emphasis is lost wherever markdown-it can show the whole
//       input as written. Elsewhere losing some is allowed, and counted.
// Whitespace carries no visible formatting, so only other characters count.

const md = createMarkdownIt();

interface Char {
  c: string;
  bold: boolean;
  italic: boolean;
}

const SPACE = /\s/u;

/** Each visible character of the HTML with the formatting the DOM gives it. */
function intended(html: string): Char[] {
  const root = document.createElement("div");
  root.innerHTML = html;
  const out: Char[] = [];
  const walk = (node: Node, bold: boolean, italic: boolean): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      for (const c of node.textContent ?? "") if (!SPACE.test(c)) out.push({ c, bold, italic });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = (node as Element).tagName.toLowerCase();
    const b = bold || tag === "b" || tag === "strong";
    const i = italic || tag === "i" || tag === "em";
    for (const child of Array.from(node.childNodes)) walk(child, b, i);
  };
  walk(root, false, false);
  return out;
}

/** Each visible character markdown-it renders, with its formatting. */
function rendered(markdown: string): Char[] {
  const out: Char[] = [];
  for (const block of md.parse(markdown, {})) {
    let strong = 0;
    let em = 0;
    for (const t of block.children ?? []) {
      if (t.type === "strong_open") strong++;
      else if (t.type === "strong_close") strong--;
      else if (t.type === "em_open") em++;
      else if (t.type === "em_close") em--;
      else if (t.type === "text" || t.type === "code_inline") {
        for (const c of t.content) {
          if (!SPACE.test(c)) out.push({ c, bold: strong > 0, italic: em > 0 });
        }
      }
    }
  }
  return out;
}

interface Verdict {
  /** (b): the rendered text is the HTML's text. */
  textOk: boolean;
  /** (a): characters rendered with emphasis the HTML did not give them. */
  added: number;
  /** (c): characters that lost emphasis the HTML gave them. */
  lost: number;
}

function judge(want: Char[], got: Char[]): Verdict {
  const textOk = want.map((x) => x.c).join("") === got.map((x) => x.c).join("");
  let added = 0;
  let lost = 0;
  if (textOk) {
    want.forEach((w, k) => {
      const g = got[k] as Char;
      if ((g.bold && !w.bold) || (g.italic && !w.italic)) added++;
      if ((w.bold && !g.bold) || (w.italic && !g.italic)) lost++;
    });
  }
  return { textOk, added, lost };
}

// A witness that markdown-it can show an input exactly as written: the plain
// markdown for it, each run of same-formatted text wrapped in its marks
// (longest-running kind outermost, whitespace taking the formatting both its
// neighbours share). When this renders with nothing added or lost and the
// text intact, the input is one where (c) must hold in full.
const esc = (s: string): string => s.replace(/\s+/g, " ").replace(/[\\`*_[\]~|<>!&]/g, "\\$&");

function witness(html: string): string {
  const root = document.createElement("div");
  root.innerHTML = html;
  const chars: Array<{ c: string; f: number }> = []; // f: 1 bold, 2 italic
  const walk = (node: Node, f: number): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      for (const c of node.textContent ?? "") chars.push({ c, f });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = (node as Element).tagName.toLowerCase();
    const add = tag === "b" || tag === "strong" ? 1 : tag === "i" || tag === "em" ? 2 : 0;
    for (const child of Array.from(node.childNodes)) walk(child, f | add);
  };
  walk(root, 0);
  for (let k = 0; k < chars.length; k++) {
    const x = chars[k] as { c: string; f: number };
    if (!SPACE.test(x.c)) continue;
    let before = 0;
    let after = 0;
    for (let j = k - 1; j >= 0; j--) {
      if (!SPACE.test((chars[j] as { c: string }).c)) {
        before = (chars[j] as { f: number }).f;
        break;
      }
    }
    for (let j = k + 1; j < chars.length; j++) {
      if (!SPACE.test((chars[j] as { c: string }).c)) {
        after = (chars[j] as { f: number }).f;
        break;
      }
    }
    x.f = before & after;
  }
  const runs: Array<{ text: string; f: number }> = [];
  for (const x of chars) {
    const last = runs.at(-1);
    if (last !== undefined && last.f === x.f) last.text += x.c;
    else runs.push({ text: x.c, f: x.f });
  }
  const extent = (r: number, bit: number): number => {
    let n = 0;
    while (r + n < runs.length && ((runs[r + n] as { f: number }).f & bit) !== 0) n++;
    return n;
  };
  const mark = (bit: number) => (bit === 1 ? "**" : "*");
  let out = "";
  const stack: number[] = [];
  runs.forEach((run, r) => {
    const low = stack.findIndex((bit) => (run.f & bit) === 0);
    if (low !== -1) for (const bit of stack.splice(low).reverse()) out += mark(bit);
    const open = [1, 2]
      .filter((bit) => (run.f & bit) !== 0 && !stack.includes(bit))
      .sort((p, q) => extent(r, q) - extent(r, p));
    for (const bit of open) {
      out += mark(bit);
      stack.push(bit);
    }
    out += esc(run.text);
  });
  for (const bit of stack.reverse()) out += mark(bit);
  return out.trim();
}

interface Check extends Verdict {
  markdown: string;
  showable: boolean;
}

function check(html: string): Check {
  const want = intended(html);
  const markdown = htmlToMarkdown(html);
  const verdict = judge(want, rendered(markdown));
  const w = judge(want, rendered(witness(html)));
  return { ...verdict, markdown, showable: w.textOk && w.added === 0 && w.lost === 0 };
}

/** What is wrong with the converter's output for html, or null. */
function problem(html: string): string | null {
  const r = check(html);
  const shown = `${html} -> ${JSON.stringify(r.markdown)}`;
  if (!r.textOk) return `${shown}: shows other text (a mark as an asterisk?)`;
  if (r.added > 0) return `${shown}: ${r.added} character(s) get emphasis the HTML did not give`;
  if (r.showable && r.lost > 0) {
    return `${shown}: loses emphasis on ${r.lost} character(s) markdown-it can show`;
  }
  return null;
}

describe("the oracle", () => {
  // A check that cannot fail is not a check: each known-bad markdown below
  // must be caught.
  it("catches emphasis that changes kind, lands on the wrong text, or shows asterisks", () => {
    const of = (html: string, markdown: string) => judge(intended(html), rendered(markdown));
    expect(of("<p><i><i>x</i></i></p>", "**x**").added).toBe(1);
    expect(of("<p><b>Note:</b>Use<b>.x</b></p>", "**Note:**Use**.x**").added).toBe(3);
    expect(of("<p><b>Note:</b>Use</p>", "**Note:**Use").textOk).toBe(false);
    expect(of("<p><b>a</b> b</p>", "a b").lost).toBe(1);
    expect(of("<p><b>a</b> b</p>", "**a** b")).toEqual({ textOk: true, added: 0, lost: 0 });
  });

  it("reads intended formatting as a browser does", () => {
    const f = (html: string) =>
      intended(html).map((x) => `${x.c}${x.bold ? "B" : ""}${x.italic ? "I" : ""}`);
    expect(f("<p><i><i>x</i></i></p>")).toEqual(["xI"]);
    expect(f("<p><em><i><b>x</b></i></em></p>")).toEqual(["xBI"]);
    expect(f("<p>a<b>b<i>c</b>d</i></p>")).toEqual(["a", "bB", "cBI", "dI"]);
  });

  it("finds a witness only where markdown-it can show everything as written", () => {
    expect(check("<p>a <b>b</b> c</p>").showable).toBe(true);
    expect(check("<p><b>Note:</b>Use</p>").showable).toBe(false);
  });
});

// Every example the review rounds raised, by name.
const NAMED: Array<[string, string]> = [
  ["punctuation before a letter (base review)", "<p><b>Note:</b>Use M3 screws</p>"],
  ["punctuation after a letter (base review)", "<p>Size<b>(mm)</b></p>"],
  ["escaped punctuation beside the marks", "<p>Wow<b>!</b>great</p>"],
  ["escaped bracket beside the marks", "<p>see<i>[1]</i>here</p>"],
  ["Unicode punctuation", "<p><b>Hinweis\u2026</b>Text</p>"],
  ["a symbol", "<p><b>5\u20ac</b>each</p>"],
  ["guillemets", "<p>Gr\u00f6\u00dfe<i>\u00bbS\u00ab</i></p>"],
  ["italic straight after bold", "<p><b>Note:</b><i>Use</i> it</p>"],
  ["link straight after bold", '<p><b>Note:</b><a href="https://example.com/x">Use</a></p>'],
  ["nested, closing at one place", "<p><b><i>Note:</i></b>Use</p>"],
  ["nested, opening at one place", "<p>Size<b><i>(mm)</i></b></p>"],
  ["italic at both edges of bold (round 1)", "<p>foo<b><i>bar</i></b>baz</p>"],
  ["italic at the end of bold (round 1)", "<p><b>bar<i>x</i></b>baz</p>"],
  ["italic at the start of bold (round 1)", "<p>a<b><i>x</i>y</b>c</p>"],
  ["italic at the end of bold, letters outside", "<p>a<b>y<i>x</i></b>c</p>"],
  ["nested at both edges, spaced", "<p>Size <b><i>(mm)</i></b>.</p>"],
  ["bold holding two italics (#348)", "<p><b>a<i>PLA</i>b<i>PETG</i></b>c</p>"],
  ["bold holding two italics at its edge (#348)", "<p>foo<b><i>a</i> and <i>b</i></b></p>"],
  ["bold holding three italics (#348)", "<p><b>a<i>PLA</i>b<i>PETG</i>c<i>TPU</i></b>d</p>"],
  ["bold holding three spaced italics", "<p>x<b><i>PLA</i> or <i>PETG</i> or <i>TPU</i></b>y</p>"],
  ["two italics back to back in bold", "<p><b><i>PLA</i><i>PETG</i></b>x</p>"],
  ["CJK bold", "<p>\u6750\u6599<b>\u63a8\u8350</b>\u6253\u5370</p>"],
  [
    "CJK bold holding italics",
    "<p>\u6750\u6599<b>\u63a8\u8350<i>PLA</i>\u6216<i>PETG</i></b>\u6253\u5370</p>",
  ],
  [
    "CJK bold holding three italics",
    "<p>\u6750\u6599<b>\u63a8\u8350<i>PLA</i>\u3001<i>PETG</i>\u6216<i>TPU</i></b>\u6253\u5370</p>",
  ],
  ["CJK punctuation alone", "<p>\u6ce8\u610f<b>\uff1a</b>\u4f7f\u7528</p>"],
  ["CJK punctuation at the end", "<p>\u6ce8\u610f<b>\u4f7f\u7528\uff1a</b>\u87ba\u4e1d</p>"],
  ["bold in bold (#346)", "<p><b>Size<b>x</b></b></p>"],
  ["italic in italic at the end (#346)", "<p><i>y<i>x</i></i></p>"],
  ["bold then italic, back to back", "<p><b>a</b><i>b</i></p>"],
  ["italic then bold, back to back", "<p><i>a</i><b>b</b></p>"],
  ["bold then bold, back to back", "<p><b>a</b><b>b</b></p>"],
  ["italic then italic, back to back", "<p><i>a</i><i>b</i></p>"],
  ["an asterisk in a link address", '<p><a href="https://example.com/a*b">x</a> <b>y</b>z</p>'],
  ["bold kept before a space", "<p><b>Note:</b> Use</p>"],
  ["bold kept before a comma", "<p><b>Note:</b>, then</p>"],
  ["bold kept at the end", "<p><b>Note:</b></p>"],
  ["bold kept in parentheses", "<p>(<b>mm</b>)</p>"],
  ["bold kept inside a word", "<p>a<b>b</b>c</p>"],
  ["bold kept after a space", "<p>Size <b>(mm)</b></p>"],
  ["bold kept before a full stop", "<p>Size<b>mm</b>.</p>"],
  ["italic kept before a space", "<p><i>e.g.</i> this</p>"],
  ["bold kept before a line break", "<p>x <b>Note:</b><br>Use</p>"],
  ["two bolds paired across each other (round 1)", "<p><b>Note:</b>Use<b>.x</b></p>"],
  [
    "two CJK bolds paired across each other (round 1)",
    "<p><b>\u6ce8\u610f\uff1a</b>\u4f7f\u7528<b>\u300cPLA\u300d</b></p>",
  ],
  ["bold in bold, then bold back to back (round 1)", "<p><b>x<b>a</b></b><b>b</b></p>"],
  ["italic in italic at both edges (#352)", "<p><i><i>x</i></i></p>"],
  ["em in i at both edges (#352)", "<p><em><i>x</i></em></p>"],
  ["bold in italic in italic (#352)", "<p><i><i><b>x</b></i></i></p>"],
  ["two italics back to back in italic (#352)", "<p><i><i>a</i><i>b</i></i></p>"],
];

describe("every example from the review rounds", () => {
  it.each(NAMED)("%s", (_name, html) => {
    expect(problem(html)).toBeNull();
  });
});

// A seeded generator of nested b, strong, i and em with text that includes
// punctuation, CJK, spaces, literal asterisks (which the converter escapes)
// and emphasis back to back. Seeded so a failure names an input that can be
// run again.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  "a",
  "Use",
  "x",
  "12",
  ":",
  ".",
  "(",
  ")",
  "!",
  "*",
  "**",
  "_",
  "\\",
  "\u2026",
  "\u63a8\u8350",
  "\uff1a",
  "\u300c",
  " ",
  " ",
  "  ",
];
const TAGS = ["b", "strong", "i", "em"];

function generate(next: () => number, depth = 0): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T;
  const count = 1 + Math.floor(next() * 3);
  let out = "";
  for (let k = 0; k < count; k++) {
    if (depth < 4 && next() < 0.55) {
      const tag = pick(TAGS);
      out += `<${tag}>${generate(next, depth + 1)}</${tag}>`;
    } else {
      out += pick(PIECES);
      if (next() < 0.4) out += pick(PIECES);
    }
  }
  return out;
}

const generated = (seed: number, count: number): string[] => {
  const next = rng(seed);
  return Array.from({ length: count }, () => `<p>${generate(next)}</p>`);
};

describe("the invariant holds on generated inputs", () => {
  it.each([1, 2, 3, 4])("seed %i", (seed) => {
    const failures: string[] = [];
    let lost = 0;
    let lossy = 0;
    const inputs = generated(seed, 1500);
    for (const html of inputs) {
      const p = problem(html);
      if (p !== null) failures.push(p);
      const r = check(html);
      if (r.lost > 0) {
        lost += r.lost;
        lossy++;
      }
    }
    // The emphasis given up to keep (a) and (b), on inputs markdown-it cannot
    // show as written.
    console.info(
      `seed ${seed}: ${inputs.length} inputs, ${lossy} lose some emphasis, ${lost} characters in all`,
    );
    expect(failures.slice(0, 20)).toEqual([]);
  });
});
