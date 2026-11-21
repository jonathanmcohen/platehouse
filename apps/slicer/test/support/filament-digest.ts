// A digest of the real Orca BBL filament presets the default-filament pick
// chooses from, so the unit tests can check the pick over every real printer
// without the profile tree, which only the slicer image has (it fetches it
// from Orca's source at the pinned commit; see apps/slicer/Dockerfile).
//
// It holds the menu printers and, for every bundled instantiable filament
// preset named "Generic ..." or whose base name is in BAMBU_FILAMENTS, its
// flattened filament type and the menu printers its compatible_printers
// names. The container tests check that the image's /v1/profiles matches the
// pick over this digest for every printer and type, so a digest that drifts
// from the image fails there.
//
// Regenerate it after a profile bump or a change to BAMBU_FILAMENTS, from a
// checkout of Orca's resources/profiles at the image's ORCA_SRC_SHA (the
// Dockerfile's sparse git fetch), from the repository root:
//
//   pnpm exec tsc -b
//   node apps/slicer/dist/test/support/filament-digest.js <resources/profiles> \
//     <orca version> <orca source commit> > apps/slicer/test/fixtures/orca-filaments.json
//   pnpm exec biome format --write apps/slicer/test/fixtures/orca-filaments.json
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BAMBU_FILAMENTS,
  type FilamentCandidate,
  flattenPreset,
  loadIndex,
  nozzlePrinters,
} from "../../src/profiles.js";

export interface FilamentDigest {
  orca: string;
  orcaSourceCommit: string;
  printers: string[];
  filaments: Record<string, { type: string; printers: string[] }>;
}

/** The digest's filaments as pick candidates. */
export function digestCandidates(digest: FilamentDigest): FilamentCandidate[] {
  return Object.entries(digest.filaments).map(([name, f]) => ({
    name,
    type: f.type,
    compatible: f.printers,
  }));
}

function baseName(name: string): string {
  const at = name.indexOf(" @");
  return at === -1 ? name : name.slice(0, at);
}

export function buildDigest(
  profilesRoot: string,
  orca: string,
  orcaSourceCommit: string,
): FilamentDigest {
  const index = loadIndex(profilesRoot);
  const printers = nozzlePrinters(index);
  const menu = new Set(printers);
  const bambu = new Set(Object.values(BAMBU_FILAMENTS));
  const names = [
    ...new Set([...index.vendor.filament.keys(), ...(index.library?.filament.keys() ?? [])]),
  ].sort();
  const filaments: FilamentDigest["filaments"] = {};
  for (const name of names) {
    if (name.includes(" template ")) continue;
    if (!name.startsWith("Generic ") && !bambu.has(baseName(name))) continue;
    const flat = flattenPreset(index, "filament", name);
    if (flat.profile.instantiation !== "true") continue;
    if (flat.dangling !== null) {
      throw new Error(`filament "${name}" inherits "${flat.dangling}", which the bundle lacks`);
    }
    const t = flat.profile.filament_type;
    const type = String((Array.isArray(t) ? t[0] : t) ?? "");
    const compatible = Array.isArray(flat.profile.compatible_printers)
      ? flat.profile.compatible_printers.filter(
          (p): p is string => typeof p === "string" && menu.has(p),
        )
      : [];
    if (type === "" || compatible.length === 0) continue;
    filaments[name] = { type, printers: [...new Set(compatible)].sort() };
  }
  return { orca, orcaSourceCommit, printers, filaments };
}

function isMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isMain()) {
  const [root, orca, commit] = process.argv.slice(2);
  if (!root || !orca || !commit) {
    process.stderr.write(
      "usage: filament-digest.ts <Orca resources/profiles> <orca version> <orca source commit>\n",
    );
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(buildDigest(root, orca, commit), null, 2)}\n`);
}
