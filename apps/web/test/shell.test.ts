// Build plan Task 18, AC-070, AC-071, AC-074 and AC-075: the shell around
// every page. Rendered to static markup (react-dom/server) inside a memory
// router: a left sidebar with Library, Creators, Collections and Tags (and,
// since Task 21, Trash and Settings), a top
// bar with the narrow-screen menu button, search and Add, the Dark / Light /
// System switch, a skip link and the main landmark. Also: index.html carries
// the defaults the server rewrites (data-theme and the color-scheme meta),
// and no source file opens a native browser dialog.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, test } from "vitest";
import { Shell } from "../src/shell/Shell";
import type { Theme } from "../src/shell/theme";

function render(path: string, initialTheme?: Theme): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(
        Shell,
        initialTheme === undefined ? {} : { initialTheme },
        createElement("p", { id: "page" }, "page body"),
      ),
    ),
  );
}

/** Every opening tag of that element, in document order. */
function tags(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, "g"))].map((m) => m[0]);
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

/** The text of the first element of that name whose opening tag matches. */
function textOf(html: string, tag: string): string {
  const start = html.indexOf(tag);
  const name = /^<([a-z]+)/.exec(tag)?.[1] ?? "";
  const end = html.indexOf(`</${name}>`, start);
  return html.slice(start + tag.length, end).replace(/<[^>]+>/g, "");
}

describe("the sidebar", () => {
  const SECTIONS: Array<[string, string]> = [
    ["Library", "/"],
    ["Creators", "/creators"],
    ["Collections", "/collections"],
    ["Tags", "/tags"],
    // Task 21's pages.
    ["Trash", "/trash"],
    ["Settings", "/settings"],
  ];

  test("links Library, Creators, Collections, Tags, Trash and Settings in a labelled navigation", () => {
    const html = render("/");
    const nav = tags(html, "nav").find((t) => attr(t, "class")?.includes("studio-sidebar"));
    expect(nav, "no sidebar nav").toBeDefined();
    expect(attr(nav as string, "aria-label")).toBe("Main");
    // The section links are the nav list; the brand above it also links home.
    const start = html.indexOf('<ul class="studio-nav-list">', html.indexOf(nav as string));
    expect(start, "no nav list in the sidebar").toBeGreaterThan(-1);
    const sidebar = html.slice(start, html.indexOf("</ul>", start));
    expect(tags(sidebar, "a")).toHaveLength(SECTIONS.length);
    for (const [label, href] of SECTIONS) {
      const link = tags(sidebar, "a").find((t) => attr(t, "href") === href);
      expect(link, `no ${label} link`).toBeDefined();
      expect(textOf(sidebar, link as string)).toBe(label);
    }
  });

  test.each(SECTIONS)("marks %s as the current page at %s, and only it", (label, path) => {
    const html = render(path);
    const nav = tags(html, "nav").find((t) => attr(t, "class")?.includes("studio-sidebar"));
    const sidebar = html.slice(html.indexOf(nav as string), html.indexOf("</nav>"));
    const current = tags(sidebar, "a").filter((t) => attr(t, "aria-current") === "page");
    expect(current).toHaveLength(1);
    expect(textOf(sidebar, current[0] as string)).toBe(label);
  });
});

describe("the top bar", () => {
  test("has a labelled search box in a search landmark", () => {
    const html = render("/");
    const landmark = tags(html, "search")[0];
    expect(landmark, "no search landmark").toBeDefined();
    const inside = html.slice(html.indexOf(landmark as string), html.indexOf("</search>"));
    expect(tags(inside, "form"), "no form in the search landmark").toHaveLength(1);
    const input = tags(inside, "input").find((t) => attr(t, "type") === "search");
    expect(input, "no search input").toBeDefined();
    expect(attr(input as string, "name")).toBe("q");
    const id = attr(input as string, "id");
    const label = tags(html, "label").find((t) => attr(t, "for") === id);
    expect(label, "the search input has no label").toBeDefined();
    expect(textOf(html, label as string)).toBe("Search the library");
  });

  test("has an Add button", () => {
    const html = render("/");
    const add = tags(html, "button").find((t) =>
      attr(t, "class")?.includes("studio-button-primary"),
    );
    expect(add, "no Add button").toBeDefined();
    expect(textOf(html, add as string)).toContain("Add");
  });

  test("has a menu button for narrow screens that controls the menu panel", () => {
    const html = render("/");
    const button = tags(html, "button").find((t) => attr(t, "aria-controls") !== undefined);
    expect(button, "no menu button").toBeDefined();
    expect(textOf(html, button as string)).toBe("Menu");
    expect(attr(button as string, "aria-expanded")).toBe("false");
    const panelId = attr(button as string, "aria-controls");
    const panel = tags(html, "div").find((t) => attr(t, "id") === panelId);
    expect(panel, "the menu button controls no element").toBeDefined();
    expect(panel).toMatch(/\shidden=""/);
    const menu = html.slice(html.indexOf(panel as string));
    for (const href of ["/", "/creators", "/collections", "/tags"]) {
      expect(
        tags(menu, "a").some((t) => attr(t, "href") === href),
        href,
      ).toBe(true);
    }
  });
});

