// The slicer's crash guard (src/guard.ts). An error thrown by a request
// handler, or by any listener or callback that serves a request, must cost
// that one request a 500 (or its connection, when the answer has already
// started) and never the server process.
//
// An uncaught exception inside the vitest worker is caught by vitest itself,
// so these tests run a real server in a child Node process, which loads
// guard.ts directly (Node 26 strips the types), and check that the child is
// still serving after each failure.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Sent } from "./support/http.js";

const GUARD = new URL("../src/guard.ts", import.meta.url).href;

// The child's routes each fail one way. "/hang" never answers, so the test
// can check what an error from outside any request does to work in flight.
// "/data-listener-throws" and "/hang-beside-data" log once their handler is
// set up, so the test can wait on the server instead of on a fixed delay.
const CHILD = `
import { createServer } from "node:http";
const { guardRequests, installCrashGuard, whenRequestFails } = await import(process.argv[2]);
const log = (line) => process.stdout.write(line + "\\n");
installCrashGuard(process, log);
const never = () => new Promise(() => {});
const server = createServer(
  guardRequests((req, res) => {
    const path = new URL(req.url ?? "/", "http://child").pathname;
    switch (path) {
      case "/health":
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
        return;
      case "/throws":
        throw new Error("the handler threw");
      case "/rejects":
        return Promise.reject(new Error("the handler rejected"));
      case "/timer-throws":
        setTimeout(() => {
          throw new Error("a timer threw");
        }, 5);
        return never();
      case "/stray-rejection":
        setTimeout(() => {
          Promise.reject(new Error("a stray rejection"));
        }, 5);
        return never();
      case "/end-callback-throws":
        res.writeHead(200, { "content-type": "text/plain", "content-length": "4" });
        res.end("done", () => {
          throw new Error("the end callback threw");
        });
        return;
      case "/data-listener-throws":
        req.on("data", () => {
          throw new Error("a data listener threw");
        });
        log("handler listening for data on /data-listener-throws");
        return never();
      case "/cleanup":
        whenRequestFails(() => log("cleanup ran for /cleanup"));
        setTimeout(() => {
          throw new Error("a timer threw after a cleanup was registered");
        }, 5);
        return never();
      case "/hang":
        whenRequestFails(() => log("cleanup ran for /hang"));
        return never();
      case "/hang-beside-data":
        whenRequestFails(() => log("cleanup ran for /hang-beside-data"));
        log("handler running for /hang-beside-data");
        return never();
      default:
        res.writeHead(404);
        res.end();
    }
  }, log),
);
process.on("message", (m) => {
  if (m === "throw-outside") throw new Error("an error from outside any request");
});
server.listen(0, "127.0.0.1", () => log("listening " + server.address().port));
`;

let child: ChildProcess;
let base = "";
let stdout = "";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "slicer-guard-"));
  const script = join(dir, "child.mjs");
  writeFileSync(script, CHILD);
  child = spawn(process.execPath, [script, GUARD], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (c: string) => {
    stdout += c;
  });
  child.stderr?.on("data", (c: string) => {
    stdout += c;
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the child never listened:\n${stdout}`)),
      10_000,
    );
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the child exited ${code} before listening:\n${stdout}`));
    });
    const poll = setInterval(() => {
      const m = /listening (\d+)/.exec(stdout);
      if (m) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    }, 10);
  });
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
  child?.kill("SIGKILL");
});

function get(path: string): Promise<Sent> {
  return new Promise((resolve) => {
    const req = request(`${base}${path}`, { agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", (e) => resolve({ error: e.message }));
    });
    req.on("error", (e: NodeJS.ErrnoException) => resolve({ error: e.code ?? e.message }));
    req.end();
  });
}

/**
 * A POST that sends its headers at once and its first body chunk only once
 * `ready` resolves, so the test decides when the chunk can reach the server.
 * If `ready` rejects, the request is dropped and the rejection is returned.
 */
