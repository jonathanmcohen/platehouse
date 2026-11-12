// Keeps credentials and signed queries out of everything the importer prints.

/** What a redacted value is replaced with. */
export const REDACTED = "[redacted]";

export interface Redactor {
  /** Adds a value the output must never show. Empty and undefined values are ignored. */
  add(secret: string | undefined): void;
  /** text with every known secret replaced by REDACTED. */
  redact(text: string): string;
}

export function createRedactor(_secrets: Iterable<string | undefined> = []): Redactor {
  throw new Error("not implemented");
}

/** Text from Manyfold made safe to print: control and bidi characters removed. */
export function cleanText(_text: string): string {
  throw new Error("not implemented");
}
