// @vitest-environment jsdom
// The Accent colour picker in Settings (Jon, 2026-11-19): twelve swatches as
// a radio group. Arrow keys move the choice and the focus together (Right
// and Down forward, Left and Up back, wrapping; Home and End to the ends),
// only the checked swatch is in the tab order, each swatch is named by its
// scheme's name, and a pick applies at once: the html element's data-accent
// and the ph_accent cookie change with no reload, so the whole app is the
// live preview. The picker starts from the accent the server wrote into the
// html element.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AccentPicker } from "../src/settings/AccentPicker";
import { SettingsPage } from "../src/settings/SettingsPage";
import { AccentProvider } from "../src/shell/AccentContext";
import { ACCENTS, type AccentId, DEFAULT_ACCENT } from "../src/shell/accent";
import { ACCENT_LABELS, ACCENT_NAMES } from "../src/shell/accentLabels";
import { Shell } from "../src/shell/Shell";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  document.documentElement.removeAttribute("data-accent");
  // Clear the cookie the last test left.
  // biome-ignore lint/suspicious/noDocumentCookie: the test reads and clears the real jsdom cookie jar.
  document.cookie = "ph_accent=; Path=/; Max-Age=0";
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function renderPicker(initial: AccentId = DEFAULT_ACCENT) {
  act(() => {
    root.render(
      <AccentProvider initial={initial}>
        <AccentPicker />
      </AccentProvider>,
    );
  });
}

function group(): HTMLElement {
  const found = container.querySelectorAll<HTMLElement>('[role="radiogroup"]');
  expect(found).toHaveLength(1);
  return found[0] as HTMLElement;
}

function radios(): HTMLElement[] {
  return [...group().querySelectorAll<HTMLElement>('[role="radio"]')];
}

function radio(id: AccentId): HTMLElement {
  return radios()[ACCENTS.indexOf(id)] as HTMLElement;
}

function checked(): string[] {
  return radios()
    .filter((r) => r.getAttribute("aria-checked") === "true")
    .map((r) => r.textContent?.trim() ?? "");
}

function key(target: HTMLElement, name: string) {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function cookieValue(): string | undefined {
  return /(?:^|; )ph_accent=([^;]*)/.exec(document.cookie)?.[1];
}

describe("the radio group", () => {
  test("is named Accent colour by its heading", () => {
    renderPicker();
    const labelledBy = group().getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy as string)?.textContent).toBe(ACCENT_LABELS.heading);
    expect(ACCENT_LABELS.heading).toBe("Accent colour");
  });

  test("holds twelve radios, each named by its scheme's name and nothing else", () => {
    renderPicker();
    expect(radios()).toHaveLength(12);
    expect(radios().map((r) => r.textContent?.trim())).toEqual(
      ACCENTS.map((id) => ACCENT_NAMES[id]),
    );
    for (const r of radios()) {
      expect(r.getAttribute("aria-label")).toBeNull();
      expect(r.getAttribute("aria-checked")).toMatch(/^(true|false)$/);
    }
  });

  test("checks the scheme it starts with, and only that one is in the tab order", () => {
    renderPicker("amber");
    expect(checked()).toEqual(["Amber"]);
    expect(radios().map((r) => r.tabIndex)).toEqual(ACCENTS.map((id) => (id === "amber" ? 0 : -1)));
  });

  test("each swatch carries its scheme, so the stylesheet colours it", () => {
    renderPicker();
    for (const id of ACCENTS) {
      expect(radio(id).querySelector(`[data-accent="${id}"]`), id).not.toBeNull();
    }
  });

  test("the swatch colour is decorative: the name is the label", () => {
    renderPicker();
    for (const id of ACCENTS) {
      expect(radio(id).querySelector(`[data-accent="${id}"]`)?.getAttribute("aria-hidden")).toBe(
        "true",
      );
    }
  });
});

