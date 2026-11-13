// @vitest-environment jsdom
// Build plan Task 18, AC-074 and AC-075: where keyboard focus goes when the
// narrow-screen menu closes. Following one of its links puts focus on the
// main landmark, so the next Tab starts in the new section instead of at the
// top of the document (the panel is hidden with the link inside it, and a
// browser drops focus from a hidden element to the body). Escape puts focus
// back on the Menu button, and so does following a link when MenuButton is
// used without onNavigate. jsdom stands in for the browser's DOM; it does not
// move focus off a hidden element itself, so focus left on the link fails.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
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
