// @vitest-environment jsdom
// Build plan Task 18, AC-071: the top bar's search box shows the search in
// the URL. The shell, and the box with it, stays mounted while the routes
// change, so after the user has typed in it the box must still follow ?q=
// on Back, Forward and a sidebar link; the library page (Task 19) reads ?q=
// and the box and the results must not disagree. Submitting keeps focus in
// the box.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, type NavigateFunction, Route, Routes, useNavigate } from "react-router";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Shell } from "../src/shell/Shell";
import { SECTIONS } from "../src/shell/Sidebar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let navigate: NavigateFunction;

function GrabNavigate() {
  navigate = useNavigate();
  return null;
}

beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ["/"] },
        createElement(GrabNavigate),
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

function box(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="search"][name="q"]');
  if (input === null) throw new Error("no search box");
  return input;
}

/** Types text into the box the way a user does: a new value, then an input event. */
async function type(text: string) {
  const input = box();
  input.focus();
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  const form = box().form;
  if (form === null) throw new Error("the search box is in no form");
  await act(async () => form.requestSubmit());
}

test("after two searches, Back and Forward put each URL's search back in the box", async () => {
  await type("a");
  await submit();
  await type("b");
  await submit();
  expect(box().value).toBe("b");
  expect(document.activeElement).toBe(box());

  await act(async () => navigate(-1));
  expect(box().value).toBe("a");

  await act(async () => navigate(1));
  expect(box().value).toBe("b");

  await act(async () => navigate(-2));
  expect(box().value).toBe("");
});

test("following a sidebar link to a page with no search empties the box", async () => {
  await type("benchy");
  await submit();
  expect(box().value).toBe("benchy");

  const link = [...container.querySelectorAll<HTMLAnchorElement>("nav a")].find(
    (a) => a.textContent === "Creators",
  );
  if (link === undefined) throw new Error("no Creators link in the sidebar");
  await act(async () => link.click());

  expect(container.querySelector("h1")?.textContent).toBe("Creators");
  expect(box().value).toBe("");
});
