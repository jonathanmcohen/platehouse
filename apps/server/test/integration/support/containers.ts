// Throwaway containers for the integration suite, started with testcontainers.
// Build plan Tasks 4 and 5 build their database and storage tests on these two
// helpers, so the pinned images live in one place.
//
// Credentials are random per run and exist only inside the container; nothing
// here reads a real secret or reaches a real store.
import { randomBytes } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";

// The database image the plan pins (Global Constraints, Q7).
export const POSTGRES_IMAGE = "postgres:17-alpine";

// The test-only S3 server the plan pins (Tech Stack). SeaweedFS 4.52 is the
// named fallback if this one cannot do what Task 5 needs.
export const S3_IMAGE = "pgsty/minio:RELEASE.2026-08-04T00-00-00Z";

const S3_PORT = 9000;

export function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer(POSTGRES_IMAGE).start();
}

export interface StartedS3 {
  container: StartedTestContainer;
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  // A client for this server: path-style, as the app is configured for a
  // self-hosted store (S3_FORCE_PATH_STYLE).
  client: S3Client;
  stop(): Promise<void>;
}

export async function startS3(): Promise<StartedS3> {
  const accessKeyId = `ph${randomBytes(8).toString("hex")}`;
  const secretAccessKey = randomBytes(24).toString("hex");
  const container = await new GenericContainer(S3_IMAGE)
    .withEnvironment({ MINIO_ROOT_USER: accessKeyId, MINIO_ROOT_PASSWORD: secretAccessKey })
    .withCommand(["server", "/data"])
    .withExposedPorts(S3_PORT)
    .withWaitStrategy(Wait.forHttp("/minio/health/live", S3_PORT))
    .start();
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(S3_PORT)}`;
  const region = "us-east-1";
  const client = new S3Client({
    endpoint,
    region,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  return {
    container,
    endpoint,
    region,
    accessKeyId,
    secretAccessKey,
    client,
    async stop() {
      client.destroy();
      await container.stop();
    },
  };
}
