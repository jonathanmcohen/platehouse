// @vitest-environment jsdom
// The web app in other languages (Jon, 2026-11-19): pages render in Spanish
// and French with no raw key anywhere, numbers follow the language, the
// Settings language menu switches at once and keeps the choice in the
// ph_lang cookie, the browser's language is the default, and a language a
// self-hoster added falls back to English for what it lacks.
import { createTranslator, type Messages, messagesOf } from "@platehouse/i18n";
import en from "@platehouse/i18n/locales/en.json";
import es from "@platehouse/i18n/locales/es.json";
import fr from "@platehouse/i18n/locales/fr.json";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadMessages } from "../src/i18n/catalogs";
import { I18nProvider, useI18n } from "../src/i18n/I18n";
import { LanguagePicker, type ListedLocale } from "../src/i18n/LanguagePicker";
import { languageCookie, readLanguage, savedLanguage } from "../src/i18n/language";
import { printerNameIn } from "../src/i18n/printers";
import { ModelCard } from "../src/library/ModelCard";
import { Shell } from "../src/shell/Shell";
import { TrashList } from "../src/trash/TrashList";
import { UploadDialog } from "../src/upload/UploadDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CATALOGS: Readonly<Record<string, Messages>> = {
  en: messagesOf(en),
  es: messagesOf(es),
  fr: messagesOf(fr),
};

/** Every English key: the raw-key detector looks for these in the page. */
const KEYS = Object.keys(CATALOGS.en as Messages);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // biome-ignore lint/suspicious/noDocumentCookie: the test reads and clears the real jsdom cookie jar.
  document.cookie = "ph_lang=; Path=/; Max-Age=0";
  document.documentElement.setAttribute("lang", "en");
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(locale: string, node: ReactNode) {
  act(() => {
    root.render(
      <I18nProvider
        locale={locale}
        messages={CATALOGS[locale] as Messages}
        load={async (code) => CATALOGS[code] as Messages}
      >
        <MemoryRouter>{node}</MemoryRouter>
      </I18nProvider>,
    );
  });
}

/** Every text and user-facing attribute on the page. */
function shownText(): string[] {
  const out = [container.textContent ?? ""];
  for (const el of container.querySelectorAll("*")) {
    for (const name of ["aria-label", "title", "placeholder", "alt"]) {
      const value = el.getAttribute(name);
      if (value !== null) out.push(value);
    }
  }
  return out;
}

/** The English keys that appear on the page as they are: a raw key the page failed to translate. */
function rawKeys(): string[] {
  const text = shownText().join("\n");
  return KEYS.filter((key) =>
    new RegExp(`(^|[^\\w.])${key.replaceAll(".", "\\.")}($|[^\\w.])`).test(text),
  );
}

/** A printer name in the shown language. */
function PrinterName({ name }: { name: string }) {
  return <span>{printerNameIn(useI18n(), name)}</span>;
}

const CARD = {
  id: "m1",
  name: "Hook",
  creator: null,
  tags: [],
  plateCount: 2,
  thumbnail: null,
  fileKind: "3mf" as const,
  timeSeconds: 5100,
  weightGrams: 41.44,
  partial: false,
  numbersUnavailable: false,
};

describe("the raw-key detector", () => {
  test("finds a key rendered as it is, so a clean page means something", () => {
    render("es", <span title="shell.nav.trash">library.title</span>);
    expect(rawKeys()).toEqual(expect.arrayContaining(["library.title", "shell.nav.trash"]));
  });
});

describe.each(["es", "fr"])("in %s", (locale) => {
  test("the shell shows the language's words and no raw key", () => {
    render(locale, <Shell onAdd={() => {}} />);
    const t = createTranslator(locale, CATALOGS[locale] as Messages, CATALOGS.en as Messages);
    expect(container.textContent).toContain(t.t("shell.nav.library"));
    expect(container.textContent).toContain(t.t("shell.skip"));
    expect(t.t("shell.nav.library")).not.toBe("Library");
    expect(rawKeys()).toEqual([]);
  });

  test("a library card writes its plates, time and weight the language's way", () => {
    render(locale, <ModelCard card={CARD} />);
    const text = container.textContent ?? "";
    expect(text).toContain(locale === "fr" ? "2 plateaux" : "2 placas");
    expect(text).toContain("1 h 25 min");
    expect(text).toContain("41,4 g");
    expect(rawKeys()).toEqual([]);
  });

  test("the upload dialog and the trash show no raw key", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ models: [], readAt: new Date(0).toISOString() })),
      ),
    );
    render(
      locale,
      <>
        <UploadDialog open files={[]} onClose={() => {}} />
        <TrashList />
      </>,
    );
    expect(rawKeys()).toEqual([]);
  });
});

