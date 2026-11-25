// Pins the weekly base-image and Node refresh (issue #453): the pure functions
// in .github/scripts/base-images.mjs, .github/workflows/base-images.yml read
// as text with its shell steps run in bash and docker, curl, git, gh stubbed,
// and the two gates of issues #432 and #453 in ci.yml and release.yml (the
// audit step and the Trivy library gates). Nothing here asks the network
// anything or runs a workflow on GitHub.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  APP_DOCKERFILE,
  DIGEST_FILES,
  E2E_COMPOSE,
  FILES,
  GATE_DOCKERFILE,
  GATE_README,
  NODE_KEYRING_URL,
  NODE_RELEASE_KEYRING_SHA256,
  NODE_RELEASE_KEYS_COMMIT,
  NODE_VERSION_FILE,
  ROOT_README,
  SLICER_DOCKERFILE,
  grepArgs,
  latestNode,
  leftovers,
  nodeSha,
  readPins,
  rewritePins,
  verifySignedShasums,
} from "../../../.github/scripts/base-images.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "base-images.yml");
const SCRIPT = join(ROOT, ".github", "scripts", "base-images.mjs");
const CI = join(ROOT, ".github", "workflows", "ci.yml");
const RELEASE = join(ROOT, ".github", "workflows", "release.yml");
const WORKSPACE = join(ROOT, "pnpm-workspace.yaml");
const APP_FILE = join(ROOT, "docker", "app.Dockerfile");
const NODE_VERSION_PATH = join(ROOT, ".node-version");
const COMPOSE_FILE = join(ROOT, "e2e", "compose.yml");
const README_FILE = join(ROOT, "README.md");
const SLICER_FILE = join(ROOT, "apps", "slicer", "Dockerfile");
const GATE_FILE = join(ROOT, "tools", "slicing-gate", "Dockerfile");
const GATE_README_FILE = join(ROOT, "tools", "slicing-gate", "README.md");
const text = () => readFileSync(WORKFLOW, "utf8");

// A stand-in job token for the stubbed steps; not a credential of any kind.
const FAKE_TOKEN = ["place", "holder"].join("-");

const hex = (c) => c.repeat(64);
const repoTexts = () => ({
  [APP_DOCKERFILE]: readFileSync(APP_FILE, "utf8"),
  [SLICER_DOCKERFILE]: readFileSync(SLICER_FILE, "utf8"),
  [GATE_DOCKERFILE]: readFileSync(GATE_FILE, "utf8"),
  [GATE_README]: readFileSync(GATE_README_FILE, "utf8"),
  [NODE_VERSION_FILE]: readFileSync(NODE_VERSION_PATH, "utf8"),
  [E2E_COMPOSE]: readFileSync(COMPOSE_FILE, "utf8"),
  [ROOT_README]: readFileSync(README_FILE, "utf8"),
});

// Small stand-ins for the four files, shaped like the real ones.
const fakeTexts = ({
  app = `node:26.1.0-trixie-slim@sha256:${hex("a")}`,
  ubuntu = `ubuntu:24.04@sha256:${hex("b")}`,
  slicerUbuntu = ubuntu,
  gateUbuntu = ubuntu,
  version = "26.1.0",
  slicerVersion = version,
  gateVersion = version,
  sha = hex("c"),
  slicerSha = sha,
  gateSha = sha,
  nodeFiles = version,
} = {}) => ({
  [APP_DOCKERFILE]: [
    "# on node:26.1.0-trixie-slim, run as the node user.",
    "",
    "# node:26.1.0-trixie-slim, multi-arch index digest read from Docker Hub on",
    "# 2026-11-13 (last updated 2026-11-05; amd64 manifest",
    `# sha256:${hex("d")}, arm64 sha256:${hex("e")}).`,
    `ARG BASE=${app}`,
    'RUN test "$(node --version)" = v26.1.0',
    "",
  ].join("\n"),
  [SLICER_DOCKERFILE]: [
    "# ubuntu:24.04, multi-arch index digest read from Docker Hub on 2026-11-07",
    `# (amd64 manifest sha256:${hex("d")}).`,
    `ARG BASE=${slicerUbuntu}`,
    `# Node.js ${slicerVersion}, linux x64.`,
    `ARG NODE_URL=https://nodejs.org/dist/v${slicerVersion}/node-v${slicerVersion}-linux-x64.tar.xz`,
    `ARG NODE_SHA256=${slicerSha}`,
    `RUN need "$(/opt/node/bin/node --version)" = v${slicerVersion}`,
    "",
  ].join("\n"),
  [GATE_DOCKERFILE]: [
    "# ubuntu:24.04, multi-arch index digest read from Docker Hub on 2026-11-07",
    `# (amd64 manifest sha256:${hex("d")}).`,
    `ARG BASE=${gateUbuntu}`,
    `# Node.js ${gateVersion}, linux x64.`,
    `ARG NODE_URL=https://nodejs.org/dist/v${gateVersion}/node-v${gateVersion}-linux-x64.tar.xz`,
    `ARG NODE_SHA256=${gateSha}`,
    `RUN need "$(node --version)" = v${gateVersion}`,
    "",
  ].join("\n"),
  [GATE_README]: [
    "| What | Version | Checked against |",
    "|---|---|---|",
    `| Base image | ubuntu:24.04 | index digest \`${ubuntu.split("@")[1]}\` |`,
    `| Node.js | ${version} linux x64 | sha256 \`${sha}\` |`,
    "",
  ].join("\n"),
  [NODE_VERSION_FILE]: `${nodeFiles}\n`,
  [E2E_COMPOSE]: `x-node: &node\n  image: node:${nodeFiles}-trixie-slim\n  working_dir: /repo\n`,
  [ROOT_README]: `You need Node ${nodeFiles}, the version in \`.node-version\`, and pnpm.\n`,
});

const NEXT = {
  appBase: `node:26.2.0-trixie-slim@sha256:${hex("1")}`,
  ubuntuBase: `ubuntu:24.04@sha256:${hex("2")}`,
  nodeVersion: "26.2.0",
  nodeSha: hex("3"),
  date: "2026-12-01",
};

// ------------------------------------------------------------------ readPins

test("readPins: reads the base images, the Node version and its sha from the files", () => {
  assert.deepEqual(readPins(fakeTexts()), {
    appBase: `node:26.1.0-trixie-slim@sha256:${hex("a")}`,
    ubuntuBase: `ubuntu:24.04@sha256:${hex("b")}`,
    nodeVersion: "26.1.0",
    nodeSha: hex("c"),
  });
});

test("readPins: reads the repo's own files, which agree", () => {
  const p = readPins(repoTexts());
  assert.match(p.appBase, /^node:\d+\.\d+\.\d+-trixie-slim@sha256:[0-9a-f]{64}$/);
  assert.match(p.ubuntuBase, /^ubuntu:24\.04@sha256:[0-9a-f]{64}$/);
  assert.match(p.nodeVersion, /^\d+\.\d+\.\d+$/);
  assert.match(p.nodeSha, /^[0-9a-f]{64}$/);
  assert.ok(p.appBase.startsWith(`node:${p.nodeVersion}-trixie-slim@`), "one Node release in the app image and the download");
});

test("readPins: refuses when the slicer and the gate disagree on the base image, Node or its sha", () => {
  assert.throws(
    () => readPins(fakeTexts({ gateUbuntu: `ubuntu:24.04@sha256:${hex("f")}` })),
    /apps\/slicer\/Dockerfile and tools\/slicing-gate\/Dockerfile disagree on the base image/,
  );
  assert.throws(
    () => readPins(fakeTexts({ gateVersion: "26.0.9" })),
    /apps\/slicer\/Dockerfile and tools\/slicing-gate\/Dockerfile disagree on the Node version/,
  );
  assert.throws(
    () => readPins(fakeTexts({ gateSha: hex("f") })),
    /apps\/slicer\/Dockerfile and tools\/slicing-gate\/Dockerfile disagree on the Node sha256/,
  );
});

test("readPins: refuses an app image on another Node release than the download", () => {
  assert.throws(
    () => readPins(fakeTexts({ app: `node:26.0.0-trixie-slim@sha256:${hex("a")}` })),
    /the app image's Node 26\.0\.0 is not the downloaded Node 26\.1\.0/,
  );
});

