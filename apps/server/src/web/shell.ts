// The web shell (build plan Task 18). Stub for the failing-tests commit; the
// implementation follows.
import type { FastifyInstance } from "fastify";

export type Theme = "dark" | "light" | "system";

export const THEME_COOKIE: string = "";

export const SHELL_PAGES: readonly string[] = Object.freeze([]);

export class ShellTemplateError extends Error {}

export interface ShellTemplate {
  render(cookie: string | undefined): string;
}

export function resolveTheme(_value: unknown): Theme {
  throw new Error("not implemented");
}

export function parseShellTemplate(_html: string): ShellTemplate {
  throw new Error("not implemented");
}

export interface WebDeps {
  /** The web app's build folder: index.html and assets/. */
  dir: string;
}

export async function registerWeb(_app: FastifyInstance, _deps: WebDeps): Promise<void> {}