function postBodyWhen(url: string, ready: Promise<void>): Promise<Sent> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: Sent) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    const req = request(
      url,
      { method: "POST", agent: false, headers: { "content-type": "application/octet-stream" } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => finish({ status: res.statusCode ?? 0, body }));
        res.on("error", (e) => finish({ error: e.message }));
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) => finish({ error: e.code ?? e.message }));
    req.flushHeaders();
    ready.then(
      () => {
        if (!req.destroyed) req.write(Buffer.alloc(1024, 1));
      },
      (e: Error) => {
        finish({ error: e.message });
        req.destroy();
      },
    );
  });
}

async function expectStillServing(): Promise<void> {
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  expect(await get("/health")).toEqual({ status: 200, body: "ok" });
}

async function waitForOutput(text: string): Promise<void> {
  const until = Date.now() + 5000;
  while (!stdout.includes(text)) {
    if (Date.now() > until) throw new Error(`no "${text}" in the child's output:\n${stdout}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const INTERNAL = { status: 500, body: "internal error\n" };

describe("crash guard", () => {
  test.each([
    ["the handler throws", "/throws", "the handler threw"],
    ["the handler rejects", "/rejects", "the handler rejected"],
    ["a timer started by the handler throws", "/timer-throws", "a timer threw"],
    ["a promise rejection goes unhandled", "/stray-rejection", "a stray rejection"],
  ])(
    "%s: that request is answered 500, the error is logged, and the server keeps serving",
    async (_label, path, message) => {
      expect(await get(path)).toEqual(INTERNAL);
      await waitForOutput(message);
      await expectStillServing();
    },
  );

  test("a response callback that throws after the answer was sent costs only that connection", async () => {
    expect(await get("/end-callback-throws")).toEqual({ status: 200, body: "done" });
    await waitForOutput("the end callback threw");
    await expectStillServing();
  });

  // A body chunk that arrives from the connection after the handler has
  // attached its "data" listener is delivered in the connection's context,
  // not the handler's, so an error the listener throws cannot be traced to
  // its request, and guard.ts fails every request in flight. The body is sent
  // only after the child logs that the handler is listening, so the chunk
  // cannot be buffered before the listener is attached and takes that path
  // every time, however slow the runner. (A chunk already buffered when the
  // listener is attached is delivered from the handler's own context instead,
  // and its error fails only its own request; which path a chunk sent with
  // the headers takes depends on timing, so this test does not rely on it.)
  // /hang-beside-data stands for another request in flight at the time; it
  // never answers on its own, so its 500 and its cleanup come only from the
  // guard failing it. The test waits for its handler to log that it is
  // running, so its cleanup is registered before the error.
  test("a data listener that throws on a chunk from the connection cannot be traced: every request in flight fails, and the server keeps serving", async () => {
    const hanging = get("/hang-beside-data");
    await waitForOutput("handler running for /hang-beside-data");
    const res = await postBodyWhen(
      `${base}/data-listener-throws`,
      waitForOutput("handler listening for data on /data-listener-throws"),
    );
    expect(res).toEqual(INTERNAL);
    expect(await hanging).toEqual(INTERNAL);
    await waitForOutput("a data listener threw");
    await waitForOutput("request failed by an error outside it");
    await waitForOutput("cleanup ran for /hang-beside-data");
    await expectStillServing();
  });

  test("a failed request runs the cleanups it registered", async () => {
    expect(await get("/cleanup")).toEqual(INTERNAL);
    await waitForOutput("cleanup ran for /cleanup");
    await expectStillServing();
  });

  test("an error from outside any request fails the requests in flight, runs their cleanups and keeps serving", async () => {
    const hanging = get("/hang");
    // let /hang reach its handler before the error
    await new Promise((r) => setTimeout(r, 100));
    child.send("throw-outside");
    expect(await hanging).toEqual(INTERNAL);
    await waitForOutput("an error from outside any request");
    await waitForOutput("cleanup ran for /hang");
    await expectStillServing();
  });
});