test("readPins: refuses a missing, doubled or malformed pin, and a NODE_URL that names two versions", () => {
  const t = fakeTexts();
  assert.throws(() => readPins({ ...t, [APP_DOCKERFILE]: "FROM x\n" }), /docker\/app\.Dockerfile has 0 ARG BASE= lines, not 1/);
  assert.throws(
    () => readPins({ ...t, [SLICER_DOCKERFILE]: `${t[SLICER_DOCKERFILE]}ARG BASE=ubuntu:24.04@sha256:${hex("b")}\n` }),
    /apps\/slicer\/Dockerfile has 2 ARG BASE= lines, not 1/,
  );
  assert.throws(
    () => readPins({ ...t, [GATE_DOCKERFILE]: t[GATE_DOCKERFILE].replace(/@sha256:\w+/, "") }),
    /tools\/slicing-gate\/Dockerfile pins ARG BASE=ubuntu:24\.04, not image@sha256:<digest>/,
  );
  assert.throws(
    () => readPins({ ...t, [SLICER_DOCKERFILE]: t[SLICER_DOCKERFILE].replace(`/node-v26.1.0-`, "/node-v26.1.1-") }),
    /NODE_URL names two Node versions/,
  );
  assert.throws(
    () => readPins({ ...t, [SLICER_DOCKERFILE]: t[SLICER_DOCKERFILE].replace(hex("c"), "abc") }),
    /NODE_SHA256=abc is not a sha256/,
  );
  assert.throws(() => readPins({ ...t, [GATE_README]: undefined }), /tools\/slicing-gate\/README\.md was not read/);
});

