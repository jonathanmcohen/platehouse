// The MakerWorld License value as an SPDX id or a description footer: BY,
// BY-SA, BY-NC, BY-NC-SA and BY-NC-ND become the matching CC 4.0 SPDX id, CC0
// becomes CC0-1.0, and the Standard Digital File License and the MakerWorld
// Exclusive License set no SPDX id and are named in a footer instead. Ported
// by behaviour from an earlier Manyfold metadata script.

const SPDX: ReadonlyMap<string, string> = new Map([
  ["BY-NC-SA", "CC-BY-NC-SA-4.0"],
  ["BY-NC", "CC-BY-NC-4.0"],
  ["BY-SA", "CC-BY-SA-4.0"],
  ["BY", "CC-BY-4.0"],
  ["BY-NC-ND", "CC-BY-NC-ND-4.0"],
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

// {spdx} for a value in the table, {footer} for a footer-only licence, {} for
// an empty or missing value, and {unknown: true} for anything else, so the
// caller can report it. Surrounding whitespace is ignored; nothing else is
// folded, so the match is exact.
export function mapLicense(value: string | null | undefined): LicenseMapping {
  const v = (value ?? "").trim();
  if (!v) return {};
  const spdx = SPDX.get(v);
  if (spdx !== undefined) return { spdx };
  if (FOOTER_ONLY.has(v)) return { footer: `License on MakerWorld: ${v}` };
  return { unknown: true };
}
