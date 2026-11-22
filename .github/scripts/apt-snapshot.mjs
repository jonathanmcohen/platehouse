// Moves the Ubuntu snapshot the slicer and slicing gate images install their
// packages from (.github/workflows/apt-snapshot.yml, issue #219).
//
// Both Dockerfiles pin one snapshot.ubuntu.com timestamp, ARG APT_SNAPSHOT,
// and the slicing gate's README lists it in its pins table. The two
// Dockerfiles must agree. A refresh picks the newest day, from today (UTC)
// back over the last week, whose snapshot exists for every suite the images
// use (noble, noble-updates and noble-security), at midnight UTC: always in
// the past when the workflow runs, so the timestamp names one fixed state of
// the archive and builds stay reproducible. A future timestamp would not: the
// service answers it with whatever is newest at the time of each build.
// The service is asked before any file is written, so a date it does not
// have is never written, and an error from it fails the run rather than
// settling for an older day. A day that is not newer than the current pin
// changes nothing.
//
// The leftover check (issue #391). Only the three pinned files may name a
// snapshot at or after the pin, and each only once, in its pin: the pin only
// moves forward, so a timestamp before it can never be a pin again, while one
// at or after it is the pin, or may be a later one, and any other copy of it
// is one the rewrite would leave behind. The monthly run checks this after its rewrite and stops before it
// pushes; the ci workflow checks it on every pull request, so a file that
// would stop a later monthly run fails that pull request instead. Both run
// the same command below. It reads the tracked files with git grep, leaves
// out CHANGELOG.md (its history may name old pins), and asks no network. It
// counts only midnight UTC timestamps, the only kind a refresh writes, and
// the exact one it starts from, so another time of day, such as an AWS
// X-Amz-Date, is not taken for a copy of the pin.
//
// Command line, run at the repo root:
//   node apt-snapshot.mjs refresh   rewrites the pins when there is a newer
//                                   snapshot, then prints old=<ts> and
//                                   new=<ts> (new= is empty when nothing
//                                   changed), and old_label= and new_label=,
//                                   the same dates as a person reads them,
//                                   on stdout for $GITHUB_OUTPUT; everything
//                                   else goes to stderr (the monthly workflow)
//   node apt-snapshot.mjs leftovers [<ts>]
//                                   the leftover check from <ts>, or from the
//                                   current pin when none is given: exits 0
//                                   when no other file, and no pinned file
//                                   beside its pin, names a snapshot at
//                                   or after it, 1 with the files and the
//                                   timestamps they name when one does, 2
//                                   when git or the arguments fail (the
//                                   monthly workflow, with the old pin after
//                                   its rewrite; the ci workflow, with none)

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const DOCKERFILES = ["apps/slicer/Dockerfile", "tools/slicing-gate/Dockerfile"];
export const GATE_README = "tools/slicing-gate/README.md";
export const SUITES = ["noble", "noble-updates", "noble-security"];
export const SNAPSHOT_URL = "https://snapshot.ubuntu.com/ubuntu";
// How many days back from today a refresh looks for a snapshot that answers.
export const LOOKBACK_DAYS = 7;

const SNAPSHOT = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const ARG_LINE = /^ARG APT_SNAPSHOT=(.*)$/gm;
const README_CELL = /\| Ubuntu snapshot (\S+) \|/g;

// Whether s is a snapshot timestamp YYYYMMDDTHHMMSSZ naming a real UTC time.
export function isSnapshot(s) {
  const m = typeof s === "string" ? SNAPSHOT.exec(s) : null;
  if (!m) return false;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === mo - 1 &&
    t.getUTCDate() === d &&
    t.getUTCHours() === h &&
    t.getUTCMinutes() === mi &&
    t.getUTCSeconds() === se
  );
}

