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
import { formatCount } from "../src/activity/format";
import { loadMessages } from "../src/i18n/catalogs";
import { I18nProvider, useI18n } from "../src/i18n/I18n";
import { LanguagePicker, type ListedLocale } from "../src/i18n/LanguagePicker";
import { languageCookie, readLanguage, savedLanguage } from "../src/i18n/language";
import { printerNameIn } from "../src/i18n/printers";
import { ModelCard } from "../src/library/ModelCard";
import { derivedMessageIn } from "../src/model/FilesTab";
import { PlateNumbersView } from "../src/model/Numbers";
import { Shell } from "../src/shell/Shell";
import { Sidebar } from "../src/shell/Sidebar";
import { TrashList } from "../src/trash/TrashList";
import { UploadDialog } from "../src/upload/UploadDialog";
import { resultMessage } from "../src/upload/useTusUpload";

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

/** A date and a count, as an English page writes them. */
function DateAndCount({ iso }: { iso: string }) {
  const i18n = useI18n();
  return (
    <span>
      {i18n.fmt.date(iso, true)} | {formatCount(1200, i18n)}
    </span>
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

describe("dates and counts on an English page (issue 292)", () => {
  const ISO = "2026-11-19T13:52:00Z";
  const as = (locale: string) =>
    `${new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ISO))} | ${new Intl.NumberFormat(locale).format(1200)}`;

  test("follow an en-GB browser's own format, the words still English", () => {
    vi.stubGlobal("navigator", { ...navigator, languages: ["en-GB", "en"] });
    render("en", <DateAndCount iso={ISO} />);
    expect(as("en-GB")).not.toBe(as("en"));
    expect(container.textContent).toBe(as("en-GB"));
  });

  test("fall back to plain English for a de browser that chose English", () => {
    vi.stubGlobal("navigator", { ...navigator, languages: ["de-DE", "de"] });
    render("en", <DateAndCount iso={ISO} />);
    expect(container.textContent).toBe(as("en"));
  });

  test("follow an es-MX browser on a Spanish page", () => {
    vi.stubGlobal("navigator", { ...navigator, languages: ["es-MX", "es"] });
    render("es", <DateAndCount iso={ISO} />);
    expect(container.textContent).toBe(as("es-MX"));
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

describe("a self-hoster's changes to a built-in language", () => {
  test("reach the app: picking Spanish shows the LOCALES_DIR word over the bundled one", async () => {
    const list = [
      {
        code: "en",
        name: "English",
        source: "built-in",
        machineDraft: false,
        overlay: false,
        complete: true,
      },
      {
        code: "es",
        name: "Espanol",
        source: "built-in",
        machineDraft: true,
        overlay: true,
        complete: true,
      },
    ];
    const merged = { ...(CATALOGS.es as Messages), "shell.nav.library": "Mi biblioteca" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/app/api/locales/es"
          ? new Response(JSON.stringify({ code: "es", messages: merged }))
          : new Response(JSON.stringify({ locales: list })),
      ),
    );
    // The provider's own loader: the bundled chunk, then the server's overlay.
    act(() => {
      root.render(
        <I18nProvider locale="en" messages={CATALOGS.en as Messages}>
          <MemoryRouter>
            <Sidebar />
            <LanguagePicker list={async () => list as ListedLocale[]} />
          </MemoryRouter>
        </I18nProvider>,
      );
    });
    await act(async () => {});
    const espanol = [...container.querySelectorAll("label")].find((l) =>
      l.textContent?.startsWith("Espanol"),
    );
    await act(async () => {
      espanol?.querySelector("input")?.click();
    });
    // The chunk import and the two requests take a few turns; wait for the switch.
    for (let i = 0; i < 50 && document.documentElement.getAttribute("lang") !== "es"; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(document.documentElement.getAttribute("lang")).toBe("es");
    const links = [...container.querySelectorAll("nav a")].map((a) => a.textContent);
    expect(links).toContain("Mi biblioteca");
    // The rest stays the bundled Spanish.
    expect(links).toContain((CATALOGS.es as Messages)["shell.nav.trash"]);
  });

  test("fall back to the bundled language when the overlay cannot be read", async () => {
    const fetcher = vi.fn(async (url: string) =>
      url === "/app/api/locales"
        ? new Response(JSON.stringify({ locales: [{ code: "es", overlay: true }] }))
        : new Response("", { status: 503 }),
    );
    const messages = await loadMessages("es", fetcher as unknown as typeof fetch);
    expect(messages["shell.nav.library"]).toBe((CATALOGS.es as Messages)["shell.nav.library"]);
  });

  test("ask nothing more when the server lists no overlay", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ locales: [{ code: "es", overlay: false }] })),
    );
    await loadMessages("es", fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/app/api/locales", expect.anything());
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

// A server sentence the page also holds by code (PR 287 review): an English
// page shows the sentence the server sent, never en.json's copy of it, so a
// server sentence reworded without en.json still reaches the page as sent.
// Another language shows the catalog's words for the code. SAID is a wording
// en.json does not hold, as a reworded server sentence would be.
describe("an English page and a server sentence the page knows by code", () => {
  const SAID = "The slicer stopped answering mid-render.";

  function translator(locale: string) {
    return createTranslator(locale, CATALOGS[locale] as Messages, CATALOGS.en as Messages);
  }

  test("a render message is the server's own in English and the catalog's in Spanish", () => {
    const file = {
      derivedMessage: `${SAID} exit status 1`,
      derivedCodes: ["slicerDown"],
      derivedDetail: "exit status 1",
    };
    expect(derivedMessageIn(translator("en"), file)).toBe(`${SAID} exit status 1`);
    expect(derivedMessageIn(translator("es"), file)).toBe(
      `${translator("es").t("derived.slicerDown")} exit status 1`,
    );
  });

  test("an upload result is the server's own in English and the catalog's in Spanish", () => {
    const result = { status: "failed" as const, error: SAID, code: "ingest_failed" };
    expect(resultMessage(result, translator("en"))).toBe(SAID);
    expect(resultMessage(result, translator("es"))).toBe(
      translator("es").t("upload.result.ingestFailed"),
    );
  });

  function failedPlate() {
    return (
      <PlateNumbersView
        numbers={{
          failure: { estimateId: "est-1", reason: "bed_too_small", words: SAID, detail: null },
        }}
        printer="p1s"
        printerName="Bambu Lab P1S, 0.4 mm nozzle"
        projectFilaments={[]}
        pending={false}
        onRetry={async () => true}
      />
    );
  }

  test("a plate that could not be sliced says the server's words on an English page", () => {
    render("en", failedPlate());
    expect(container.textContent).toContain(SAID);
    expect(container.textContent).not.toContain(translator("en").t("estimate.reason.bedTooSmall"));
  });

  test("a plate that could not be sliced says the catalog's words on a Spanish page", () => {
    render("es", failedPlate());
    expect(container.textContent).toContain(translator("es").t("estimate.reason.bedTooSmall"));
    expect(container.textContent).not.toContain(SAID);
  });
});
