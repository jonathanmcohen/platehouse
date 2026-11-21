// A file download's time limit is an idle limit: the download fails only when
// no byte arrives for that long, never because the whole file takes longer
// (0.1.0 release review). It used to be one fixed 600 s cap on the whole
// transfer, so a large file over a slow link failed on every run. The limit
// is --download-idle-timeout or MANYFOLD_DOWNLOAD_IDLE_TIMEOUT, in seconds.
//
// The client tests below call createManyfold with a fetch that streams a
// body on real timers and, like the real fetch, errors the body when the
// request's signal aborts. The command-line tests use the MSW stubs, except
// for the one stalled file.
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { createManyfold, ManyfoldError } from "../src/manyfold.js";
import { ENV, MANYFOLD, setup, useServer } from "./support/harness.js";
import { library } from "./support/library.js";

useServer();

const BASE = "https://manyfold.test.invalid";
const FILE = `${BASE}/models/m1/model_files/f1.3mf`;
// A fake grant, built from parts as in the harness.
const GRANT = { scope: "read" } as Record<string, string>;
GRANT[["access", "token"].join("_")] = ["stub", "grant", "value", "1234"].join("-");

interface Body {
  /** Bytes per chunk. */
  chunk: number;
  /** Chunks sent before the body ends, or stalls when stallAfter is set. */
  chunks: number;
  /** Delay before each chunk, in ms. */
  every: number;
  /** After this many chunks, send nothing more and never end. */
  stallAfter?: number;
  /** Never answer with headers at all. */
  noHeaders?: boolean;
}

/** A fetch that serves the grant and one streamed file, honouring the request's signal. */
function fakeFetch(body: Body): { fetch: typeof fetch; fileRequests: () => number } {
  let fileRequests = 0;
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === "/oauth/token") return Response.json(GRANT);
    if (url.toString() !== FILE) return new Response(null, { status: 404 });
    fileRequests++;
    const signal = init?.signal ?? undefined;
    if (body.noHeaders === true) {
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
      async pull(controller) {
        if (body.stallAfter !== undefined && sent >= body.stallAfter) {
          await new Promise<void>(() => {});
        }
        if (sent >= body.chunks) {
          controller.close();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, body.every));
        if (signal?.aborted === true) return;
        sent++;
        controller.enqueue(new Uint8Array(body.chunk).fill(sent));
      },
    });
    return new Response(stream, { status: 200 });
  };
  return { fetch: impl as typeof fetch, fileRequests: () => fileRequests };
}

async function client(body: Body, downloadTimeoutMs: number) {
  const fake = fakeFetch(body);
  const manyfold = createManyfold({
    base: BASE,
    clientId: "stub-id",
    clientKey: "stub-key",
    fetch: fake.fetch,
    sleep: async () => {},
    downloadTimeoutMs,
  });
  await manyfold.authenticate();
  return { manyfold, fileRequests: fake.fileRequests };
}

describe("a file download's time limit", () => {
  it("lets a download that takes longer than the limit in total finish while bytes keep arriving", async () => {
    // 8 chunks 40 ms apart: about 320 ms in total, never 150 ms without a byte.
    const { manyfold } = await client({ chunk: 16, chunks: 8, every: 40 }, 150);
    const bytes = await manyfold.download(FILE, 128);
    expect(bytes.byteLength).toBe(128);
    expect(bytes.at(-1)).toBe(8);
  });

  it("fails a download that stops sending, naming the idle limit, without waiting for the whole transfer", async () => {
    const { manyfold } = await client({ chunk: 16, chunks: 8, every: 10, stallAfter: 2 }, 100);
    const started = Date.now();
    const error = await manyfold.download(FILE, 128).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ManyfoldError);
    expect((error as Error).message).toBe("GET /models/m1/model_files/f1.3mf: no data for 0.1 s");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("retries a request whose answer never starts, then fails naming the idle limit", async () => {
    const { manyfold, fileRequests } = await client(
      { chunk: 16, chunks: 1, every: 0, noHeaders: true },
      50,
    );
    const error = await manyfold.download(FILE, 16).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ManyfoldError);
    expect((error as Error).message).toBe("GET /models/m1/model_files/f1.3mf: no data for 0.05 s");
    expect(fileRequests()).toBe(4);
  });
});

describe("--download-idle-timeout and MANYFOLD_DOWNLOAD_IDLE_TIMEOUT", () => {
  it.each(["0", "-1", "1.5", "abc", "86401", ""])(
    "refuse %j for the flag with exit 2 before anything is read",
    async (value) => {
      const s = setup(library());
      const r = await s.run([`--download-idle-timeout=${value}`]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(
        "--download-idle-timeout takes a whole number of seconds from 1 to 86400",
      );
      expect(s.manyfold.tokenRequests).toHaveLength(0);
    },
  );

  it("refuses a bad MANYFOLD_DOWNLOAD_IDLE_TIMEOUT with exit 2, naming the variable", async () => {
    const s = setup(library());
    const r = await s.run([], { ...ENV, MANYFOLD_DOWNLOAD_IDLE_TIMEOUT: "soon" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      "MANYFOLD_DOWNLOAD_IDLE_TIMEOUT takes a whole number of seconds from 1 to 86400",
    );
  });

  it("lists the flag and the variable in the usage text", async () => {
    const s = setup(library());
    const r = await s.run(["--no-such-flag"]);
    expect(r.code).toBe(2);
    expect(r.output).toContain("--download-idle-timeout <seconds>");
    expect(r.output).toContain("MANYFOLD_DOWNLOAD_IDLE_TIMEOUT");
  });

  it.each([
    ["the flag", ["--apply", "--download-idle-timeout", "1"], ENV],
    ["the variable", ["--apply"], { ...ENV, MANYFOLD_DOWNLOAD_IDLE_TIMEOUT: "1" }],
  ])("applies %s to a download that stalls", async (_, argv, env) => {
    const s = setup(library());
    const stalled = `${MANYFOLD}/models/m3/model_files/f5.3mf`;
    // The stalled file is served here rather than by MSW: aborting a response
    // MSW is still streaming trips an assertion inside undici when MSW's fake
    // socket closes, which a real socket does not do. Everything else goes
    // to the stubs.
    const fetchWithStall = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url !== stalled) return globalThis.fetch(input, init);
      const signal = init?.signal ?? undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(4));
          signal?.addEventListener("abort", () => controller.error(signal.reason), {
            once: true,
          });
        },
        pull: () => new Promise<void>(() => {}),
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;
    const stderr: string[] = [];
    const r = await run({
      argv,
      env,
      stdout: () => {},
      stderr: (line) => stderr.push(line),
      fetch: fetchWithStall,
      sleep: async () => {},
    });
    expect(stderr).toEqual([]);
    expect(r.code).toBe(1);
    expect(s.manyfold.objectRequests.length).toBeGreaterThan(0);
    const m3 = r.report?.models.find((m) => m.manyfoldId === "m3");
    expect(m3?.files[0]?.status).toBe("failed");
    expect(m3?.files[0]?.reason).toBe("GET /models/m3/model_files/f5.3mf: no data for 1 s");
  });
});
