// Keeps the page behind an open dialog out of reach. While a dialog is
// mounted, every element beside it, and beside each of its ancestors up to
// the body, gets the inert attribute: Tab, a screen reader's reading keys and
// a click cannot reach it, wherever focus has been (the address bar, say).
// An element added beside the dialog or an ancestor while it is open (a route
// change, a conditional alert) is made inert too, and let go with the rest.
//
// A live region (role status or alert, or aria-live) with nothing focusable
// inside it is left alone: it has to stay readable, so that a result that
// arrives as the dialog closes is still announced. One that holds a control
// stays inert like the rest.
//
// Dialogs can nest (a confirmation asked from inside another dialog). Each
// element is counted, so an inner dialog closing takes off only what it
// added and the outer dialog's isolation stays until the outer one closes.
// An element that was inert before any dialog opened is not counted, so it
// stays inert afterwards.
import { type RefObject, useEffect } from "react";

/** How many open dialogs are holding each element inert. */
const holds = new Map<Element, number>();

const LIVE_REGION = '[role="status"], [role="alert"], [aria-live]';
const FOCUSABLE =
  'button, input, select, textarea, a[href], summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function isQuietLiveRegion(element: Element): boolean {
  return (
    element.matches(LIVE_REGION) &&
    !element.matches(FOCUSABLE) &&
    element.querySelector(FOCUSABLE) === null
  );
}

export function useInertOutside(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const start = ref.current;
    if (!active || start === null) return;
    const mine: Element[] = [];
    const observers: MutationObserver[] = [];

    // A quiet region is watched: if a control appears inside it (a failed
    // reload's Try again), it goes inert from then on and gives up announcing.
    function watchRegion(region: Element) {
      const observer = new MutationObserver(() => {
        if (!isQuietLiveRegion(region) && !mine.includes(region)) isolate(region);
      });
      observer.observe(region, { childList: true, subtree: true, attributes: true });
      observers.push(observer);
    }

    function isolate(element: Element) {
      if (isQuietLiveRegion(element)) {
        watchRegion(element);
        return;
      }
      const count = holds.get(element);
      if (count !== undefined) {
        holds.set(element, count + 1);
        mine.push(element);
      } else if (!element.hasAttribute("inert")) {
        holds.set(element, 1);
        element.setAttribute("inert", "");
        mine.push(element);
      }
    }

    let node: Element = start;
    while (node !== document.body && node.parentElement !== null) {
      const parent: Element = node.parentElement;
      const onPath = node;
      for (const sibling of parent.children) if (sibling !== onPath) isolate(sibling);
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const added of record.addedNodes) {
            if (added instanceof Element && added !== onPath && !mine.includes(added)) {
              isolate(added);
            }
          }
        }
      });
      // A dialog mounted later as a sibling on another open dialog's path
      // would be made inert here too. No caller does that on purpose: a file
      // drop that would open the upload dialog under an open dialog is
      // ignored by DropZone, so the two never isolate each other.
      observer.observe(parent, { childList: true });
      observers.push(observer);
      node = parent;
    }
    return () => {
      for (const observer of observers) observer.disconnect();
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
