// The bucket versioning check (AC-013, decided Q20). Platehouse reads the
// state at startup and the settings page warns when it is off.
import { GetBucketVersioningCommand, type S3Client } from "@aws-sdk/client-s3";
import { StoreUnavailable, toStoreError } from "./errors.js";

export type VersioningState = "enabled" | "suspended" | "off" | "unknown";

/**
 * Maps GetBucketVersioning's Status to a state. S3 leaves Status out for a
 * bucket that never had versioning turned on, which is "off".
 */
export function versioningState(status: unknown): VersioningState {
  if (status === undefined || status === "") return "off";
  if (status === "Enabled") return "enabled";
  if (status === "Suspended") return "suspended";
  return "unknown";
}

/**
 * Reads the bucket's versioning state. Throws StoreUnavailable when the store
 * cannot be reached. Any refusal (no permission to read it, a provider that
 * does not implement it, a missing bucket) is "unknown": the state could not
 * be read, which is not the same as off.
 */
export async function readVersioning(client: S3Client, bucket: string): Promise<VersioningState> {
  try {
    const out = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    return versioningState(out.Status);
  } catch (err) {
    const mapped = toStoreError(err, "GetBucketVersioning");
    if (mapped instanceof StoreUnavailable) throw mapped;
    return "unknown";
  }
}
