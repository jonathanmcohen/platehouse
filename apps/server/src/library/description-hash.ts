// The hash ingest stores beside a description it converted (migration 0010),
// in a module of its own so the models repository can use it without the
// re-conversion's store and zip readers (library/reconvert.ts).
import { createHash } from "node:crypto";

/** SHA-256 of the text's UTF-8 bytes, lowercase hex. */
export function descriptionSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
