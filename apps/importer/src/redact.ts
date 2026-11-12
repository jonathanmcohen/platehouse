// Keeps credentials and signed queries out of everything the importer prints
// (AC-003). Every line the CLI writes goes through one Redactor, which holds
// the client id and secret, the Platehouse token, the Manyfold token once it
// arrives, and each signed query of an object-store redirect as it is seen.
// The clients already keep these out of their messages; this is the floor
// under them, for the cases they cannot see, such as a server that echoes a
// credential back in an error body. The clients also run an error body
// through redact() before they cut it to its quote length, since a value cut
// in two is no longer one this redactor can find. Control characters are
// taken out (cleanText) before redact() runs, in the clients and the CLI
// alike: taken out after it, they could join up a credential that was echoed
// with one inside it, past the redactor.
//
// Text that came from Manyfold (model and file names) is printed through
// cleanText as well, so a name cannot move the terminal's cursor, ring it,
// break the report's one-line-per-item shape or reorder what follows it.

/** What a redacted value is replaced with. */
export const REDACTED = "[redacted]";

export interface Redactor {
  /** Adds a value the output must never show. Empty and undefined values are ignored. */
  add(secret: string | undefined): void;
  /** text with every known secret replaced by REDACTED. */
  redact(text: string): string;
}

export function createRedactor(secrets: Iterable<string | undefined> = []): Redactor {
  const known = new Set<string>();
  // Longest first, so a secret that contains another is replaced whole.
  let ordered: string[] = [];

  function add(secret: string | undefined): void {
    if (secret === undefined || secret === "") return;
    for (const form of [secret, encodeURIComponent(secret)]) known.add(form);
    ordered = [...known].sort((a, b) => b.length - a.length);
  }

  for (const s of secrets) add(s);

  return {
    add,
    redact(text) {
      let out = text;
      for (const secret of ordered) out = out.split(secret).join(REDACTED);
      return out;
    },
  };
}

/**
 * C0 controls (newline and tab included, so one value stays on one line),
 * DEL, C1 controls, and the bidi embeddings, overrides and isolates.
 */
function unsafe(cp: number): boolean {
  return (
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
}

/** Text from Manyfold made safe to print: control and bidi characters removed. */
export function cleanText(text: string): string {
  let out = "";
  for (const ch of text) if (!unsafe(ch.codePointAt(0) ?? 0)) out += ch;
  return out;
}
