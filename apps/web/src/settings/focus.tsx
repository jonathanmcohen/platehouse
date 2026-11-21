// Keeping keyboard focus when the focused control goes away (build plan Task
// 21), shared by every list on the settings, trash and organising pages. A
// browser puts focus on the page body when the focused element is removed
// (a row or chip whose change worked) or disabled, and a keyboard user then
// has to Tab back through the whole shell. So no control that may hold
// focus takes the disabled attribute (aria-disabled, with presses ignored,
// instead), and every list of rows uses useRowFocus: when the row that had
// focus leaves, for any reason, focus goes to the same control on the next
// row, else the previous row, else the list's fallback (a status line that
// says what happened, or the control that adds a row). A .tsx module like
// api.tsx: useRowFocus is a React hook.
import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";

/**
 * Focuses the first candidate that is still on the page and can take focus,
 * and returns it; null when none can.
 */
export function focusFirst(candidates: ReadonlyArray<Element | null | undefined>): Element | null {
  for (const el of candidates) {
    if (!(el instanceof HTMLElement) || !el.isConnected || el.matches(":disabled")) continue;
    el.focus();
    if (document.activeElement === el) return el;
  }
  return null;
}

/** Whether focus has fallen to the page body (or to an element no longer on the page). */
export function focusLost(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}

export interface RowFocus {
  /** A ref callback for the control of row key that takes focus when a neighbour leaves. */
  control(key: string): (el: HTMLElement | null) => void;
  /** Put on each row's element: notes the row as the one holding focus. */
  focusIn(key: string): () => void;
  /** That control of row key, while it is on the page. */
  get(key: string): HTMLElement | null;
  /**
   * Where focus would go if row key left now: the next row's control, else
   * the previous row's, else the fallback. For a dialog's return target.
   */
  after(key: string): HTMLElement | null;
}

/**
 * Focus for a list of rows, in the order keys gives. After every render in
 * which the row that last held focus is gone and focus has fallen to the
 * body, focus goes to the next row's control, else the previous row's, else
 * fallback. Focus a user has moved elsewhere is never taken back.
 */
export function useRowFocus(
  keys: readonly string[],
  fallback: RefObject<HTMLElement | null>,
): RowFocus {
  const controls = useRef(new Map<string, HTMLElement>());
  const refs = useRef(new Map<string, (el: HTMLElement | null) => void>());
  const shown = useRef<readonly string[]>(keys);
  const holder = useRef<string | null>(null);

  const neighbours = useCallback((order: readonly string[], key: string, live: Set<string>) => {
    const at = order.indexOf(key);
    const next = at < 0 ? [] : order.slice(at + 1);
    const previous = at < 0 ? [] : order.slice(0, at).reverse();
    return [...next, ...previous]
      .filter((k) => live.has(k))
      .map((k) => controls.current.get(k) ?? null);
  }, []);

  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = keys;
    const key = holder.current;
    if (key === null || keys.includes(key)) return;
    holder.current = null;
    if (!focusLost()) return;
    focusFirst([...neighbours(before, key, new Set(keys)), fallback.current]);
  });

  const control = useCallback((key: string) => {
    let ref = refs.current.get(key);
    if (ref === undefined) {
      ref = (el: HTMLElement | null) => {
        if (el === null) controls.current.delete(key);
        else controls.current.set(key, el);
      };
      refs.current.set(key, ref);
    }
    return ref;
  }, []);

  const focusIn = useCallback(
    (key: string) => () => {
      holder.current = key;
    },
    [],
  );

  const get = useCallback((key: string) => controls.current.get(key) ?? null, []);

  const after = useCallback(
    (key: string) => {
      const order = shown.current;
      const live = new Set(order.filter((k) => k !== key));
      const found = neighbours(order, key, live).find((el) => el?.isConnected);
      return found ?? fallback.current;
    },
    [fallback, neighbours],
  );

  return { control, focusIn, get, after };
}
