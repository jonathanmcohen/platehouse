// The Language section of Settings (Jon, 2026-11-19): the browser's own
// language, or one of the languages Platehouse has, as a group of radio
// buttons. A pick applies at once, with no reload, and is kept in this
// browser in the ph_lang cookie; Browser language clears the cookie, so the
// browser's own list decides again. The list comes from GET
// /app/api/locales: the built-in languages and any a self-hoster dropped
// into LOCALES_DIR. While it cannot be read, the built-in languages are
// offered. A machine translation nobody has reviewed yet says so beside its
// name, and so does a language that covers only part of the app.
import { languageName, resolveLocale, SOURCE_LOCALE } from "@platehouse/i18n";
import { useEffect, useId, useState } from "react";
import { builtinLocales, isBuiltinMachineDraft } from "./catalogs";
import { useI18n } from "./I18n";
import { savedLanguage } from "./language";

/** One language as GET /app/api/locales lists it (apps/server/src/app-api/locales.ts, ListedLocale in apps/server/src/locales/locales.ts). */
export interface ListedLocale {
  code: string;
  /** The language's name in itself. */
  name: string;
  source: "built-in" | "local";
  /** A machine translation nobody has reviewed yet. */
  machineDraft: boolean;
  /** Whether it has a message for every English key. */
  complete: boolean;
  /** A built-in language a LOCALES_DIR file changes (catalogs.ts merges it). */
  overlay?: boolean;
}

/**
 * The built-in languages as the bundle knows them, for when the list cannot
 * be read, each machine draft marked from its catalog's $meta as the server
 * marks it.
 */
function bundled(): ListedLocale[] {
  return builtinLocales().map((code) => ({
    code,
    name: languageName(code),
    source: "built-in",
    machineDraft: isBuiltinMachineDraft(code),
    complete: true,
  }));
}

/** The browser's languages, best first. */
function browserLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages ?? (navigator.language ? [navigator.language] : []);
}

export interface LanguagePickerProps {
  /** Reads the language list; GET /app/api/locales when left out. */
  list?: () => Promise<ListedLocale[]>;
}

async function fetchList(): Promise<ListedLocale[]> {
  const res = await fetch("/app/api/locales", {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`the language list answered ${res.status}`);
  return ((await res.json()) as { locales: ListedLocale[] }).locales;
}

export function LanguagePicker({ list = fetchList }: LanguagePickerProps) {
  const { t, setLanguage } = useI18n();
  const headingId = useId();
  const introId = useId();
  const [locales, setLocales] = useState<ListedLocale[]>(bundled);
  const [choice, setChoice] = useState<string | null>(() =>
    typeof document === "undefined" ? null : savedLanguage(document),
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    list().then(
      (answer) => {
        if (live && answer.length > 0) setLocales(answer);
      },
      () => {
        // The built-in languages stay on offer.
      },
    );
    return () => {
      live = false;
    };
  }, [list]);

  const codes = locales.map((l) => l.code);
  const browserShows = resolveLocale({ wanted: browserLanguages(), available: codes });
  const browserName =
    locales.find((l) => l.code === browserShows)?.name ?? languageName(SOURCE_LOCALE);

  async function pick(next: string | null) {
    const shown = next ?? browserShows;
    setFailed(false);
    try {
      // Only the pick still current marks its radio; one a newer pick
      // replaced before its language loaded changes nothing (issue 298).
      if (await setLanguage(next, shown)) setChoice(next);
    } catch {
      setFailed(true);
    }
  }

  const options: Array<{ value: string | null; label: string; note: string | null }> = [
    { value: null, label: t("language.browser", { name: browserName }), note: null },
    ...locales.map((l) => ({
      value: l.code,
      label: l.name,
      note: l.machineDraft ? t("language.machineDraft") : l.complete ? null : t("language.partial"),
    })),
  ];

  return (
    <div className="ph-section">
      <h2 id={headingId}>{t("language.heading")}</h2>
      <p id={introId} className="studio-muted">
        {t("language.intro")}
      </p>
      <fieldset
        className="ph-language-picker"
        aria-labelledby={headingId}
        aria-describedby={introId}
      >
        {options.map((option) => (
          <label key={option.value ?? ""} className="ph-language-option">
            <input
              type="radio"
              name={`${headingId}-language`}
              checked={option.value === choice}
              onChange={() => void pick(option.value)}
            />
            <span {...(option.value === null ? {} : { lang: option.value })}>{option.label}</span>
            {option.note === null ? null : <span className="studio-muted"> ({option.note})</span>}
          </label>
        ))}
      </fieldset>
      {failed ? (
        <p role="alert" className="studio-alert studio-alert-alert">
          {t("language.failed")}
        </p>
      ) : null}
    </div>
  );
}
