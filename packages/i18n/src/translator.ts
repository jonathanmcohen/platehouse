// A translator for one language: a message by key, from that language's
// catalog, else English (Jon, 2026-11-19: missing keys fall back to
// English). A key neither has is a programming error the catalog check
// catches; at run time it shows as the English fallback text "?", never as
// the raw key. Parsed messages are kept, so each is parsed once.
import {
  formatNodes,
  type MessageNode,
  type MessageValues,
  parseMessage,
  type Renderer,
  renderMessage,
} from "./message.js";
import { SOURCE_LOCALE } from "./negotiate.js";
import type { Messages } from "./validate.js";

export interface Translator {
  /** The language this translator shows. */
  readonly locale: string;
  /** A message as plain text, tags dropped to their text. */
  t(key: string, values?: MessageValues): string;
  /** A message rendered with the caller's own tag and text renderer. */
  render<T>(key: string, values: MessageValues, renderer: Renderer<T>): T[];
  /** Whether the language's own catalog has the key (not the English fallback). */
  has(key: string): boolean;
}

interface Parsed {
  locale: string;
  nodes: MessageNode[];
}

/** What a key that is in no catalog shows: never the key itself. */
export const MISSING_TEXT = "?";

export function createTranslator(
  locale: string,
  messages: Messages,
  english: Messages,
): Translator {
  const cache = new Map<string, Parsed>();

  function parsed(key: string): Parsed {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let result: Parsed | undefined;
    const own = Object.hasOwn(messages, key) ? messages[key] : undefined;
    if (own !== undefined) {
      try {
        result = { locale, nodes: parseMessage(own) };
      } catch {
        // A message that does not parse falls back to English, like a missing one.
      }
    }
    if (result === undefined) {
      const source = Object.hasOwn(english, key) ? english[key] : undefined;
      result =
        source === undefined
          ? { locale: SOURCE_LOCALE, nodes: [{ kind: "text", value: MISSING_TEXT }] }
          : { locale: SOURCE_LOCALE, nodes: parseMessage(source) };
    }
    cache.set(key, result);
    return result;
  }

  return {
    locale,
    t(key, values = {}) {
      const p = parsed(key);
      return formatNodes(p.locale, p.nodes, values);
    },
    render(key, values, renderer) {
      const p = parsed(key);
      return renderMessage(p.locale, p.nodes, values, renderer);
    },
    has(key) {
      return Object.hasOwn(messages, key);
    },
  };
}
