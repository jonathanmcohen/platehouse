// Moves the base images and the Node release the app, slicer and slicing gate
// images are built on (.github/workflows/base-images.yml, issue #453).
//
// Three Dockerfiles pin their base image by digest in an ARG BASE line, which
// Dependabot does not read, and two of them download Node from nodejs.org with
// a sha256 (NODE_URL, NODE_SHA256):
//
//   docker/app.Dockerfile            ARG BASE=node:X.Y.Z-trixie-slim@sha256:...
//   apps/slicer/Dockerfile           ARG BASE=ubuntu:24.04@sha256:..., NODE_URL, NODE_SHA256
//   tools/slicing-gate/Dockerfile    the same
//   tools/slicing-gate/README.md     its pins table lists the Ubuntu digest and Node
//
// Three more files name the Node release alone and move with it, so a Node
// update never leaves CI and the docs on the old one: .node-version (the Node
// CI runs on), the x-node image line of e2e/compose.yml, and the "You need
// Node X.Y.Z" sentence of README.md. readPins refuses when any of them
// disagrees with the Dockerfiles.
//
// One Node release drives both: the app image's node:X.Y.Z tag is the release
// the slicer and the gate download. The slicer and the gate must pin the same
// Ubuntu digest, Node release and Node sha256, and the pins table must agree
// with them, or readPins refuses. The network lookups (nodejs.org, Docker Hub)
// stay in the workflow; this file holds the pure functions and a command line
// the workflow calls, run at the repo root:
//
//   node base-images.mjs read           prints the current pins as old_*=,
//                                       node_major= and ubuntu_image= lines
//   node base-images.mjs latest-node <major> <index.json> [<current>]
//                                       the newest <major>.x release, or
//                                       <current> when that is newer
//   node base-images.mjs keyring-url    prints NODE_KEYRING_URL, the Node
//                                       release keyring at the pinned commit
//   node base-images.mjs node-sha-signed <SHASUMS256.txt.asc> <keyring> <file>
//                                       checks the signed list with gpgv
//                                       against the keyring (which must have
//                                       the pinned sha256), then prints the
//                                       sha256 it lists for <file>
//   node base-images.mjs rewrite        rewrites the pins from NEXT_APP_BASE,
//                                       NEXT_UBUNTU_BASE, NEXT_NODE_VERSION,
//                                       NEXT_NODE_SHA and NEXT_DATE
//   node base-images.mjs leftovers <sha256-hex>...
//                                       exits 1 when a tracked file other than
//                                       the four pinned ones and CHANGELOG.md
//                                       names one of these digests (a copy of
//                                       an old pin the rewrite left behind)
//
// Exit codes: 0 done, 1 a refusal or a failed check, 2 a usage error. On
// stdout only what the workflow reads; messages go to stderr.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const APP_DOCKERFILE = "docker/app.Dockerfile";
export const SLICER_DOCKERFILE = "apps/slicer/Dockerfile";
export const GATE_DOCKERFILE = "tools/slicing-gate/Dockerfile";
export const GATE_README = "tools/slicing-gate/README.md";
export const NODE_VERSION_FILE = ".node-version";
export const E2E_COMPOSE = "e2e/compose.yml";
export const ROOT_README = "README.md";
// The four files that hold a digest, which no other tracked file may name.
export const DIGEST_FILES = [APP_DOCKERFILE, SLICER_DOCKERFILE, GATE_DOCKERFILE, GATE_README];
// Every file the weekly run reads and may rewrite: the digest files and the
// three that name only the Node release.
export const FILES = [...DIGEST_FILES, NODE_VERSION_FILE, E2E_COMPOSE, ROOT_README];

// Node signs SHASUMS256.txt (SHASUMS256.txt.asc) with a releaser's key. The
// keys of the active releasers are in nodejs/release-keys, as one keyring
// gpgv reads; this pins that keyring to a commit and its sha256. Move both,
// in a reviewed pull request, when Node has a new releaser (RELEASING.md,
// "Node release keys").
export const NODE_RELEASE_KEYS_COMMIT = "481637f813e912c4aa3622d7964ab426c97b8e8d";
export const NODE_RELEASE_KEYRING_SHA256 =
  "140f2ad5260fd62773b6243ce8e1d3009645d558f121b8262c55e383dc285932";
