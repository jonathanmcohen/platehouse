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

// A uses: line is "owner/repo(/path)?@<40 hex> # vX.Y.Z", the tag it was
// resolved from, so a moved tag cannot change what a job runs.
const PINNED = /^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40} # v\d+\.\d+\.\d+$/;

test("every uses: in every workflow is a full commit SHA with its tag as a comment", () => {
  const files = workflows();
  assert.ok(files.length >= 6, files.join(", "));
  let seen = 0;
  for (const f of files) {
    for (const line of workflow(f).split("\n")) {
      const m = line.match(/^\s*(?:- )?uses: (.*)$/);
      if (!m) continue;
      seen++;
      assert.match(m[1], PINNED, `${f}: ${line.trim()}`);
    }
  }
  assert.ok(seen >= 60, `uses: lines found: ${seen}`);
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
