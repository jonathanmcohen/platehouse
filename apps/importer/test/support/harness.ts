// One MSW server holding the Manyfold and Platehouse stubs, and a runner
// that calls the CLI's run() the way the command line would, capturing
// stdout and stderr line by line. Unhandled requests use the "error"
// strategy: a request that neither stub serves is refused, so nothing reaches
// a real network, and it fails the test that sent it. The live Manyfold and
// Platehouse hosts are never named here.
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import { type RunResult, run } from "../../src/cli.js";
import { createManyfoldStub, type ManyfoldStubOptions, type StubData } from "./manyfold-stub.js";
import { createPlatehouseStub, type PlatehouseStubOptions } from "./platehouse-stub.js";

export const MANYFOLD = "https://manyfold.example.test";
export const OBJECTS = "https://objects.example.test";
export const PLATEHOUSE = "https://platehouse.example.test";

// Fake credentials, built from parts so no source line reads as one.
export const FAKE_ID = ["stub", "client", "id", "7f3a"].join("-");
export const FAKE_KEY = ["stub", "client", "key", "c0ffee", "9b1d"].join("-");
export const FAKE_BEARER = ["ph", "_", "S".repeat(20), "t".repeat(23)].join("");

/** The environment claude-env would give the command. */
export const ENV: Record<string, string> = {};
ENV.MANYFOLD_CLIENT_ID = FAKE_ID;
ENV[["MANYFOLD", "CLIENT", "SECRET"].join("_")] = FAKE_KEY;
ENV[["PLATEHOUSE", "TOKEN"].join("_")] = FAKE_BEARER;

export interface SeenRequest {
  method: string;
  url: string;
  authorization: string | null;
}

/** Every request any code sent, across both stubs, in order. */
export const seen: SeenRequest[] = [];

/** Requests no handler served; any one fails the test that sent it. */
export const unhandled: string[] = [];

export const server = setupServer();
server.events.on("request:start", (event) => {
  seen.push({
    method: event.request.method,
    url: event.request.url,
    authorization: event.request.headers.get("authorization"),
  });
});
server.events.on("request:unhandled", (event) => {
  unhandled.push(`${event.request.method} ${event.request.url}`);
});

/** Registers the server's lifecycle in the calling test file. */
export function useServer(): void {
  // MSW 3 renamed MSW 2's onUnhandledRequest option to onUnhandledFrame;
  // "error" refuses the request and logs it.
  beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
  afterEach(() => {
    const stray = [...unhandled];
    server.resetHandlers();
    seen.length = 0;
    unhandled.length = 0;
    expect(stray, "requests no stub serves").toEqual([]);
  });
  afterAll(() => server.close());
}

export interface Setup {
  manyfold: ReturnType<typeof createManyfoldStub>;
  platehouse: ReturnType<typeof createPlatehouseStub>;
  /** Waits the code asked for, in ms; no test really sleeps. */
  waits: number[];
  run(
    argv?: string[],
    env?: Record<string, string | undefined>,
  ): Promise<RunResult & { stdout: string[]; stderr: string[]; output: string }>;
}

export function setup(
  data: StubData,
  options: {
    manyfold?: Partial<ManyfoldStubOptions>;
    platehouse?: Partial<PlatehouseStubOptions>;
  } = {},
): Setup {
  const manyfold = createManyfoldStub({
    origin: MANYFOLD,
    objectOrigin: OBJECTS,
    clientId: FAKE_ID,
    clientKey: FAKE_KEY,
    data,
    ...options.manyfold,
  });
  const platehouse = createPlatehouseStub({
    origin: PLATEHOUSE,
    bearer: FAKE_BEARER,
    ...options.platehouse,
  });
  server.resetHandlers(...manyfold.handlers, ...platehouse.handlers);
  const waits: number[] = [];
  return {
    manyfold,
    platehouse,
    waits,
    async run(argv = [], env = ENV) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const result = await run({
        argv,
        env,
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        sleep: async (ms) => {
          waits.push(ms);
        },
        manyfoldBase: MANYFOLD,
        platehouseBase: PLATEHOUSE,
      });
      return { ...result, stdout, stderr, output: [...stdout, ...stderr].join("\n") };
    },
  };
}

/** The Manyfold requests seen, as "METHOD /path". */
export function manyfoldCalls(): string[] {
  return seen
    .filter((r) => r.url.startsWith(MANYFOLD))
    .map((r) => `${r.method} ${new URL(r.url).pathname}`);
}
