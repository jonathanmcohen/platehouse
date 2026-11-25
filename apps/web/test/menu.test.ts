// @vitest-environment jsdom
// Where keyboard focus goes when the
// narrow-screen menu closes. Following one of its links puts focus on the
// main landmark, so the next Tab starts in the new section instead of at the
// top of the document (the panel is hidden with the link inside it, and a
// browser drops focus from a hidden element to the body). Escape puts focus
// back on the Menu button, and so does following a link when MenuButton is
// used without onNavigate. jsdom stands in for the browser's DOM; it does not
// move focus off a hidden element itself, so focus left on the link fails.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  Link,
  MemoryRouter,
  type NavigateFunction,
  Route,
  Routes,
  useNavigate,
} from "react-router";
import { afterEach, beforeEach, expect, test } from "vitest";
import { MenuButton } from "../src/shell/MenuButton";
import { Shell } from "../src/shell/Shell";
import { SECTIONS } from "../src/shell/Sidebar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/"] },
        createElement(
          Shell,
          null,
          createElement(
            Routes,
            null,
            SECTIONS.map(({ label, to }) =>
              createElement(Route, {
                key: to,
                path: to,
                element: createElement("h1", null, label),
              }),
            ),
          ),
        ),
      ),
    );
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function menuButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>("button[aria-controls]");
  if (button === null) throw new Error("no menu button");
  return button;
}

function panel(): HTMLElement {
  const id = menuButton().getAttribute("aria-controls") ?? "";
  const element = document.getElementById(id);
  if (element === null) throw new Error("the menu button controls no element");
  return element;
}

async function openMenu() {
  await act(async () => menuButton().click());
  expect(panel().hidden).toBe(false);
  expect(menuButton().getAttribute("aria-expanded")).toBe("true");
}

test("following a menu link closes the menu and puts focus on the main landmark", async () => {
  await openMenu();
  const link = [...panel().querySelectorAll("a")].find((a) => a.textContent === "Creators");
  if (link === undefined) throw new Error("no Creators link in the menu");
  link.focus();
  expect(document.activeElement).toBe(link);

  await act(async () => link.click());

  expect(container.querySelector("h1")?.textContent).toBe("Creators");
  expect(panel().hidden).toBe(true);
  expect(menuButton().getAttribute("aria-expanded")).toBe("false");
  const main = container.querySelector("main");
  expect(main?.id).toBe("ph-content");
  expect(document.activeElement).toBe(main);
});

test("Escape closes the menu and puts focus back on the Menu button", async () => {
  await openMenu();
  const link = panel().querySelector("a");
  link?.focus();

  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  expect(panel().hidden).toBe(true);
  expect(document.activeElement).toBe(menuButton());
});

test("used without onNavigate, following a menu link puts focus back on the Menu button", async () => {
  await act(async () => {
    root.render(createElement(MemoryRouter, { initialEntries: ["/"] }, createElement(MenuButton)));
  });
  await openMenu();
  const link = panel().querySelector("a");
  if (link === null) throw new Error("no link in the menu");
  link.focus();

  await act(async () => link.click());

  expect(panel().hidden).toBe(true);
  expect(document.activeElement).toBe(menuButton());
});

// Issue #187: following an in-app link that changes page (a card's link to
// a model page, Show in the library) left keyboard focus on the page body,
// because the link went away with the old page, so a keyboard or
// screen-reader user started again from the top of the document. The shell
// now puts focus on the main landmark after any client-side change of page,
// once, in one place, as the skip link and the menu do. Back and Forward
// leave focus where the browser restores it, and a search keeps focus in
// the search box.
let go: NavigateFunction;

function GrabNavigate() {
  go = useNavigate();
  return null;
}

/** The shell with pages whose content links to another page, as a card or Show in the library does. */
async function renderLinkedPages(path: string) {
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(GrabNavigate),
        createElement(
          Shell,
          null,
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: "/",
              element: createElement(
                "div",
                null,
                createElement("h1", null, "Library"),
                createElement(Link, { to: "/models/abc" }, "Open the model"),
              ),
            }),
            createElement(Route, {
              path: "/models/:id",
              element: createElement(
                "div",
                null,
                createElement("h1", null, "A model"),
                createElement(Link, { to: "/?tag=PLA" }, "Show in the library"),
              ),
            }),
            createElement(Route, {
              path: "/creators",
              element: createElement("h1", null, "Creators"),
            }),
          ),
        ),
      ),
    );
  });
}

function main(): HTMLElement {
  const element = container.querySelector("main");
  if (element === null) throw new Error("no main landmark");
  return element;
}

function pageLink(text: string): HTMLAnchorElement {
  const link = [...main().querySelectorAll<HTMLAnchorElement>("a")].find(
    (a) => a.textContent === text,
  );
  if (link === undefined) throw new Error(`no ${text} link in the page`);
  return link;
}

test("following a link in the page to another page puts focus on the main landmark", async () => {
  await renderLinkedPages("/");
  const link = pageLink("Open the model");
  link.focus();
  await act(async () => link.click());
  expect(container.querySelector("h1")?.textContent).toBe("A model");
  expect(document.activeElement).toBe(main());

  // And back to the library from the model page's own link.
  const back = pageLink("Show in the library");
  back.focus();
  await act(async () => back.click());
  expect(container.querySelector("h1")?.textContent).toBe("Library");
  expect(document.activeElement).toBe(main());
});

test("following a sidebar link puts focus on the main landmark", async () => {
  await renderLinkedPages("/");
  const link = [...container.querySelectorAll<HTMLAnchorElement>("nav.studio-sidebar a")].find(
    (a) => a.textContent === "Creators",
  );
  if (link === undefined) throw new Error("no Creators link in the sidebar");
  link.focus();
  await act(async () => link.click());
  expect(container.querySelector("h1")?.textContent).toBe("Creators");
  expect(document.activeElement).toBe(main());
});

test("Back and Forward do not move focus to the main landmark", async () => {
  await renderLinkedPages("/");
  await act(async () => pageLink("Open the model").click());
  const button = menuButton();
  button.focus();
  await act(async () => go(-1));
  expect(container.querySelector("h1")?.textContent).toBe("Library");
  expect(document.activeElement).toBe(button);
  await act(async () => go(1));
  expect(container.querySelector("h1")?.textContent).toBe("A model");
  expect(document.activeElement).toBe(button);
});

test("a search from another page keeps focus in the search box", async () => {
  await renderLinkedPages("/creators");
  const input = container.querySelector<HTMLInputElement>('input[type="search"][name="q"]');
  if (input === null || input.form === null) throw new Error("no search box");
  input.focus();
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(input, "benchy");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.form?.requestSubmit());
  expect(container.querySelector("h1")?.textContent).toBe("Library");
  expect(document.activeElement).toBe(input);
});
