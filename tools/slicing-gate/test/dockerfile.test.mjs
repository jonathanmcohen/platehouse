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
  // Issue #6: an ORCA_SRC_TAG build arg looked like a setting but nothing read
  // it, so --build-arg ORCA_SRC_TAG=... was silently ignored. The tag is a
  // comment beside the commit it pointed to when pinned, not an ARG.
  assert.doesNotMatch(text, /^ARG ORCA_SRC_TAG\b/m, "no ORCA_SRC_TAG build arg");
  assert.doesNotMatch(text, /\$\{?ORCA_SRC_TAG\b/, "nothing reads ORCA_SRC_TAG");
  assert.match(text, new RegExp(`^# .*\\bv2\\.5\\.0\\b.*\\b${ORCA_SRC_SHA.slice(0, 7)}`, "m"), "a comment names the tag and the commit");
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

// The Dockerfile split into its stages, each with its RUNs (continuations
// joined) and its other instructions.
const stages = () => {
  const text = readFileSync(join(HERE, "Dockerfile"), "utf8").replace(/\\\n/g, " ");
  const out = [];
  for (const line of text.split("\n")) {
    if (/^FROM\b/.test(line)) out.push({ from: line, lines: [] });
    else if (out.length > 0) out.at(-1).lines.push(line);
  }
  return out.map((s) => ({ ...s, runs: s.lines.filter((l) => /^RUN\b/.test(l)) }));
};
// A Node call is node, by either path, at the start of a command (a RUN, a
// step after && or ;, or a $(...)); a path argument such as ln -s
// /opt/node/bin/node or check-libs.sh /opt/node/bin/node is not one.
const NODE_CALL = /(^RUN|&&|;|\$\()\s*(\/opt\/node\/bin\/node|node)\s/;
// A stage runs Node when a RUN calls node or the image's default command does.
const runsNode = (stage) => stage.runs.some((r) => NODE_CALL.test(r)) || stage.lines.some((l) => /^CMD \["node"/.test(l));

// Hades run 2 (2026-11-08): the fetch stage's first Node call, the profile
// version check, died with "libatomic.so.1: cannot open shared object file"
// (exit 127). The Node 26 linux-x64 binary links libatomic.so.1, which the
// ubuntu:24.04 base image does not carry.
test("both stages run Node", () => {
  const s = stages();
  assert.equal(s.length, 2);
  for (const stage of s) assert.ok(runsNode(stage), `${stage.from} runs node`);
});

test("every stage that runs Node installs libatomic1 from the dated snapshot", () => {
  for (const stage of stages().filter(runsNode)) {
    const apt = stage.runs.find((r) => r.includes("apt-get install"));
    assert.ok(apt, `${stage.from} installs apt packages`);
    const after = apt.split("APT::Snapshot")[1];
    assert.ok(after !== undefined, `${stage.from} switches the snapshot on`);
    const installs = after.split("&&").filter((c) => c.includes("apt-get install"));
    const pkgs = installs.flatMap((c) => c.replace(/.*apt-get install/, "").trim().split(/\s+/));
    assert.ok(pkgs.includes("libatomic1"), `${stage.from} installs libatomic1 after the snapshot is on: ${pkgs.join(" ")}`);
  }
});

// check-libs.sh names the binary and every missing library, so the next
// missing library fails the build there instead of at a later RUN with exit 127.
test("every stage that runs Node checks /opt/node/bin/node's libraries before its first Node call", () => {
  for (const stage of stages().filter(runsNode)) {
    assert.ok(
      stage.lines.some((l) => /^COPY\b.*\bcheck-libs\.sh\b/.test(l)),
      `${stage.from} copies check-libs.sh in`,
    );
    const check = stage.runs.findIndex((r) => /bash \S*check-libs\.sh \/opt\/node\/bin\/node\b/.test(r));
    assert.ok(check !== -1, `${stage.from} runs check-libs.sh on /opt/node/bin/node`);
    const firstNode = stage.runs.findIndex((r) => NODE_CALL.test(r));
    assert.ok(firstNode !== -1, `${stage.from} calls node`);
    assert.ok(check <= firstNode, `${stage.from}: the library check (RUN ${check}) comes before the first Node call (RUN ${firstNode})`);
    if (check === firstNode) {
      const run = stage.runs[check];
      assert.ok(
        run.indexOf("check-libs.sh /opt/node/bin/node") < run.search(NODE_CALL),
        `${stage.from}: the library check runs before node in the same RUN`,
      );
    }
  }
});
