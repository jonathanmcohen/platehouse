// Picks the tag the rc image tags point at (.github/workflows/rc-tag.yml).
//
// The rule: rc points at T, the highest version by semver precedence among
// the pushed vX.Y.Z-rc.N and plain vX.Y.Z tags whose app image
// (platehouse:X.Y.Z[-rc.N]) and slicer image (platehouse-slicer:X.Y.Z[-rc.N])
// were both published. Any other tag, such as v0.0.0-test, v0.2.0-beta.1,
// v0.2.0-rc or v0.2.0-rc.01, never qualifies. Everything here is a pure
// function of its input; the workflow gathers the input from the git tags and
// the registry each time it runs, so the answer never depends on which run
// triggered it or in what order runs finished.
//
// Command line, used by the workflow:
//   node rc-target.mjs candidates   tag names on stdin, one per line; prints
//                                   the qualifying ones, highest first
//   node rc-target.mjs pick         JSON lines {"tag","app","slicer"} on
//                                   stdin; prints T, or nothing when no tag
//                                   has both images published

import { pathToFileURL } from "node:url";

const QUALIFYING = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-rc\.(0|[1-9][0-9]*))?$/;

// The parts of a qualifying tag, as digit strings (no leading zeros, so no
// precision limit), or null for any other string.
export function parseTag(tag) {
  const m = typeof tag === "string" ? QUALIFYING.exec(tag) : null;
  if (!m) return null;
  return { major: m[1], minor: m[2], patch: m[3], rc: m[4] ?? null };
}

// Numeric order of two digit strings without leading zeros.
function compareDigits(a, b) {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Semver precedence of two qualifying tags: negative, zero or positive. A
// plain release sorts above every rc of the same version, and rc numbers
// compare as numbers (rc.10 above rc.9).
export function compareTags(a, b) {
  const x = parseTag(a);
  const y = parseTag(b);
  if (!x || !y) throw new Error(`not a vX.Y.Z or vX.Y.Z-rc.N tag: ${!x ? a : b}`);
  for (const k of ["major", "minor", "patch"]) {
    const c = compareDigits(x[k], y[k]);
    if (c !== 0) return c;
  }
  if (x.rc === null || y.rc === null) return x.rc === y.rc ? 0 : x.rc === null ? 1 : -1;
  return compareDigits(x.rc, y.rc);
}

// The qualifying tags in a list, without duplicates, highest first.
export function candidates(tags) {
  return [...new Set(tags.filter((t) => parseTag(t) !== null))].sort((a, b) => compareTags(b, a));
}

// T: the highest qualifying tag whose app and slicer images were both
// published, or null. entries: [{ tag, app, slicer }], app and slicer true
// only when that image's version tag exists in the registry.
export function pickTarget(entries) {
  let best = null;
  for (const e of entries) {
    if (!e || e.app !== true || e.slicer !== true || parseTag(e.tag) === null) continue;
    if (best === null || compareTags(e.tag, best) > 0) best = e.tag;
  }
  return best;
}

async function readStdin() {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

async function main(mode) {
  const lines = (await readStdin()).split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (mode === "candidates") {
    for (const t of candidates(lines)) process.stdout.write(`${t}\n`);
  } else if (mode === "pick") {
    const t = pickTarget(lines.map((l) => JSON.parse(l)));
    if (t !== null) process.stdout.write(`${t}\n`);
  } else {
    throw new Error(`usage: rc-target.mjs candidates|pick (got '${mode ?? ""}')`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).catch((e) => {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  });
}