test("readPins: refuses .node-version, the e2e image or the README sentence on another Node release", () => {
  const t = fakeTexts();
  const stale = fakeTexts({ nodeFiles: "26.0.0" });
  assert.throws(() => readPins({ ...t, [NODE_VERSION_FILE]: stale[NODE_VERSION_FILE] }), /\.node-version names Node 26\.0\.0, the Dockerfiles pin 26\.1\.0/);
  assert.throws(() => readPins({ ...t, [E2E_COMPOSE]: stale[E2E_COMPOSE] }), /e2e\/compose\.yml names Node 26\.0\.0, the Dockerfiles pin 26\.1\.0/);
  assert.throws(() => readPins({ ...t, [ROOT_README]: stale[ROOT_README] }), /README\.md names Node 26\.0\.0, the Dockerfiles pin 26\.1\.0/);
  assert.throws(() => readPins({ ...t, [E2E_COMPOSE]: "x: 1\n" }), /e2e\/compose\.yml does not hold one `image: node:X\.Y\.Z-trixie-slim` line/);
  assert.throws(() => readPins({ ...t, [ROOT_README]: "no version here\n" }), /README\.md does not hold one "You need Node/);
  assert.throws(() => readPins({ ...t, [NODE_VERSION_FILE]: "lts\n" }), /\.node-version does not hold a single X\.Y\.Z line/);
  assert.throws(() => readPins({ ...t, [E2E_COMPOSE]: undefined }), /e2e\/compose\.yml was not read/);
});

test("readPins: refuses a README whose pins table disagrees with the Dockerfiles", () => {
  const t = fakeTexts();
  assert.throws(
    () => readPins({ ...t, [GATE_README]: t[GATE_README].replace(hex("b"), hex("f")) }),
    /README\.md lists the base image digest sha256:f+, the Dockerfiles pin sha256:b+/,
  );
  assert.throws(
    () => readPins({ ...t, [GATE_README]: t[GATE_README].replace("| Node.js | 26.1.0 ", "| Node.js | 26.0.0 ") }),
    /README\.md lists Node 26\.0\.0, the Dockerfiles pin 26\.1\.0/,
  );
});

// -------------------------------------------------------------- rewritePins

test("rewritePins: moves every pin, its copies and the README table, and reads back as the new pins", () => {
  const out = rewritePins(fakeTexts(), NEXT);
  const { date: _date, ...want } = NEXT;
  assert.deepEqual(readPins(out), want);
  assert.match(out[APP_DOCKERFILE], /^# on node:26\.2\.0-trixie-slim, run as/m);
  assert.match(out[APP_DOCKERFILE], /^RUN test "\$\(node --version\)" = v26\.2\.0$/m);
  assert.match(out[SLICER_DOCKERFILE], /^# Node\.js 26\.2\.0, linux x64\.$/m);
  assert.match(out[SLICER_DOCKERFILE], /^RUN need "\$\(\/opt\/node\/bin\/node --version\)" = v26\.2\.0$/m);
  assert.match(out[GATE_DOCKERFILE], /^ARG NODE_URL=https:\/\/nodejs\.org\/dist\/v26\.2\.0\/node-v26\.2\.0-linux-x64\.tar\.xz$/m);
  assert.match(out[GATE_README], new RegExp(`\\| Base image \\| ubuntu:24\\.04 \\| index digest \`sha256:${hex("2")}\` \\|`));
  assert.match(out[GATE_README], new RegExp(`\\| Node\\.js \\| 26\\.2\\.0 linux x64 \\| sha256 \`${hex("3")}\` \\|`));
  for (const f of [APP_DOCKERFILE, SLICER_DOCKERFILE, GATE_DOCKERFILE]) {
    assert.doesNotMatch(out[f], /26\.1\.0/, `${f} keeps no old Node version`);
  }
});

test("rewritePins: moves .node-version, the e2e image and the README sentence with the Node release", () => {
  const out = rewritePins(fakeTexts(), NEXT);
  assert.equal(out[NODE_VERSION_FILE], "26.2.0\n");
  assert.equal(out[E2E_COMPOSE], "x-node: &node\n  image: node:26.2.0-trixie-slim\n  working_dir: /repo\n");
  assert.equal(out[ROOT_README], "You need Node 26.2.0, the version in `.node-version`, and pnpm.\n");
  const same = readPins(fakeTexts());
  const onlyDigests = rewritePins(fakeTexts(), { ...same, ubuntuBase: NEXT.ubuntuBase, date: NEXT.date });
  for (const f of [NODE_VERSION_FILE, E2E_COMPOSE, ROOT_README]) assert.equal(onlyDigests[f], fakeTexts()[f], `${f} untouched when Node stays`);
});

test("rewritePins: the digest comments name the new date and drop the old manifest digests", () => {
  const out = rewritePins(fakeTexts(), NEXT);
  assert.match(out[APP_DOCKERFILE], /^# node:26\.2\.0-trixie-slim, multi-arch index digest read from Docker Hub on 2026-12-01\n(?:#.*\n)?ARG BASE=/m);
  assert.match(out[SLICER_DOCKERFILE], /^# ubuntu:24\.04, multi-arch index digest read from Docker Hub on 2026-12-01\n(?:#.*\n)?ARG BASE=/m);
  for (const f of [APP_DOCKERFILE, SLICER_DOCKERFILE, GATE_DOCKERFILE]) {
    assert.doesNotMatch(out[f], new RegExp(hex("d")), `${f} keeps no old manifest digest`);
    assert.doesNotMatch(out[f], /2026-11-/, `${f} keeps no old date`);
  }
});

test("rewritePins: moves only what changed and is a no-op when the pins are already current", () => {
  const same = readPins(fakeTexts());
  const t = fakeTexts();
  assert.deepEqual(rewritePins(t, { ...same, date: "2026-12-01" }), t, "same pins, same text, even on another date");
  const onlyUbuntu = rewritePins(t, { ...same, ubuntuBase: NEXT.ubuntuBase, date: NEXT.date });
  assert.equal(onlyUbuntu[APP_DOCKERFILE], t[APP_DOCKERFILE], "the app image is untouched");
  assert.notEqual(onlyUbuntu[SLICER_DOCKERFILE], t[SLICER_DOCKERFILE]);
  assert.equal(readPins(onlyUbuntu).nodeVersion, "26.1.0");
});

test("rewritePins: rewrites the repo's own files and they still read back", () => {
  const before = repoTexts();
  const now = readPins(before);
  const [maj, min, pat] = now.nodeVersion.split(".").map(Number);
  const next = { ...NEXT, nodeVersion: `${maj}.${min + 1}.${pat}`, appBase: `node:${maj}.${min + 1}.${pat}-trixie-slim@sha256:${hex("1")}` };
  const out = rewritePins(before, next);
  const { date: _date, ...want } = next;
  assert.deepEqual(readPins(out), want);
  const old = new RegExp(now.nodeVersion.replaceAll(".", "\\."));
  for (const f of [APP_DOCKERFILE, SLICER_DOCKERFILE, GATE_DOCKERFILE, GATE_README, NODE_VERSION_FILE, E2E_COMPOSE]) {
    assert.doesNotMatch(out[f], old, `${f} keeps no old Node version`);
  }
});

test("rewritePins: refuses a bad next: a short digest, a version the app image does not match, a bad date", () => {
  const t = fakeTexts();
  assert.throws(() => rewritePins(t, { ...NEXT, ubuntuBase: "ubuntu:24.04@sha256:abc" }), /ubuntuBase .* is not image@sha256/);
  assert.throws(() => rewritePins(t, { ...NEXT, nodeSha: "abc" }), /nodeSha abc is not a sha256/);
  assert.throws(() => rewritePins(t, { ...NEXT, nodeVersion: "26.3.0" }), /the app image's Node 26\.2\.0 is not 26\.3\.0/);
  assert.throws(() => rewritePins(t, { ...NEXT, date: "1 December" }), /date 1 December is not YYYY-MM-DD/);
});

test("rewritePins: refuses when a file has no digest comment to move, rather than leaving a stale one", () => {
  const t = fakeTexts();
  assert.throws(
    () => rewritePins({ ...t, [GATE_DOCKERFILE]: t[GATE_DOCKERFILE].replace(/^# ubuntu.*\n#.*\n/m, "") }, NEXT),
    /tools\/slicing-gate\/Dockerfile has no "multi-arch index digest" comment above ARG BASE=/,
  );
});

// -------------------------------------------------- latestNode and nodeSha

const INDEX = JSON.stringify([
  { version: "v27.0.0", date: "2026-12-01" },
  { version: "v26.13.0", date: "2026-11-05" },
  { version: "v26.9.1", date: "2026-10-05" },
  { version: "v26.13.1", date: "2026-11-20" },
  { version: "v26.10.0", date: "2026-10-20" },
  { version: "v25.9.0", date: "2026-09-01" },
  { version: "v260.1.0", date: "2027-01-01" },
]);

test("latestNode: the newest vMAJOR.x in index.json, compared as numbers", () => {
  assert.equal(latestNode(26, INDEX), "26.13.1");
  assert.equal(latestNode("26", INDEX), "26.13.1");
  assert.equal(latestNode(25, INDEX), "25.9.0");
  assert.equal(latestNode(27, INDEX), "27.0.0");
});

test("latestNode: refuses an empty major, bad JSON, a non-list and a major it does not know", () => {
  assert.throws(() => latestNode(24, INDEX), /no Node 24\.x release in index\.json/);
  assert.throws(() => latestNode(26, "not json"), /index\.json is not JSON/);
  assert.throws(() => latestNode(26, "{}"), /index\.json is not a list/);
  assert.throws(() => latestNode("x", INDEX), /Node major x is not a number/);
  assert.equal(latestNode(26, JSON.stringify([{ version: "bogus" }, { nope: 1 }, { version: "v26.1.0" }])), "26.1.0");
});

const SHASUMS = [
  `${hex("a")}  node-v26.13.1-darwin-arm64.tar.gz`,
  `${hex("b")}  node-v26.13.1-linux-x64.tar.xz`,
  `${hex("c")}  node-v26.13.1-linux-x64.tar.gz`,
  "",
].join("\n");

test("nodeSha: the sha256 listed for exactly that file", () => {
  assert.equal(nodeSha(SHASUMS, "node-v26.13.1-linux-x64.tar.xz"), hex("b"));
  assert.equal(nodeSha(SHASUMS, "node-v26.13.1-linux-x64.tar.gz"), hex("c"));
});

test("nodeSha: refuses a file that is not listed, listed twice, or listed with a bad sha", () => {
  assert.throws(() => nodeSha(SHASUMS, "node-v26.13.1-linux-arm64.tar.xz"), /node-v26\.13\.1-linux-arm64\.tar\.xz is not in SHASUMS256\.txt/);
  assert.throws(() => nodeSha(`${SHASUMS}${hex("d")}  node-v26.13.1-linux-x64.tar.xz\n`, "node-v26.13.1-linux-x64.tar.xz"), /listed 2 times/);
  assert.throws(() => nodeSha("abc  node-v1-linux-x64.tar.xz\n", "node-v1-linux-x64.tar.xz"), /sha256 abc is not 64 hex digits/);
});

// ------------------------------------- the signature on SHASUMS256.txt
//
// The fixtures in support/node-release-keys come from two throwaway keys, A
// and B, made once with GnuPG 2.5 and then thrown away (no private key is
// kept anywhere). keyring.gpg is A's public key; SHASUMS256.txt.asc is the
// body below clearsigned by A; SHASUMS256.other-key.txt.asc is the same body
// clearsigned by B, which is not in the keyring; SHASUMS256.tampered.txt.asc
// is A's file with the first 3 of its signed text changed to a 5. Run in
// bash, with the fixture folder as $out:
//
//   work="$(mktemp -d)"
//   uid='Platehouse test key <test@example.invalid>'
//   printf '%s  node-v26.2.0-linux-x64.tar.xz\n%s  node-v26.1.0-linux-x64.tar.xz\n' \
//     "$(printf '3%.0s' $(seq 64))" "$(printf '4%.0s' $(seq 64))" >"$work/body.txt"
//   for k in a b; do
//     mkdir -m 700 "$work/$k"
//     gpg --homedir "$work/$k" --batch --passphrase '' --quick-generate-key "$uid" rsa3072 sign never
//     gpg --homedir "$work/$k" --batch --passphrase '' --pinentry-mode loopback \
//       --clearsign --digest-algo SHA256 -o "$work/$k.asc" "$work/body.txt"
//   done
//   gpg --homedir "$work/a" --export >"$out/keyring.gpg"
//   cp "$work/a.asc" "$out/SHASUMS256.txt.asc"
//   cp "$work/b.asc" "$out/SHASUMS256.other-key.txt.asc"
//   awk '!done && /^3/ { sub(/^3/, "5"); done = 1 } 1' "$work/a.asc" >"$out/SHASUMS256.tampered.txt.asc"
//   gpgconf --homedir "$work/a" --kill all; gpgconf --homedir "$work/b" --kill all; rm -rf "$work"
//
// The tests that run gpgv skip, with the reason, only where gpgv is missing
// and CI is not set; on CI they always run.
const GPGV = spawnSync("gpgv", ["--version"]).status === 0;
const needGpgv = { skip: GPGV || process.env.CI ? false : "gpgv is not installed; CI runs this" };
const FIX = join(dirname(fileURLToPath(import.meta.url)), "support", "node-release-keys");
const FIX_KEYRING = join(FIX, "keyring.gpg");
const FIX_SHA = createHash("sha256").update(readFileSync(FIX_KEYRING)).digest("hex");
const fixture = (name) => join(FIX, name);
// base-images.mjs with its keyring pin moved to the fixture keyring, for the
// command line and the workflow step, which read the pin from the script.
const scriptPinnedToFixture = () => {
  const original = readFileSync(SCRIPT, "utf8");
  const pinned = original.replace(NODE_RELEASE_KEYRING_SHA256, FIX_SHA);
  assert.notEqual(pinned, original, "the keyring pin was replaced");
  return pinned;
};

test("verifySignedShasums: a list signed by a key in the keyring gives its text", needGpgv, () => {
  const text = verifySignedShasums({ ascPath: fixture("SHASUMS256.txt.asc"), keyringPath: FIX_KEYRING, keyringSha256: FIX_SHA });
  assert.equal(nodeSha(text, "node-v26.2.0-linux-x64.tar.xz"), hex("3"));
});

test("verifySignedShasums: lines outside the signed block are not in the text", needGpgv, () =>
  inScratch((dir) => {
    const asc = join(dir, "SHASUMS256.txt.asc");
    const added = (v) => `${hex("9")}  node-v${v}-linux-x64.tar.xz\n`;
    writeFileSync(asc, `${added("26.3.0")}${readFileSync(fixture("SHASUMS256.txt.asc"), "utf8")}${added("26.4.0")}`);
    const text = verifySignedShasums({ ascPath: asc, keyringPath: FIX_KEYRING, keyringSha256: FIX_SHA });
    assert.equal(nodeSha(text, "node-v26.2.0-linux-x64.tar.xz"), hex("3"));
    assert.doesNotMatch(text, /26\.3\.0|26\.4\.0/);
  }));

test("verifySignedShasums: a tampered list does not verify, and gives no text", needGpgv, () => {
  assert.throws(
    () => verifySignedShasums({ ascPath: fixture("SHASUMS256.tampered.txt.asc"), keyringPath: FIX_KEYRING, keyringSha256: FIX_SHA }),
    /SHASUMS256\.txt\.asc does not verify \(gpgv exit \d+\)/,
  );
});

test("verifySignedShasums: a list signed by a key not in the keyring names the pin to move", needGpgv, () => {
  assert.throws(
    () => verifySignedShasums({ ascPath: fixture("SHASUMS256.other-key.txt.asc"), keyringPath: FIX_KEYRING, keyringSha256: FIX_SHA }),
    (e) => /nodejs\/release-keys/.test(e.message) && /NODE_RELEASE_KEYS_COMMIT/.test(e.message),
  );
});

test("verifySignedShasums: a keyring that is not the pinned one is refused before gpgv runs", () => {
  assert.throws(
    () =>
      verifySignedShasums({
        ascPath: fixture("SHASUMS256.txt.asc"),
        keyringPath: FIX_KEYRING,
        keyringSha256: hex("0"),
        gpgv: "/nonexistent/gpgv",
      }),
    (e) => /has sha256 [0-9a-f]{64}, not the pinned 0{64}/.test(e.message) && !/not installed/.test(e.message),
  );
});

test("verifySignedShasums: a gpgv that cannot start says gpgv is not installed", () => {
  assert.throws(
    () => verifySignedShasums({ ascPath: fixture("SHASUMS256.txt.asc"), keyringPath: FIX_KEYRING, keyringSha256: FIX_SHA, gpgv: "/nonexistent/gpgv" }),
    /gpgv is not installed/,
  );
});

test("the Node release keyring is pinned to a commit of nodejs/release-keys and a sha256", () => {
  assert.match(NODE_RELEASE_KEYS_COMMIT, /^[0-9a-f]{40}$/);
  assert.match(NODE_RELEASE_KEYRING_SHA256, /^[0-9a-f]{64}$/);
  assert.equal(NODE_KEYRING_URL, `https://raw.githubusercontent.com/nodejs/release-keys/${NODE_RELEASE_KEYS_COMMIT}/gpg-only-active-keys/pubring.kbx`);
});

test("RELEASING.md says how the Node release keys are moved", () => {
  const releasing = readFileSync(join(ROOT, "RELEASING.md"), "utf8");
  for (const line of ["## Node release keys", "NODE_RELEASE_KEYS_COMMIT", "NODE_RELEASE_KEYRING_SHA256"]) {
    assert.ok(releasing.includes(line), line);
  }
});

// ----------------------------------------------------- the command line

function inScratch(fn) {
  const dir = mkdtempSync(join(tmpdir(), "base-images-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function writeTree(dir, texts) {
  for (const [p, t] of Object.entries(texts)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), t);
  }
}
const cli = (cwd, args, env = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", env: { PATH: process.env.PATH, ...env } });

test("cli read: prints the current pins as outputs, the major and the Ubuntu image", () =>
  inScratch((dir) => {
    writeTree(dir, fakeTexts());
    const r = cli(dir, ["read"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout,
      [
        `old_app_base=node:26.1.0-trixie-slim@sha256:${hex("a")}`,
        `old_ubuntu_base=ubuntu:24.04@sha256:${hex("b")}`,
        "old_node_version=26.1.0",
        `old_node_sha=${hex("c")}`,
        "node_major=26",
        "ubuntu_image=ubuntu:24.04",
        "",
      ].join("\n"),
    );
  }));

test("cli read: fails with the reason when the files disagree", () =>
  inScratch((dir) => {
    writeTree(dir, fakeTexts({ gateVersion: "26.0.9" }));
    const r = cli(dir, ["read"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /::error::.*disagree on the Node version/);
    assert.equal(r.stdout, "");
  }));

test("cli latest-node: prints the newest release, and never one older than the current pin", () =>
  inScratch((dir) => {
    writeFileSync(join(dir, "index.json"), INDEX);
    assert.equal(cli(dir, ["latest-node", "26", "index.json", "26.13.0"]).stdout, "26.13.1\n");
    assert.equal(cli(dir, ["latest-node", "26", "index.json", "26.14.0"]).stdout, "26.14.0\n", "a pin ahead of the index stays");
    assert.equal(cli(dir, ["latest-node", "24", "index.json", "24.1.0"]).status, 1);
  }));

test("cli node-sha-signed: prints the sha from a list that verifies, and nothing from one that does not", needGpgv, () =>
  inScratch((dir) => {
    // The real path: the script runs its command line only when argv[1] is
    // its own file URL, and the temp folder may be behind a symlink.
    const script = join(realpathSync(dir), "base-images.mjs");
    writeFileSync(script, scriptPinnedToFixture());
    const run = (asc) =>
      spawnSync(process.execPath, [script, "node-sha-signed", fixture(asc), FIX_KEYRING, "node-v26.2.0-linux-x64.tar.xz"], {
        cwd: dir,
        encoding: "utf8",
        env: { PATH: process.env.PATH },
      });
    const good = run("SHASUMS256.txt.asc");
    assert.equal(good.status, 0, good.stderr);
    assert.equal(good.stdout, `${hex("3")}\n`);
    for (const asc of ["SHASUMS256.tampered.txt.asc", "SHASUMS256.other-key.txt.asc"]) {
      const bad = run(asc);
      assert.equal(bad.status, 1, asc);
      assert.equal(bad.stdout, "", asc);
    }
  }));

test("cli keyring-url: prints the pinned keyring URL; node-sha is gone", () =>
  inScratch((dir) => {
    assert.equal(cli(dir, ["keyring-url"]).stdout, `${NODE_KEYRING_URL}\n`);
    writeFileSync(join(dir, "SHASUMS256.txt"), SHASUMS);
    assert.equal(cli(dir, ["node-sha", "SHASUMS256.txt", "node-v26.13.1-linux-x64.tar.xz"]).status, 2, "an unsigned list has no command");
  }));

test("cli rewrite: writes the changed files from the NEXT_ environment, and refuses without it", () =>
  inScratch((dir) => {
    writeTree(dir, fakeTexts());
    const env = {
      NEXT_APP_BASE: NEXT.appBase,
      NEXT_UBUNTU_BASE: NEXT.ubuntuBase,
      NEXT_NODE_VERSION: NEXT.nodeVersion,
      NEXT_NODE_SHA: NEXT.nodeSha,
      NEXT_DATE: NEXT.date,
    };
    const r = cli(dir, ["rewrite"], env);
    assert.equal(r.status, 0, r.stderr);
    const read = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(dir, f), "utf8")]));
    assert.equal(readPins(read).nodeVersion, "26.2.0");
    assert.equal(cli(dir, ["rewrite"], { ...env, NEXT_NODE_SHA: "" }).status, 2);
    assert.equal(cli(dir, ["nonsense"]).status, 2);
  }));

// The leftover check, with real git: a digest the rewrite moved that another
// tracked file still names is a copy it left behind.
function gitRepo(dir, files) {
  writeTree(dir, files);
  const run = (...a) => assert.equal(spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" }).status, 0, a.join(" "));
  run("init", "-q");
  run("add", "-A");
  run("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "x");
}

test("leftovers: finds a tracked file, other than the four digest files and the CHANGELOG, that names an old digest", () =>
  inScratch((dir) => {
    const old = [hex("a"), hex("b")];
    gitRepo(dir, {
      ...fakeTexts(),
      "CHANGELOG.md": `history names ${hex("a")}\n`,
      "docs/notes.md": `the image is sha256:${hex("b")} today\n`,
      "docs/clean.md": "nothing here\n",
    });
    assert.deepEqual(leftovers(dir, old), ["docs/notes.md"]);
    assert.deepEqual(leftovers(dir, [hex("9")]), []);
    assert.deepEqual(leftovers(dir, []), []);
  }));

test("leftovers: only sha256 hex digests are searched, and a bad one is refused", () => {
  assert.throws(() => grepArgs(["abc"]), /abc is not a sha256/);
  const args = grepArgs([hex("a")]);
  assert.deepEqual(args.slice(0, 4), ["grep", "-l", "-F", "-e"]);
  assert.ok(args.includes(":!CHANGELOG.md"));
  for (const f of DIGEST_FILES) assert.ok(args.includes(`:!${f}`), f);
  assert.ok(!args.includes(`:!${ROOT_README}`), "the root README is searched for digests; only the pins table may hold one");
});

test("cli leftovers: exit 0 when clean, 1 listing the files when not", () =>
  inScratch((dir) => {
    gitRepo(dir, { ...fakeTexts(), "docs/notes.md": `${hex("b")}\n` });
    const clean = cli(dir, ["leftovers", hex("9")]);
    assert.equal(clean.status, 0, clean.stderr);
    const dirty = cli(dir, ["leftovers", hex("b")]);
    assert.equal(dirty.status, 1);
    assert.match(dirty.stderr, /::error::/);
    assert.match(dirty.stderr, /docs\/notes\.md/);
  }));

// -------------------------------------------------------------- the workflow

const onBlock = (t) => t.slice(t.indexOf("\non:\n")).split(/\n(?=[a-z])/)[1];
function jobBlock(t, id) {
  const jobs = t.slice(t.indexOf("\njobs:\n"));
  const at = jobs.indexOf(`\n  ${id}:\n`);
  assert.ok(at !== -1, `a job named ${id}`);
  return jobs.slice(at + 1).split(/\n(?= {2}[\w-]+:\n)/)[0];
}
const jobSteps = (block) => block.split(/\n(?= {6}- )/).slice(1);
const stepNames = (block) => jobSteps(block).map((s) => s.match(/^ {6}- name: (.+)$/m)[1]);
function stepBlock(block, name) {
  const s = jobSteps(block).find((x) => x.includes(`- name: ${name}\n`));
  assert.ok(s, `a step named ${name}`);
  return s;
}
function stepScript(t, stepName) {
  const at = t.indexOf(`- name: ${stepName}\n`);
  assert.ok(at !== -1, `a step named ${stepName}`);
  const rest = t.slice(at).split("\n");
  const runAt = rest.findIndex((l) => /^\s+run: \|$/.test(l));
  assert.ok(runAt !== -1, `${stepName} has a run: | block`);
  const body = [];
  let indent = null;
  for (const line of rest.slice(runAt + 1)) {
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    const lead = line.match(/^ */)[0].length;
    if (indent === null) indent = lead;
    if (lead < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}
function workflowEnv(t) {
  const m = t.match(/\nenv:\n((?: {2}\S.*\n)+)/);
  assert.ok(m, "a top-level env: block");
  return Object.fromEntries(
    m[1]
      .trimEnd()
      .split("\n")
      .map((l) => l.match(/^ {2}(\w+): (.+)$/).slice(1)),
  );
}

// Runs one step of base-images.yml in bash in a scratch folder after the given
// stub functions, with the workflow's env, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY,
// RUNNER_TEMP and CALLS, a file the stubs append to.
function runStep(job, stepName, { env = {}, stubs = [], setup, files = [] } = {}) {
  return inScratch((dir) => {
    const work = join(dir, "work");
    mkdirSync(work);
    setup?.(work);
    const out = join(dir, "github-output");
    const summary = join(dir, "step-summary");
    const calls = join(dir, "calls");
    const temp = join(dir, "temp");
    mkdirSync(temp);
    for (const f of [out, summary, calls]) writeFileSync(f, "");
    const t = text();
    const script = ["set -eo pipefail", ...stubs, stepScript(jobBlock(t, job), stepName)].join("\n");
    const r = spawnSync("bash", ["-c", script], {
      cwd: work,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        ...workflowEnv(t),
        GITHUB_OUTPUT: out,
        GITHUB_STEP_SUMMARY: summary,
        RUNNER_TEMP: temp,
        CALLS: calls,
        ...env,
      },
    });
    const outputs = {};
    for (const line of readFileSync(out, "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) outputs[line.slice(0, i)] = line.slice(i + 1);
    }
    return {
      status: r.status,
      log: `${r.stdout}${r.stderr}`,
      outputs,
      summary: readFileSync(summary, "utf8"),
      calls: readFileSync(calls, "utf8"),
      files: Object.fromEntries(files.map((f) => [f, existsSync(join(work, f)) ? readFileSync(join(work, f), "utf8") : null])),
    };
  });
}

test("base-images: runs weekly and by hand, nothing else", () => {
  const on = onBlock(text());
  assert.match(on, /^ {2}schedule:\n {4}- cron: "0 6 \* \* 1"\n(?! {4}- )/m, `weekly:\n${on}`);
  assert.match(on, /^ {2}workflow_dispatch:$/m);
  assert.doesNotMatch(on, /push:|pull_request|workflow_run|inputs:/, "no other trigger, no inputs");
});

test("base-images: one concurrency group, never cancelled part way, and one fixed bot branch", () => {
  const t = text();
  assert.match(t, /\nconcurrency:\n {2}group: base-images\n {2}cancel-in-progress: false\n/);
  assert.equal([...t.matchAll(/^\s*concurrency:/gm)].length, 1);
  assert.equal(workflowEnv(t).BRANCH, "bot/base-images");
});

test("base-images: each job holds only the permissions it uses", () => {
  const t = text();
  assert.match(t, /^permissions:\n {2}contents: read\n(?! {2}\S)/m);
  const perms = (id) => {
    const m = jobBlock(t, id).match(/\n {4}permissions:\n((?: {6}\S.*\n)+)/);
    assert.ok(m, `${id} sets its own permissions`);
    return Object.fromEntries(m[1].trimEnd().split("\n").map((l) => l.trim().split(": ")));
  };
  const jobs = [...t.slice(t.indexOf("\njobs:\n")).matchAll(/\n {2}([\w-]+):\n/g)].map((m) => m[1]);
  assert.deepEqual(jobs, ["refresh", "dispatch-ci"]);
  assert.deepEqual(perms("refresh"), { contents: "write", "pull-requests": "write" });
  assert.deepEqual(perms("dispatch-ci"), { actions: "write" });
  assert.doesNotMatch(t, /write-all|read-all|packages:|issues:|id-token:|secrets\./);
  assert.match(t, /persist-credentials: false/);
  assert.doesNotMatch(t, /persist-credentials: true/);
  assert.doesNotMatch(t, /[^\x00-\x7F]/, "ASCII only");
});

test("base-images: no run: step interpolates an expression; values pass through env", () => {
  const t = text();
  for (const id of ["refresh", "dispatch-ci"]) {
    for (const s of jobSteps(jobBlock(t, id))) {
      const run = s.match(/\n {8}run: [\s\S]*$/)?.[0] ?? "";
      assert.doesNotMatch(run, /\$\{\{/, `${s.split("\n")[0]} has an expression in its run:`);
    }
  }
});

test("base-images: actions are the SHA pins other workflows use; jobs run on ubuntu-24.04 with timeouts", () => {
  const t = text();
  const pins = (x) => {
    const out = {};
    for (const [, u] of x.matchAll(/uses: (\S+ # \S+)/g)) {
      const [name, tag] = u.split("@");
      (out[name] ??= new Set()).add(tag);
    }
    return out;
  };
  const ci = pins(readFileSync(CI, "utf8"));
  const ours = pins(t);
  assert.deepEqual(Object.keys(ours).sort(), ["actions/checkout", "actions/setup-node"]);
  for (const [name, tags] of Object.entries(ours)) assert.deepEqual([...tags], [...ci[name]], name);
  for (const id of ["refresh", "dispatch-ci"]) {
    const b = jobBlock(t, id);
    assert.match(b, /\n {4}runs-on: ubuntu-24\.04\n/, id);
    assert.match(b, /\n {4}timeout-minutes: \d+\n/, id);
  }
  assert.match(jobBlock(t, "refresh"), /\n {10}node-version-file: \.node-version\n/);
});

test("base-images: the main-only check runs first and refuses any other ref", () => {
  const block = jobBlock(text(), "refresh");
  assert.deepEqual(stepNames(block), [
    "Run only from main",
    "Check out",
    "Set up Node",
    "Resolve the newest base images and Node",
    "Rewrite the pins",
    "Push the branch and open the pull request",
  ]);
  assert.equal(runStep("refresh", "Run only from main", { env: { REF: "refs/heads/main" } }).status, 0);
  for (const ref of ["refs/heads/feature", "refs/heads/bot/base-images", "refs/tags/v0.1.0", "refs/heads/main-x", ""]) {
    const r = runStep("refresh", "Run only from main", { env: { REF: ref } });
    assert.notEqual(r.status, 0, ref);
    assert.match(r.log, /::error::.* is not main/);
  }
});

// The resolve step with the real script and stand-ins for the network: curl
// writes the file named by -o, from INDEX_JSON, or a copy of the file ASC
// (the signed list) or KEYRING (the release keyring); a plain SHASUMS256.txt
// gets SHASUMS, an unsigned list with another sha for 26.2.0 that must never
// be used. docker prints the digest of the image it is asked about, or fails
// for one named in MISSING. The script is a copy pinned to the fixture
// keyring, as the real one is pinned to Node's.
const RESOLVE_STUBS = [
  "curl() {",
  '  echo "curl $*" >>"$CALLS"',
  '  out=""; prev=""; for a in "$@"; do if [ "$prev" = -o ]; then out="$a"; fi; prev="$a"; done',
  '  case "$*" in',
  '    *index.json*) printf "%s" "$INDEX_JSON" >"$out" ;;',
  '    *SHASUMS256.txt.asc*) cp "$ASC" "$out" ;;',
  '    *pubring.kbx*) cp "$KEYRING" "$out" ;;',
  '    *SHASUMS256.txt*) printf "%s" "$SHASUMS" >"$out" ;;',
  "    *) return 22 ;;",
  "  esac",
  "}",
  "docker() {",
  '  echo "docker $*" >>"$CALLS"',
  '  ref="$4"',
  '  if [ "$ref" = "$MISSING" ]; then echo "not found" >&2; return 1; fi',
  '  case "$ref" in',
  '    ubuntu:24.04) echo "sha256:$UBUNTU_DIGEST" ;;',
  '    node:*) echo "sha256:$NODE_DIGEST" ;;',
  "  esac",
  "}",
];
const resolveRun = (env = {}) =>
  runStep("refresh", "Resolve the newest base images and Node", {
    stubs: RESOLVE_STUBS,
    setup: (work) => {
      writeTree(work, fakeTexts());
      mkdirSync(join(work, ".github", "scripts"), { recursive: true });
      writeFileSync(join(work, ".github", "scripts", "base-images.mjs"), scriptPinnedToFixture());
    },
    env: {
      INDEX_JSON: JSON.stringify([{ version: "v26.2.0" }, { version: "v26.1.0" }, { version: "v27.0.0" }]),
      ASC: fixture("SHASUMS256.txt.asc"),
      KEYRING: FIX_KEYRING,
      SHASUMS: `${hex("9")}  node-v26.2.0-linux-x64.tar.xz\n${hex("4")}  node-v26.1.0-linux-x64.tar.xz\n`,
      UBUNTU_DIGEST: hex("2"),
      NODE_DIGEST: hex("1"),
      MISSING: "",
      ...env,
    },
  });

test("base-images resolve: finds the newest Node of the same major, its sha from the signed list and both digests", needGpgv, () => {
  const r = resolveRun();
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(r.outputs, {
    old_app_base: `node:26.1.0-trixie-slim@sha256:${hex("a")}`,
    old_ubuntu_base: `ubuntu:24.04@sha256:${hex("b")}`,
    old_node_version: "26.1.0",
    old_node_sha: hex("c"),
    next_app_base: `node:26.2.0-trixie-slim@sha256:${hex("1")}`,
    next_ubuntu_base: `ubuntu:24.04@sha256:${hex("2")}`,
    next_node_version: "26.2.0",
    next_node_sha: hex("3"),
    next_date: r.outputs.next_date,
  });
  assert.match(r.outputs.next_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(r.calls, /docker buildx imagetools inspect node:26\.2\.0-trixie-slim --format \{\{\.Manifest\.Digest\}\}/);
  assert.match(r.calls, /docker buildx imagetools inspect ubuntu:24\.04 --format \{\{\.Manifest\.Digest\}\}/);
  assert.match(r.calls, /curl .*https:\/\/nodejs\.org\/dist\/index\.json/);
  assert.match(r.calls, /curl .*https:\/\/nodejs\.org\/dist\/v26\.2\.0\/SHASUMS256\.txt\.asc/);
  assert.ok(
    r.calls.includes(`https://raw.githubusercontent.com/nodejs/release-keys/${NODE_RELEASE_KEYS_COMMIT}/gpg-only-active-keys/pubring.kbx`),
    r.calls,
  );
  assert.doesNotMatch(r.calls, /SHASUMS256\.txt(?!\.asc)/, "the unsigned list is never downloaded");
});

test("base-images resolve: a Node on nodejs.org but not yet on Docker Hub keeps the current Node, with a notice", () => {
  const r = resolveRun({ MISSING: "node:26.2.0-trixie-slim" });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.outputs.next_node_version, "26.1.0");
  assert.equal(r.outputs.next_node_sha, hex("c"), "the sha stays with the version");
  assert.equal(r.outputs.next_app_base, `node:26.1.0-trixie-slim@sha256:${hex("1")}`);
  assert.match(r.log, /::notice::node:26\.2\.0-trixie-slim is not on Docker Hub yet/);
  assert.doesNotMatch(r.calls, /SHASUMS256|pubring/, "no list or keyring is downloaded when Node stays");
});

test("base-images resolve: fails, with nothing handed on, when a lookup fails or an answer is not a digest", () => {
  // Node stays at 26.1.0, so the run reaches the Ubuntu lookup without gpgv.
  const INDEX_JSON = JSON.stringify([{ version: "v26.1.0" }]);
  const down = resolveRun({ INDEX_JSON, MISSING: "ubuntu:24.04" });
  assert.notEqual(down.status, 0);
  assert.deepEqual(down.outputs, {});
  const bad = resolveRun({ INDEX_JSON, UBUNTU_DIGEST: "xyz" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.log, /::error::.*sha256:xyz is not an image digest/);
  assert.deepEqual(bad.outputs, {});
});

test("base-images resolve: an empty download fails, with nothing handed on", () => {
  const empty = resolveRun({ ASC: "/dev/null" });
  assert.notEqual(empty.status, 0);
  assert.deepEqual(empty.outputs, {});
});

test("base-images resolve: a list that does not verify fails, with nothing handed on", needGpgv, () => {
  const tampered = resolveRun({ ASC: fixture("SHASUMS256.tampered.txt.asc") });
  assert.notEqual(tampered.status, 0, tampered.log);
  assert.match(tampered.log, /::error::SHASUMS256\.txt\.asc does not verify/);
  assert.deepEqual(tampered.outputs, {});
  const otherKey = resolveRun({ ASC: fixture("SHASUMS256.other-key.txt.asc") });
  assert.notEqual(otherKey.status, 0, otherKey.log);
  assert.match(otherKey.log, /::error::.*nodejs\/release-keys/);
  assert.deepEqual(otherKey.outputs, {});
});

test("base-images rewrite: changes the files and reports changed=true, or changed=false when nothing moves", () => {
  const env = {
    NEXT_APP_BASE: NEXT.appBase,
    NEXT_UBUNTU_BASE: NEXT.ubuntuBase,
    NEXT_NODE_VERSION: NEXT.nodeVersion,
    NEXT_NODE_SHA: NEXT.nodeSha,
    NEXT_DATE: NEXT.date,
  };
  const stubs = ['git() { echo "git $*" >>"$CALLS"; if [ "$1" = diff ]; then printf "%s" "$CHANGED"; fi; }'];
  const setup = (work) => {
    writeTree(work, fakeTexts());
    mkdirSync(join(work, ".github", "scripts"), { recursive: true });
    copyFileSync(SCRIPT, join(work, ".github", "scripts", "base-images.mjs"));
  };
  const moved = runStep("refresh", "Rewrite the pins", { stubs, setup, env: { ...env, CHANGED: `${FILES.join("\n")}\n` }, files: [SLICER_DOCKERFILE] });
  assert.equal(moved.status, 0, moved.log);
  assert.equal(moved.outputs.changed, "true");
  assert.match(moved.files[SLICER_DOCKERFILE], /v26\.2\.0/);
  const still = runStep("refresh", "Rewrite the pins", { stubs, setup, env: { ...env, CHANGED: "" } });
  assert.equal(still.outputs.changed, "false");
  assert.match(still.summary, /Up to date/);
  const stray = runStep("refresh", "Rewrite the pins", { stubs, setup, env: { ...env, CHANGED: "docs/x.md\n" } });
  assert.notEqual(stray.status, 0);
  assert.match(stray.log, /::error::the rewrite changed these files/);
});

// The PR step: git, gh and node are stubs, as in apt-snapshot's test. git diff
// lists CHANGED, ls-remote gives REMOTE, git show gives FETCHED_PINS for the
// fetched branch (its ARG lines; unset: it fails) and HEAD_PINS for HEAD, the
// fetched tree equals HEAD's
// when SAME_TREE is 1, the leftover check (node) fails when LEFT is set, gh pr
// list gives EXISTING, gh pr create prints a URL or fails with CREATE_ERROR.
const PR_STUBS = [
  "node() {",
  '  echo "node $*" >>"$CALLS"',
  '  if [ -n "$LEFT" ]; then echo "::error::these files name an old digest" >&2; printf "%s\\n" "$LEFT" >&2; return 1; fi',
  "}",
  "git() {",
  '  echo "git $*" >>"$CALLS"',
  '  case "$1" in',
  '    diff) printf "%s" "$CHANGED" ;;',
  "    commit) cat >commit-message.txt ;;",
  '    ls-remote) if [ -n "$REMOTE" ]; then printf "%s\\trefs/heads/bot/base-images\\n" "$REMOTE"; fi ;;',
  '    show) case "$2" in HEAD:*) printf "%s\\n" "$HEAD_PINS" ;; *) if [ -n "$FETCHED_PINS" ]; then printf "%s\\n" "$FETCHED_PINS"; else return 128; fi ;; esac ;;',
  '    rev-parse) case "$2" in "FETCH_HEAD^{tree}") if [ "$SAME_TREE" = 1 ]; then echo tree1; else echo tree0; fi ;; "HEAD^{tree}") echo tree1 ;; *) echo headsha ;; esac ;;',
  '    push) return "${PUSH_STATUS:-0}" ;;',
  "    *) return 0 ;;",
  "  esac",
  "}",
  "gh() {",
  '  echo "gh $*" >>"$CALLS"',
  '  case "$1 $2" in',
  '    "pr list") printf "%s" "$EXISTING" ;;',
  '    "pr create") cp body.md posted.md; if [ -n "$CREATE_ERROR" ]; then echo "$CREATE_ERROR" >&2; return 1; fi; echo "https://github.com/o/r/pull/412" ;;',
  "    *) return 0 ;;",
  "  esac",
  "}",
];
const prRun = (env = {}) =>
  runStep("refresh", "Push the branch and open the pull request", {
    stubs: PR_STUBS,
    files: ["posted.md", "commit-message.txt"],
    env: {
      GH_TOKEN: FAKE_TOKEN,
      REPO: "o/r",
      OLD_APP_BASE: `node:26.1.0-trixie-slim@sha256:${hex("a")}`,
      OLD_UBUNTU_BASE: `ubuntu:24.04@sha256:${hex("b")}`,
      OLD_NODE_VERSION: "26.1.0",
      OLD_NODE_SHA: hex("c"),
      NEXT_APP_BASE: NEXT.appBase,
      NEXT_UBUNTU_BASE: NEXT.ubuntuBase,
      NEXT_NODE_VERSION: NEXT.nodeVersion,
      NEXT_NODE_SHA: NEXT.nodeSha,
      SERVER_URL: "https://github.com",
      RUN_URL: "https://github.com/o/r/actions/runs/99",
      CHANGED: `${FILES.join("\n")}\n`,
      LEFT: "",
      REMOTE: "",
      SAME_TREE: "0",
      EXISTING: "",
      CREATE_ERROR: "",
      FETCHED_PINS: "",
      HEAD_PINS: "ARG BASE=new",
      ...env,
    },
  });
const callLines = (r, prefix) => r.calls.split("\n").filter((l) => l.startsWith(prefix));

test("base-images pr: a first run runs the leftover check, pushes the branch and opens the pull request; ci runs", () => {
  const r = prRun();
  assert.equal(r.status, 0, r.log);
  assert.equal(r.outputs.ci, "true");
  assert.deepEqual(callLines(r, "node "), [`node .github/scripts/base-images.mjs leftovers ${hex("a")} ${hex("b")} ${hex("c")}`]);
  assert.deepEqual(callLines(r, "git push"), ["git push -q origin HEAD:refs/heads/bot/base-images"]);
  assert.deepEqual(callLines(r, "git switch"), ["git switch -q -C bot/base-images"]);
  assert.deepEqual(callLines(r, "git add"), [`git add ${FILES.join(" ")}`]);
  assert.deepEqual(callLines(r, "gh pr close"), []);
  const [create] = callLines(r, "gh pr create");
  assert.match(create, /^gh pr create --repo o\/r --base main --head bot\/base-images --title .+ --body-file body\.md$/);
  assert.match(r.files["commit-message.txt"], /^Move the base images and Node to /);
  assert.match(r.files["commit-message.txt"], /Made by https:\/\/github\.com\/o\/r\/actions\/runs\/99\n$/);
  assert.match(r.summary, /pull request: #412/);
});

test("base-images pr: the leftover check names only the digests that moved", () => {
  const r = prRun({ OLD_UBUNTU_BASE: `ubuntu:24.04@sha256:${hex("2")}`, NEXT_UBUNTU_BASE: `ubuntu:24.04@sha256:${hex("2")}` });
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(callLines(r, "node "), [`node .github/scripts/base-images.mjs leftovers ${hex("a")} ${hex("c")}`]);
});

test("base-images pr: the body says what moved and why, and where the checks are", () => {
  const body = prRun().files["posted.md"];
  assert.match(body, /Node 26\.1\.0 to 26\.2\.0/);
  assert.match(body, /do not read ARG-based images/);
  assert.match(body, /docker\/app\.Dockerfile, apps\/slicer\/Dockerfile, tools\/slicing-gate\/Dockerfile and the pins table in tools\/slicing-gate\/README\.md/);
  assert.match(body, /https:\/\/github\.com\/o\/r\/actions\/workflows\/ci\.yml\?query=branch%3Abot%2Fbase-images/);
  assert.match(body, /\.node-version/, "names the Node version files it moves");
  assert.doesNotMatch(body, /on top of it|Move them/, "no advice to push onto the bot branch, which the next run replaces");
  assert.match(body, /fix it on another branch, because the next run replaces this one/);
  assert.doesNotMatch(body, /This replaces #/);
  assert.match(body, /Opened by the base-images workflow: https:\/\/github\.com\/o\/r\/actions\/runs\/99/);
  assert.doesNotMatch(body, /[^\x00-\x7F]/);
  assert.doesNotMatch(body.replace(/`[^`\n]*`/g, ""), /<\/?[A-Za-z][^<>]*>/, "no bare tag-like text");
});

test("base-images pr: a rewrite that touches a file outside the four, or leftovers, stops before any push", () => {
  const stray = prRun({ CHANGED: "docs/x.md\n" });
  assert.notEqual(stray.status, 0);
  assert.match(stray.log, /::error::the rewrite changed these files/);
  assert.deepEqual(callLines(stray, "git push"), []);
  const left = prRun({ LEFT: "docs/notes.md" });
  assert.notEqual(left.status, 0);
  assert.match(left.log, /::error::the leftover check failed \(exit 1\); nothing is pushed/);
  assert.deepEqual(callLines(left, "git push"), []);
  assert.deepEqual(callLines(left, "git switch"), []);
});

test("base-images pr: a branch already holding the change is not pushed, and its open PR is left alone", () => {
  const r = prRun({ REMOTE: "a".repeat(40), SAME_TREE: "1", EXISTING: "300" });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.outputs.ci, "false");
  assert.deepEqual(callLines(r, "git push"), []);
  assert.deepEqual(callLines(r, "gh pr create"), []);
  assert.match(r.log, /already holds this change on this main; nothing is pushed/);
});

test("base-images pr: a different change replaces the branch: close the open PR, delete, push fresh, open a new PR naming it", () => {
  const r = prRun({ REMOTE: "b".repeat(40), SAME_TREE: "0", EXISTING: "300", FETCHED_PINS: "ARG BASE=old" });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.outputs.ci, "true");
  const order = r.calls.split("\n").filter((l) => /^gh pr (close|create)|^git push/.test(l));
  assert.match(order[0], /^gh pr close 300 --repo o\/r --comment /);
  assert.equal(order[1], `git push -q --force-with-lease=refs/heads/bot/base-images:${"b".repeat(40)} origin :refs/heads/bot/base-images`);
  assert.equal(order[2], "git push -q origin HEAD:refs/heads/bot/base-images");
  assert.match(order[3], /^gh pr create /);
  assert.match(r.files["posted.md"], /This replaces #300, which proposed an older change and was not merged\./);
});

test("base-images pr: the same pins on an older main say main moved", () => {
  const r = prRun({ REMOTE: "b".repeat(40), EXISTING: "300", FETCHED_PINS: "ARG BASE=new" });
  assert.equal(r.status, 0, r.log);
  assert.match(callLines(r, "gh pr close")[0], /main moved since it was opened/);
  assert.match(r.files["posted.md"], /proposed the same change on an older main/);
});

test("base-images pr: a refused pull request says which setting to turn on", () => {
  const r = prRun({ CREATE_ERROR: "GitHub Actions is not permitted to create or approve pull requests" });
  assert.notEqual(r.status, 0);
  assert.match(r.log, /::error::GitHub refused to let the workflow open the pull request\. Turn on Settings, Actions, General, Workflow permissions, "Allow GitHub Actions to create and approve pull requests"/);
});

test("base-images: dispatch-ci starts ci.yml on the bot branch, only after a refresh with news", () => {
  const t = text();
  const d = jobBlock(t, "dispatch-ci");
  assert.match(d, /\n {4}needs: refresh\n/);
  assert.match(d, /\n {4}if: \$\{\{ !cancelled\(\) && needs\.refresh\.result == 'success' && needs\.refresh\.outputs\.ci == 'true' \}\}\n/);
  assert.match(jobBlock(t, "refresh"), /\n {6}ci: \$\{\{ steps\.pr\.outputs\.ci \}\}\n/);
  assert.match(jobBlock(t, "refresh"), /\n {8}if: \$\{\{ steps\.rewrite\.outputs\.changed == 'true' \}\}\n/);
  const r = runStep("dispatch-ci", "Start the ci workflow", {
    stubs: ['gh() { echo "gh $*" >>"$CALLS"; }'],
    env: { GH_TOKEN: FAKE_TOKEN, REPO: "o/r", SERVER_URL: "https://github.com" },
  });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.calls, "gh workflow run ci.yml --repo o/r --ref bot/base-images\n");
  assert.match(r.summary, /actions\/workflows\/ci\.yml\?query=branch%3Abot%2Fbase-images/);
});

test("base-images: ci.yml's gate-tests list names this workflow, its script and pnpm-workspace.yaml", () => {
  const ci = readFileSync(CI, "utf8");
  const list = ci.match(/grep -Eq '\^\((tools\/slicing-gate\/[^']*)\)' <<<"\$changed"/)[1];
  assert.match(list, /\(ci\|release\|slicer-image\|rc-tag\|apt-snapshot\|base-images\|docs-pages\|release-notes\)\\\.yml\$/);
  assert.match(list, /\\\.github\/scripts\/\(rc-target\|apt-snapshot\|base-images\|release-gate\|release-notes\)\\\.mjs\$/);
  assert.match(list, /\|pnpm-workspace\\\.yaml\$/);
});

// ------------------------------------------- the audit and library gates

test("pnpm overrides: tinypool, serialize-javascript and uuid move to the fixed releases, scoped to the docs site's chains (#432)", () => {
  const y = readFileSync(WORKSPACE, "utf8");
  const overrides = y.slice(y.indexOf("\noverrides:\n"));
  // Each is scoped by its parent, so a package a shipped app depends on can
  // never pick an override up by accident.
  for (const [key, floor] of [
    ["@docusaurus/core>tinypool", ">=2.1.2"],
    ["copy-webpack-plugin>serialize-javascript", ">=7.1.3"],
    ["css-minimizer-webpack-plugin>serialize-javascript", ">=7.1.3"],
    ["sockjs>uuid", ">=11.1.1"],
  ]) {
    const m = overrides.match(new RegExp(`^ {2}["']?${key.replaceAll(/[/@>-]/g, (c) => `\\${c}`)}["']?: ["']?([^"'\\n]+)["']?$`, "m"));
    assert.ok(m, `${key} is overridden`);
    assert.equal(m[1], floor, key);
  }
  assert.doesNotMatch(overrides, /^ {2}["']?(tinypool|serialize-javascript|uuid)["']?:/m, "no unscoped override of the three");
});

const stepsOf = (file, id) => jobSteps(jobBlock(readFileSync(file, "utf8"), id));

test("ci: the lint job audits the shipped dependencies and fails on a critical advisory (#432, #453)", () => {
  const block = jobBlock(readFileSync(CI, "utf8"), "lint");
  const names = stepNames(block);
  const audit = stepBlock(block, "Audit production dependencies (fail on critical)");
  assert.match(audit, /\n {8}run: pnpm audit --prod --audit-level=critical\n?$/);
  assert.doesNotMatch(audit, /continue-on-error|\|\| true|if:/, "it cannot be waved through");
  assert.equal(names.at(-1), "Audit production dependencies (fail on critical)", "the last step, after Biome and the compose check");
  assert.ok(names.indexOf("Biome") < names.length - 1 && names.includes("Validate the example Compose file"));
  assert.equal(stepsOf(CI, "lint").filter((s) => /pnpm audit/.test(s)).length, 1);
});

// The Trivy library gate sits next to the OS gate, on the same image, with the
// same Trivy version and cache; the OS gate and the informational reports stay.
for (const [file, job, image, os] of [
  [CI, "app-image", "${{ env.IMAGE }}", "Trivy gate (fail on fixable OS HIGH/CRITICAL)"],
  [RELEASE, "build", "${{ env.LOCAL }}", "Trivy gate (fail on fixable OS HIGH/CRITICAL)"],
]) {
  const name = file === CI ? "ci.yml" : "release.yml";
  test(`${name}: the Trivy library gate fails on fixable CRITICAL findings, beside the unchanged OS gate (#453)`, () => {
    const block = jobBlock(readFileSync(file, "utf8"), job);
    const lib = stepBlock(block, "Trivy library gate (fail on fixable CRITICAL)");
    const osGate = stepBlock(block, os);
    const inputs = (s) => Object.fromEntries([...s.matchAll(/\n {10}([\w-]+): (.+)/g)].map((m) => [m[1], m[2]]));
    assert.match(lib, /uses: aquasecurity\/trivy-action@[0-9a-f]{40} # v0\.36\.0\n/);
    assert.deepEqual(inputs(lib), {
      "image-ref": image,
      severity: "CRITICAL",
      "ignore-unfixed": "true",
      "vuln-type": "library",
      "exit-code": '"1"',
      format: "table",
      "cache-dir": "${{ runner.temp }}/trivy-cache",
      version: "v0.76.2",
    });
    assert.deepEqual(inputs(osGate), {
      "image-ref": image,
      severity: "HIGH,CRITICAL",
      "ignore-unfixed": "true",
      "vuln-type": "os",
      "exit-code": '"1"',
      format: "table",
      "cache-dir": "${{ runner.temp }}/trivy-cache",
      version: "v0.76.2",
    });
    assert.doesNotMatch(lib, /\n {8}(if|continue-on-error):/, "nothing softens the library gate");
    const names = stepNames(block);
    assert.equal(names.indexOf("Trivy library gate (fail on fixable CRITICAL)"), names.indexOf(os) + 1, "right after the OS gate");
  });
}

test("release.yml keeps its informational Trivy report; slicer-image.yml has no OS gate to pair, only its report", () => {
  const release = readFileSync(RELEASE, "utf8");
  assert.match(release, /- name: Trivy full report \(informational, does not fail the job\)\n(?:.*\n)*?\s+exit-code: "0"/);
  const slicer = readFileSync(join(ROOT, ".github", "workflows", "slicer-image.yml"), "utf8");
  assert.doesNotMatch(slicer, /vuln-type:/);
  assert.doesNotMatch(slicer, /exit-code: "1"/);
});
