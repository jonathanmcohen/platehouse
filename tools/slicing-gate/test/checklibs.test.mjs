// Drives check-libs.sh, the image's build-time shared-library check, with a
// stub ldd on PATH, and pins what the Dockerfile runs it on.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = join(HERE, "check-libs.sh");
const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

// The stub prints STUB_LDD_OUT, logs LD_LIBRARY_PATH, and exits STUB_LDD_RC.
const LDD = `#!/usr/bin/env bash
printf '%s\\n' "\${LD_LIBRARY_PATH:-<unset>}" > "$STUB_LOG"
printf '%b' "\${STUB_LDD_OUT:-}"
exit "\${STUB_LDD_RC:-0}"
`;

function check(args, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "gate-ldd-"));
  made.push(dir);
  writeFileSync(join(dir, "ldd"), LDD);
  chmodSync(join(dir, "ldd"), 0o755);
  const bin = join(dir, "prog");
  writeFileSync(bin, "x");
  const log = join(dir, "log.txt");
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, STUB_LOG: log, ...extra };
  delete env.LD_LIBRARY_PATH;
  const r = spawnSync("bash", [CHECK, ...args.map((a) => (a === "@bin" ? bin : a))], { encoding: "utf8", env });
  let libPath = null;
  try {
    libPath = readFileSync(log, "utf8").trim();
  } catch {}
  return { ...r, libPath };
}

test("check-libs passes a binary whose libraries all resolve, with the given library path", () => {
  const r = check(["@bin", "/opt/orca/lib/orca-runtime:/opt/orca/bin"], {
    STUB_LDD_OUT: "\\tlibc.so.6 => /lib/libc.so.6 (0x1)\\n",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.libPath, "/opt/orca/lib/orca-runtime:/opt/orca/bin");
});

test("check-libs fails when ldd reports a missing library", () => {
  const r = check(["@bin"], { STUB_LDD_OUT: "\\tlibwebkit2gtk-4.1.so.0 => not found\\n" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /libwebkit2gtk-4\.1\.so\.0 => not found/);
  assert.equal(r.libPath, "<unset>");
});

test("check-libs fails when ldd itself fails, so a script or a non-ELF cannot pass unchecked", () => {
  const r = check(["@bin"], { STUB_LDD_OUT: "\\tnot a dynamic executable\\n", STUB_LDD_RC: "1" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ldd .* exited 1/);
  assert.match(r.stderr, /not a dynamic executable/);
});

test("check-libs fails on a binary that does not exist", () => {
  const r = check(["/nonexistent/orca-slicer"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /does not exist/);
});

test("the Dockerfile checks Orca's real binary with the launcher's library path, not the AppRun script", () => {
  const dockerfile = readFileSync(join(HERE, "Dockerfile"), "utf8");
  assert.match(
    dockerfile,
    /check-libs\.sh \/opt\/orca\/bin\/orca-slicer \/opt\/orca\/lib\/orca-runtime:\/opt\/orca\/bin\b/,
  );
  assert.match(dockerfile, /check-libs\.sh \/opt\/openscad\/usr\/bin\/openscad\b/);
  assert.doesNotMatch(dockerfile, /ldd \/opt\/orca\/AppRun/);
});
