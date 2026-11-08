// Pins the README's run steps against what went wrong on the first Hades run
// (2026-11-08): scp -r over Tailscale SSH dropped the scripts' execute bits,
// so step 3's /tmp/platehouse-gate/tool/run.sh failed with exit 126.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
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

// select-sample.mjs scans subfolders, so a name in the names file can hold a
// path (sub/x.3mf), and gate.mjs looks for each file at sample/<name>. Step 2
// must keep that relative path, and nothing may say the names are top-level.
const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const sampleCopy = () => commands.find((c) => c.includes("-T /tmp/platehouse-names.txt"));

test("the sample is copied by name list in one tar stream that keeps relative paths", () => {
  const c = sampleCopy();
  assert.ok(c, "a step reads /tmp/platehouse-names.txt");
  assert.match(c, /\| ssh hades 'tar -xf - -C \/tmp\/platehouse-gate\/in\/sample'$/);
  assert.ok(!commands.some((x) => /while .*read .*scp/.test(x)), "no per-file scp loop");
  assert.doesNotMatch(readme, /top-level file names/);
  const select = readFileSync(join(HERE, "select-sample.mjs"), "utf8");
  assert.doesNotMatch(select, /rsync/, "select-sample's help names the copy README step 2 really uses");
  assert.match(select, /--names .*may hold a subfolder path/s);
});

// Runs README step 2's sample copy as written, with the ssh hop replaced by a
// local bash and the Hades folder by a scratch one. bsdtar's flags in that
// line are macOS ones, and step 2 runs on mini01, so this runs on macOS only.
test(
  "README step 2's sample copy, run as written, lands each name at sample/<name>",
  { skip: process.platform !== "darwin" && "step 2 runs on mini01, and its tar flags are bsdtar's (macOS)" },
  () => {
    const root = mkdtempSync(join(tmpdir(), "gate-copy-"));
    made.push(root);
    const src = join(root, "3D Prints");
    const dest = join(root, "sample");
    mkdirSync(join(src, "Sub Folder"), { recursive: true });
    mkdirSync(dest);
    const names = ["Air Dry - AMS.3mf", "Sub Folder/two words.3mf", "-leading dash.3mf"];
    for (const [i, n] of names.entries()) writeFileSync(join(src, n), `crafted ${i}\n`);
    writeFileSync(join(src, "not selected.3mf"), "x\n");
    const list = join(root, "names.txt");
    writeFileSync(list, `${names.join("\n")}\n`);
    const line = sampleCopy()
      .replaceAll("/tmp/platehouse-names.txt", list)
      .replace("ssh hades '", "bash -c '")
      .replace("/tmp/platehouse-gate/in/sample", dest);
    const r = spawnSync("bash", ["-c", line], { cwd: src, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    for (const [i, n] of names.entries()) assert.equal(readFileSync(join(dest, n), "utf8"), `crafted ${i}\n`, n);
    assert.equal(existsSync(join(dest, "not selected.3mf")), false);
    const all = readdirSync(dest, { recursive: true });
    assert.ok(!all.some((f) => f.split("/").pop().startsWith("._")), `no AppleDouble files: ${all.join(", ")}`);
  },
);
