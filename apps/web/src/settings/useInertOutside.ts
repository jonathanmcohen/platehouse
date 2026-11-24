// Keeps the page behind an open dialog out of reach. While a dialog is
// mounted, every element beside it, and beside each of its ancestors up to
// the body, gets the inert attribute: Tab, a screen reader's reading keys and
// a click cannot reach it, wherever focus has been (the address bar, say).
//
// Dialogs can nest (a confirmation asked from inside another dialog). Each
// element is counted, so an inner dialog closing takes off only what it
// added and the outer dialog's isolation stays until the outer one closes.
// An element that was inert before any dialog opened is not counted, so it
// stays inert afterwards.
import { type RefObject, useEffect } from "react";

/** How many open dialogs are holding each element inert. */
const holds = new Map<Element, number>();

export function useInertOutside(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const start = ref.current;
    if (!active || start === null) return;
    const mine: Element[] = [];
    let node: Element = start;
    while (node !== document.body && node.parentElement !== null) {
      const parent: Element = node.parentElement;
      for (const sibling of parent.children) {
        if (sibling === node) continue;
        const count = holds.get(sibling);
        if (count !== undefined) {
          holds.set(sibling, count + 1);
          mine.push(sibling);
        } else if (!sibling.hasAttribute("inert")) {
          holds.set(sibling, 1);
          sibling.setAttribute("inert", "");
          mine.push(sibling);
        }
      }
      node = parent;
    }
    return () => {
      for (const element of mine) {
        const count = (holds.get(element) ?? 1) - 1;
        if (count > 0) {
          holds.set(element, count);
        } else {
          holds.delete(element);
          element.removeAttribute("inert");
        }
      }
    };
  }, [ref, active]);
}