describe("the theme switch", () => {
  /** The switch's markup: a fieldset (role group) named Theme by its legend. */
  function switchHtml(html: string): string {
    const group = tags(html, "fieldset").find((t) =>
      attr(t, "class")?.includes("studio-theme-switch"),
    );
    expect(group, "no theme switch").toBeDefined();
    const start = html.indexOf(group as string);
    const inside = html.slice(start, html.indexOf("</fieldset>", start));
    const legend = tags(inside, "legend")[0];
    expect(legend, "the theme switch has no legend").toBeDefined();
    expect(textOf(inside, legend as string)).toBe("Theme");
    return inside;
  }

  function switchButtons(html: string): Map<string, string> {
    // Read each button in place: two unpressed buttons have the same tag.
    const buttons = new Map<string, string>();
    for (const m of switchHtml(html).matchAll(/(<button\b[^>]*>)(.*?)<\/button>/g)) {
      buttons.set(
        (m[2] as string).replace(/<[^>]+>/g, ""),
        attr(m[1] as string, "aria-pressed") ?? "",
      );
    }
    return buttons;
  }

  test("offers Dark, Light and System, with Dark pressed by default", () => {
    expect([...switchButtons(render("/")).entries()]).toEqual([
      ["Dark", "true"],
      ["Light", "false"],
      ["System", "false"],
    ]);
  });

  test.each([
    ["light", "Light"],
    ["system", "System"],
  ] as const)("presses %s when that is the theme", (theme, label) => {
    const buttons = switchButtons(render("/", theme));
    for (const [name, pressed] of buttons) expect(pressed, name).toBe(String(name === label));
  });

  test("its buttons are buttons, not a form that posts and reloads", () => {
    const html = render("/");
    const inside = switchHtml(html);
    expect(inside).not.toContain("<form");
    const buttons = tags(inside, "button");
    expect(buttons).toHaveLength(3);
    for (const tag of buttons) expect(attr(tag, "type")).toBe("button");
  });
});

describe("the page frame", () => {
  test("has a skip link to the main landmark, which holds the page", () => {
    const html = render("/");
    const skip = tags(html, "a").find((t) => attr(t, "class") === "studio-skip");
    expect(skip, "no skip link").toBeDefined();
    expect(attr(skip as string, "href")).toBe("#ph-content");
    const main = tags(html, "main")[0];
    expect(attr(main as string, "id")).toBe("ph-content");
    expect(attr(main as string, "tabindex")).toBe("-1");
    expect(html.indexOf('<p id="page">page body</p>')).toBeGreaterThan(
      html.indexOf(main as string),
    );
  });

  // Issue #205: the top bar was a plain div, so the theme switch sat outside
  // every landmark and axe's region rule failed on every page. A header that
  // is not inside main, nav, aside, section or article is the banner
  // landmark, and the page keeps exactly one banner and one main.
  test("the top bar is the page's one banner: a header outside every other landmark, holding the menu, search, Add and the theme switch", () => {
    const html = render("/");
    const headers = tags(html, "header");
    expect(headers, "the top bar is not a header").toHaveLength(1);
    const header = headers[0] as string;
    expect(attr(header, "class")).toBe("studio-topbar");
    expect(html).not.toMatch(/\srole="banner"/);
    expect(tags(html, "main")).toHaveLength(1);

    // Not nested in another landmark or sectioning element, where a header
    // stops being the banner.
    const before = html.slice(0, html.indexOf(header));
    for (const name of ["main", "nav", "aside", "section", "article"]) {
      const opened = tags(before, name).length;
      const closed = before.split(`</${name}>`).length - 1;
      expect(opened - closed, `the header is inside a ${name}`).toBe(0);
    }

    const start = html.indexOf(header);
    const inside = html.slice(start, html.indexOf("</header>", start));
    expect(
      tags(inside, "fieldset").some((t) => attr(t, "class")?.includes("studio-theme-switch")),
    ).toBe(true);
    expect(tags(inside, "search")).toHaveLength(1);
    expect(tags(inside, "button").some((t) => attr(t, "aria-controls") !== undefined)).toBe(true);
    expect(
      tags(inside, "button").some((t) => attr(t, "class")?.includes("studio-button-primary")),
    ).toBe(true);
    // Same order as before: the top bar comes before main, so Tab still
    // reaches the menu, search, Add and the theme switch before the page.
    expect(start).toBeLessThan(html.indexOf(tags(html, "main")[0] as string));
  });
});

describe("index.html", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

  test("defaults to dark: one data-theme on the html element and one color-scheme meta", () => {
    expect(html.match(/<html\b[^>]*>/g)).toEqual(['<html lang="en" data-theme="dark">']);
    expect(html.match(/data-theme=/g)).toHaveLength(1);
    expect(html.match(/<meta name="color-scheme" content="dark" \/>/g)).toHaveLength(1);
    expect(html.match(/color-scheme/g)).toHaveLength(1);
  });

  test("loads nothing from another host", () => {
    expect(html).not.toMatch(/(?:src|href)="(?:https?:)?\/\//);
  });
});

test("no source file opens a native browser dialog", () => {
  const root = fileURLToPath(new URL("../src", import.meta.url));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name)) files.push(path);
    }
  };
  walk(root);
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    expect(source, file).not.toMatch(/\b(?:alert|confirm|prompt)\s*\(/);
  }
});
