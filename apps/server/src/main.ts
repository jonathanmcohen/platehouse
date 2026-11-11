// The server process (build plan Task 30). Not built yet: the failing tests
// come first.
import type { FastifyInstance } from "fastify";
import type { Config } from "./config.js";

/** The longest a shutdown may take before the process exits anyway. */
export const SHUTDOWN_DEADLINE_MS = 30_000;

export interface Server {
  app: FastifyInstance;
  /** Stops the HTTP server, the inbox watcher, pg-boss and the database, in that order. */
  stop(): Promise<void>;
}

export async function start(_config: Config): Promise<Server> {
  throw new Error("not implemented");
}

/** The part of process the signal handling uses. */
export interface SignalTarget {
  on(event: "SIGTERM" | "SIGINT", listener: (signal: NodeJS.Signals) => void): unknown;
  exit(code: number): void;
}

export function installSignalHandlers(
  _stop: () => Promise<void>,
  _proc: SignalTarget = process,
  _log: (line: string) => void = console.info,
): void {
  throw new Error("not implemented");
}
