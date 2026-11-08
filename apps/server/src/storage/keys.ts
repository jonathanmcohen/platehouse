// The bucket key layout (build plan, Contracts): models/<modelId>/<blobId>.
// Both ids are UUIDv7, lowercase and hyphenated. A key holds no extension and
// no user-supplied text, and is never renamed (AC-060): a display name lives
// in the database only.

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7_BODY = UUID_V7.source.slice(1, -1);
const BLOB_KEY = new RegExp(`^models/${UUID_V7_BODY}/${UUID_V7_BODY}$`);

/**
 * The bucket key of a blob. Throws TypeError, naming the argument but never
 * its value, when either id is not a lowercase hyphenated UUIDv7.
 */
export function blobKey(modelId: string, blobId: string): string {
  if (!UUID_V7.test(modelId)) throw new TypeError("blobKey: modelId must be a lowercase UUIDv7");
  if (!UUID_V7.test(blobId)) throw new TypeError("blobKey: blobId must be a lowercase UUIDv7");
  return `models/${modelId}/${blobId}`;
}

/** True when a key is exactly in the models/<uuidv7>/<uuidv7> layout. */
export function isBlobKey(key: string): boolean {
  return BLOB_KEY.test(key);
}