describe("the keyboard", () => {
  test.each(["ArrowRight", "ArrowDown"])("%s checks and focuses the next scheme", (name) => {
    renderPicker("bambu-green");
    radio("bambu-green").focus();
    const event = key(radio("bambu-green"), name);
    expect(event.defaultPrevented).toBe(true);
    expect(checked()).toEqual(["Workshop green"]);
    expect(document.activeElement).toBe(radio("workshop-green"));
    expect(radio("workshop-green").tabIndex).toBe(0);
    expect(radio("bambu-green").tabIndex).toBe(-1);
  });

  test.each(["ArrowLeft", "ArrowUp"])("%s checks and focuses the previous scheme", (name) => {
    renderPicker("coral");
    radio("coral").focus();
    key(radio("coral"), name);
    expect(checked()).toEqual(["PLA violet"]);
    expect(document.activeElement).toBe(radio("pla-violet"));
  });

  test("forward from the last wraps to the first, and back from the first to the last", () => {
    renderPicker("lime");
    key(radio("lime"), "ArrowRight");
    expect(checked()).toEqual(["Green"]);
    key(radio("bambu-green"), "ArrowLeft");
    expect(checked()).toEqual(["Lime"]);
    expect(document.activeElement).toBe(radio("lime"));
  });

  test("Home and End go to the first and last scheme", () => {
    renderPicker("coral");
    key(radio("coral"), "End");
    expect(checked()).toEqual(["Lime"]);
    key(radio("lime"), "Home");
    expect(checked()).toEqual(["Green"]);
    expect(document.activeElement).toBe(radio("bambu-green"));
  });

  test("Tab and other keys are left alone", () => {
    renderPicker("coral");
    for (const name of ["Tab", "a", "Escape"]) {
      expect(key(radio("coral"), name).defaultPrevented, name).toBe(false);
    }
    expect(checked()).toEqual(["Coral"]);
  });

  test("walking all twelve with the arrows visits each scheme once", () => {
    renderPicker("bambu-green");
    const seen: string[] = [];
    let at: AccentId = "bambu-green";
    for (let i = 0; i < 12; i++) {
      key(radio(at), "ArrowRight");
      at = document.documentElement.getAttribute("data-accent") as AccentId;
      seen.push(at);
    }
    expect(seen).toEqual([...ACCENTS.slice(1), ACCENTS[0]]);
  });
});

describe("a pick applies at once", () => {
  test("a click checks the scheme, writes data-accent and the cookie", () => {
    renderPicker("bambu-green");
    act(() => radio("sky-blue").click());
    expect(checked()).toEqual(["Sky blue"]);
    expect(document.documentElement.getAttribute("data-accent")).toBe("sky-blue");
    expect(cookieValue()).toBe("sky-blue");
  });

  test("an arrow key writes data-accent and the cookie too", () => {
    renderPicker("magenta");
    key(radio("magenta"), "ArrowRight");
    expect(document.documentElement.getAttribute("data-accent")).toBe("graphite");
    expect(cookieValue()).toBe("graphite");
  });

  test("leaves the theme alone", () => {
    document.documentElement.setAttribute("data-theme", "light");
    renderPicker();
    act(() => radio("coral").click());
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  test("shows a preview of the scheme's button, text, chip and progress bar", () => {
    renderPicker();
    const preview = container.querySelector(".ph-accent-preview");
    expect(preview).not.toBeNull();
    expect(preview?.getAttribute("aria-hidden")).toBe("true");
    expect(preview?.querySelector(".studio-button-primary")).not.toBeNull();
    expect(preview?.querySelector("progress")).not.toBeNull();
    // Nothing in it can take focus.
    expect(preview?.querySelectorAll("button, a, input, [tabindex]")).toHaveLength(0);
  });
});

describe("in the app", () => {
  test("the Shell starts the picker from the accent the server wrote", () => {
    document.documentElement.setAttribute("data-accent", "spool-teal");
    act(() => {
      root.render(
        <MemoryRouter initialEntries={["/settings"]}>
          <Shell>
            <AccentPicker />
          </Shell>
        </MemoryRouter>,
      );
    });
    expect(checked()).toEqual(["Spool teal"]);
  });

  test("an unknown accent on the html element starts the picker at the default", () => {
    document.documentElement.setAttribute("data-accent", "sepia");
    act(() => {
      root.render(
        <MemoryRouter>
          <Shell>
            <AccentPicker />
          </Shell>
        </MemoryRouter>,
      );
    });
    expect(checked()).toEqual([ACCENT_NAMES[DEFAULT_ACCENT]]);
  });

  test("the Settings page has the Accent colour section", () => {
    // The settings, tokens and trash requests never answer: only the
    // picker matters here, and it needs none of them.
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    act(() => {
      root.render(
        <MemoryRouter initialEntries={["/settings"]}>
          <SettingsPage />
        </MemoryRouter>,
      );
    });
    expect(group()).toBeDefined();
    expect(radios()).toHaveLength(12);
    const headings = [...container.querySelectorAll("h2")].map((h) => h.textContent);
    expect(headings).toContain("Accent colour");
  });
});

describe("the stylesheet", () => {
  // Under jsdom, new URL(path, import.meta.url) is not a file URL; join the path instead.
  const css = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/styles/studio.css"),
    "utf8",
  );

  test("never takes the focus ring off a swatch", () => {
    const rules = [...css.matchAll(/([^{}]*ph-accent[^{}]*)\{([^{}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(0);
    for (const m of rules) expect(m[2], m[1]).not.toMatch(/outline:\s*(none|0)/);
  });

  test("marks the checked swatch by more than colour", () => {
    expect(css).toMatch(/\.ph-accent-option\[aria-checked="true"\][^{]*\{[^}]*/);
    expect(css).toMatch(/\.ph-accent-option\[aria-checked="true"\] \.ph-accent-swatch::after\s*\{/);
  });
});
