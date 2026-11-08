// Pins how the gate image's Dockerfile references the BuildKit frontend, how
// its build checks report a failure, and the paths it checks in each
// downloaded artifact.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the Dockerfile pulls no frontend image by a floating tag", () => {
  const lines = readFileSync(join(HERE, "Dockerfile"), "utf8").split("\n");
  // Parser directives are only honoured in the leading comment block.
  const directives = [];
  for (const line of lines) {
    if (!line.startsWith("#")) break;
    if (/^#\s*syntax\s*=/i.test(line)) directives.push(line);
  }
  for (const d of directives) {
    assert.match(
      d,
      /^#\s*syntax\s*=\s*docker\/dockerfile:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}\s*$/,
      `frontend must be absent or pinned to an exact version and digest: ${d}`,
    );
  }
});

// apt installs before the APT::Snapshot line come from the live archive, so
// each package there must name an exact version, or the image varies with the
// day it is built.
test("every apt package installed before the snapshot is switched on names an exact version", () => {
  const text = readFileSync(join(HERE, "Dockerfile"), "utf8").replace(/\\\n/g, " ");
  const runs = text.split("\n").filter((l) => /^RUN\b/.test(l) && l.includes("apt-get install"));
  assert.ok(runs.length >= 2, "both stages install apt packages");
  for (const run of runs) {
    const [before, after] = run.split("APT::Snapshot");
    assert.ok(after !== undefined, `the snapshot is switched on in: ${run.slice(0, 80)}`);
    for (const install of before.split("&&").filter((c) => c.includes("apt-get install"))) {
      const pkgs = install.replace(/.*apt-get install/, "").trim().split(/\s+/).filter((w) => !w.startsWith("-"));
      assert.ok(pkgs.length > 0, install);
      for (const p of pkgs) assert.match(p, /^[a-z0-9.+-]+=[0-9][A-Za-z0-9.+~:-]*$/, `unpinned before the snapshot: ${p}`);
    }
  }
});

// Every RUN with its line continuations joined.
const runs = () =>
  readFileSync(join(HERE, "Dockerfile"), "utf8")
    .replace(/\\\n/g, " ")
    .split("\n")
    .filter((l) => /^RUN\b/.test(l));

const need = (script) => spawnSync("bash", ["-euo", "pipefail", "-c", `source "${join(HERE, "need.sh")}"; ${script}`], { encoding: "utf8" });

// On Hades (2026-11-08) the Orca step passed its sha256 check and then exited 1
// with no text, because a bare `test -f` failed. need names the check instead.
test("need passes silently when its test holds", () => {
  const r = need(`need -d "${HERE}" && echo after`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "after\n");
  assert.equal(r.stderr, "");
});

test("need names the failed check on stderr, exits 1 and stops the chain", () => {
  const r = need("need -x /nonexistent/AppRun && echo after");
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "build check failed: test -x /nonexistent/AppRun\n");
});

test("need adds the reason given after --", () => {
  const r = need('need -f /nonexistent/BBL.json -- "profiles are packed elsewhere"');
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "build check failed: test -f /nonexistent/BBL.json - profiles are packed elsewhere\n");
});

test("need compares strings, so a wrong version names both values", () => {
  const r = need("need v26.6.0 = v26.13.0");
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "build check failed: test v26.6.0 = v26.13.0\n");
});

