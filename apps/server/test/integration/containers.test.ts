// Smoke test for the integration suite itself: proves the CI runner can start
// both containers the plan names and talk to each. Without at least one test
// here the integration job's zero-test guard would fail it before Tasks 4 and
// 5 add the real database and storage tests.
import { randomBytes } from "node:crypto";
import { CreateBucketCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type StartedS3, startPostgres, startS3 } from "./support/containers.js";

describe("postgres:17-alpine", () => {
  let db: StartedPostgreSqlContainer | undefined;

  beforeAll(async () => {
    db = await startPostgres();
  });

  afterAll(async () => {
    await db?.stop();
  });

  test("answers SELECT 1 and reports major version 17", async () => {
    if (!db) throw new Error("postgres container did not start");
    const client = new pg.Client({ connectionString: db.getConnectionUri() });
    await client.connect();
    try {
      const one = await client.query<{ one: number }>("select 1 as one");
      expect(one.rows).toEqual([{ one: 1 }]);
      const version = await client.query<{ server_version_num: string }>("show server_version_num");
      expect(Math.floor(Number(version.rows[0]?.server_version_num) / 10000)).toBe(17);
    } finally {
      await client.end();
    }
  });
});

describe("S3 test server", () => {
  let s3: StartedS3 | undefined;

  beforeAll(async () => {
    s3 = await startS3();
  });

  afterAll(async () => {
    await s3?.stop();
  });

  test("accepts a put and returns the same bytes on get", async () => {
    if (!s3) throw new Error("S3 container did not start");
    const bucket = "platehouse-smoke";
    const key = "models/smoke/object";
    const body = randomBytes(64 * 1024);
    await s3.client.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: "application/octet-stream",
      }),
    );
    const got = await s3.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    expect(got.ContentLength).toBe(body.length);
    expect(got.ContentType).toBe("application/octet-stream");
    const bytes = await got.Body?.transformToByteArray();
    expect(bytes && Buffer.from(bytes).equals(body)).toBe(true);
  });
});
