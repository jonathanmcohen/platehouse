// pnpm i18n:format: rewrites every catalog in packages/i18n/locales into its
// canonical form (the maintainer, 2026-11-19): $meta first, then the keys sorted, two
// spaces of indent, a newline at the end, and every character outside ASCII
// written as a \u escape, so the repo stays ASCII however a translator typed
// it. With --check it rewrites nothing and exits 1 when a file is not in
// that form. The catalog test (packages/i18n/test/catalogs.test.ts) runs the
// same check in CI, through canonicalCatalog below.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LOCALES = fileURLToPath(new URL("../locales/", import.meta.url));

/** The canonical text of a catalog file's parsed JSON. */
export function canonicalCatalog(data) {
  const keys = Object.keys(data).sort((a, b) => {
    if (a === "$meta") return -1;
    if (b === "$meta") return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const ordered = {};
  for (const key of keys) ordered[key] = data[key];
  const text = JSON.stringify(ordered, null, 2).replace(
    /[\u0080-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return `${text}\n`;
}

function main() {
  const check = process.argv.includes("--check");
  let bad = 0;
  for (const name of readdirSync(LOCALES).sort()) {
    if (!name.endsWith(".json")) continue;
    const path = join(LOCALES, name);
    const before = readFileSync(path, "utf8");
    const after = canonicalCatalog(JSON.parse(before));
    if (before === after) continue;
    if (check) {
      console.error(`${name} is not in canonical form; run pnpm i18n:format`);
      bad += 1;
    } else {
      writeFileSync(path, after);
      console.log(`formatted ${name}`);
    }
  }
  if (bad > 0) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