test("no RUN makes a bare test or grep -q check that would fail without saying which", () => {
  for (const run of runs()) {
    assert.doesNotMatch(run, /(^RUN|&&|;|\|\||\{)\s*(test|\[\[?)\s/, `bare test in: ${run.slice(0, 120)}`);
    assert.doesNotMatch(run, /grep -q/, `silent grep in: ${run.slice(0, 120)}`);
  }
});

test("every RUN that calls need sources it, and both stages copy it in", () => {
  const callers = runs().filter((r) => /&& need /.test(r));
  assert.ok(callers.length >= 3, "the Orca, OpenSCAD and final checks use need");
  for (const run of callers) assert.match(run, /source \/usr\/local\/lib\/need\.sh/, run.slice(0, 120));
  const text = readFileSync(join(HERE, "Dockerfile"), "utf8");
  assert.equal(text.match(/^COPY need\.sh \/usr\/local\/lib\/need\.sh$/gm)?.length, 2);
});

// The paths each downloaded artifact really holds, read from the pinned
// files on 2026-11-08 (squashfs listings of both AppImages, the npm tarball,
// the Node tarball and the NIST zip). See the PR for the listing lines.
test("the build checks the paths the pinned artifacts really hold", () => {
  const all = runs().join("\n");
  for (const check of [
    "need -x /opt/orca/AppRun",
    "need -x /opt/orca/libexec/orca-slicer-env",
    "need -x /opt/orca/bin/orca-slicer",
    "need -d /opt/orca/lib/orca-runtime",
    "need -f /opt/orca/resources/profiles/BBL.opc",
    "need -x /opt/openscad/AppRun",
    "need -x /opt/openscad/usr/bin/openscad",
    "need -x /usr/local/bin/landrun",
    'need "$(node --version)" = v26.13.0',
    "need -f /opt/gate/node_modules/occt-import-js/dist/occt-import-js.js",
    "need -f /opt/gate/node_modules/occt-import-js/dist/occt-import-js.wasm",
  ]) {
    assert.ok(all.includes(check), `missing: ${check}`);
  }
  assert.doesNotMatch(all, /find \/opt\/openscad/, "OpenSCAD's binary is named, not searched for");
});

// Jon's call, 2026-11-08: Orca 2.5.0 ships its presets only as binary .opc
// caches, so the gate takes the BBL profile JSON from Orca's own source at the
// commit tag v2.5.0 points to, fetched by that commit and checked by git.
const ORCA_SRC_SHA = "40ecc66f78ed72dc368e0c1ebe40d77f00cc8a19";
const PROFILES = "/opt/orca-profiles";

test("the profile source is pinned by the commit tag v2.5.0 points to, not by a moving ref", () => {
  const text = readFileSync(join(HERE, "Dockerfile"), "utf8");
  assert.match(text, /^ARG ORCA_SRC_TAG=v2\.5\.0$/m);
  assert.match(text, new RegExp(`^ARG ORCA_SRC_SHA=${ORCA_SRC_SHA}$`, "m"));
  const all = runs().join("\n");
  const fetches = all.match(/git fetch [^&]*/g) ?? [];
  assert.equal(fetches.length, 1, fetches.join("\n"));
  assert.match(fetches[0], /--depth 1 /);
  assert.match(fetches[0], /--filter=blob:none /);
  assert.match(fetches[0], /origin "\$ORCA_SRC_SHA"\s*$/, "the fetch names the commit");
  assert.doesNotMatch(all, /git (clone|fetch)[^&]*(\$ORCA_SRC_TAG|v2\.5\.0|--branch|refs\/)/, "no tag or branch is fetched");
  assert.ok(all.includes('need "$(git rev-parse HEAD)" = "$ORCA_SRC_SHA"'), "HEAD is checked against the pin");
  assert.match(all, /git sparse-checkout set --no-cone /);
});

test("the README Pins table names the same tag and commit as the Dockerfile", () => {
  const readme = readFileSync(join(HERE, "README.md"), "utf8");
  const row = readme.split("\n").find((l) => l.startsWith("| OrcaSlicer profiles"));
  assert.ok(row, "a Pins row for the profiles");
  assert.ok(row.includes("v2.5.0") && row.includes(ORCA_SRC_SHA), row);
});

test("the profile JSON lands in its own folder, checked, beside Orca's shipped .opc files", () => {
  const all = runs().join("\n");
  for (const check of [
    `need -f ${PROFILES}/BBL.json`,
    `need -d ${PROFILES}/BBL/machine`,
    `need -d ${PROFILES}/BBL/process`,
    `need -d ${PROFILES}/BBL/filament`,
    `need -f ${PROFILES}/OrcaFilamentLibrary.json`,
    `need -d ${PROFILES}/OrcaFilamentLibrary/filament`,
  ]) {
    assert.ok(all.includes(check), `missing: ${check}`);
  }
  const text = readFileSync(join(HERE, "Dockerfile"), "utf8");
  assert.match(text, new RegExp(`^COPY --from=fetch ${PROFILES} ${PROFILES}$`, "m"));
  assert.ok(!PROFILES.startsWith("/opt/orca/"), "not inside the AppImage tree");
});

test("the build fails unless the source BBL.json version matches the BBL.opc Orca ships", () => {
  const text = readFileSync(join(HERE, "Dockerfile"), "utf8");
  // The script imports lib/is-main.mjs, so it is copied beside it.
  assert.match(text, /^COPY check-profile-version\.mjs \/opt\/gate-build\/check-profile-version\.mjs$/m);
  assert.match(text, /^COPY lib\/is-main\.mjs \/opt\/gate-build\/lib\/is-main\.mjs$/m);
  const all = runs().join("\n");
  for (const vendor of ["BBL", "OrcaFilamentLibrary"]) {
    assert.ok(
      all.includes(
        `/opt/node/bin/node /opt/gate-build/check-profile-version.mjs /opt/orca/resources/profiles/${vendor}.opc ${PROFILES}/${vendor}.json`,
      ),
      `the version check runs on ${vendor}`,
    );
  }
});

test("gate.mjs reads the profiles from the fetched JSON folder", () => {
  const env = { ...process.env };
  delete env.GATE_ORCA_PROFILES;
  const r = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `import { PATHS } from ${JSON.stringify(join(HERE, "gate.mjs"))}; process.stdout.write(PATHS.orcaProfiles);`],
    { encoding: "utf8", env },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, PROFILES);
});
