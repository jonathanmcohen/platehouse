// The current accent scheme, shared from the Shell to the Settings picker
// (the maintainer, 2026-11-19). The Shell starts it from what the server wrote into the
// html element; a change is applied to the document (data-accent and the
// ph_accent cookie) at once, with no reload, so every page re-colours as the
// user picks.
import { createContext, type ReactNode, useContext, useState } from "react";
import { type AccentId, applyAccent, DEFAULT_ACCENT, readAccent, resolveAccent } from "./accent";

export interface AccentState {
  accent: AccentId;
  setAccent(accent: AccentId): void;
}

const AccentContext = createContext<AccentState | null>(null);

/** The accent the server wrote into the page; the default where there is no document (server rendering in tests). */
export function documentAccent(): AccentId {
  return typeof document === "undefined" ? DEFAULT_ACCENT : readAccent(document);
}

export interface AccentProviderProps {
  initial: AccentId;
  children?: ReactNode;
}

export function AccentProvider({ initial, children }: AccentProviderProps) {
  const [accent, setState] = useState<AccentId>(() => resolveAccent(initial));

  function setAccent(next: AccentId) {
    const resolved = resolveAccent(next);
    applyAccent(resolved, document);
    setState(resolved);
  }

  return <AccentContext.Provider value={{ accent, setAccent }}>{children}</AccentContext.Provider>;
}

/**
 * The current accent and its setter. Inside the Shell this is the Shell's
 * state; a page rendered on its own (a test) reads the html element and
 * applies to the document itself, the same way.
 */
export function useAccent(): AccentState {
  const shared = useContext(AccentContext);
  const [own, setOwn] = useState<AccentId>(documentAccent);
  if (shared !== null) return shared;
  return {
    accent: own,
    setAccent(next) {
      const resolved = resolveAccent(next);
      applyAccent(resolved, document);
      setOwn(resolved);
    },
  };
}
