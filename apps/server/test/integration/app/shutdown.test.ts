// Build plan Task 30: the real process. src/main.ts is started with node,
// from source (test/support/ts-hooks.ts), with only its environment, the way
// the app image starts it. Once /healthz is 200 it gets SIGTERM, and it must
// exit 0 within 30 s with nothing left running: the port is closed and the
// server holds no connection to its database.
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SHUTDOWN_DEADLINE_MS } from "../../../src/main.js";
import { healthStatus, type ServerEnv, startServerEnv, until } from "../support/server.js";

const MAIN = fileURLToPath(new URL("../../../src/main.ts", import.meta.url));
const HOOKS = pathToFileURL(fileURLToPath(new URL("../../support/ts-hooks.ts", import.meta.url)));

let env: ServerEnv;
let child: ChildProcess | undefined;
let output = "";

beforeAll(async () => {
  env = await startServerEnv();
});

afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
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
    child = proc;
    proc.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      proc.once("exit", (code, signal) => resolve({ code, signal })),
    );

    try {
      await until(
        async () => (proc.exitCode === null ? healthStatus(env) : "exited"),
        (status) => status === 200 || status === "exited",
        120_000,
      );
    } catch (error) {
      throw new Error(`the server did not come up: ${String(error)}\n${output.slice(-4000)}`);
    }
    expect(proc.exitCode, output.slice(-4000)).toBeNull();
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
});
