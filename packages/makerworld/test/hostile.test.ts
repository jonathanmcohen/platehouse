import { describe, expect, it } from "vitest";
import { extractMakerWorld, htmlToMarkdown } from "../src/index.js";

// A crafted file must not tie up the app (requirements AC-023 and lesson 4).
// The MakerWorld fields come from 3D/3dmodel.model read up to <resources and
// capped at 256 KiB (build plan Task 6), so 256 KiB is the largest input
// either function meets from a file. Each shape below aims at one way a
// regex tokenizer or a converter that re-reads its own output can do work
// that grows with the square of the input (a scan to the end for every < or
// every <!--, a re-read of the whole output for every tag), or write output
// that grows faster than the input (indentation for unbounded list nesting).
// The time budget is far above what linear work takes on 256 KiB and far
// below what quadratic work takes.
const SIZE = 256 * 1024;
const BUDGET_MS = 2000;
const fill = (unit: string): string => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
const nest = (open: string, inner: string, close: string): string => {
  const n = Math.floor(SIZE / (open.length + close.length));
  return open.repeat(n) + inner + close.repeat(n);
};

const HTML_SHAPES: Array<[string, string]> = [
  ["tag starts with no closing >", fill("<a ")],
  ["unterminated quoted attributes", fill('<a href="x ')],
  ["one quote left open before many tags", `<a href="${fill("<b ")}`],
  ["quoted values holding <", fill('<a b="<c" ')],
  ["mixed quotes holding <", fill('<a b="<c d=\'" e=\'<f" ')],
  // A quote in a name is an ordinary character (PR #121 review).
  ["stray quotes in tag and attribute names", fill('<span"x y">')],
  ["stray quotes in names before quoted values holding <", fill('<a x"y z=\'<b" w="<c\' ')],
  [
    "many empty paragraphs then list items",
    `${fill("<p></p>").slice(0, SIZE / 2)}<ul>${fill("<li><h3></h3></li>").slice(0, SIZE / 2)}`,
  ],
  ["unterminated comments", fill("<!--")],
  ["deeply nested emphasis", nest("<b>", "x", "</b>")],
  ["deeply nested links", nest('<a href="https://e.test/">', "x", "</a>")],
  ["many sibling emphasis", fill("<b>x</b> ")],
  ["deeply nested lists", fill("<ul><li>a")],
  ["deeply nested ordered lists", fill("<ol><li>a")],
  ["many line breaks in one list item", `<ul><li>${fill("a<br>")}`],
  // Lists opened in a cell and never closed, then list items after the cell
  // (PR #24 review): each item outside the cell once scanned back over every
  // list left open in it.
  [
    "lists left open in a cell, then list items",
    `<table><tr><td>${fill("<ul>").slice(0, SIZE / 2)}</td>${fill("<li>").slice(0, SIZE / 2 - 32)}`,
  ],
  [
    "lists left open in a cell, then nested lists",
    `<table><tr><td>${fill("<ol>").slice(0, SIZE / 2)}</td>${fill("<ul><li>a</ul>").slice(0, SIZE / 2 - 32)}`,
  ],
  // Line breaks in a cell, then emphasis whose rewrite cuts the text after
  // them (PR #24 review): each <br> was its own one-space part, and every cut
  // re-read all of them from the end, once per nested emphasis closed.
  [
    "many line breaks in a cell before emphasis",
    `<table><tr><td>${fill("<br>").slice(0, SIZE - 256)}${"<b>".repeat(16)}y${"</b>".repeat(16)}`,
  ],
  [
    "line breaks and emphasis repeated in a cell",
    `<table><tr><td>${fill("<br><br><br><br><b>y</b>")}`,
  ],
  ["many paragraphs", fill("<p>x</p>")],
  ["many headings", fill("<h2>x</h2>")],
  ["many cells in one row", `<table><tr>${fill("<td>x</td>")}`],
  ["many rows", `<table>${fill("<tr><td>x</td></tr>")}`],
  ["deeply nested tables", fill("<table><tr><td>")],
  ["entity-like runs", fill("&a")],
  ["one long entity-like name", `&${"a".repeat(SIZE)}`],
  ["numeric references", fill("&#1")],
  ["line-start markers after line breaks", fill("<br># ")],
  ["many links", fill('<a href="https://e.test/">x</a>')],
  ["whitespace runs", fill(" \t\n")],
  ["dropped elements left open", fill("<script>")],
  ["raw-text elements opened and closed, with quotes inside", fill(`<script>'<a href="</script>`)],
  ["raw-text elements that never close their own kind", fill("<style></script>")],
  ["raw-text close tags holding < and quoted >", fill(`<script>a</script x<y z='>' >`)],
];

