// The slicer's crash guard. An error in one request must cost that request,
// never the server process.
//
// guardRequests runs each request's handler inside a scope of its own
// (AsyncLocalStorage). Every listener, callback, timer and child process the
// handler starts inherits that scope, so an error thrown there is traced back
// to its request, even one that escapes to the process as an uncaught
// exception (installCrashGuard). An unhandled rejection takes the same path:
// Node's default rejection mode raises it as an uncaught exception. The request is
// then answered 500, or its connection is closed when the answer has already
// started; the cleanups it registered with whenRequestFails run; and the
// server keeps serving.
//
// An error with no scope cannot be traced: a listener that runs from the
// connection's own I/O (a request "data" listener, say) runs in the
// connection's context, not the handler's. Such an error fails every request
// still in flight, which runs all their cleanups, so no job is left holding
// the heavy-job lock, and the server keeps serving.
//
// This file imports only node: modules, so Node can load it as TypeScript
// source (guard.test.ts runs it in a child process).
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";

export type Log = (line: string) => void;

interface Scope {
  res: ServerResponse;
  /** The connection, kept from the start: Node detaches it from req and res later. */
  socket: Socket | null;
  cleanups: Array<() => void>;
  failed: boolean;
  log: Log;
}

const scopes = new AsyncLocalStorage<Scope>();
// Requests whose handler has not settled yet.
const inFlight = new Set<Scope>();

/**
 * Registers work to undo if the current request fails (free the heavy-job
 * lock, kill its program, delete its folder). A cleanup may run after the
 * handler's own clean-up has run, so it must be safe to run twice.
 */
export function whenRequestFails(cleanup: () => void): void {
  scopes.getStore()?.cleanups.push(cleanup);
}

function describe(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/** Answers 500 if nothing has been sent yet, else closes the connection. Never throws. */
function answerFailure(scope: Scope): void {
  const { res, socket } = scope;
  try {
    if (!res.headersSent && !res.writableEnded && !res.destroyed) {
      res.writeHead(500, { "content-type": "text/plain", connection: "close" });
      res.end("internal error\n", () => socket?.destroy());
      return;
    }
  } catch {
    // fall through and close the connection
  }
  try {
    socket?.destroy();
    res.destroy();
  } catch {
    // nothing more can be done for this connection
  }
}

function fail(scope: Scope, what: string, err: unknown): void {
  scope.log(`${what}: ${describe(err)}`);
  inFlight.delete(scope);
  if (scope.failed) {
    // A second error for a request already failed: just make sure its
    // connection is closed.
    answerFailure(scope);
    return;
  }
  scope.failed = true;
  for (const cleanup of scope.cleanups.splice(0)) {
    try {
      cleanup();
    } catch (cleanupErr) {
      scope.log(`a cleanup failed: ${describe(cleanupErr)}`);
    }
  }
  answerFailure(scope);
}

/**
 * Wraps a request handler. A handler that throws, or whose promise rejects,
 * fails its own request (500, or a closed connection) and nothing else.
 */
export function guardRequests(
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
  log: Log,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const scope: Scope = { res, socket: req.socket, cleanups: [], failed: false, log };
    inFlight.add(scope);
    scopes.run(scope, () => {
      let done: Promise<void>;
      try {
        done = Promise.resolve(handle(req, res));
      } catch (err) {
        done = Promise.reject(err);
      }
      done.then(
        () => {
          inFlight.delete(scope);
        },
        (err: unknown) => fail(scope, "request failed", err),
      );
    });
  };
}

/**
 * The last line of defence, for the server's main module: an uncaught
 * exception fails its own request when it can be traced to one, else every
 * request in flight, and never exits the process. No unhandledRejection
 * listener is needed: under Node's default --unhandled-rejections=throw an
 * unhandled rejection arrives here as an uncaught exception, in the scope
 * of the code that rejected (guard.test.ts covers it).
 */
export function installCrashGuard(proc: NodeJS.Process, log: Log): void {
  const onError = (what: string) => (err: unknown) => {
    const scope = scopes.getStore();
    if (scope) {
      fail(scope, `${what} in a request`, err);
      return;
    }
    log(
      `${what} outside any request, failing the ${inFlight.size} request(s) in flight: ${describe(err)}`,
    );
    for (const s of [...inFlight]) fail(s, "request failed by an error outside it", err);
  };
  proc.on("uncaughtException", onError("uncaught exception"));
}