export const NODE_KEYRING_URL = `https://raw.githubusercontent.com/nodejs/release-keys/${NODE_RELEASE_KEYS_COMMIT}/gpg-only-active-keys/pubring.kbx`;

const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const IMAGE_AT_DIGEST = /^([^@\s]+)@sha256:([0-9a-f]{64})$/;
const APP_BASE = /^node:(\d+\.\d+\.\d+)-trixie-slim@sha256:[0-9a-f]{64}$/;
const NODE_URL =
  /^https:\/\/nodejs\.org\/dist\/v(\d+\.\d+\.\d+)\/node-v(\d+\.\d+\.\d+)-linux-x64\.tar\.xz$/;
const NODE_VERSION_LINE = /^(\d+\.\d+\.\d+)\n?$/;
const COMPOSE_NODE = /^( {2}image: node:)(\d+\.\d+\.\d+)(-trixie-slim)$/gm;
const README_NODE = /(You need Node )(\d+\.\d+\.\d+)(, the version in)/g;
const BASE_ROW = /^\| Base image \| (\S+) \| index digest `sha256:([0-9a-f]{64})` \|$/gm;
const NODE_ROW = /^\| Node\.js \| (\d+\.\d+\.\d+) linux x64 \| sha256 `([0-9a-f]{64})` \|$/gm;
// The comment above ARG BASE=: its first line and every # line after it.
const COMMENT_BLOCK =
  /^# (?:node|ubuntu):\S+, multi-arch index digest[^\n]*\n(?:#[^\n]*\n)*(?=ARG BASE=)/m;

const need = (texts, f) => {
  if (typeof texts[f] !== "string") throw new Error(`${f} was not read`);
  return texts[f];
};

// The one value of the one line ^ARG <name>=(.*)$ in a Dockerfile.
function argValue(text, file, name) {
  const all = [...text.matchAll(new RegExp(`^ARG ${name}=(.*)$`, "gm"))];
  if (all.length !== 1) throw new Error(`${file} has ${all.length} ARG ${name}= lines, not 1`);
  return all[0][1];
}

function nodeOf(text, file) {
  const url = argValue(text, file, "NODE_URL");
  const m = NODE_URL.exec(url);
  if (!m) throw new Error(`${file} pins NODE_URL=${url}, not a nodejs.org linux-x64 .tar.xz`);
  if (m[1] !== m[2])
    throw new Error(`${file} NODE_URL names two Node versions: ${m[1]} and ${m[2]}`);
  const sha = argValue(text, file, "NODE_SHA256");
  if (!SHA256.test(sha)) throw new Error(`${file}: NODE_SHA256=${sha} is not a sha256`);
  return { version: m[1], sha };
}

function ubuntuOf(text, file) {
  const base = argValue(text, file, "BASE");
  if (!IMAGE_AT_DIGEST.test(base))
    throw new Error(`${file} pins ARG BASE=${base}, not image@sha256:<digest>`);
  return base;
}

