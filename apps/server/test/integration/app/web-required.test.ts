// Build plan Task 24 (issue #162): the server process requires the web
// build. main() starts the server with processWeb(), the web app's build
// folder beside the server package (defaultWebDir) marked required, so a
// server started without apps/web/dist answers /healthz with 503 and its
// image's HEALTHCHECK fails, instead of serving 503 pages behind a green
// health check. start(config) on its own keeps the build optional, as the
// other server tests use it.
//
// The real server against Postgres and the S3 test server, started with
// processWeb() pointed at a temp folder: first with no build in it, then with
// a build laid out the way vite build lays out apps/web/dist.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { processWeb, type Server, start } from "../../../src/main.js";
import { defaultWebDir } from "../../../src/web/shell.js";
import { healthStatus, type ServerEnv, startServerEnv } from "../support/server.js";

const INDEX = [
  "<!doctype html>",
  '<html lang="en" data-theme="dark">',
  "  <head>",
  '    <meta name="color-scheme" content="dark" />',
  "  </head>",
  '  <body><div id="root"></div></body>',
  "</html>",
  "",
].join("\n");

let env: ServerEnv;
let root: string;
let server: Server | undefined;

beforeAll(async () => {
  env = await startServerEnv();
  root = await mkdtemp(join(tmpdir(), "platehouse-web-required-"));
});

afterAll(async () => {
  await server?.stop();
  await env?.stop();
  await rm(root, { recursive: true, force: true });
});

describe("the process's web build", () => {
  test("is the web app's build folder beside the server package, and required", () => {
    expect(processWeb()).toEqual({ dir: defaultWebDir(), required: true });
  });

  test("a server started without it fails /healthz with 503, then passes once it is there", async () => {
    const dist = join(root, "dist");
    server = await start(env.config, { web: processWeb(dist) });

    expect(await healthStatus(env)).toBe(503);
    const res = await fetch(`${env.baseUrl}/healthz`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "unavailable" });

    await mkdir(join(dist, "assets"), { recursive: true });
    await writeFile(join(dist, "index.html"), INDEX);
    expect(await healthStatus(env)).toBe(200);

    await server.stop();
    server = undefined;
  });
});
