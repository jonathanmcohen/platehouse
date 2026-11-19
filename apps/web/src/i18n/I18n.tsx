// The web app's translations (Jon, 2026-11-19). useI18n gives every
// component the shown language's t (plain text), rich (text with elements
// for its <tag>s, such as a <time> or a link) and fmt (numbers, sizes,
// durations, dates and lists). Messages are always rendered as text nodes
// and elements built here, never as markup.
//
// Without a provider (a component rendered on its own, as the tests do) it
// is English, so every English string is exactly what the UI showed before
// translations. The provider holds the shown language: main.tsx starts it
// from the html element's lang, which the server wrote from the ph_lang
// cookie or the browser's languages, and the Settings language menu changes
// it with setLanguage, with no reload.
import {
  createTranslator,
  formatDateTime,
  formatDecimal,
  formatList,
  type Messages,
  type MessageValues,
  type Translator,
} from "@platehouse/i18n";
import {
  createContext,
  Fragment,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { ENGLISH, loadMessages, type MessageKey } from "./catalogs";
import { applyLanguage } from "./language";

export type { MessageKey } from "./catalogs";

/** What a tag in a message becomes: its rendered children, wrapped. */
export type TagRenderers = Readonly<Record<string, (children: ReactNode) => ReactNode>>;

export interface Formatters {
  /** A print time: 50m, 1h 25m. Never less than 1m. */
  duration(seconds: number): string;
  /** A weight: 31 g, 41.4 g, 1.25 kg. */
  weight(grams: number): string;
  /** A file size: 684 B, 120.6 KB, 89.4 MB. */
  size(bytes: number): string;
  /** A whole percentage: 42%. */
  percent(value: number): string;
  /** A date, or a date and time. */
  date(iso: string, withTime?: boolean): string;
  /** A list: a, b, c. */
  list(items: readonly string[]): string;
  /** A number with at most maxFraction decimals and no grouping. */
  decimal(value: number, maxFraction: number): string;
}

export interface I18n {
  /** The shown language's code. */
  locale: string;
  t(key: MessageKey, values?: MessageValues): string;
  rich(key: MessageKey, values: MessageValues, tags: TagRenderers): ReactNode;
  fmt: Formatters;
  /**
   * Shows another language and keeps the choice: a code, or null to follow
   * the browser (shown is then the language the browser's list resolves to).
   */
  setLanguage(choice: string | null, shown: string): Promise<void>;
}

function makeFormatters(translator: Translator): Formatters {
  const { locale } = translator;
  const t = (key: MessageKey, values: MessageValues) => translator.t(key, values);
  return {
    duration(seconds) {
      const minutes = Math.max(1, Math.round(seconds / 60));
      const hours = Math.floor(minutes / 60);
      return hours > 0
        ? t("format.duration.hoursMinutes", { hours, minutes: minutes % 60 })
        : t("format.duration.minutes", { minutes });
    },
    weight(grams) {
      if (grams >= 1000) {
        return t("format.weight.kilograms", { value: formatDecimal(locale, grams / 1000, 2) });
      }
      return t("format.weight.grams", { value: formatDecimal(locale, grams, 1) });
    },
    size(bytes) {
      if (bytes < 1000) return t("format.size.bytes", { value: formatDecimal(locale, bytes, 0) });
      if (bytes < 1_000_000) {
        return t("format.size.kilobytes", { value: formatDecimal(locale, bytes / 1000, 1) });
      }
      if (bytes < 1_000_000_000) {
        return t("format.size.megabytes", { value: formatDecimal(locale, bytes / 1_000_000, 1) });
      }
      return t("format.size.gigabytes", {
        value: formatDecimal(locale, bytes / 1_000_000_000, 2),
      });
    },
    percent(value) {
      return t("format.percent", { value: formatDecimal(locale, value, 0) });
    },
    date(iso, withTime = false) {
      return formatDateTime(locale, iso, withTime);
    },
    list(items) {
      return formatList(locale, items);
    },
    decimal(value, maxFraction) {
      return formatDecimal(locale, value, maxFraction);
    },
  };
}

function makeI18n(translator: Translator, setLanguage: I18n["setLanguage"]): I18n {
  return {
    locale: translator.locale,
    t: (key, values) => translator.t(key, values),
    rich(key, values, tags) {
      const parts = translator.render<ReactNode>(key, values, {
        text: (value) => value,
        tag: (name, children) => {
          const inner = children.map((child, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a message's parts are fixed for that message and never reorder, so their position is their identity.
            <Fragment key={i}>{child}</Fragment>
          ));
          const wrap = tags[name];
          return wrap === undefined ? inner : wrap(inner);
        },
      });
      return (
        <>
          {parts.map((part, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a message's parts are fixed for that message and never reorder, so their position is their identity.
            <Fragment key={i}>{part}</Fragment>
          ))}
        </>
      );
    },
    fmt: makeFormatters(translator),
    setLanguage,
  };
}

const ENGLISH_TRANSLATOR = createTranslator("en", ENGLISH, ENGLISH);

/** English, for a component outside the provider (a test) and for code with no component. */
export const ENGLISH_I18N: I18n = makeI18n(ENGLISH_TRANSLATOR, async () => {});

const I18nContext = createContext<I18n>(ENGLISH_I18N);

export interface I18nProviderProps {
  /** The language shown first. */
  locale: string;
  /** Its messages, already loaded (main.tsx loads them before the first render). */
  messages: Messages;
  children?: ReactNode;
  /** Loads a language's messages; loadMessages when left out. */
  load?: (code: string) => Promise<Messages>;
}

export function I18nProvider({
  locale,
  messages,
  children,
  load = loadMessages,
}: I18nProviderProps) {
  const [translator, setTranslator] = useState(() => createTranslator(locale, messages, ENGLISH));

  const setLanguage = useCallback(
    async (choice: string | null, shown: string) => {
      const next = await load(shown);
      applyLanguage(choice, shown, document);
      setTranslator(createTranslator(shown, next, ENGLISH));
    },
    [load],
  );

  const value = useMemo(() => makeI18n(translator, setLanguage), [translator, setLanguage]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** The shown language's translations; English outside a provider. */
export function useI18n(): I18n {
  return useContext(I18nContext);
}
