// The message format of Platehouse's translations: a small, strict subset of
// ICU MessageFormat, parsed and rendered here so the web app, the server and
// the catalog check all read a message the same way (Jon, 2026-11-19: no new
// dependency).
//
// - Text is taken as it is. Apostrophes and quotes need no escaping.
// - {name} is a placeholder. A number is formatted for the locale (its
//   decimal mark, no thousands separator).
// - {name, plural, =0 {...} one {...} other {...}} picks a case with
//   Intl.PluralRules for the locale, an exact =N case first, other when the
//   chosen case is missing. Inside a case, # is the number, formatted for the
//   locale. Every plural needs an other case.
// - <tag>...</tag> marks a run of text a caller wraps in an element (a
//   <time>, a link, a hidden span). A tag name is lower-case letters only.
//   Any other < (markup, a comparison, a comment) is a syntax error, so a
//   message can never carry HTML: the web app renders a message as text
//   nodes and elements it builds itself, never as markup.
//
// Nothing else (select, selectordinal, number skeletons) is supported; the
// inventory needs none of it.

export type MessageNode =
  | { kind: "text"; value: string }
  | { kind: "arg"; name: string }
  | { kind: "pound" }
  | { kind: "plural"; name: string; cases: ReadonlyMap<string, MessageNode[]> }
  | { kind: "tag"; name: string; children: MessageNode[] };

/** A message that does not parse. */
export class MessageSyntaxError extends Error {
  override name = "MessageSyntaxError";
}

/** The plural cases a message may name, besides an exact =N. */
export const PLURAL_CATEGORIES: ReadonlySet<string> = new Set([
  "zero",
  "one",
  "two",
  "few",
  "many",
  "other",
]);

const NAME = /[A-Za-z_][A-Za-z0-9_]*/y;
const TAG_NAME = /[a-z]+/y;
const SPACE = /\s*/y;
const SELECTOR = /=[0-9]+|[a-z]+/y;

class Parser {
  private at = 0;
  private readonly src: string;

  constructor(src: string) {
    this.src = src;
  }

  parse(): MessageNode[] {
    const nodes = this.nodes(false, null);
    if (this.at < this.src.length) this.fail("unexpected text");
    return nodes;
  }

  private fail(why: string): never {
    throw new MessageSyntaxError(`${why} at character ${this.at + 1}`);
  }

  private match(re: RegExp): string | null {
    re.lastIndex = this.at;
    const m = re.exec(this.src);
    if (m === null) return null;
    this.at = re.lastIndex;
    return m[0];
  }

  private space(): void {
    this.match(SPACE);
  }

  /** Nodes up to a closing } (inPlural), a closing tag (tag), or the end. */
  private nodes(inPlural: boolean, tag: string | null): MessageNode[] {
    const out: MessageNode[] = [];
    let text = "";
    const flush = () => {
      if (text !== "") out.push({ kind: "text", value: text });
      text = "";
    };
    while (this.at < this.src.length) {
      const ch = this.src[this.at] as string;
      if (ch === "{") {
        flush();
        out.push(this.argument());
      } else if (ch === "}") {
        if (!inPlural) this.fail("a } with no {");
        break;
      } else if (ch === "<") {
        if (this.src.startsWith("</", this.at)) {
          if (tag === null) this.fail("a closing tag with no opening tag");
          break;
        }
        flush();
        out.push(this.tag(inPlural));
      } else if (ch === "#" && inPlural) {
        flush();
        out.push({ kind: "pound" });
        this.at += 1;
      } else {
        text += ch;
        this.at += 1;
      }
    }
    flush();
    if (tag !== null) {
      if (!this.src.startsWith("</", this.at)) this.fail(`<${tag}> is not closed`);
      this.at += 2;
      const name = this.match(TAG_NAME);
      if (name !== tag || this.src[this.at] !== ">") this.fail(`<${tag}> is closed by another tag`);
      this.at += 1;
    }
    return out;
  }

  private tag(inPlural: boolean): MessageNode {
    this.at += 1;
    const name = this.match(TAG_NAME);
    if (name === null || this.src[this.at] !== ">") this.fail("markup that is not a <tag>");
    this.at += 1;
    const children = this.nodes(inPlural, name);
    return { kind: "tag", name, children };
  }

  private argument(): MessageNode {
    this.at += 1;
    this.space();
    const name = this.match(NAME);
    if (name === null) this.fail("a placeholder with no name");
    this.space();
    if (this.src[this.at] === "}") {
      this.at += 1;
      return { kind: "arg", name };
    }
    if (this.src[this.at] !== ",") this.fail(`a bad placeholder {${name}`);
    this.at += 1;
    this.space();
    const type = this.match(NAME);
    if (type !== "plural") this.fail(`an argument type other than plural for {${name}`);
    this.space();
    if (this.src[this.at] !== ",") this.fail(`a plural for {${name}} with no cases`);
    this.at += 1;
    const cases = new Map<string, MessageNode[]>();
    for (;;) {
      this.space();
      if (this.src[this.at] === "}") {
        this.at += 1;
        break;
      }
      const selector = this.match(SELECTOR);
      if (selector === null) this.fail(`a bad plural case in {${name}}`);
      if (!selector.startsWith("=") && !PLURAL_CATEGORIES.has(selector)) {
        this.fail(`an unknown plural case ${selector}`);
      }
      if (cases.has(selector)) this.fail(`the plural case ${selector} twice`);
      this.space();
      if (this.src[this.at] !== "{") this.fail(`the plural case ${selector} has no {`);
      this.at += 1;
      const body = this.nodes(true, null);
      if (this.src[this.at] !== "}") this.fail(`the plural case ${selector} is not closed`);
      this.at += 1;
      cases.set(selector, body);
    }
    if (!cases.has("other")) this.fail(`the plural {${name}} has no other case`);
    return { kind: "plural", name, cases };
  }
}

