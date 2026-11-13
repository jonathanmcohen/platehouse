// Keeps credentials and signed queries out of everything the importer prints
// (AC-003). Every line the CLI writes goes through one Redactor, which holds
// the client id and secret, the Platehouse token, the Manyfold token once it
// arrives, and each signed query of an object-store redirect as it is seen.
// The clients already keep these out of their messages; this is the floor
// under them, for the cases they cannot see, such as a server that echoes a
// credential back in an error body. The clients quote an error body through
// one helper, quoteBody: control characters out (cleanText), then redact(),
// then whitespace made one line, then the cut to the quote length. Control
// characters come out first, in the clients and the CLI alike: taken out
// after redact(), they could join up a credential that was echoed with one
// inside it, past the redactor. That includes newline, tab and CR, so
// whitespace is collapsed only after redact(): made a space first, one of
// them inside a credential would split it into two halves the redactor
// cannot find. And redaction comes before the cut, since a value cut in two
// is no longer one this redactor can find.
//
// A credential is registered with the forms it can be echoed in: as given,
// trimmed, and with control characters taken out, each URL-encoded too. So a
// token set with a newline or space before or after it, which fetch strips
// from the header and a server may echo bare, is still found, as is one the
// output path cleaned (cleanText) before redacting. A value with nothing left
// once trimmed and cleaned is ignored, so it cannot match every space.
//
// Text that came from Manyfold (model and file names) is printed through
// cleanText as well, so a name cannot move the terminal's cursor, ring it,
// break the report's one-line-per-item shape or reorder what follows it.

/** What a redacted value is replaced with. */
export const REDACTED = "[redacted]";

export interface Redactor {
  /**
   * Adds a value the output must never show, with its trimmed and cleaned
   * forms. Empty, blank and undefined values are ignored.
   */
  add(secret: string | undefined): void;
  /** text with every known secret replaced by REDACTED. */
  redact(text: string): string;
}

export function createRedactor(secrets: Iterable<string | undefined> = []): Redactor {
  const known = new Set<string>();
  // Longest first, so a secret that contains another is replaced whole.
  let ordered: string[] = [];

  function add(secret: string | undefined): void {
    if (secret === undefined) return;
    const cleaned = cleanText(secret);
    if (cleaned.trim() === "") return;
    const forms = new Set([secret, secret.trim(), cleaned, cleaned.trim()]);
    for (const form of forms) {
      if (form === "") continue;
      known.add(form);
      known.add(encodeURIComponent(form));
    }
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

/**
 * An error body as the clients quote it: control and bidi characters
 * removed, then redacted, then on one line with each whitespace run made one
 * space, then cut to max characters. The order is what keeps a credential
 * echoed with a control character inside it (newline, tab and CR included)
 * from being printed even in part; see the top of this file.
 */
export function quoteBody(text: string, redact: (text: string) => string, max: number): string {
  return redact(cleanText(text)).replace(/\s+/g, " ").trim().slice(0, max);
}