// The snapshot timestamp for midnight UTC of the day date falls on.
export function snapshotFor(date) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}T000000Z`;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// A snapshot timestamp as a date a person reads, such as 7 November 2026.
export function label(ts) {
  if (!isSnapshot(ts)) throw new Error(`${ts} is not a snapshot timestamp`);
  const [, y, mo, d] = SNAPSHOT.exec(ts);
  return `${Number(d)} ${MONTHS[Number(mo) - 1]} ${y}`;
}

// The timestamps a refresh at now tries, newest first: midnight UTC today,
// then each day before it, LOOKBACK_DAYS in all.
export function candidates(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("now is not a date");
  const out = [];
  for (let i = 0; i < LOOKBACK_DAYS; i++) {
    out.push(snapshotFor(new Date(now.getTime() - i * 86_400_000)));
  }
  return out;
}

// The APT_SNAPSHOT a Dockerfile pins. Throws unless it has exactly one ARG
// APT_SNAPSHOT=<timestamp> line.
export function dockerfilePin(text, name = "the Dockerfile") {
  const all = [...text.matchAll(ARG_LINE)];
  if (all.length !== 1) throw new Error(`${name} has ${all.length} ARG APT_SNAPSHOT= lines, not 1`);
  const value = all[0][1];
  if (!isSnapshot(value))
    throw new Error(`${name} pins APT_SNAPSHOT=${value}, not a snapshot timestamp`);
  return value;
}

// The one snapshot every file pins. texts maps each of DOCKERFILES and
// GATE_README to its text. Throws when a file is missing, a Dockerfile's pin
// is not exactly one timestamp, the README does not list exactly one, or any
// two disagree.
export function currentPin(texts) {
  const pins = {};
  for (const f of DOCKERFILES) {
    if (typeof texts[f] !== "string") throw new Error(`${f} was not read`);
    pins[f] = dockerfilePin(texts[f], f);
  }
  if (typeof texts[GATE_README] !== "string") throw new Error(`${GATE_README} was not read`);
  const cells = [...texts[GATE_README].matchAll(README_CELL)];
  if (cells.length !== 1) {
    throw new Error(`${GATE_README} lists ${cells.length} "Ubuntu snapshot" pins, not 1`);
  }
  pins[GATE_README] = cells[0][1];
  const values = new Set(Object.values(pins));
  if (values.size !== 1) {
    const list = Object.entries(pins)
      .map(([f, v]) => `${f} ${v}`)
      .join(", ");
    throw new Error(`the snapshot pins disagree: ${list}`);
  }
  return pins[DOCKERFILES[0]];
}

// The files with every pin moved from `from` to `to`. Touches only the ARG
// APT_SNAPSHOT= lines and the README's pins cell; throws when the result
// would not pin `to` everywhere.
export function rewritePins(texts, from, to) {
  if (!isSnapshot(to)) throw new Error(`${to} is not a snapshot timestamp`);
  const out = {};
  for (const f of DOCKERFILES) {
    out[f] = texts[f].replace(ARG_LINE, (line, v) =>
      v === from ? `ARG APT_SNAPSHOT=${to}` : line,
    );
  }
  out[GATE_README] = texts[GATE_README].replace(README_CELL, (cell, v) =>
    v === from ? `| Ubuntu snapshot ${to} |` : cell,
  );
  if (currentPin(out) !== to) throw new Error(`the rewrite did not move every pin to ${to}`);
  return out;
}

// How many times one InRelease request is tried when the service errors
// (anything but 200 or 404, or no answer), and the wait before each retry.
// snapshot.ubuntu.com answers 5xx for a while now and then; a longer outage
// fails the run, and the next run or a run by hand tries again.
export const ATTEMPTS = 4;
export const RETRY_WAIT_MS = 5_000;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// What snapshot.ubuntu.com says about timestamp ts, asking for each suite's
// InRelease. fetchFn is fetch (or a stand-in for tests); sleep waits between
// retries. Returns { state, detail }: state "ok" when every suite answered
// 200; "missing" when a suite answered 404, the only answer that means the
// service has no such snapshot; "error" when a suite kept erroring through
// every attempt, so whether it exists is not known. detail names the first
// suite that was not 200.
export async function reachable(ts, fetchFn = fetch, sleep = wait) {
  if (!isSnapshot(ts)) return { state: "missing", detail: `${ts} is not a snapshot timestamp` };
  for (const suite of SUITES) {
    const url = `${SNAPSHOT_URL}/${ts}/dists/${suite}/InRelease`;
    let detail = "";
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      if (attempt > 1) await sleep(RETRY_WAIT_MS * (attempt - 1));
      let status;
      try {
        status = (await fetchFn(url, { method: "HEAD", redirect: "manual" })).status;
      } catch (e) {
        detail = `${url}: ${e instanceof Error ? e.message : String(e)}`;
        continue;
      }
      if (status === 200) {
        detail = "";
        break;
      }
      if (status === 404) return { state: "missing", detail: `${url} answered 404` };
      detail = `${url} answered ${status}`;
    }
    if (detail !== "") return { state: "error", detail: `${detail} (${ATTEMPTS} attempts)` };
  }
  return { state: "ok", detail: "" };
}

// The snapshot a refresh at now moves to from current: the newest candidate
// newer than current that the service has for every suite, or null when no
// candidate is newer than current. A candidate the service does not have
// (404) is passed over for the day before. Throws when the service errors on
// a candidate, rather than passing it over for an older day, and when no
// newer candidate exists at all, so the run fails instead of staying put.
export async function pickSnapshot(
  current,
  now,
  { fetchFn = fetch, sleep = wait, log = () => {} } = {},
) {
  if (!isSnapshot(current))
    throw new Error(`the current pin ${current} is not a snapshot timestamp`);
  const newer = candidates(now).filter((ts) => ts > current);
  if (newer.length === 0) return null;
  const tried = [];
  for (const ts of newer) {
    const r = await reachable(ts, fetchFn, sleep);
    if (r.state === "ok") return ts;
    if (r.state === "error") {
      throw new Error(
        `could not tell whether snapshot ${ts} exists: ${r.detail}; nothing was changed`,
      );
    }
    log(`${ts} is not on the service: ${r.detail}`);
    tried.push(`${ts} (${r.detail})`);
  }
  throw new Error(
    `no snapshot newer than ${current} exists for ${SUITES.join(", ")}: ${tried.join("; ")}`,
  );
}

// One refresh: reads the pins, picks the new snapshot (checking it exists
// before anything is written), then writes every file. read and write take
// repo-relative paths. Returns { old, new } with new null when nothing
// changed.
export async function refresh({ now, fetchFn = fetch, sleep = wait, read, write, log = () => {} }) {
  const files = [...DOCKERFILES, GATE_README];
  const texts = Object.fromEntries(files.map((f) => [f, read(f)]));
  const old = currentPin(texts);
  log(`current snapshot: ${old}`);
  const next = await pickSnapshot(old, now, { fetchFn, sleep, log });
  if (next === null) {
    log(`no day from ${candidates(now).at(-1)} to ${candidates(now)[0]} is newer than ${old}`);
    return { old, new: null };
  }
  const out = rewritePins(texts, old, next);
  for (const f of files) if (out[f] !== texts[f]) write(f, out[f]);
  log(`moved the snapshot from ${old} to ${next} in ${files.join(", ")}`);
  return { old, new: next };
}

// The git grep the leftover check from since runs, at the repo root, one
// "<file>:<match>" per line, CHANGELOG.md left out. It matches only what can
// be a copy of a pin: a timestamp at midnight UTC, the only kind a refresh
// writes (snapshotFor), and since itself, which a pin set by hand may not be.
// Any other compact ISO 8601 UTC time, such as an AWS SigV4 X-Amz-Date in a
// presigned URL, is not a snapshot and is not matched. since is the current
// pin in the ci workflow, and the old pin, whose copies the rewrite would
// leave behind, in the monthly run, whose new pin is always at midnight.
export function grepArgs(since) {
  if (!isSnapshot(since)) throw new Error(`${since} is not a snapshot timestamp`);
  return ["grep", "-o", "-E", "-e", "[0-9]{8}T000000Z", "-e", since, "--", ".", ":!CHANGELOG.md"];
}

// The leftovers in git grep output (grepArgs), as "<file> <timestamp>"
// strings, sorted and without repeats: every real snapshot timestamp at or
// after since that a file other than the three pinned ones names, and every
// one a pinned file names when it names more than one. The rewrite moves only
// a pinned file's ARG APT_SNAPSHOT= line or pins cell, so that pin is the one
// such timestamp the file may hold; a second copy, such as a comment or a
// sentence in the gate README, would be left behind. git grep -o gives no
// line, so all of that file's timestamps are listed, its pin among them.
export function findLeftovers(grepOutput, since) {
  if (!isSnapshot(since)) throw new Error(`${since} is not a snapshot timestamp`);
  const pinned = Object.fromEntries([...DOCKERFILES, GATE_README].map((f) => [f, []]));
  const out = new Set();
  for (const line of grepOutput.split("\n")) {
    const at = line.lastIndexOf(":");
    if (at <= 0) continue;
    const file = line.slice(0, at);
    const ts = line.slice(at + 1);
    if (!isSnapshot(ts) || ts < since) continue;
    if (Object.hasOwn(pinned, file)) pinned[file].push(ts);
    else out.add(`${file} ${ts}`);
  }
  for (const [file, found] of Object.entries(pinned)) {
    if (found.length > 1) for (const ts of found) out.add(`${file} ${ts}`);
  }
  return [...out].sort();
}

// Runs the leftover check over the repo at root with real git. since defaults
// to the current pin. Returns { since, leftovers }; throws when git fails.
export function leftovers(root, since = undefined) {
  const from =
    since ??
    currentPin(
      Object.fromEntries(
        [...DOCKERFILES, GATE_README].map((f) => [f, readFileSync(join(root, f), "utf8")]),
      ),
    );
  if (!isSnapshot(from)) throw new Error(`${from} is not a snapshot timestamp`);
  const r = spawnSync("git", ["-C", root, ...grepArgs(from)], { encoding: "utf8" });
  // git grep exits 1 when nothing matches.
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`git grep failed (exit ${r.status}): ${r.stderr || r.error?.message || ""}`);
  }
  return { since: from, leftovers: findLeftovers(r.stdout, from) };
}

function leftoversCommand(args) {
  if (args.length > 1 || (args.length === 1 && !isSnapshot(args[0]))) {
    process.stderr.write("usage: node apt-snapshot.mjs leftovers [YYYYMMDDTHHMMSSZ]\n");
    process.exit(2);
  }
  let r;
  try {
    r = leftovers(process.cwd(), args[0]);
  } catch (e) {
    process.stderr.write(`::error::${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
  if (r.leftovers.length > 0) {
    const files = [DOCKERFILES[0], DOCKERFILES[1], GATE_README].join(", ");
    process.stderr.write(
      `::error::these files name the Ubuntu snapshot ${r.since} or a later one, which only ${files} may, each once in its pin: the monthly apt-snapshot run would leave them behind and stop before it pushes. Take the date out of them, use a date before ${r.since}, or teach .github/scripts/apt-snapshot.mjs about them:\n`,
    );
    process.stderr.write(`${r.leftovers.join("\n")}\n`);
    process.exit(1);
  }
  process.stderr.write(`No file but the three pins names the snapshot ${r.since} or a later one\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "leftovers") {
    leftoversCommand(args);
    process.exit(0);
  }
  if (cmd !== "refresh" || args.length > 0) {
    process.stderr.write("usage: node apt-snapshot.mjs refresh | leftovers [YYYYMMDDTHHMMSSZ]\n");
    process.exit(2);
  }
  const root = process.cwd();
  try {
    const r = await refresh({
      now: new Date(),
      read: (f) => readFileSync(join(root, f), "utf8"),
      write: (f, t) => writeFileSync(join(root, f), t),
      log: (m) => process.stderr.write(`${m}\n`),
    });
    const lines = [
      `old=${r.old}`,
      `new=${r.new ?? ""}`,
      `old_label=${label(r.old)}`,
      `new_label=${r.new ? label(r.new) : ""}`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  } catch (e) {
    process.stderr.write(`::error::${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
