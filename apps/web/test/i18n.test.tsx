// @vitest-environment jsdom
// The web app in other languages (the maintainer, 2026-11-19): pages render in Spanish
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
import { scheduleIn } from "../src/activity/ActivityPage";
import { inboxReasonIn } from "../src/activity/Events";
import { formatCount } from "../src/activity/format";
import { loadInitialMessages, loadMessages, OVERLAY_LIST_TIMEOUT_MS } from "../src/i18n/catalogs";
import { I18nProvider, useI18n } from "../src/i18n/I18n";
import { LanguagePicker, type ListedLocale } from "../src/i18n/LanguagePicker";
import { languageCookie, readLanguage, savedLanguage } from "../src/i18n/language";
import { printerNameIn } from "../src/i18n/printers";
import { serverText } from "../src/i18n/serverText";
import { ModelCard } from "../src/library/ModelCard";
import { SortControl } from "../src/library/SortControl";
import { derivedMessageIn } from "../src/model/FilesTab";
import { PlateNumbersView } from "../src/model/Numbers";
import { sentenceFor } from "../src/settings/api";
import { Shell } from "../src/shell/Shell";
import { Sidebar } from "../src/shell/Sidebar";
import { TrashList } from "../src/trash/TrashList";
import { UploadDialog } from "../src/upload/UploadDialog";
import { resultMessage, type StartUpload, type UploadHandlers } from "../src/upload/useTusUpload";

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
        load={async (code) => ({ messages: CATALOGS[code] as Messages })}
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

