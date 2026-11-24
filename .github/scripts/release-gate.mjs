// The release gate (.github/workflows/release.yml, issue #450).
//
// ciVerdict decides from the ci workflow's runs for a commit whether the
// release may go ahead; isLatest decides whether a tag may carry `latest`
// (only the highest stable vX.Y.Z; a backport or an rc never does).
//
// Command line, used by the workflow:
//   node release-gate.mjs ci <sha>      polls the ci runs for <sha> every 30 s,
//                                       for at most WAIT_MINUTES; exits 0 when
//                                       one succeeded, 1 on failure or timeout.
//                                       Needs GH_TOKEN and GITHUB_REPOSITORY.
//   node release-gate.mjs latest <tag>  tag names on stdin, one per line;
//                                       prints true or false

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { compareTags, parseTag } from "./rc-target.mjs";

export const WAIT_MINUTES = 60;
const POLL_MS = 30_000;

// "pass": a completed run of this commit succeeded. "wait": none did, and one
// is queued or running. "fail": anything else, including no runs, and runs
// that only failed or were cancelled. The runs API lists a run's latest
// attempt, so a cancelled attempt that was re-run and passed shows as a pass.
export function ciVerdict(runs, sha) {
  const mine = runs.filter((r) => r.head_sha === sha);
  if (mine.some((r) => r.status === "completed" && r.conclusion === "success")) return "pass";
  if (mine.some((r) => r.status !== "completed")) return "wait";
  return "fail";
}

// True only for a stable vX.Y.Z that no other stable tag in allTags beats.
export function isLatest(tag, allTags) {
  const p = parseTag(tag);
  if (p === null || p.rc !== null) return false;
  return allTags.every((t) => {
    const q = parseTag(t);
    return q === null || q.rc !== null || compareTags(tag, t) >= 0;
  });
}

// Polls fetchRuns until the verdict is not "wait", or WAIT_MINUTES pass.
// Returns "pass" or "fail"; a timeout is a fail.
export async function waitForCi({ sha, fetchRuns, sleep = delay }) {
  let waited = 0;
  for (;;) {
    const verdict = ciVerdict(await fetchRuns(), sha);
    if (verdict !== "wait") return verdict;
    if (waited >= WAIT_MINUTES * 60_000) return "fail";
    await sleep(POLL_MS);
    waited += POLL_MS;
  }
}

async function main(argv) {
  const [mode, arg] = argv;
  if (mode === "latest") {
    const tags = readFileSync(0, "utf8").split("\n").filter(Boolean);
    process.stdout.write(`${isLatest(arg ?? "", tags)}\n`);
    return 0;
  }
  if (mode === "ci") {
    if (!/^[0-9a-f]{40}$/.test(arg ?? ""))
      throw new Error("usage: release-gate.mjs ci <40-hex sha>");
    const repo = process.env.GITHUB_REPOSITORY;
    if (!repo) throw new Error("GITHUB_REPOSITORY is not set");
    const run = promisify(execFile);
    // No event filter: the tag push has no ci run of its own, the branch push
    // (or its pull request) that put the commit there does.
    const fetchRuns = async () => {
      const { stdout } = await run("gh", [
        "api",
        `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${arg}&per_page=100`,
        "--jq",
        ".workflow_runs",
      ]);
      return JSON.parse(stdout);
    };
    const verdict = await waitForCi({ sha: arg, fetchRuns });
    if (verdict === "pass") {
      console.log(`ci passed for ${arg}`);
      return 0;
    }
    console.error(
      `ci has no successful run for ${arg} (failed, cancelled, not run, or still running after ${WAIT_MINUTES} minutes); nothing is published`,
    );
    return 1;
  }
  throw new Error("usage: release-gate.mjs ci <sha> | latest <tag>");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    },
  );
}