describe("a crafted description of 256 KiB converts in bounded time and size", () => {
  it.each(HTML_SHAPES)("%s", (_name, html) => {
    const started = performance.now();
    const out = htmlToMarkdown(html);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(BUDGET_MS);
    expect(out.length).toBeLessThanOrEqual(4 * SIZE);
  });
});

// extractMakerWorld once read the prefix with one regular expression whose
// two lazy scans could each run to the end of the input from every
// <metadata start, so a prefix of start tags that never close took time
// that grows with the square of its length: about half a second on a fast
// Mac at 256 KiB and over 2 s on a CI runner (PR #24 review). A fixed
// budget passes or fails with the machine, so each shape is timed at 64 KiB
// and at 256 KiB instead. Four times the input takes about four times as
// long when the work is linear and about sixteen times when it is
// quadratic; the test allows eight, plus a few milliseconds so that timer
// noise on runs well under a millisecond cannot fail it.
const SMALL = 64 * 1024;
const GROWTH_LIMIT = 8;
const SLACK_MS = 5;
const fillTo = (unit: string, size: number): string =>
  unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

const XML_SHAPES: Array<[string, (size: number) => string]> = [
  ["metadata elements never closed", (n) => fillTo('<metadata name="x">', n)],
  ["metadata start tags with no >", (n) => fillTo('<metadata name="x" ', n)],
  [
    "start tags with no > before one that closes",
    (n) => `${fillTo('<metadata name="x" ', n - 64)}<metadata name="Designer">a</metadata>`,
  ],
  [
    "start tags with a > that never close, then a close",
    (n) => `${fillTo('<metadata name="x">', n - 64)}</metadata>`,
  ],
  ["close tags with no >", (n) => `<metadata name="x">${fillTo("</metadata ", n)}`],
  ["unterminated quoted names", (n) => fillTo('<metadata name="', n)],
  ["quoted names holding <", (n) => fillTo('<metadata name="a<b" ', n)],
  [
    "self-closing elements after one never closed",
    (n) => `<metadata name="x">${fillTo('<metadata name="y"/>', n)}`,
  ],
  ["one unterminated name", (n) => `<metadata name="${"a".repeat(n)}`],
  ["a Designer with no closing tag", (n) => `<metadata name="Designer">${fillTo("a", n)}`],
  ["many complete elements", (n) => fillTo('<metadata name="Designer">a</metadata>', n)],
  ["entities in a value", (n) => `<metadata name="Designer">${fillTo("&amp;amp;", n)}</metadata>`],
];

// The fastest of three runs, so a garbage collection or a compile in one run
// does not set the number.
function fastestMs(run: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

describe("a crafted model prefix is read in time that grows linearly up to 256 KiB", () => {
  // The quadratic code took several seconds per shape on a CI runner, so the
  // timeout is raised to let it fail on the assertion rather than time out.
  it.each(XML_SHAPES)(
    "%s",
    (_name, shape) => {
      const small = shape(SMALL);
      const large = shape(SIZE);
      const smallMs = fastestMs(() => extractMakerWorld(small));
      const largeMs = fastestMs(() => extractMakerWorld(large));
      expect(largeMs, `64 KiB: ${smallMs} ms, 256 KiB: ${largeMs} ms`).toBeLessThan(
        GROWTH_LIMIT * smallMs + SLACK_MS,
      );
    },
    60_000,
  );
});
