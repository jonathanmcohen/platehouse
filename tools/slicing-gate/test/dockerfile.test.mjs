// Pins how the gate image's Dockerfile references the BuildKit frontend.
import assert from "node:assert/strict";
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