// What the files pin now: { appBase, ubuntuBase, nodeVersion, nodeSha }, the
// two bases as image@sha256:digest. texts maps each of FILES to its text.
// Throws when a pin is missing or malformed, the slicer and the gate disagree,
// the app image is on another Node release than the download, or the README's
// pins table disagrees with the Dockerfiles.
export function readPins(texts) {
  const appText = need(texts, APP_DOCKERFILE);
  const slicerText = need(texts, SLICER_DOCKERFILE);
  const gateText = need(texts, GATE_DOCKERFILE);
  const readme = need(texts, GATE_README);

  const appBase = argValue(appText, APP_DOCKERFILE, "BASE");
  const app = APP_BASE.exec(appBase);
  if (!app)
    throw new Error(
      `${APP_DOCKERFILE} pins ARG BASE=${appBase}, not node:X.Y.Z-trixie-slim@sha256:<digest>`,
    );

  const slicer = {
    ubuntu: ubuntuOf(slicerText, SLICER_DOCKERFILE),
    node: nodeOf(slicerText, SLICER_DOCKERFILE),
  };
  const gate = {
    ubuntu: ubuntuOf(gateText, GATE_DOCKERFILE),
    node: nodeOf(gateText, GATE_DOCKERFILE),
  };
  const pair = `${SLICER_DOCKERFILE} and ${GATE_DOCKERFILE} disagree on`;
  if (slicer.ubuntu !== gate.ubuntu)
    throw new Error(`${pair} the base image: ${slicer.ubuntu} and ${gate.ubuntu}`);
  if (slicer.node.version !== gate.node.version) {
    throw new Error(`${pair} the Node version: ${slicer.node.version} and ${gate.node.version}`);
  }
  if (slicer.node.sha !== gate.node.sha)
    throw new Error(`${pair} the Node sha256: ${slicer.node.sha} and ${gate.node.sha}`);
  if (app[1] !== slicer.node.version) {
    throw new Error(
      `the app image's Node ${app[1]} is not the downloaded Node ${slicer.node.version}`,
    );
  }

  const pins = {
    appBase,
    ubuntuBase: slicer.ubuntu,
    nodeVersion: slicer.node.version,
    nodeSha: slicer.node.sha,
  };

  const bases = [...readme.matchAll(BASE_ROW)];
  const nodes = [...readme.matchAll(NODE_ROW)];
  if (bases.length !== 1)
    throw new Error(`${GATE_README} lists ${bases.length} "Base image" pins, not 1`);
  if (nodes.length !== 1)
    throw new Error(`${GATE_README} lists ${nodes.length} "Node.js" pins, not 1`);
  const digest = pins.ubuntuBase.split("@")[1];
  if (bases[0][2] !== digest.slice("sha256:".length)) {
    throw new Error(
      `${GATE_README} lists the base image digest sha256:${bases[0][2]}, the Dockerfiles pin ${digest}`,
    );
  }
  if (nodes[0][1] !== pins.nodeVersion) {
    throw new Error(
      `${GATE_README} lists Node ${nodes[0][1]}, the Dockerfiles pin ${pins.nodeVersion}`,
    );
  }
  if (nodes[0][2] !== pins.nodeSha) {
    throw new Error(
      `${GATE_README} lists the Node sha256 ${nodes[0][2]}, the Dockerfiles pin ${pins.nodeSha}`,
    );
  }

  const others = [
    [
      NODE_VERSION_FILE,
      NODE_VERSION_LINE.exec(need(texts, NODE_VERSION_FILE))?.[1],
      "a single X.Y.Z line",
    ],
    [
      E2E_COMPOSE,
      onlyOne(need(texts, E2E_COMPOSE), COMPOSE_NODE, 2),
      "one `image: node:X.Y.Z-trixie-slim` line",
    ],
    [
      ROOT_README,
      onlyOne(need(texts, ROOT_README), README_NODE, 2),
      'one "You need Node X.Y.Z, the version in" sentence',
    ],
  ];
  for (const [f, v, shape] of others) {
    if (v === undefined) throw new Error(`${f} does not hold ${shape}`);
    if (v !== pins.nodeVersion)
      throw new Error(`${f} names Node ${v}, the Dockerfiles pin ${pins.nodeVersion}`);
  }
  return pins;
}

// The version group of the one match of re in text, or undefined for none or
// several.
function onlyOne(text, re, group) {
  const all = [...text.matchAll(re)];
  return all.length === 1 ? all[0][group] : undefined;
}

function checkNext(next) {
  const { appBase, ubuntuBase, nodeVersion, nodeSha: sha } = next;
  const app = APP_BASE.exec(appBase ?? "");
  if (!app) throw new Error(`appBase ${appBase} is not node:X.Y.Z-trixie-slim@sha256:<digest>`);
  if (!IMAGE_AT_DIGEST.test(ubuntuBase ?? ""))
    throw new Error(`ubuntuBase ${ubuntuBase} is not image@sha256:<digest>`);
  if (!VERSION.test(nodeVersion ?? "")) throw new Error(`nodeVersion ${nodeVersion} is not X.Y.Z`);
  if (!SHA256.test(sha ?? "")) throw new Error(`nodeSha ${sha} is not a sha256`);
  if (app[1] !== nodeVersion)
    throw new Error(`the app image's Node ${app[1]} is not ${nodeVersion}`);
}

