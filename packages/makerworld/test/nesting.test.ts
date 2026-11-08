// @vitest-environment jsdom
/// <reference lib="dom" />
import { describe, expect, it } from "vitest";
import { htmlToMarkdown, renderMarkdown } from "../src/index.js";
import { htmlEscape } from "./support/payloads.js";

// Every block and inline the converter handles, nested inside every other,
// properly and misnested, with a link or emphasis left open across the
// boundary and runs of <br> before it. Closing a link or emphasis writes its
// markup where it opened, and some boundaries trim or rewrite text already
// written (a heading, a table cell, the "; " between list items or nested
// rows in a cell). An element whose start fell out of step with the text
// once un-escaped designer text and turned an escaped ! into an image
// (PR #24 review, issue #33). Whatever the nesting, the designer's text must
// come out as text: no image, no attribute but a link's http(s) href, and the
// payload intact.

// Every character Task 7 escapes, a line-start "1.", and the three crafted
// inputs: an image to an address the designer chose, a raw <img onerror>
// and a javascript: link, plus a script tag.
const PAYLOAD =
  "1. * _ [ ] ( ) # < > ` | ~ $ { \\ ! & " +
  "![x](https://attacker.example/x.png) <img src=x onerror=alert(1)> " +
  "<script>alert(1)</script> [j](javascript:alert(1))";
const P = htmlEscape(PAYLOAD);

const LINK = "https://e.test/l";
const EVIL = "https://evil.example/x.png";
const IMAGE_BAIT = `!<a href="${EVIL}">y</a>`;
const END_ITEM = "<li>end item</li>";
const LISTS = new Set(["list", "ordered list"]);

interface Context {
  open: string;
  mid: string; // ends one item of the context and starts the next
  close: string;
}

const CONTEXTS: Record<string, Context> = {
  // Each list closes with one more item, which must still render as an item
  // whatever came before it in the list (PR #24 review: after a heading in an
  // ordered item, the next item rendered as text).
  list: { open: "<ul><li>a</li><li>", mid: "</li><li>", close: `</li>${END_ITEM}</ul>` },
  "ordered list": {
    open: "<ol><li>a</li><li>",
    mid: "</li><li>",
    close: `</li>${END_ITEM}</ol>`,
  },
  "table cell": {
    open: "<table><tr><td>a</td><td>",
    mid: "</td><td>",
    close: "</td></tr></table>",
  },
  // HTML lets a page leave out </td> and </tr>: the next cell or row closes
  // the open one. A cell left open once kept its start while a link closed
  // across it rewrote the text before that start, so the cell was then cut
  // between a backslash and the "!" it escaped (PR #24 review).
  "table cell, no </td>": {
    open: "<table><tr><td>a<td>",
    mid: "<td>",
    close: "</tr></table>",
  },
  "table row, no </td> or </tr>": {
    open: "<table><tr><td>a<tr><td>",
    mid: "<tr><td>",
    close: "</table>",
  },
  "nested table": {
    open: "<table><tr><td><table><tr><td>a</td></tr><tr><td>",
    mid: "</td></tr><tr><td>",
    close: "</td></tr></table></td></tr></table>",
  },
  heading: { open: "<h2>", mid: "</h2><h2>", close: "</h2>" },
  link: { open: `<a href="${LINK}">`, mid: `</a> <a href="${LINK}">`, close: "</a>" },
  emphasis: { open: "<b>", mid: "</b> <b>", close: "</b>" },
  blockquote: { open: "<blockquote>", mid: "</blockquote><blockquote>", close: "</blockquote>" },
};

// The link or emphasis left open across a boundary.
const DANGLING: Array<[string, string, string]> = [
  ["em", "<i>", "</i>"],
  ["strong", "<strong>", "</strong>"],
  ["link", `<a href="${EVIL}">`, "</a>"],
];

interface Case {
  name: string;
  html: string;
  // The outer context is a list and the inner one sits wholly inside it, so
  // the list's closing item must render as an item, however many <br> came
  // before (two or more once wrote a blank line that ended the item; PR #24
  // review). Left out: misnested pairs, where that item can fall inside the
  // inner context (a table cell, say) and is no item there.
  listHolds: boolean;
}

function cases(): Case[] {
  const out: Case[] = [];
  for (const [aName, a] of Object.entries(CONTEXTS)) {
    const listHolds = LISTS.has(aName);
    for (const [bName, b] of Object.entries(CONTEXTS)) {
      const pair = `${bName} in ${aName}`;
      out.push({
        name: `${pair}, nested`,
        html: a.open + P + b.open + P + b.close + P + a.close,
        listHolds,
      });
      out.push({
        name: `${pair}, misnested`,
        html: a.open + P + b.open + P + a.close + P + b.close,
        listHolds: false,
      });
      for (const [dName, dOpen, dClose] of DANGLING) {
        for (let n = 1; n <= 3; n++) {
          const brs = "<br>".repeat(n);
          const tag = `${dName} after ${n} br`;
          out.push({
            name: `${pair}, ${tag} open across the inner boundary`,
            html: `${a.open + b.open}a${brs}${dOpen}${b.mid}${IMAGE_BAIT}${P}${dClose}${b.close}${a.close}`,
            listHolds,
          });
          out.push({
            name: `${pair}, ${tag} open across the outer boundary`,
            html: `${a.open}a${brs}${dOpen}${a.mid}${b.open}${IMAGE_BAIT}${P}${dClose}${b.close}${a.close}`,
            listHolds,
          });
          out.push({
            name: `${pair}, ${tag} open around both and closed inside`,
            html: `${dOpen}${a.open}${P}${brs}${b.open}${IMAGE_BAIT}${P}${dClose}${P}${b.close}${a.close}`,
            listHolds,
          });
        }
      }
    }
  }
  return out;
}

const ALLOWED_TAGS = new Set([
  "p",
  "br",
  "strong",
  "em",
  "a",
  "h2",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
]);

const norm = (s: string): string => s.replace(/\s+/g, " ");

function count(haystack: string, needle: string): number {
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) n++;
  return n;
}

describe("designer text nested in every block and inline renders literally", () => {
  it.each(cases())("$name", ({ html, listHolds }) => {
    const md = htmlToMarkdown(html);
    const rendered = renderMarkdown(md);
    const root = document.createElement("div");
    root.innerHTML = rendered;
    const elements = Array.from(root.querySelectorAll("*"));

    const detail = `${html}\n-> ${md}\n-> ${rendered}`;
    for (const el of elements) {
      const tag = el.tagName.toLowerCase();
      expect(tag, detail).not.toBe("img");
      expect(ALLOWED_TAGS.has(tag), `${tag} in ${detail}`).toBe(true);
      for (const attr of Array.from(el.attributes)) {
        // An ordered list that markdown-it starts past 1 carries its number.
        if (`${tag} ${attr.name}` === "ol start") {
          expect(attr.value, detail).toMatch(/^\d+$/);
          continue;
        }
        expect(`${tag} ${attr.name}`, detail).toBe("a href");
        expect([LINK, EVIL], detail).toContain(attr.value);
      }
    }
    expect(count(norm(root.textContent ?? ""), PAYLOAD), detail).toBe(count(html, P));
    if (listHolds) {
      const items = elements.filter(
        (el) => el.tagName === "LI" && norm(el.textContent ?? "").trim() === "end item",
      );
      expect(items.length, detail).toBe(count(html, END_ITEM));
    }
  });
});
