// Build plan Task 17 with Task 30's entry point: start(config) wires file
// delivery and slicer links into the real server (buildApp registers them
// only when it is given deps.delivery). A .3mf dropped in the inbox becomes
// a file; a session made in the sessions table mints a link with the
// server's own LINK_SECRET; the link, with no session, returns the file's
// bytes, and the download and blob routes answer.
//
// Postgres 17, the S3 test server and the slicer stub, as Task 30's server
// tests use them. Every file and value is generated per run.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createSessions, dbSessionStore, SESSION_COOKIE } from "../../../src/auth/sessions.js";
import type { SlicerLink } from "../../../src/delivery/links.js";
import { type Server, start } from "../../../src/main.js";
import { build3mf } from "../support/ingest.js";
import { dropInInbox, type ServerEnv, startServerEnv, until } from "../support/server.js";

let env: ServerEnv;
let server: Server | undefined;

beforeAll(async () => {
  env = await startServerEnv();
  server = await start(env.config);
});

afterAll(async () => {
  await server?.stop();
  await env?.stop();
});

describe("the real server serves delivery and slicer links", () => {
  test("an inbox file can be downloaded and opened by a link with no session", async () => {
    const name = `Delivery ${Date.now()}.3mf`;
    const bytes = build3mf({ plates: 1 });
    await dropInInbox(env, name, bytes);
    const file = await until(
      () =>
        env.db.selectFrom("files").selectAll().where("originalName", "=", name).executeTakeFirst(),
      (f) => f !== undefined,
    );
    if (file === undefined) throw new Error("the inbox file was not imported");

    const session = await createSessions({ store: dbSessionStore(env.db) }).start("jon");
    const cookie = `${SESSION_COOKIE}=${session.id}`;

    const download = await fetch(`${env.baseUrl}/files/${file.id}/download`, {
      headers: { cookie },
    });
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer()).equals(bytes)).toBe(true);

    const minted = await fetch(`${env.baseUrl}/app/api/files/${file.id}/slicer-link`, {
      method: "POST",
      headers: { cookie, origin: env.config.publicOrigin },
    });
    expect(minted.status).toBe(200);
    const link = (await minted.json()) as SlicerLink;
    expect(link.url.startsWith(`${env.config.publicOrigin}/s/`)).toBe(true);
    expect(link.url.endsWith(`/${encodeURIComponent(name)}`)).toBe(true);

    const path = link.url.slice(env.config.publicOrigin.length);
    const opened = await fetch(`${env.baseUrl}${path}`);
    expect(opened.status).toBe(200);
    expect(Buffer.from(await opened.arrayBuffer()).equals(bytes)).toBe(true);

    const refused = await fetch(`${env.baseUrl}/s/${"A".repeat(48)}/${encodeURIComponent(name)}`);
    expect(refused.status).toBe(403);
    expect((await refused.arrayBuffer()).byteLength).toBe(0);

    const thumbnail = await env.db
      .selectFrom("plates")
      .select("thumbnailBlobId")
      .where("fileId", "=", file.id)
      .executeTakeFirst();
    expect(thumbnail?.thumbnailBlobId).toBeTruthy();
    const blob = await fetch(`${env.baseUrl}/blobs/${thumbnail?.thumbnailBlobId}`, {
      headers: { cookie },
    });
    expect(blob.status).toBe(200);
    expect(blob.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect((await blob.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
});
