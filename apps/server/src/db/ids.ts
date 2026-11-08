import { randomBytes } from "node:crypto";

// UUIDv7 (RFC 9562 section 5.7): 48 bits of Unix time in milliseconds, the
// version nibble 7, 12 random bits, the variant bits 10 and 62 random bits.
// Every id the repositories mint comes from here, and the bucket key contract
// (models/<modelId>/<blobId>) relies on these being lowercase and hyphenated.
// Postgres 17 has no uuidv7() of its own (it arrives in 18), so ids are made
// in the app and every id column is a plain uuid with no default.

const MAX_MS = 2 ** 48 - 1;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for text Postgres reads as a uuid in its canonical hyphenated form. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export function uuidv7(ms: number = Date.now()): string {
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_MS) {
    throw new RangeError("uuidv7 takes a whole number of milliseconds from 0 to 2^48 - 1");
  }
  const bytes = randomBytes(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f);
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
