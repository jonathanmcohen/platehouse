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
// connection's own I/O runs in the connection's context, not the handler's.
// Such an error fails every request still in flight, which runs all their
// cleanups, so no job is left holding the heavy-job lock, and the server
// keeps serving.
//
// A request "data" listener can end up on either path. A body chunk that
// arrives from the connection after the listener is attached is delivered
// from the connection's I/O, so an error the listener throws on it fails
// every request in flight. A chunk already buffered when the listener is
// attached is delivered from the handler's own scope instead (attaching the
// listener resumes the stream from there), so its error fails only that
// request. Which path a chunk sent with the headers takes depends on timing.
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

/**
 * How long a connection answered early is drained before it is dropped: time
 * enough for the client to read the answer, short enough that a client still
 * sending a 512 MiB body cannot hold the socket.
 */
const LINGER_MS = 5_000;

const lingering = new WeakSet<Socket>();

/**
 * Closes a connection answered early without losing its answer (a lingering
 * close): a refusal (server.ts refuseEarly) or the crash guard's 500.
 * Closing a socket with unread bytes in its receive queue makes the kernel
 * reset the connection, and the reset can throw away the answer before the
 * client reads it: the client sees ECONNRESET or EPIPE, never the answer. So
 * this half-closes instead (FIN after the answer), reads and discards
 * whatever still arrives, and destroys the socket once the client ends or
 * errors, or after LINGER_MS, whichever comes first. Safe to call twice.
 */
export function closeLingering(socket: Socket): void {
  if (socket.destroyed || lingering.has(socket)) return;
  lingering.add(socket);
  const timer = setTimeout(() => socket.destroy(), LINGER_MS);
  timer.unref();
  socket.once("close", () => clearTimeout(timer));
  socket.once("end", () => socket.destroy());
  socket.on("error", () => socket.destroy());
  socket.on("data", () => {});
  socket.resume();
  socket.end();
}

function describe(err: unknown): string {
  return err instanceof Error ? (err.stack ?? err.message) : String(err);
}

/**
 * Answers 500 if nothing has been sent yet, else closes the connection. Never throws.
 *
 * The 500 can go out before the request's body is read (its job folder
 * could not be made, say), so it closes the way a refusal does: lingering
 * (closeLingering), with the socket's destroySoon replaced so Node's own
 * Connection: close handling does not reset the connection under the answer.
 */
function answerFailure(scope: Scope): void {
  const { res, socket } = scope;
  try {
    if (!res.headersSent && !res.writableEnded && !res.destroyed) {
      if (socket) socket.destroySoon = () => closeLingering(socket);
      res.writeHead(500, { "content-type": "text/plain", connection: "close" });
      res.end("internal error\n", () => {
        if (socket) closeLingering(socket);
      });
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
