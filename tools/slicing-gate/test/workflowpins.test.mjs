// Pins every GitHub Action in .github/workflows to a commit SHA (issue #420)
// and holds the small build-hygiene fixes of issue #473: the docs-pages path
// filter, release.yml's runner image, the LICENSE in the app image, tools/brand
// in the root tsconfig and a docker compose config check in CI. The workflows
// are read as text, like the other workflow tests; nothing runs on GitHub.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Paths are built with resolve, not join(ROOT, ...): ciworkflow.test.mjs scans
// the gate tests for joined reads outside tools/slicing-gate and wants each on
// ci.yml's tests list, and a whole-folder read has no file to list. Every file
// read here is on that list by hand (see the "Decide whether the gate jobs run"
// step in ci.yml), and a changed workflow is on it already.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");
const workflows = () => readdirSync(resolve(ROOT, ".github/workflows")).filter((f) => /\.ya?ml$/.test(f));
const workflow = (f) => read(`.github/workflows/${f}`);

// A uses: value is "owner/repo(/path)?@<40 hex> # vX.Y.Z", the tag it was
// resolved from, so a moved tag cannot change what a job runs. A local action
// (./path) is in the repository and needs no pin.
const PINNED = /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40} # v\d+\.\d+\.\d+$/;

// Every uses key, however it is written: plain, quoted, or in a flow mapping
// ("- { uses: x@v7 }"). The value runs to the end of the line, so the tag
// comment is part of it, and the closing brace or quote of a flow form is not.
const USES = /["']?\buses["']?\s*:\s*["']?([^"'\n}]*?)["']?\s*(?:[,}]|$)/gm;
const unpinned = (text) =>
  [...text.matchAll(USES)].map((m) => m[1].trim()).filter((v) => !v.startsWith("./") && !PINNED.test(v));

test("the pin scan catches quoted keys, flow mappings and tag-only pins", () => {
  const bad = [
    "      - uses: actions/checkout@v7",
    '      - "uses": actions/checkout@v7',
    "      - 'uses': actions/checkout@v7.0.1",
    "      - { uses: actions/checkout@v7 }",
    '      - { name: x, "uses": "actions/checkout@v7" }',
    "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b # v7.0.1",
  ];
  for (const line of bad) assert.equal(unpinned(line).length, 1, line);
  const good = [
    "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
    "      - uses: ./.github/actions/local",
    "      - { uses: ./local }",
  ];
  for (const line of good) assert.deepEqual(unpinned(line), [], line);
});

test("every uses: in every workflow is a full commit SHA with its tag as a comment", () => {
  const files = workflows();
  assert.ok(files.length >= 6, files.join(", "));
  let seen = 0;
  for (const f of files) {
    const t = workflow(f);
    seen += [...t.matchAll(USES)].length;
    assert.deepEqual(unpinned(t), [], `${f} has an action that is not pinned to a SHA with its tag`);
  }
  assert.ok(seen >= 60, `uses: entries found: ${seen}`);
});

test("one action is pinned to one SHA and one tag across all workflows", () => {
  const byAction = {};
  for (const f of workflows()) {
    for (const [, name, sha, tag] of workflow(f).matchAll(/uses: ([^@\s]+)@([0-9a-f]{40}) # (\S+)/g)) {
      (byAction[name] ??= new Set()).add(`${sha} ${tag}`);
    }
  }
  for (const [name, pins] of Object.entries(byAction)) assert.equal(pins.size, 1, `${name}: ${[...pins].join(" | ")}`);
});

test("docs-pages rebuilds when the workspace manifest, lockfile or Node version changes (#473)", () => {
  const t = workflow("docs-pages.yml");
  const paths = t.slice(t.indexOf("    paths:\n")).split("\n  workflow_dispatch")[0];
  for (const p of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", ".node-version"]) {
    assert.ok(paths.includes(`      - "${p}"\n`), `${p} is in the path filter`);
  }
});

test("release.yml runs on ubuntu-24.04, never ubuntu-latest, at every job and build runner (#473)", () => {
  const t = workflow("release.yml");
  assert.doesNotMatch(t, /^\s*(runs-on|runner): ubuntu-latest$/m);
  assert.equal([...t.matchAll(/^\s*(?:runs-on|runner): ubuntu-24\.04$/gm)].length, 3, "the gate job and the two build runners");
});

test("the app image carries the LICENSE and test-app-image.sh checks it (#473)", () => {
  assert.match(read("docker/app.Dockerfile"), /^COPY LICENSE \/app\/LICENSE$/m);
  assert.match(read("docker/test-app-image.sh"), /test -s \/app\/LICENSE/);
});

test("tools/brand is typechecked through the root tsconfig (#473)", () => {
  const refs = JSON.parse(read("tsconfig.json")).references.map((r) => r.path);
  assert.ok(refs.includes("./tools/brand"), refs.join(", "));
  const brand = JSON.parse(read("tools/brand/tsconfig.json"));
  assert.equal(brand.extends, "../../tsconfig.base.json");
});

test("CI validates the example Compose file with docker compose config (#473)", () => {
  const t = workflow("ci.yml");
  assert.match(t, /docker compose -f examples\/docker-compose\.yml --env-file \S+ config -q/);
});
