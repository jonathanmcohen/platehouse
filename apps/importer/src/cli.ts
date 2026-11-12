// platehouse-import [--apply] [--model <id>] (build plan Task 23).
import type { Report } from "./report.js";

export const MANYFOLD_BASE = "https://manyfold.local.jonco.dev";
export const PLATEHOUSE_BASE = "https://platehouse.local.jonco.dev";

export interface RunOptions {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  manyfoldBase?: string;
  platehouseBase?: string;
}

export interface RunResult {
  /** 0 ok, 1 a model failed, 2 the run could not start. */
  code: 0 | 1 | 2;
  report: Report | null;
}

export async function run(_options: RunOptions): Promise<RunResult> {
  throw new Error("not implemented");
}
