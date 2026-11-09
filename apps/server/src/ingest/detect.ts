// Which uploads Platehouse takes (build plan Task 8; AC-020, AC-024). The
// supported types are exactly .3mf, .stl, .step, .stp and .scad (Global
// Constraints). The file name's extension picks the kind, compared without
// regard to case, and the first bytes must agree with it:
// - .3mf is a zip: it starts with a zip local file header (PK 03 04);
// - .scad is text: no NUL byte, and valid UTF-8;
// - .stl is ASCII (starts with "solid" and has no NUL byte) or binary (at
//   least its 80-byte header and its 4-byte triangle count);
// - .step and .stp start with ISO-10303-21, after an optional UTF-8 BOM.
// Anything else is refused (null), and the caller stores nothing.
import type { FileKind } from "../db/types.js";

export type Kind = FileKind;

/** How many leading bytes detectKind needs; the caller reads this many, or the whole file if shorter. */
export const FIRST_BYTES = 4096;

const EXTENSIONS: ReadonlyMap<string, Kind> = new Map([
  ["3mf", "3mf"],
  ["stl", "stl"],
  ["step", "step"],
  ["stp", "step"],
  ["scad", "scad"],
]);

const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const STEP_MAGIC = Buffer.from("ISO-10303-21", "ascii");
const STL_BINARY_MIN = 84;

/** The extension of the last path segment, lowercased; "" for none or a dotfile. */
function extensionOf(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    // stream: true lets the sample end part way through a character.
    new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
    return true;
  } catch {
    return false;
  }
}

function startsWithAsciiSolid(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 512).toString("latin1").trimStart();
  return head.startsWith("solid");
}

/**
 * The kind of an upload from its name and its first bytes (FIRST_BYTES of
 * them, or the whole file if shorter), or null when Platehouse does not take
 * it.
 */
export function detectKind(name: string, firstBytes: Buffer, _size: number): Kind | null {
  const kind = EXTENSIONS.get(extensionOf(name));
  switch (kind) {
    case "3mf":
      return firstBytes.subarray(0, 4).equals(ZIP_LOCAL_HEADER) ? kind : null;
    case "scad":
      return isText(firstBytes) ? kind : null;
    case "stl": {
      const ascii = startsWithAsciiSolid(firstBytes) && !firstBytes.includes(0);
      return ascii || firstBytes.length >= STL_BINARY_MIN ? kind : null;
    }
    case "step": {
      const body = firstBytes.subarray(0, 3).equals(UTF8_BOM) ? firstBytes.subarray(3) : firstBytes;
      return body.subarray(0, STEP_MAGIC.length).equals(STEP_MAGIC) ? kind : null;
    }
    default:
      return null;
  }
}