/** Parses a message; throws MessageSyntaxError when it does not parse. */
export function parseMessage(source: string): MessageNode[] {
  return new Parser(source).parse();
}

export interface MessageShape {
  /** Every placeholder name, plural arguments included. */
  args: Set<string>;
  tags: Set<string>;
  /** Each plural argument's case names. */
  plurals: Map<string, Set<string>>;
}

/** What a message uses: the placeholders, tags and plural cases a translation must match. */
export function messageShape(nodes: readonly MessageNode[]): MessageShape {
  const shape: MessageShape = { args: new Set(), tags: new Set(), plurals: new Map() };
  const walk = (list: readonly MessageNode[]) => {
    for (const node of list) {
      if (node.kind === "arg") shape.args.add(node.name);
      else if (node.kind === "tag") {
        shape.tags.add(node.name);
        walk(node.children);
      } else if (node.kind === "plural") {
        shape.args.add(node.name);
        const cases = shape.plurals.get(node.name) ?? new Set<string>();
        for (const [key, body] of node.cases) {
          cases.add(key);
          walk(body);
        }
        shape.plurals.set(node.name, cases);
      }
    }
  };
  walk(nodes);
  return shape;
}

/** A value a placeholder takes. */
export type MessageValue = string | number;

export type MessageValues = Readonly<Record<string, MessageValue>>;

export interface Renderer<T> {
  /** A tag's rendered children, wrapped as the caller wants. */
  tag(name: string, children: T[]): T;
  text(value: string): T;
}

const numberFormats = new Map<string, Intl.NumberFormat>();
const pluralRules = new Map<string, Intl.PluralRules>();

function numberFormat(locale: string): Intl.NumberFormat {
  let f = numberFormats.get(locale);
  if (f === undefined) {
    // No thousands separator: the UI has always written counts as plain
    // figures (1234 models), and English stays exactly as it was.
    f = new Intl.NumberFormat(locale, { useGrouping: false });
    numberFormats.set(locale, f);
  }
  return f;
}

function pluralRule(locale: string): Intl.PluralRules {
  let r = pluralRules.get(locale);
  if (r === undefined) {
    r = new Intl.PluralRules(locale);
    pluralRules.set(locale, r);
  }
  return r;
}

function valueText(locale: string, value: MessageValue): string {
  return typeof value === "number" ? numberFormat(locale).format(value) : value;
}

/** The case a plural takes for n: an exact =n, else the locale's category, else other. */
export function pluralCase(
  locale: string,
  cases: ReadonlyMap<string, unknown>,
  n: number,
): string {
  if (cases.has(`=${n}`)) return `=${n}`;
  const category = pluralRule(locale).select(n);
  return cases.has(category) ? category : "other";
}

/**
 * Renders parsed nodes. A missing placeholder shows as {name}, so it is
 * visible rather than silently empty; a plural whose value is not a number
 * takes its other case.
 */
export function renderMessage<T>(
  locale: string,
  nodes: readonly MessageNode[],
  values: MessageValues,
  renderer: Renderer<T>,
): T[] {
  const render = (list: readonly MessageNode[], pound: number | undefined): T[] => {
    const out: T[] = [];
    for (const node of list) {
      switch (node.kind) {
        case "text":
          out.push(renderer.text(node.value));
          break;
        case "arg": {
          const value = values[node.name];
          out.push(renderer.text(value === undefined ? `{${node.name}}` : valueText(locale, value)));
          break;
        }
        case "pound":
          out.push(renderer.text(pound === undefined ? "#" : numberFormat(locale).format(pound)));
          break;
        case "plural": {
          const value = values[node.name];
          if (typeof value === "number") {
            out.push(...render(node.cases.get(pluralCase(locale, node.cases, value)) ?? [], value));
          } else {
            out.push(...render(node.cases.get("other") ?? [], undefined));
          }
          break;
        }
        case "tag":
          // A # inside a tag inside a plural keeps the plural's number.
          out.push(renderer.tag(node.name, render(node.children, pound)));
          break;
      }
    }
    return out;
  };
  return render(nodes, undefined);
}

const STRING_RENDERER: Renderer<string> = {
  tag: (_name, children) => children.join(""),
  text: (value) => value,
};

/** A message as a plain string: tags are dropped to their text. */
export function formatNodes(
  locale: string,
  nodes: readonly MessageNode[],
  values: MessageValues = {},
): string {
  return renderMessage(locale, nodes, values, STRING_RENDERER).join("");
}

/** Parses and formats a message as a plain string. */
export function formatMessage(locale: string, source: string, values: MessageValues = {}): string {
  return formatNodes(locale, parseMessage(source), values);
}