describe("plurals and numbers", () => {
  test("follow each language's rules: French counts 0 as one, Spanish and French have many", () => {
    const fr0 = createTranslator("fr", CATALOGS.fr as Messages, CATALOGS.en as Messages);
    expect(fr0.t("library.card.plates", { count: 0 })).toBe("0 plateau");
    expect(fr0.t("library.card.plates", { count: 1_000_000 })).toBe("1000000 de plateaux");
    const es0 = createTranslator("es", CATALOGS.es as Messages, CATALOGS.en as Messages);
    expect(es0.t("library.card.plates", { count: 0 })).toBe("0 placas");
    expect(es0.t("library.card.plates", { count: 1 })).toBe("1 placa");
  });

  test("a printer name is written again in the language", () => {
    render("fr", <PrinterName name="Bambu Lab P1S, 0.4 mm nozzle" />);
    expect(container.textContent).toBe("Bambu Lab P1S, buse de 0,4 mm");
  });
});

describe("the language menu", () => {
  const LIST: ListedLocale[] = [
    { code: "en", name: "English", source: "built-in", machineDraft: false, complete: true },
    { code: "es", name: "Espa\u00f1ol", source: "built-in", machineDraft: true, complete: true },
    { code: "fr", name: "Fran\u00e7ais", source: "built-in", machineDraft: true, complete: true },
    { code: "de", name: "Deutsch", source: "local", machineDraft: false, complete: false },
  ];

  function radio(label: string): HTMLInputElement {
    const found = [...container.querySelectorAll<HTMLLabelElement>("label")].find((l) =>
      l.textContent?.includes(label),
    );
    const input = found?.querySelector("input");
    if (input === null || input === undefined) throw new Error(`no ${label} option`);
    return input;
  }

  test("switches at once, keeps the choice in ph_lang and sets the html lang", async () => {
    render("en", <LanguagePicker list={async () => LIST} />);
    await act(async () => {});
    expect(container.textContent).toContain("machine translation, not yet reviewed");
    expect(container.textContent).toContain("partly translated, the rest in English");
    await act(async () => {
      radio("Espa\u00f1ol").click();
    });
    expect(container.querySelector("h2")?.textContent).toBe("Idioma");
    expect(document.documentElement.getAttribute("lang")).toBe("es");
    expect(savedLanguage(document)).toBe("es");
  });

  test("Browser language follows the browser's own list and clears the cookie", async () => {
    vi.stubGlobal("navigator", { ...navigator, languages: ["fr-CA", "en"] });
    // biome-ignore lint/suspicious/noDocumentCookie: the test sets the real jsdom cookie jar.
    document.cookie = "ph_lang=es; Path=/";
    render("es", <LanguagePicker list={async () => LIST} />);
    await act(async () => {});
    await act(async () => {
      radio("Fran\u00e7ais)").click();
    });
    expect(document.documentElement.getAttribute("lang")).toBe("fr");
    expect(savedLanguage(document)).toBeNull();
  });
});

describe("the language cookie and the html lang", () => {
  test("write a canonical code, clear on null, and read English when there is none", () => {
    expect(languageCookie("pt-br", false)).toBe(
      "ph_lang=pt-BR; Path=/; Max-Age=31536000; SameSite=Lax",
    );
    expect(languageCookie(null, true)).toBe("ph_lang=; Path=/; Max-Age=0; SameSite=Lax; Secure");
    expect(languageCookie("../x", false)).toContain("Max-Age=0");
    document.documentElement.removeAttribute("lang");
    expect(readLanguage(document)).toBe("en");
  });
});

describe("a language a self-hoster added", () => {
  test("comes from the server and falls back to English for what it lacks", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ code: "de", messages: { "shell.nav.library": "Bibliothek" } }),
        ),
    );
    const messages = await loadMessages("de", fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledWith("/app/api/locales/de", expect.anything());
    const t = createTranslator("de", messages, CATALOGS.en as Messages);
    expect(t.t("shell.nav.library")).toBe("Bibliothek");
    expect(t.t("shell.nav.trash")).toBe("Trash");
  });
});