/** Hands the provider's I18n to a test, as a component sees it. */
function GrabI18n({ into }: { into: (i18n: ReturnType<typeof useI18n>) => void }) {
  into(useI18n());
  return null;
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

describe("the sort note under the library's Sort menu", () => {
  const SERVER_NAME = "Bambu Lab P1S, 0.4 mm nozzle";

  function renderSort(locale: string, sort: string) {
    act(() => {
      root.render(
        <I18nProvider
          locale={locale}
          messages={CATALOGS[locale] as Messages}
          load={async (code) => ({ messages: CATALOGS[code] as Messages })}
        >
          <MemoryRouter initialEntries={[`/?sort=${sort}`]}>
            <SortControl q="" printer={SERVER_NAME} />
          </MemoryRouter>
        </I18nProvider>,
      );
    });
    return container.querySelector("p")?.textContent ?? "";
  }

  test("names the printer the server's way on an English page", () => {
    expect(renderSort("en", "time-asc")).toBe(
      `Models without a print time for ${SERVER_NAME} are listed last.`,
    );
  });

  test.each([
    ["es", "time-asc", "Bambu Lab P1S, boquilla de 0,4 mm"],
    ["fr", "weight-desc", "Bambu Lab P1S, buse de 0,4 mm"],
  ])("names the printer in the language in %s", (locale, sort, name) => {
    const note = renderSort(locale, sort);
    expect(note).toContain(name);
    expect(note).not.toContain("nozzle");
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

  /** The provider with a load whose answer for each language waits delays[code] ms. */
  function renderPicker(
    delays: Readonly<Record<string, number>>,
    overlays: Record<string, Messages> = {},
  ) {
    act(() => {
      root.render(
        <I18nProvider
          locale="en"
          messages={CATALOGS.en as Messages}
          load={async (code) => {
            await new Promise((r) => setTimeout(r, delays[code] ?? 0));
            const overlay = overlays[code];
            return {
              messages: CATALOGS[code] as Messages,
              ...(overlay === undefined
                ? {}
                : {
                    later: new Promise<Messages>((r) =>
                      setTimeout(() => r(overlay), (delays[code] ?? 0) + 40),
                    ),
                  }),
            };
          }}
        >
          <MemoryRouter>
            <LanguagePicker list={async () => LIST} />
          </MemoryRouter>
        </I18nProvider>,
      );
    });
  }

  test("two quick picks finishing out of order leave the later pick shown (issue 298)", async () => {
    renderPicker({ es: 80, fr: 5 });
    await act(async () => {});
    await act(async () => {
      radio("Espa\u00f1ol").click();
      radio("Fran\u00e7ais").click();
      // Both loads land: French first, Spanish 75 ms later.
      await new Promise((r) => setTimeout(r, 150));
    });
    expect(document.documentElement.getAttribute("lang")).toBe("fr");
    expect(container.querySelector("h2")?.textContent).toBe("Langue");
    expect(savedLanguage(document)).toBe("fr");
    expect(radio("Fran\u00e7ais").checked).toBe(true);
    expect(radio("Espa\u00f1ol").checked).toBe(false);
  });

  test("a replaced pick's LOCALES_DIR overlay is dropped when it lands", async () => {
    const esOverlay = { ...(CATALOGS.es as Messages), "language.heading": "Idioma (local)" };
    renderPicker({ es: 5, fr: 20 }, { es: esOverlay });
    await act(async () => {});
    await act(async () => {
      radio("Espa\u00f1ol").click();
      await new Promise((r) => setTimeout(r, 10));
      radio("Fran\u00e7ais").click();
      // The Spanish overlay lands at 45 ms, after French was picked.
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(document.documentElement.getAttribute("lang")).toBe("fr");
    expect(container.querySelector("h2")?.textContent).toBe("Langue");
  });

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

  test.each([
    ["before the list answers", () => new Promise<ListedLocale[]>(() => {})],
    ["when the list cannot be read", () => Promise.reject(new Error("503"))],
  ])("marks the bundled machine drafts %s", async (_when, list) => {
    render("en", <LanguagePicker list={list} />);
    await act(async () => {});
    const note = (label: string) =>
      [...container.querySelectorAll("label")]
        .find((l) => l.querySelector("span")?.textContent === label)
        ?.textContent?.includes("machine translation, not yet reviewed");
    expect(note("Espa\u00f1ol")).toBe(true);
    expect(note("Fran\u00e7ais")).toBe(true);
    expect(note("English")).toBe(false);
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

  // The first paint (PR 287 review): a built-in language renders from its
  // bundled chunk at once, and the overlay is merged when the server's list
  // answers, so a slow or hanging list never leaves the page blank.
  test("the first paint has the bundled language while the server's list still hangs", async () => {
    const fetcher = vi.fn(() => new Promise<Response>(() => {}));
    const first = await loadInitialMessages("es", fetcher as unknown as typeof fetch);
    expect(first.messages["shell.nav.library"]).toBe(
      (CATALOGS.es as Messages)["shell.nav.library"],
    );
    expect(first.later).toBeInstanceOf(Promise);
  });

  test("the overlay arrives later, merged over the bundled language", async () => {
    const merged = { ...(CATALOGS.es as Messages), "shell.nav.library": "Mi biblioteca" };
    const fetcher = vi.fn(async (url: string) =>
      url === "/app/api/locales"
        ? new Response(JSON.stringify({ locales: [{ code: "es", overlay: true }] }))
        : new Response(JSON.stringify({ code: "es", messages: merged })),
    );
    const first = await loadInitialMessages("es", fetcher as unknown as typeof fetch);
    expect(first.messages["shell.nav.library"]).toBe(
      (CATALOGS.es as Messages)["shell.nav.library"],
    );
    expect((await first.later)?.["shell.nav.library"]).toBe("Mi biblioteca");
  });

  test("nothing arrives later when the server lists no overlay or cannot be read", async () => {
    const none = vi.fn(
      async () => new Response(JSON.stringify({ locales: [{ code: "es", overlay: false }] })),
    );
    expect(await (await loadInitialMessages("es", none as unknown as typeof fetch)).later).toBe(
      undefined,
    );
    const down = vi.fn(async () => new Response("", { status: 503 }));
    expect(await (await loadInitialMessages("es", down as unknown as typeof fetch)).later).toBe(
      undefined,
    );
    // English and a self-hoster's language have nothing to merge later.
    expect((await loadInitialMessages("en", down as unknown as typeof fetch)).later).toBe(
      undefined,
    );
  });

  test("the provider shows the bundled language first and the overlay when it arrives", async () => {
    let arrive: (messages: Messages) => void = () => {};
    const later = new Promise<Messages | undefined>((resolve) => {
      arrive = resolve;
    });
    act(() => {
      root.render(
        <I18nProvider locale="es" messages={CATALOGS.es as Messages} later={later}>
          <MemoryRouter>
            <Sidebar />
          </MemoryRouter>
        </I18nProvider>,
      );
    });
    const links = () => [...container.querySelectorAll("nav a")].map((a) => a.textContent);
    expect(links()).toContain((CATALOGS.es as Messages)["shell.nav.library"]);
    await act(async () => {
      arrive({ ...(CATALOGS.es as Messages), "shell.nav.library": "Mi biblioteca" });
      await later;
    });
    expect(links()).toContain("Mi biblioteca");
  });

  test("an overlay that arrives after a switch to another language is not applied", async () => {
    let arrive: (messages: Messages) => void = () => {};
    const later = new Promise<Messages | undefined>((resolve) => {
      arrive = resolve;
    });
    let i18n: ReturnType<typeof useI18n> | undefined;
    act(() => {
      root.render(
        <I18nProvider
          locale="es"
          messages={CATALOGS.es as Messages}
          later={later}
          load={async (code) => ({ messages: CATALOGS[code] as Messages })}
        >
          <MemoryRouter>
            <GrabI18n
              into={(value) => {
                i18n = value;
              }}
            />
            <Sidebar />
          </MemoryRouter>
        </I18nProvider>,
      );
    });
    await act(async () => {
      await i18n?.setLanguage("fr", "fr");
    });
    await act(async () => {
      arrive({ ...(CATALOGS.es as Messages), "shell.nav.library": "Mi biblioteca" });
      await later;
    });
    const links = [...container.querySelectorAll("nav a")].map((a) => a.textContent);
    expect(i18n?.locale).toBe("fr");
    expect(links).toContain((CATALOGS.fr as Messages)["shell.nav.library"]);
    expect(links).not.toContain("Mi biblioteca");
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
        onRetry={async () => {}}
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

describe("every other place that shows server text follows the same rule", () => {
  const SAID = "Words only this server would write.";

  function translator(locale: string) {
    return createTranslator(locale, CATALOGS[locale] as Messages, CATALOGS.en as Messages);
  }

  test("serverText: the server's own text in English, the catalog's elsewhere, as sent with no key", () => {
    expect(serverText(translator("en"), SAID, "activity.queue.ingest")).toBe(SAID);
    expect(serverText(translator("fr"), SAID, "activity.queue.ingest")).toBe(
      translator("fr").t("activity.queue.ingest"),
    );
    expect(serverText(translator("fr"), SAID, undefined)).toBe(SAID);
  });

  test("a schedule is the server's own in English and the catalog's in French", () => {
    expect(scheduleIn(translator("en"), "Every 15 minutes (Etc/UTC)")).toBe(
      "Every 15 minutes (Etc/UTC)",
    );
    expect(scheduleIn(translator("fr"), "Every 15 minutes (Etc/UTC)")).toBe(
      translator("fr").t("activity.when.minutes", { count: 15, zone: "Etc/UTC" }),
    );
    expect(scheduleIn(translator("fr"), "17 */3 * * 1 (UTC)")).toBe("17 */3 * * 1 (UTC)");
  });

  test("an inbox file refused as a duplicate is the server's own in English and the catalog's in Spanish, never server English", () => {
    const id = "0198f0c4-0000-7000-8000-00000000000a";
    const event = {
      reason: `This file is already in the library, in the model "Clip" (id ${id}) and 1 other model, so it was skipped; nothing was saved.`,
      reasonCode: "duplicate",
      duplicate: { name: "Clip", id, others: 1 },
    };
    expect(inboxReasonIn(translator("en"), event)).toBe(event.reason);
    const spanish = inboxReasonIn(translator("es"), event);
    expect(spanish).toBe(
      translator("es").t("inbox.reason.duplicate", { name: "Clip", id, others: 1 }),
    );
    expect(spanish).toContain("Clip");
    expect(spanish).not.toBe(event.reason);
    expect(inboxReasonIn(translator("fr"), event)).not.toBe(event.reason);
    // An older file whose words the server could not read back: shown as it is.
    expect(inboxReasonIn(translator("es"), { reason: SAID, reasonCode: "duplicate" })).toBe(SAID);
    // A fixed reason by its code, as before.
    expect(inboxReasonIn(translator("es"), { reason: SAID, reasonCode: "changed" })).toBe(
      translator("es").t("inbox.reason.changed"),
    );
  });

  test("a printer name is the server's own in English, even in a form the catalog writes differently", () => {
    render("en", <PrinterName name="Bambu Lab P1S, 0.40 mm nozzle" />);
    expect(container.textContent).toBe("Bambu Lab P1S, 0.40 mm nozzle");
  });

  test("an app API refusal is the server's own sentence in English and its code's words in Spanish", () => {
    const body = { error: "bad_request", code: "stale_trash", message: SAID };
    expect(sentenceFor(400, body, translator("en"))).toBe(SAID);
    expect(sentenceFor(400, body, translator("es"))).toBe(translator("es").t("api.staleTrash"));
  });

  test("a 503 that names its code is the server's sentence in English and the code's words in French", () => {
    const body = { error: "unavailable", code: "slicer_unavailable", message: SAID };
    expect(sentenceFor(503, body, translator("en"))).toBe(SAID);
    expect(sentenceFor(503, body, translator("fr"))).toBe(
      translator("fr").t("api.slicerUnavailable"),
    );
    // A 5xx with no code the page knows still says the plain line, never the server's words.
    const plain = { error: "unavailable", message: SAID };
    expect(sentenceFor(503, plain, translator("en"))).toBe(translator("en").t("api.unavailable"));
    expect(sentenceFor(500, { error: "internal", message: SAID }, translator("en"))).toBe(
      translator("en").t("api.failed"),
    );
  });
});

describe("an upload's own outcomes on a Spanish page (issue 295)", () => {
  const UPLOAD = "https://platehouse.test/app/uploads/u-9";
  const es = createTranslator("es", CATALOGS.es as Messages, CATALOGS.en as Messages);

  /** Sends one file through the dialog on an es page; GET <upload>/result answers status. */
  async function sendWithResult(status: number): Promise<string> {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "x" }), { status })),
    );
    const handlers: UploadHandlers[] = [];
    const start: StartUpload = (_file, _target, h) => {
      handlers.push(h);
      return { abort() {} };
    };
    const file = new File(["solid a\nendsolid a\n"], "a.stl");
    render(
      "es",
      <UploadDialog open files={[file]} onClose={() => {}} start={start} resultDelayMs={0} />,
    );
    const send = container.querySelector<HTMLButtonElement>(".studio-button-primary");
    await act(async () => {
      send?.click();
    });
    await act(async () => {
      handlers[0]?.onSuccess(UPLOAD);
    });
    for (let i = 0; i < 5; i += 1) await act(async () => {});
    return container.querySelector('[data-upload="a.stl"]')?.textContent ?? "";
  }

  test("a 401 says, in Spanish, that the file was sent and to check the library", async () => {
    const row = await sendWithResult(401);
    expect(row).toContain(es.t("upload.sentSessionEnded"));
    expect(row).not.toContain(es.t("upload.failed"));
  });

  test("a 404 says, in Spanish, that it could not be confirmed and to check the library", async () => {
    const row = await sendWithResult(404);
    expect(row).toContain(es.t("upload.notConfirmed"));
    expect(row).not.toContain(es.t("upload.failed"));
  });

  test("resultMessage says the page's own codes in the shown language, never as server English", () => {
    expect(resultMessage({ status: "failed", code: "sent_session_ended" }, es)).toBe(
      es.t("upload.sentSessionEnded"),
    );
    expect(resultMessage({ status: "failed", code: "not_confirmed" }, es)).toBe(
      es.t("upload.notConfirmed"),
    );
  });
});

describe("a language pick while the language list hangs (issue 296)", () => {
  /** A fetch that never answers, and gives up only when its signal is aborted. */
  function hanging(): typeof fetch {
    return ((_url: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
  }

  test("still applies the bundled language at once", async () => {
    vi.stubGlobal("fetch", hanging());
    act(() => {
      root.render(
        <I18nProvider locale="en" messages={CATALOGS.en as Messages}>
          <LanguagePicker
            list={async () => [
              {
                code: "en",
                name: "English",
                source: "built-in",
                machineDraft: false,
                complete: true,
              },
              {
                code: "es",
                name: "Espanol",
                source: "built-in",
                machineDraft: true,
                complete: true,
              },
            ]}
          />
        </I18nProvider>,
      );
    });
    await act(async () => {});
    const option = [...container.querySelectorAll("label")].find((l) =>
      l.textContent?.startsWith("Espanol"),
    );
    const idioma = createTranslator("es", CATALOGS.es as Messages, CATALOGS.en as Messages).t(
      "language.heading",
    );
    const picked = Date.now();
    await act(async () => {
      option?.querySelector("input")?.click();
    });
    // The real Spanish chunk loads by dynamic import; wait for it, well under
    // the list's own timeout, which this pick must not wait for.
    for (let i = 0; i < 200 && container.querySelector("h2")?.textContent !== idioma; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
    expect(container.querySelector("h2")?.textContent).toBe(idioma);
    expect(Date.now() - picked).toBeLessThan(OVERLAY_LIST_TIMEOUT_MS);
    expect(document.documentElement.getAttribute("lang")).toBe("es");
  });

  test("a list that hangs past the timeout counts as no changes", async () => {
    const messages = await loadMessages("es", hanging(), 20);
    expect(messages).toEqual(CATALOGS.es);
  });
});
