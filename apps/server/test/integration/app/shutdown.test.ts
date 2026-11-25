// The real process. src/main.ts is started with node,
// from source (test/support/ts-hooks.ts), with only its environment, the way
// the app image starts it. Once /healthz answers it gets SIGTERM, and it must
// exit 0 within 30 s with nothing left running: the port is closed and the
// server holds no connection to its database.
//
// The process requires the web build (issue #162), so /healthz is
// 200 only when apps/web/dist/index.html is there, beside the server package
// (defaultWebDir), and 503 while it is not. The integration job does not
// build the web app, so in CI this checks the 503: the process itself, not
// only start() with processWeb(), fails its health check without the build.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SHUTDOWN_DEADLINE_MS } from "../../../src/main.js";
import { defaultWebDir } from "../../../src/web/shell.js";
import { healthStatus, type ServerEnv, startServerEnv, until } from "../support/server.js";

const MAIN = fileURLToPath(new URL("../../../src/main.ts", import.meta.url));
const HOOKS = pathToFileURL(fileURLToPath(new URL("../../support/ts-hooks.ts", import.meta.url)));

let env: ServerEnv;
const children = new Set<ChildProcess>();
let output = "";

beforeAll(async () => {
  env = await startServerEnv();
});

afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  await env?.stop();
});

/** Connections to the server's database other than the one asking. */
async function otherConnections(): Promise<number> {
  const client = new pg.Client({ connectionString: env.dbUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()",
    );
    return rows[0]?.n ?? -1;
  } finally {
    await client.end();
  }
}

describe("the server process", () => {
  test("SIGTERM exits 0 within 30 s with nothing left running", async () => {
    const proc = spawn(process.execPath, ["--conditions=source", "--import", HOOKS.href, MAIN], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(proc);
    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      proc.once("exit", (code, signal) => resolve({ code, signal })),
    );

    // What /healthz answers once the server is up: it listens only after the
    // database and pg-boss are started, so before that nothing answers.
    const webBuilt = existsSync(join(defaultWebDir(), "index.html"));
    const upStatus = webBuilt ? 200 : 503;
    try {
      await until(
        async () => (proc.exitCode === null ? healthStatus(env) : "exited"),
        (status) => status === upStatus || status === "exited",
        120_000,
      );
    } catch (error) {
      throw new Error(
        `the server did not come up answering ${upStatus}: ${String(error)}\n${output.slice(-4000)}`,
      );
    }
    expect(proc.exitCode, output.slice(-4000)).toBeNull();
    expect(await healthStatus(env), output.slice(-4000)).toBe(upStatus);
    expect(await otherConnections()).toBeGreaterThan(0);

    const sent = Date.now();
    proc.kill("SIGTERM");
    const result = await Promise.race([
      exited,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 40_000)),
    ]);
    const took = Date.now() - sent;

    expect(result, output.slice(-4000)).toEqual({ code: 0, signal: null });
    expect(took).toBeLessThan(SHUTDOWN_DEADLINE_MS);
    expect(await healthStatus(env)).toBeNull();
    // Postgres may list a backend for a moment after its client has gone.
    expect(
      await until(
        () => otherConnections(),
        (n) => n === 0,
        5_000,
      ),
    ).toBe(0);
  }, 180_000);

  // A database that accepts the connection and never answers keeps start-up
  // in migrate(); a SIGTERM then must not wait for the 30 s connect timeout.
  test("SIGTERM during start-up exits 0 promptly", async () => {
    const sockets = new Set<Socket>();
    const silent = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const address = silent.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    let log = "";
    const proc = spawn(process.execPath, ["--conditions=source", "--import", HOOKS.href, MAIN], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...env.env,
        DATABASE_URL: `postgres://nobody:nothing@127.0.0.1:${port}/none`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(proc);
    for (const stream of [proc.stdout, proc.stderr]) {
      stream?.on("data", (chunk: Buffer) => {
        log += chunk.toString("utf8");
      });
    }
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      proc.once("exit", (code, signal) => resolve({ code, signal })),
    );
    try {
      // Start-up is in migrate once the silent database has accepted a
      // connection, and the signal handlers exist by then. A process that
      // exits first ends the wait at once. The waits (15 s, then 10 s) leave
      // 5 s of the 30 s for the cleanup below.
      try {
        await until(
          async () => sockets.size > 0 || proc.exitCode !== null,
          (reached) => reached,
          15_000,
        );
      } catch (error) {
        throw new Error(
          `the server did not reach the database: ${String(error)}\n${log.slice(-4000)}`,
        );
      }
      expect(proc.exitCode, log.slice(-4000)).toBeNull();
      proc.kill("SIGTERM");
      const result = await Promise.race([
        exited,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
      ]);
      expect(result, log.slice(-4000)).toEqual({ code: 0, signal: null });
    } finally {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => silent.close(resolve));
    }
  }, 30_000);
});
