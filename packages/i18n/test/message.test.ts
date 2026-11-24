import { describe, expect, it } from "vitest";
import {
  formatMessage,
  MessageSyntaxError,
  messageShape,
  parseMessage,
  renderMessage,
} from "../src/message.js";

describe("parseMessage and formatMessage", () => {
  it("leaves plain text alone, apostrophes and quotes included", () => {
    const text = `This file's plates are "still" being read. 50% done #1.`;
    expect(formatMessage("en", text)).toBe(text);
  });

  it("fills placeholders, and keeps a missing one visible as its name", () => {
    expect(formatMessage("en", "Rename {name}", { name: "Hook" })).toBe("Rename Hook");
    expect(formatMessage("en", "Rename {name}", {})).toBe("Rename {name}");
  });

  it("formats a number placeholder in the locale", () => {
    expect(formatMessage("fr", "{n} mm", { n: 0.4 })).toBe("0,4 mm");
    expect(formatMessage("en", "{n} mm", { n: 0.4 })).toBe("0.4 mm");
  });

  it("picks the plural case with Intl.PluralRules, exact cases first, # as the number", () => {
    const plates = "{count, plural, =0 {no plates} one {# plate} other {# plates}}";
    expect(formatMessage("en", plates, { count: 0 })).toBe("no plates");
    expect(formatMessage("en", plates, { count: 1 })).toBe("1 plate");
    expect(formatMessage("en", plates, { count: 2 })).toBe("2 plates");
    expect(formatMessage("en", plates, { count: 1000 })).toBe("1000 plates");
  });

  it("follows each language's own plural rules", () => {
    const fr = "{count, plural, one {# plateau} many {# de plateaux} other {# plateaux}}";
    expect(formatMessage("fr", fr, { count: 0 })).toBe("0 plateau");
    expect(formatMessage("fr", fr, { count: 1 })).toBe("1 plateau");
    expect(formatMessage("fr", fr, { count: 2 })).toBe("2 plateaux");
    expect(formatMessage("fr", fr, { count: 1_000_000 })).toBe("1000000 de plateaux");
  });

  it("falls back to other when the chosen case is missing", () => {
    expect(formatMessage("fr", "{n, plural, other {# x}}", { n: 1_000_000 })).toBe("1000000 x");
  });

  it("allows placeholders and tags inside plural cases", () => {
    const m = "{n, plural, one {<b>{name}</b> has # file} other {<b>{name}</b> has # files}}";
    expect(formatMessage("en", m, { n: 3, name: "Hook" })).toBe("Hook has 3 files");
  });

  it("drops tags to their text when formatting a plain string", () => {
    expect(formatMessage("en", "Deleted after <time>{date}</time>.", { date: "Nov 1" })).toBe(
      "Deleted after Nov 1.",
    );
  });

  it.each([
    ["an unclosed placeholder", "Hello {name"],
    ["a stray closing brace", "Hello }"],
    ["an empty placeholder", "Hello {}"],
    ["a placeholder name with spaces", "Hello {first name}"],
    ["an unknown argument type", "{n, number}"],
    ["a plural with no other case", "{n, plural, one {x}}"],
    ["a plural case with no braces", "{n, plural, one x other {y}}"],
    ["a repeated plural case", "{n, plural, one {a} one {b} other {c}}"],
    ["an unknown plural case", "{n, plural, few2 {a} other {c}}"],
    ["an unclosed tag", "Hello <b>there"],
    ["a mismatched closing tag", "<b>x</i>"],
    ["a stray closing tag", "x</b>"],
    ["markup that is not a tag", 'Hello <a href="x">there</a>'],
    ["a lone angle bracket", "1 < 2"],
    ["an HTML comment", "a <!-- b --> c"],
  ])("refuses %s", (_what, source) => {
    expect(() => parseMessage(source)).toThrow(MessageSyntaxError);
  });
});

describe("messageShape", () => {
  it("lists the placeholders, the tags and each plural's cases", () => {
    const shape = messageShape(
      parseMessage("<code>{p}</code> {n, plural, one {# <b>{x}</b>} other {# y}}"),
    );
    expect([...shape.args].sort()).toEqual(["n", "p", "x"]);
    expect([...shape.tags].sort()).toEqual(["b", "code"]);
    expect(shape.plurals.get("n")).toEqual(new Set(["one", "other"]));
  });
});

describe("renderMessage", () => {
  it("hands each tag its rendered children, so a caller can wrap them in an element", () => {
    const out = renderMessage<string>(
      "en",
      parseMessage("Deleted after <time>{date}</time>."),
      { date: "Nov 1" },
      { tag: (name, children) => `[${name}:${children.join("")}]`, text: (s) => s },
    );
    expect(out.join("")).toBe("Deleted after [time:Nov 1].");
  });
});

describe("placeholder lookup", () => {
  it("does not read an inherited property as a value", () => {
    expect(formatMessage("en", "Rename {constructor}", {})).toBe("Rename {constructor}");
  });
});