const escapeRe = (s) => s.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A base image moved: its comment block (the date it was read, the old
// manifest digests) is replaced, then its ARG BASE line.
function moveBase(text, file, to, date) {
  if (!COMMENT_BLOCK.test(text))
    throw new Error(`${file} has no "multi-arch index digest" comment above ARG BASE=`);
  const ref = to.split("@")[0];
  return text
    .replace(
      COMMENT_BLOCK,
      () =>
        `# ${ref}, multi-arch index digest read from Docker Hub on ${date}\n# by the base-images workflow.\n`,
    )
    .replace(/^ARG BASE=.*$/m, () => `ARG BASE=${to}`);
}

// The texts with every pin moved to next, { appBase, ubuntuBase, nodeVersion,
// nodeSha, date } (date is YYYY-MM-DD, written into the digest comments).
// Only what changed is touched: pins already current leave a file as it was.
// Throws unless the result reads back as next.
export function rewritePins(texts, next) {
  checkNext(next);
  const now = readPins(texts);
  const baseMoved = now.appBase !== next.appBase || now.ubuntuBase !== next.ubuntuBase;
  if (baseMoved && !/^\d{4}-\d{2}-\d{2}$/.test(next.date ?? ""))
    throw new Error(`date ${next.date} is not YYYY-MM-DD`);

  const out = {};
  for (const f of FILES) out[f] = texts[f];

  if (now.appBase !== next.appBase)
    out[APP_DOCKERFILE] = moveBase(out[APP_DOCKERFILE], APP_DOCKERFILE, next.appBase, next.date);
  for (const f of [SLICER_DOCKERFILE, GATE_DOCKERFILE]) {
    if (now.ubuntuBase !== next.ubuntuBase)
      out[f] = moveBase(out[f], f, next.ubuntuBase, next.date);
    if (now.nodeSha !== next.nodeSha)
      out[f] = out[f].replace(/^ARG NODE_SHA256=.*$/m, () => `ARG NODE_SHA256=${next.nodeSha}`);
  }
  if (now.nodeVersion !== next.nodeVersion) {
    const old = new RegExp(`(?<![\\d.])${escapeRe(now.nodeVersion)}(?![\\d.])`, "g");
    for (const f of [APP_DOCKERFILE, SLICER_DOCKERFILE, GATE_DOCKERFILE]) {
      out[f] = out[f].replace(old, next.nodeVersion);
      if (old.test(out[f])) throw new Error(`${f} still names Node ${now.nodeVersion}`);
    }
  }
  if (now.nodeVersion !== next.nodeVersion) {
    out[NODE_VERSION_FILE] = `${next.nodeVersion}\n`;
    out[E2E_COMPOSE] = out[E2E_COMPOSE].replace(
      COMPOSE_NODE,
      (_m, a, _v, c) => `${a}${next.nodeVersion}${c}`,
    );
    out[ROOT_README] = out[ROOT_README].replace(
      README_NODE,
      (_m, a, _v, c) => `${a}${next.nodeVersion}${c}`,
    );
  }
  const digest = next.ubuntuBase.split("@")[1].slice("sha256:".length);
  out[GATE_README] = out[GATE_README]
    .replace(
      BASE_ROW,
      (_row, image) => `| Base image | ${image} | index digest \`sha256:${digest}\` |`,
    )
    .replace(
      NODE_ROW,
      () => `| Node.js | ${next.nodeVersion} linux x64 | sha256 \`${next.nodeSha}\` |`,
    );

  const { date: _date, ...want } = next;
  const got = readPins(out);
  for (const k of Object.keys(want)) {
    if (got[k] !== want[k])
      throw new Error(`the rewrite did not move ${k} to ${want[k]} (it reads ${got[k]})`);
  }
  return out;
}

const parseVersion = (v) => v.split(".").map(Number);
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// The newest vMAJOR.x.y release in nodejs.org's index.json (its text), as
// X.Y.Z. Entries without a vX.Y.Z version are ignored.
export function latestNode(major, indexJson) {
  const m = String(major);
  if (!/^\d+$/.test(m)) throw new Error(`Node major ${major} is not a number`);
  let list;
  try {
    list = JSON.parse(indexJson);
  } catch {
    throw new Error("index.json is not JSON");
  }
  if (!Array.isArray(list)) throw new Error("index.json is not a list");
  const versions = list
    .map((e) =>
      typeof e?.version === "string" ? /^v(\d+\.\d+\.\d+)$/.exec(e.version)?.[1] : undefined,
    )
    .filter((v) => v !== undefined && parseVersion(v)[0] === Number(m));
  if (versions.length === 0) throw new Error(`no Node ${m}.x release in index.json`);
  return versions.reduce((a, b) => (compareVersions(b, a) > 0 ? b : a));
}

// The sha256 SHASUMS256.txt (its text) lists for exactly this file name.
export function nodeSha(shasumsText, file) {
  const hits = shasumsText
    .split("\n")
    .map((l) => /^(\S+)\s+\*?(\S+)$/.exec(l.trim()))
    .filter((m) => m && m[2] === file);
  if (hits.length === 0) throw new Error(`${file} is not in SHASUMS256.txt`);
  if (hits.length > 1) throw new Error(`${file} is listed ${hits.length} times in SHASUMS256.txt`);
  if (!SHA256.test(hits[0][1])) throw new Error(`the sha256 ${hits[0][1]} is not 64 hex digits`);
  return hits[0][1];
}

// The clear text of a signed SHASUMS256.txt.asc, once gpgv has checked its
// signature against the keyring at keyringPath, whose sha256 must be
// keyringSha256. gpgv writes the clear text as it reads, before it rejects a
// file, so its output is read only when it exits 0. Throws when the keyring
// is not the pinned one (before gpgv runs), when the list is signed by a key
// not in the keyring, when the signature does not verify, or when gpgv is not
// installed.
export function verifySignedShasums({
  ascPath,
  keyringPath,
  keyringSha256 = NODE_RELEASE_KEYRING_SHA256,
  gpgv = "gpgv",
}) {
  const got = createHash("sha256").update(readFileSync(keyringPath)).digest("hex");
  if (got !== keyringSha256) {
    throw new Error(
      `the Node release keyring ${keyringPath} has sha256 ${got}, not the pinned ${keyringSha256} (NODE_RELEASE_KEYRING_SHA256)`,
    );
  }
  const home = mkdtempSync(join(tmpdir(), "gpgv-"));
  try {
    // An absolute keyring path: gpgv looks for a bare name in its home.
    const r = spawnSync(
      gpgv,
      ["--homedir", home, "--keyring", resolve(keyringPath), "--output", "-", resolve(ascPath)],
      { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, maxBuffer: 16 * 1024 * 1024 },
    );
    if (r.error?.code === "ENOENT") {
      throw new Error(`${gpgv} could not start: gpgv is not installed`);
    }
    if (r.error) throw new Error(`gpgv failed to run: ${r.error.message}`);
    if (r.status === 0) return r.stdout;
    const stderr = r.stderr ?? "";
    if (/No public key/.test(stderr)) {
      throw new Error(
        `SHASUMS256.txt.asc is not signed by a key in nodejs/release-keys at ${NODE_RELEASE_KEYS_COMMIT}. If Node has a new releaser, move NODE_RELEASE_KEYS_COMMIT and NODE_RELEASE_KEYRING_SHA256 in .github/scripts/base-images.mjs in a reviewed pull request (RELEASING.md, "Node release keys").`,
      );
    }
    const last = stderr.trim().split("\n").slice(-3).join(" | ");
    throw new Error(`SHASUMS256.txt.asc does not verify (gpgv exit ${r.status}): ${last}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// The git grep that lists the tracked files naming one of the digests, other
// than the four pinned files and CHANGELOG.md (whose history may name old pins).
export function grepArgs(hexes) {
  for (const h of hexes) if (!SHA256.test(h)) throw new Error(`${h} is not a sha256`);
  return [
    "grep",
    "-l",
    "-F",
    ...hexes.flatMap((h) => ["-e", h]),
    "--",
    ".",
    ":!CHANGELOG.md",
    ...DIGEST_FILES.map((f) => `:!${f}`),
  ];
}

// The leftover files in the repo at root for these digests, sorted.
export function leftovers(root, hexes) {
  if (hexes.length === 0) return [];
  const r = spawnSync("git", ["-C", root, ...grepArgs(hexes)], { encoding: "utf8" });
  // git grep exits 1 when nothing matches.
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`git grep failed (exit ${r.status}): ${r.stderr || r.error?.message || ""}`);
  }
  return r.stdout.split("\n").filter(Boolean).sort();
}

const usage = () => {
  process.stderr.write(
    "usage: node base-images.mjs read | latest-node <major> <index.json> [<current>] | keyring-url | node-sha-signed <SHASUMS256.txt.asc> <keyring> <file> | rewrite | leftovers <sha256>...\n",
  );
  process.exit(2);
};

function main([cmd, ...args]) {
  const root = process.cwd();
  const readFiles = () =>
    Object.fromEntries(FILES.map((f) => [f, readFileSync(join(root, f), "utf8")]));
  switch (cmd) {
    case "read": {
      if (args.length > 0) usage();
      const p = readPins(readFiles());
      process.stdout.write(
        `${[
          `old_app_base=${p.appBase}`,
          `old_ubuntu_base=${p.ubuntuBase}`,
          `old_node_version=${p.nodeVersion}`,
          `old_node_sha=${p.nodeSha}`,
          `node_major=${p.nodeVersion.split(".")[0]}`,
          `ubuntu_image=${p.ubuntuBase.split("@")[0]}`,
        ].join("\n")}\n`,
      );
      return;
    }
    case "latest-node": {
      if (args.length < 2 || args.length > 3) usage();
      const latest = latestNode(args[0], readFileSync(args[1], "utf8"));
      const current = args[2];
      if (current !== undefined && !VERSION.test(current))
        throw new Error(`current Node ${current} is not X.Y.Z`);
      process.stdout.write(
        `${current !== undefined && compareVersions(current, latest) > 0 ? current : latest}\n`,
      );
      return;
    }
    case "keyring-url": {
      if (args.length > 0) usage();
      process.stdout.write(`${NODE_KEYRING_URL}\n`);
      return;
    }
    case "node-sha-signed": {
      if (args.length !== 3) usage();
      const text = verifySignedShasums({ ascPath: args[0], keyringPath: args[1] });
      process.stdout.write(`${nodeSha(text, args[2])}\n`);
      return;
    }
    case "rewrite": {
      if (args.length > 0) usage();
      const e = process.env;
      const next = {
        appBase: e.NEXT_APP_BASE,
        ubuntuBase: e.NEXT_UBUNTU_BASE,
        nodeVersion: e.NEXT_NODE_VERSION,
        nodeSha: e.NEXT_NODE_SHA,
        date: e.NEXT_DATE,
      };
      for (const [k, v] of Object.entries(next)) {
        if (!v) {
          process.stderr.write(`::error::the NEXT_ value for ${k} is not set\n`);
          process.exit(2);
        }
      }
      const before = readFiles();
      const out = rewritePins(before, next);
      for (const f of FILES) if (out[f] !== before[f]) writeFileSync(join(root, f), out[f]);
      return;
    }
    case "leftovers": {
      if (args.length === 0) usage();
      const found = leftovers(root, args);
      if (found.length > 0) {
        process.stderr.write(
          `::error::these files name a base image or Node digest the rewrite moved, which only ${DIGEST_FILES.join(", ")} may: the weekly base-images run would leave them behind and stop before it pushes. Move the copy to the pin, or teach .github/scripts/base-images.mjs about it:\n${found.join("\n")}\n`,
        );
        process.exit(1);
      }
      process.stderr.write("No file but the pinned ones names a digest that moved\n");
      return;
    }
    default:
      usage();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`::error::${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
