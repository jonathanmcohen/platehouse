// Designer text that would be Markdown or HTML if it reached the renderer
// unescaped. markdown.test.ts runs the table through htmlToMarkdown and
// markdown-it; render.test.ts runs it through renderMarkdown, DOMPurify
// included. Each payload is put in the HTML as text, HTML-escaped, the way a
// designer's typing reaches the file.
export const DESIGNER_PAYLOADS: string[] = [
  ..."*_[]()#<>`|~$!&\\+-=:^\"'".split(""),
  "{",
  "}",
  "1.",
  "1)",
  "10)",
  "**",
  "__",
  "~~",
  "~~~",
  "```",
  "---",
  "===",
  "***",
  "- ",
  "+ ",
  "* ",
  "> ",
  "# ",
  "## ",
  "1. ",
  "| a | b |",
  "[a](https://e.test)",
  "![a](https://e.test/i.png)",
  "[a]: https://e.test",
  "<https://e.test>",
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  '<a href="javascript:alert(1)">x</a>',
  "[x](javascript:alert(1))",
  "&lt;",
  "&amp;",
  "&#42;",
  "&#x3C;script&#x3E;",
];

// HTML-escape text the way an editor writes it into HTML.
export const htmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
