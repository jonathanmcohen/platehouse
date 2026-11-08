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

// A regression guard, not a proof of a fix: extractMakerWorld keeps the
// source's regular expression, and Node 26's engine read every shape here in
// a few milliseconds with it.
const XML_SHAPES: Array<[string, string]> = [
  ["metadata elements never closed", fill('<metadata name="x">')],
  ["metadata start tags with no >", fill('<metadata name="x" ')],
  ["one unterminated name", `<metadata name="${"a".repeat(SIZE)}`],
  ["a Designer with no closing tag", `<metadata name="Designer">${fill("a")}`],
  ["many complete elements", fill('<metadata name="Designer">a</metadata>')],
  ["entities in a value", `<metadata name="Designer">${fill("&amp;amp;")}</metadata>`],
];

describe("a crafted model prefix of 256 KiB is read in bounded time", () => {
  it.each(XML_SHAPES)("%s", (_name, xml) => {
    const started = performance.now();
    extractMakerWorld(xml);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });
});
