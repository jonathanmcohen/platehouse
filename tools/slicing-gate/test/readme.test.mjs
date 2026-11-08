// Pins the README's run steps against what went wrong on the first Hades run
// (2026-11-08): scp -r over Tailscale SSH dropped the scripts' execute bits,
// so step 3's /tmp/platehouse-gate/tool/run.sh failed with exit 126.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
  // Step 3's detached form wraps the same call in setsid nohup bash -c '...',
  // after removing the previous run's exit file.
  for (const c of calls) {
    assert.match(c, /^(setsid nohup bash -c 'rm -f \/tmp\/platehouse-gate\/run\.exit; )?bash \/tmp\/platehouse-gate\/tool\/run\.sh\b/, c);
  }
});

// scp -r into a directory that already exists copies the folder inside it
// (tool/slicing-gate), so a re-run would start the old run.sh. The tool dir is
// removed before the copy, in the same ssh call that makes the sample dir.
test("an old copy of the tool is removed before the new one is copied", () => {
  const prep = commands.findIndex((c) => c.startsWith("ssh Hades") && c.includes("rm -rf /tmp/platehouse-gate/tool"));
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
  assert.match(c, /\| ssh Hades 'tar -xf - -C \/tmp\/platehouse-gate\/in\/sample'$/);
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
      .replace("ssh Hades '", "bash -c '")
      .replace("/tmp/platehouse-gate/in/sample", dest);
    const r = spawnSync("bash", ["-c", line], { cwd: src, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    for (const [i, n] of names.entries()) assert.equal(readFileSync(join(dest, n), "utf8"), `crafted ${i}\n`, n);
    assert.equal(existsSync(join(dest, "not selected.3mf")), false);
    const all = readdirSync(dest, { recursive: true });
    assert.ok(!all.some((f) => f.split("/").pop().startsWith("._")), `no AppleDouble files: ${all.join(", ")}`);
    // With an extended attribute on a file, plain bsdtar writes it as a
    // LIBARCHIVE.xattr pax header, which GNU tar on Hades warns about; the
    // step's flags keep it out. The create half of the line, run alone:
    spawnSync("xattr", ["-w", "com.platehouse.test", "1", join(src, names[0])]);
    const create = line.slice(0, line.indexOf(" | "));
    const stream = spawnSync("bash", ["-c", create], { cwd: src, maxBuffer: 1 << 24 });
    assert.equal(stream.status, 0, String(stream.stderr));
    const bytes = stream.stdout.toString("latin1");
    assert.ok(bytes.includes("crafted 0"), "the stream carries the files");
    assert.ok(!bytes.includes("LIBARCHIVE.xattr") && !bytes.includes("._"), "no extended attributes or AppleDouble entries");
  },
);

// Hades run 2 (2026-11-08): the ssh alias on mini01 is Hades, and OpenSSH
// matches Host patterns case-sensitively, so "ssh hades" missed the alias and
// failed with "Host key verification failed" until the operator typed Hades.
// Every ssh and scp target in any README command must be the alias exactly.
const allCommands = [...readme.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((m) =>
  m[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#")),
);

test("every ssh and scp in the README targets the alias Hades, spelled exactly", () => {
  const ssh = allCommands.flatMap((c) => [...c.matchAll(/\bssh\s+([^\s']+)/g)].map((m) => m[1]));
  const scp = allCommands
    .filter((c) => /\bscp\b/.test(c))
    .flatMap((c) => [...c.matchAll(/(?:^|\s)([A-Za-z][\w.-]*):\//g)].map((m) => m[1]));
  assert.ok(ssh.length >= 2 && scp.length >= 2, `found ssh ${ssh.join(",")} scp ${scp.join(",")}`);
  for (const host of [...ssh, ...scp]) assert.equal(host, "Hades", `host alias in a README command: ${host}`);
  assert.doesNotMatch(readme, /\b(ssh|scp)\b[^\n`]*\bhades\b/, "no lower-case hades in an ssh or scp line");
  assert.doesNotMatch(readme, /\bhades:/, "no lower-case hades: scp target");
});

// Run 2's operator started run.sh detached by hand, so a dropped ssh session
// could not kill a run of several hours. Step 3 says how, with the log and the
// exit code written inside the scratch dir, where step 5 deletes them.
const step3 = runSteps.slice(runSteps.indexOf("\n3. "), runSteps.indexOf("\n4. "));
const detached = () =>
  [...step3.matchAll(/```sh\n([\s\S]*?)```/g)]
    .flatMap((m) => m[1].split("\n"))
    .map((l) => l.trim())
    .find((l) => l.startsWith("setsid "));

test("step 3 starts the run detached, with its log and exit code in the scratch dir", () => {
  const line = detached();
  assert.ok(line, "step 3 has a setsid line");
  // A run.exit left by an earlier run would read as this run having finished.
  assert.match(line, /^setsid nohup bash -c 'rm -f \/tmp\/platehouse-gate\/run\.exit; bash /);
  assert.match(line, /bash \/tmp\/platehouse-gate\/tool\/run\.sh > \/tmp\/platehouse-gate\/run\.log 2>&1/);
  assert.match(line, /echo \$\? > \/tmp\/platehouse-gate\/run\.exit/);
  assert.match(line, /< \/dev\/null > \/dev\/null 2>&1 &$/, "detached from the terminal and backgrounded");
  assert.match(step3, /dropped ssh session/i);
});

// The tail is pasted straight after the backgrounded setsid line, so on a first
// run it usually starts before the background job has created run.log. GNU
// tail -f then prints "No such file or directory" and exits 1; tail -F follows
// the name and waits for the file to appear.
const step3Commands = () =>
  [...step3.matchAll(/```sh\n([\s\S]*?)```/g)]
    .flatMap((m) => m[1].split("\n"))
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

test("step 3 follows run.log with tail -F, which waits for a log that is not there yet", () => {
  const tails = step3Commands().filter((l) => /^tail\b/.test(l));
  assert.deepEqual(tails, ["tail -F /tmp/platehouse-gate/run.log"]);
  assert.doesNotMatch(step3, /tail -f\b/, "no tail -f in step 3's text");
});

test("step 3's tail, run as written before run.log exists, keeps waiting and then shows the log", async () => {
  const root = mkdtempSync(join(tmpdir(), "gate-tail-"));
  made.push(root);
  const line = step3Commands().find((l) => /^tail\b/.test(l)).replaceAll("/tmp/platehouse-gate", root);
  const child = spawn("bash", ["-c", `exec ${line}`], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  let exited = null;
  child.on("exit", (code) => (exited = code));
  try {
    await new Promise((res) => setTimeout(res, 500));
    assert.equal(exited, null, "tail exited while run.log did not exist yet");
    writeFileSync(join(root, "run.log"), "stub run line\n");
    for (let i = 0; i < 100 && !out.includes("stub run line"); i++) await new Promise((res) => setTimeout(res, 50));
    assert.match(out, /stub run line/);
  } finally {
    child.kill();
  }
});

// Runs step 3's detached line as written, with run.sh replaced by a stub that
// prints a line and exits 3 and the scratch dir by a temporary one. setsid is
// util-linux, so this runs on Linux (CI and Hades), not on macOS.
test(
  "step 3's detached line, run as written, records the run's output and exit code",
  { skip: spawnSync("bash", ["-c", "command -v setsid"]).status !== 0 && "setsid is not installed (util-linux, Linux only)" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "gate-detach-"));
    made.push(root);
    mkdirSync(join(root, "tool"));
    // The stub reports whether the earlier run's exit file was gone when it started.
    writeFileSync(
      join(root, "tool", "run.sh"),
      'if [ -e "$(dirname "$0")/../run.exit" ]; then s=present; else s=absent; fi\nprintf \'stub run %s, old exit file %s\\n\' "$$" "$s"\nexit 3\n',
    );
    writeFileSync(join(root, "run.exit"), "0\n"); // left by an earlier run
    const line = detached().replaceAll("/tmp/platehouse-gate", root);
    const r = spawnSync("bash", ["-c", line], { encoding: "utf8", timeout: 10000 });
    assert.equal(r.status, 0, r.stderr);
    const exitFile = join(root, "run.exit");
    const done = () => existsSync(exitFile) && /^[1-9]\d*\n$/.test(readFileSync(exitFile, "utf8"));
    for (let i = 0; i < 100 && !done(); i++) await new Promise((res) => setTimeout(res, 50));
    assert.equal(readFileSync(exitFile, "utf8"), "3\n");
    assert.match(readFileSync(join(root, "run.log"), "utf8"), /^stub run \d+, old exit file absent\n$/);
  },
);
