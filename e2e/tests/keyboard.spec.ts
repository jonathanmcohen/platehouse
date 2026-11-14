// The keyboard path (build plan Task 22; AC-075 keyboard and focus). On every
// page, Tab from the top of the document reaches every control shown, and
// every control it lands on has a visible focus outline: outline-style not
// none, at least 1 px wide and not transparent. Both themes.
//
// "Every control" is every visible element in the tab order (links, buttons,
// form fields, summary and anything with tabindex 0 or more) that is not
// disabled. A radio group counts once, since Tab enters a group at one radio.
// Elements with tabindex -1 (the main landmark, an inactive tab in a tab
// list) are out of the tab order on purpose and are not counted.
import { expect, type Page, test } from "@playwright/test";
import { ORIGIN } from "../support/env.js";
import { ALL_PAGES, openPage } from "../support/pages.js";

interface Stop {
  /** The control's index from markControls, or null for an unmarked element or the body. */
  id: number | null;
  label: string;
  outline: { style: string; width: string; color: string };
}

/**
 * Marks every control the page shows with data-e2e-control and returns their
 * labels by index. A radio group is one control: its radios share an index.
 */
async function markControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const selector = [
      "a[href]",
      "button",
      "input",
      "select",
      "textarea",
      "summary",
      "[tabindex]",
      '[contenteditable="true"]',
    ].join(",");
    const labels: string[] = [];
    const groups = new Map<string, number>();
    const describeControl = (el: Element) => {
      const name =
        el.getAttribute("aria-label") ??
        (el as HTMLElement).textContent?.trim().slice(0, 40) ??
        el.getAttribute("name") ??
        "";
      return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""} "${name}"`;
    };
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (el.tabIndex < 0) continue;
      if ((el as HTMLButtonElement).disabled) continue;
      if (el.closest("[inert]")) continue;
      if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) continue;
      if (el instanceof HTMLInputElement && el.type === "hidden") continue;
      if (el instanceof HTMLInputElement && el.type === "radio" && el.name !== "") {
        const key = `${el.form?.id ?? ""}:${el.name}`;
        const known = groups.get(key);
        if (known !== undefined) {
          el.dataset.e2eControl = String(known);
          continue;
        }
        groups.set(key, labels.length);
      }
      el.dataset.e2eControl = String(labels.length);
      labels.push(describeControl(el));
    }
    return labels;
  });
}

async function focused(page: Page): Promise<Stop | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (el === null || el === document.body || el === document.documentElement) return null;
    const style = getComputedStyle(el);
    const raw = (el as HTMLElement).dataset?.e2eControl;
    return {
      id: raw === undefined ? null : Number(raw),
      label: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""} "${(el as HTMLElement).textContent?.trim().slice(0, 40) ?? ""}"`,
      outline: { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor },
    };
  });
}

/** True for a colour with no alpha: transparent, rgba(..., 0) or a #rrggbb00 form. */
function transparent(color: string): boolean {
  if (color === "transparent") return true;
  const rgba = /rgba?\(([^)]+)\)/.exec(color);
  if (rgba === null) return false;
  const parts = (rgba[1] ?? "").split(/[,\s/]+/).filter(Boolean);
  return parts.length === 4 && Number(parts[3]) === 0;
}

for (const theme of ["dark", "light"] as const) {
  for (const target of ALL_PAGES) {
    test(`keyboard: Tab reaches every control on ${target.name} in ${theme} with a visible outline`, async ({
      page,
      context,
    }) => {
      await context.addCookies([{ name: "ph_theme", value: theme, url: ORIGIN }]);
      await openPage(page, target);
      const controls = await markControls(page);
      expect(controls.length, "controls on the page").toBeGreaterThan(0);

      // Start before the first element of the document.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const reached = new Set<number>();
      const badOutline: string[] = [];
      const seen: string[] = [];
      let first: string | null = null;
      for (let press = 0; press < 400; press += 1) {
        await page.keyboard.press("Tab");
        const stop = await focused(page);
        if (stop === null) {
          if (press > 0) break;
          continue;
        }
        const key = `${stop.id ?? "x"}|${stop.label}`;
        if (key === first) break;
        first ??= key;
        seen.push(stop.label);
        if (stop.id !== null) reached.add(stop.id);
        const width = Number.parseFloat(stop.outline.width);
        if (stop.outline.style === "none" || !(width >= 1) || transparent(stop.outline.color)) {
          badOutline.push(
            `${stop.label}: outline ${stop.outline.style} ${stop.outline.width} ${stop.outline.color}`,
          );
        }
      }

      const missed = controls.filter((_, i) => !reached.has(i));
      expect(missed, `controls Tab never reached (reached in order: ${seen.join(", ")})`).toEqual(
        [],
      );
      expect(badOutline, "focused controls without a visible outline").toEqual([]);
    });
  }
}
