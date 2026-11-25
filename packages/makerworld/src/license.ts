// The MakerWorld License value as an SPDX id or a licence footer: BY, BY-SA,
// BY-ND, BY-NC, BY-NC-SA and BY-NC-ND become the matching CC 4.0 SPDX id, CC0
// becomes CC0-1.0, and the Standard Digital File License and the MakerWorld
// Exclusive License set no SPDX id and are named in a footer instead. Any
// other value is kept too: it becomes a footer, cleaned and capped, and is
// flagged unknown so the caller can report it. Ported by behaviour from an
// earlier Manyfold metadata script.

import { cutCodePoints } from "./extract.js";

const SPDX: ReadonlyMap<string, string> = new Map([
  ["BY-NC-SA", "CC-BY-NC-SA-4.0"],
  ["BY-NC", "CC-BY-NC-4.0"],
  ["BY-SA", "CC-BY-SA-4.0"],
  ["BY", "CC-BY-4.0"],
  ["BY-NC-ND", "CC-BY-NC-ND-4.0"],
  ["BY-ND", "CC-BY-ND-4.0"],
  ["CC0", "CC0-1.0"],
]);

// Licences with no SPDX id: they set no licence and are named in a footer.
const FOOTER_ONLY: ReadonlySet<string> = new Set([
  "Standard Digital File License",
  "MakerWorld Exclusive License",
]);

export interface LicenseMapping {
  spdx?: string;
  footer?: string;
  unknown?: true;
}

// The note's text (FOOTER_PREFIX and what cleanUnknown gives) is stored data:
// the description re-conversion compares stored descriptions against it later,
// so neither may change.
const FOOTER_PREFIX = "License on MakerWorld: ";
const MAX_UNKNOWN_CODE_POINTS = 120;

// Control and format characters removed, whitespace collapsed, then cut to
// MAX_UNKNOWN_CODE_POINTS without splitting a surrogate pair.
function cleanUnknown(value: string): string {
  const collapsed = value
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return cutCodePoints(collapsed, MAX_UNKNOWN_CODE_POINTS).trim();
}

// {spdx} for a value in the table, {footer} for a footer-only licence, {} for
// an empty or missing value, and {footer, unknown: true} for anything else, so
// the caller keeps the value and can report it. Surrounding whitespace is
// ignored; nothing else is folded, so the table match is exact.
export function mapLicense(value: string | null | undefined): LicenseMapping {
  const v = (value ?? "").trim();
  if (!v) return {};
  const spdx = SPDX.get(v);
  if (spdx !== undefined) return { spdx };
  if (FOOTER_ONLY.has(v)) return { footer: `${FOOTER_PREFIX}${v}` };
  const cleaned = cleanUnknown(v);
  if (!cleaned) return {};
  return { footer: `${FOOTER_PREFIX}${cleaned}`, unknown: true };
}
