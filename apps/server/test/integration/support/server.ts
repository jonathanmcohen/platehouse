// The server tests' environment (build plan Task 30): an empty Postgres 17
// database (the server migrates it itself), a bucket on the S3 test server,
// the contract-faithful slicer stub, an inbox and a temp folder, and the
// environment a real server process is started with. Every value here is
// made per run; nothing reads a real secret or reaches a real store.
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import type { Kysely } from "kysely";
import { type Config, loadConfig } from "../../../src/config.js";
import type { DB } from "../../../src/db/types.js";
import { createRepos, type Repos } from "../../../src/repos/index.js";
import { type SlicerStub, startSlicerStub } from "../../support/slicer-stub.js";
import { type StartedS3, startS3 } from "./containers.js";
import { startTestPostgres, type TestPostgres } from "./db.js";

export interface ServerEnv {
  /** The server's environment, as a real process gets it. */
  env: Record<string, string>;
  config: Config;
  /** The test's own connection to the server's database. */
  db: Kysely<DB>;
  repos: Repos;
  dbUrl: string;
  pgc: TestPostgres;
  s3: StartedS3;
  stub: SlicerStub;
  inboxDir: string;
  tmpDir: string;
  /** http://127.0.0.1:<port> */
  baseUrl: string;
  stop(): Promise<void>;
}

/** A TCP port nothing listens on right now. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === "string") reject(new Error("no port"));
        else resolve(address.port);
      });
    });
  });
}

export async function startServerEnv(): Promise<ServerEnv> {
  let pgc: TestPostgres | undefined;
  let s3: StartedS3 | undefined;
  let stub: SlicerStub | undefined;
  const root = await mkdtemp(join(tmpdir(), "platehouse-server-"));
  const stop = async () => {
    await stub?.stop();
    // A test may have stopped the database container already.
    await Promise.all([pgc?.stop().catch(() => undefined), s3?.stop()]);
    await rm(root, { recursive: true, force: true });
  };
  try {
    [pgc, s3, stub] = await Promise.all([startTestPostgres(), startS3(), startSlicerStub()]);
    const t = await pgc.freshDatabase();
    const bucket = `platehouse-t30-${randomBytes(4).toString("hex")}`;
    await s3.client.send(new CreateBucketCommand({ Bucket: bucket }));
    const inboxDir = join(root, "inbox");
    const tmpDir = join(root, "tmp");
    await mkdir(inboxDir, { recursive: true });
    await mkdir(tmpDir, { recursive: true });
    const port = await freePort();
    const env: Record<string, string> = {
      PUBLIC_ORIGIN: "https://platehouse.test",
      DATABASE_URL: t.url,
      PORT: String(port),
      S3_ENDPOINT: s3.endpoint,
      S3_REGION: s3.region,
      S3_BUCKET: bucket,
      S3_ACCESS_KEY_ID: s3.accessKeyId,
      S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
      S3_FORCE_PATH_STYLE: "true",
      OIDC_CLIENT_ID: "platehouse-test",
      OIDC_CLIENT_SECRET: randomBytes(16).toString("hex"),
      LINK_SECRET: randomBytes(32).toString("hex"),
      SLICER_URL: stub.url,
      INBOX_DIR: inboxDir,
      TMP_DIR: tmpDir,
      INBOX_SETTLE_SECONDS: "1",
    };
    return {
      env,
      config: loadConfig(env),
      db: t.db,
      repos: createRepos(t.db),
      dbUrl: t.url,
      pgc,
      s3,
      stub,
      inboxDir,
      tmpDir,
      baseUrl: `http://127.0.0.1:${port}`,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** Polls read() until done(value) holds, or fails after ms. */
export async function until<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  ms = 45_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`timed out waiting; last value ${JSON.stringify(value)}`);
    await sleep(200);
  }
}

/**
 * Puts a file in the inbox the way a finished copy lands: written under a
 * dotfile name the watcher ignores, then renamed into place.
 */
export async function dropInInbox(
  env: ServerEnv,
  name: string,
  bytes: Buffer | string,
): Promise<string> {
  const part = join(env.inboxDir, `.${randomBytes(4).toString("hex")}.writing`);
  const path = join(env.inboxDir, name);
  await writeFile(part, bytes);
  await rename(part, path);
  return path;
}

/** GET /healthz's status, or null when nothing answers. */
export async function healthStatus(env: Pick<ServerEnv, "baseUrl">): Promise<number | null> {
  try {
    const res = await fetch(`${env.baseUrl}/healthz`, { signal: AbortSignal.timeout(10_000) });
    await res.arrayBuffer();
    return res.status;
  } catch {
    return null;
  }
}
