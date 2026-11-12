// Pins the apt and setuid steps of the slicer image's Dockerfile. These checks
// live here, in the unit project, so they run on every pull request, a change
// to apps/slicer/Dockerfile alone included; in the slicing gate's suite they
// ran only when tools/slicing-gate changed (PR #154 review). The gate's own
// Dockerfile is checked the same way in tools/slicing-gate/test/dockerfile.test.mjs.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const DOCKERFILE = new URL("../Dockerfile", import.meta.url);

/** The Dockerfile's lines, each line continuation joined. */
const lines = (): string[] => readFileSync(DOCKERFILE, "utf8").replace(/\\\n/g, " ").split("\n");
/** Every RUN of the Dockerfile, its line continuations joined. */
const runs = (): string[] => lines().filter((l) => /^RUN\b/.test(l));

describe("apps/slicer/Dockerfile apt stages", () => {
  // Issue #148: snapshot.ubuntu.com answered GitHub's runners with 502 and
  // 503 errors for hours (PR #147), so every RUN that runs apt-get update
  // first writes /etc/apt/apt.conf.d/80retries with Acquire::Retries "10".
  // This pins it, so a new or reworked apt stage cannot drop it.
  test("every RUN that runs apt-get update writes 80retries first", () => {
    const aptRuns = runs().filter((r) => /\bapt-get update\b/.test(r));
    expect(aptRuns.length, "an apt stage before and after the build").toBeGreaterThanOrEqual(2);
    for (const run of aptRuns) {
      const retries = run.search(
        /'Acquire::Retries "10";'[^&]*> \/etc\/apt\/apt\.conf\.d\/80retries\b/,
      );
      const update = run.search(/\bapt-get update\b/);
      expect(retries, `no 80retries with Acquire::Retries "10" in: ${run.slice(0, 100)}`).not.toBe(
        -1,
      );
      expect(
        retries,
        `80retries is written after the first apt-get update in: ${run.slice(0, 100)}`,
      ).toBeLessThan(update);
    }
  });

  // Issue #150: apt-get update only warns on an index it could not fetch and
  // exits 0, so an outage that outlasts the retries failed the build a
  // command later with a misleading "Unable to locate package". The update
  // against the snapshot runs with --error-on=any, so it fails there, with
  // the server's error.
  test("every apt-get update after the snapshot is switched on runs with --error-on=any", () => {
    let checked = 0;
    for (const run of runs()) {
      const at = run.indexOf("APT::Snapshot");
      if (at === -1) continue;
      for (const m of run.slice(at).matchAll(/\bapt-get update\b[^&]*/g)) {
        expect(m[0]).toMatch(/\s--error-on=any\b/);
        checked++;
      }
    }
    expect(checked, "snapshot updates checked").toBeGreaterThanOrEqual(2);
  });
});

// Issue #153 item 5: Landlock's no-new-privileges covers a setuid helper
// inside OpenSCAD's sandbox, but Orca runs outside it, and an Ubuntu install
// script can leave a helper setuid when setcap is missing. The runtime stage
// strips every setuid and setgid bit, as root, after its last package and
// file is in place, and fails the build if any is left. The container test
// checks the built image has none; this pins where the step sits.
test("the runtime stage strips setuid and setgid bits and checks none is left", () => {
  const all = lines();
  const runtime = all.findLastIndex((l) => /^FROM\b/.test(l));
  const user = all.findIndex((l, i) => i > runtime && /^USER 10001$/.test(l));
  expect(runtime !== -1 && user > runtime, "the runtime stage switches to the slicer user").toBe(
    true,
  );
  const strip = all.findIndex(
    (l, i) =>
      i > runtime && /^RUN\b/.test(l) && l.includes("-perm /6000") && l.includes("chmod a-s"),
  );
  expect(strip !== -1 && strip < user, "a RUN before USER strips the bits").toBe(true);
  expect(all[strip]).toMatch(/find \/ -xdev -perm \/6000 -type f -exec chmod a-s/);
  expect(all[strip]).toMatch(/need -z "\$\(find \/ -xdev -perm \/6000 -type f\)"/);
  const lastRootChange = all.findLastIndex(
    (l, i) => i > runtime && i < user && i !== strip && /^(RUN|COPY|ADD)\b/.test(l),
  );
  expect(
    lastRootChange,
    `a step after the strip could add one back: ${all[lastRootChange]}`,
  ).toBeLessThan(strip);
});
