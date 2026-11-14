// Makes the app's bucket on the S3 test server for the end-to-end stack
// (build plan Task 22), retrying while the server starts, then exits 0. The
// app does not make its bucket itself; on Hades the bucket already exists.
// The AWS SDK is the server package's own dependency, loaded from there.
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

// The two parts of @aws-sdk/client-s3 used here, typed by hand: the package
// is not a dependency of the root, so its own types do not resolve from e2e/.
interface S3Module {
  S3Client: new (config: object) => { send(command: unknown): Promise<unknown>; destroy(): void };
  CreateBucketCommand: new (input: { Bucket: string }) => unknown;
}

const require = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const { S3Client, CreateBucketCommand } = require("@aws-sdk/client-s3") as S3Module;

function need(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const bucket = need("S3_BUCKET");
const client = new S3Client({
  endpoint: need("S3_ENDPOINT"),
  region: need("S3_REGION"),
  forcePathStyle: true,
  credentials: {
    accessKeyId: need("S3_ACCESS_KEY_ID"),
    secretAccessKey: need("S3_SECRET_ACCESS_KEY"),
  },
});

const deadline = Date.now() + 90_000;
for (;;) {
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    console.info(`bucket ${bucket}: made`);
    break;
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists") {
      console.info(`bucket ${bucket}: already there`);
      break;
    }
    if (Date.now() > deadline) {
      console.error(`bucket ${bucket}: the S3 server did not answer in time (${name ?? "error"})`);
      process.exit(1);
    }
    await sleep(1_000);
  }
}
client.destroy();
