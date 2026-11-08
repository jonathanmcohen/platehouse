// Pins the README's run steps against what went wrong on the first Hades run
// (2026-11-08): scp -r over Tailscale SSH dropped the scripts' execute bits,
// so step 3's /tmp/platehouse-gate/tool/run.sh failed with exit 126.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(HERE, "README.md"), "utf8");
const runSteps = readme.slice(readme.indexOf("## How to run it"), readme.indexOf("## The container"));
// Every command line inside a fenced shell block of the run steps.
const commands = [...runSteps.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((m) =>
  m[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#")),
);

test("the run steps are found", () => {
  assert.ok(commands.length >= 8, commands.join("\n"));
});

test("the tool is copied with scp -rp, so its scripts keep their modes", () => {
  const copies = commands.filter((c) => /\bscp\b/.test(c) && c.includes("tools/slicing-gate"));
  assert.equal(copies.length, 1, copies.join("\n"));
  assert.match(copies[0], /^scp -rp /);
  assert.ok(!commands.some((c) => /\bscp -r /.test(c)), "no copy uses scp -r without -p");
});

test("every run.sh call goes through bash, so it works without the execute bit", () => {
  const calls = commands.filter((c) => c.includes("run.sh"));
  assert.ok(calls.length >= 2, calls.join("\n"));
  for (const c of calls) assert.match(c, /^bash \/tmp\/platehouse-gate\/tool\/run\.sh\b/, c);
});

// scp -r into a directory that already exists copies the folder inside it
// (tool/slicing-gate), so a re-run would start the old run.sh. The tool dir is
// removed before the copy, in the same ssh call that makes the sample dir.
test("an old copy of the tool is removed before the new one is copied", () => {
  const prep = commands.findIndex((c) => c.startsWith("ssh hades") && c.includes("rm -rf /tmp/platehouse-gate/tool"));
  const copy = commands.findIndex((c) => c.startsWith("scp -rp "));
  assert.ok(prep !== -1, "an ssh step removes /tmp/platehouse-gate/tool");
  assert.ok(prep < copy, "and it runs before the copy");
});
