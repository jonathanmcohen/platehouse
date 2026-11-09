// The MakerWorld License value as an SPDX id or a description footer, as
// requirements AC-022 and build plan Task 7 set out. Ported by behaviour from
// mapLicense in automation Manyfold/makerworld-metadata at 1ce8c57.

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
