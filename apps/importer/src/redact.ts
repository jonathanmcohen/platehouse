// Keeps credentials and signed queries out of everything the importer prints
// (AC-003). Every line the CLI writes goes through one Redactor, which holds
// the client id and secret, the Platehouse token, the Manyfold token once it
// arrives, and each signed query of an object-store redirect as it is seen.
// The clients already keep these out of their messages; this is the floor
// under them, for the cases they cannot see, such as a server that echoes a
// credential back in an error body. The clients quote an error body through
// one helper, quoteBody, and the CLI cleans every line it prints. Control
// characters come out before redact(), in the clients and the CLI alike:
// taken out after it, they could join up a credential that was echoed with
// one inside it, past the redactor. That includes newline, tab and CR, so
// quoteBody first redacts the body with them taken out (cleanText). Only if
// that finds nothing does it quote the body with the line breaks and tabs
// made spaces instead, redacted again, so separate lines do not run
// together; whitespace is collapsed only after redact(). And redaction comes
// before the cut, since a value cut in two is no longer one this redactor can
// find.
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

/** text with each tab, newline, VT, FF and CR (0x09 to 0x0d) made a space. */
function spaced(text: string): string {
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    out += cp >= 0x09 && cp <= 0x0d ? " " : ch;
  }
  return out;
}

/**
 * An error body as the clients quote it, on one line with each whitespace
 * run made one space, then cut to max characters. Redacted with every control
 * and bidi character removed first (cleanText), so a credential echoed with
 * a newline, tab or CR inside it is found whole. If that finds a credential,
 * that redacted text is what is quoted. If not, the body is quoted with its
 * line breaks and tabs made spaces and the other control and bidi characters
 * removed, redacted again (a credential may itself hold a space), so the
 * words of separate lines stay apart. See the top of this file.
 */
export function quoteBody(text: string, redact: (text: string) => string, max: number): string {
  const cleaned = cleanText(text);
  const redacted = redact(cleaned);
  const quoted = redacted !== cleaned ? redacted : redact(cleanText(spaced(text)));
  return quoted.replace(/\s+/g, " ").trim().slice(0, max);
}
