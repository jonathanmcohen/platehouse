// The theme (build plan Task 18). Stub for the failing-tests commit; the
// implementation follows.
export type Theme = "dark" | "light" | "system";

export const THEME_COOKIE: string = "";
export const THEMES: readonly Theme[] = [];
export const DEFAULT_THEME: Theme = "light";

export interface ThemeDocument {
  documentElement: {
    getAttribute(name: string): string | null;
    setAttribute(name: string, value: string): void;
  };
  querySelector(selector: string): { setAttribute(name: string, value: string): void } | null;
  cookie: string;
  location?: { readonly protocol: string } | null;
}

export function resolveTheme(_value: unknown): Theme {
  throw new Error("not implemented");
}

export function colorSchemeFor(_theme: Theme): string {
  throw new Error("not implemented");
}

export function readTheme(_doc: ThemeDocument): Theme {
  throw new Error("not implemented");
}

export function themeCookie(_theme: Theme, _secure: boolean): string {
  throw new Error("not implemented");
}

export function applyTheme(_theme: Theme, _doc: ThemeDocument): void {
  throw new Error("not implemented");
}
