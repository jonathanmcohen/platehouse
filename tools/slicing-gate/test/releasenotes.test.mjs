// The draft Release's body (#496): release-notes.mjs turns a tag, CHANGELOG.md
// and the two images' facts into the filled-in release-notes template. The
// functions are pure; the command line is run as the workflow runs it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  beforeYouUpgrade,
  changelogSection,
  githubAnchor,
  imageFacts,
  imagesTable,
  isReleaseTag,
  previousRelease,
  releaseValues,
  render,
  TODO_COMMENT,
} from "../../../.github/scripts/release-notes.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHANGELOG_FILE = join(ROOT, "CHANGELOG.md");
const TEMPLATE_FILE = join(ROOT, ".github", "release-notes-template.md");
const SCRIPT = join(ROOT, ".github", "scripts", "release-notes.mjs");
const CHANGELOG = readFileSync(CHANGELOG_FILE, "utf8");
const TEMPLATE = readFileSync(TEMPLATE_FILE, "utf8");

const REPO_URL = "https://github.com/jonathanmcohen/platehouse";
const APP_DIGEST = "sha256:7b8547b2499404ed549119b04c8f9d4e065b632a41ef5ae915c57aafd5564ba5";
const SLICER_DIGEST = "sha256:7fcbbdb365bfab50ac88c14b74ad6b935423932314c28d8f49183afdef05ab6d";
// 0.1.1 as it was published.
const V011 = {
  version: "0.1.1",
  previous: "v0.1.0",
  repoUrl: REPO_URL,
  app: { digest: APP_DIGEST, platforms: ["linux/amd64", "linux/arm64"], latest: true },
  slicer: { digest: SLICER_DIGEST, platforms: ["linux/amd64"], orcaVersion: "2.5.2" },
};
const SECTIONS = ["Summary", "Security", "Before you upgrade", "What's new", "Images", "Known issues", "Full changelog"];

// ------------------------------------------------------------------ tags

test("isReleaseTag: a plain vX.Y.Z is a release tag", () => {
  assert.equal(isReleaseTag("v0.1.2"), true);
  assert.equal(isReleaseTag("v10.0.0"), true);
});

test("isReleaseTag: leading zeros, rc and test tags, short or long versions and non-strings are not", () => {
  for (const tag of ["v01.2.3", "v0.01.2", "v0.1.2-rc.1", "v0.0.0-test", "v1.2", "0.1.2", "v1.2.3.4", "", undefined]) {
    assert.equal(isReleaseTag(tag), false, String(tag));
  }
});

test("previousRelease: the first release has none, and its rc tags do not count", () => {
  assert.equal(previousRelease("v0.1.0", ["v0.1.0", "v0.1.0-rc.4"]), null);
});

test("previousRelease: the highest release below the tag, ignoring rc and test tags", () => {
  assert.equal(previousRelease("v0.1.2", ["v0.1.0", "v0.1.1", "v0.1.2-rc.1", "v0.1.2", "v0.0.0-test"]), "v0.1.1");
});

test("previousRelease: a backport's previous release is the one below it, not the highest", () => {
  assert.equal(previousRelease("v0.1.3", ["v0.2.0", "v0.1.2", "v0.1.3"]), "v0.1.2");
});

test("previousRelease: throws on an rc tag", () => {
  assert.throws(() => previousRelease("v0.1.2-rc.1", ["v0.1.1", "v0.1.2-rc.1"]), /v0\.1\.2-rc\.1/);
});

// ------------------------------------------------------------- changelog

test("githubAnchor: the anchor GitHub gives a CHANGELOG version heading", () => {
  assert.equal(githubAnchor("## [0.1.1] - 2026-11-24"), "011---2026-11-24");
  assert.equal(githubAnchor("## [0.1.2] - unreleased"), "012---unreleased");
});

test("changelogSection: the real 0.1.1 section, heading included, up to the next version", () => {
  const section = changelogSection(CHANGELOG, "0.1.1");
  assert.ok(section.startsWith("## [0.1.1] - 2026-11-24"), section.slice(0, 80));
  assert.ok(!section.includes("## [0.1.0]"));
});

test("changelogSection: null for a version with no section", () => {
  assert.equal(changelogSection(CHANGELOG, "9.9.9"), null);
});

test("changelogSection: 0.1.1 never matches 0.1.10", () => {
  assert.equal(changelogSection("# Changelog\n\n## [0.1.10] - x\n\n- a change\n", "0.1.1"), null);
});

test("beforeYouUpgrade: the real 0.1.1 list, all ten items", () => {
  const list = beforeYouUpgrade(changelogSection(CHANGELOG, "0.1.1"));
  assert.ok(list.startsWith("- Upgrade the app and slicer images together"), list.slice(0, 80));
  assert.ok(list.endsWith("for the monthly apt-snapshot pull request."), list.slice(-80));
  assert.equal(list.split("\n").filter((l) => l.startsWith("- ")).length, 10);
});

test("beforeYouUpgrade: null for 0.1.0, which has no list", () => {
  assert.equal(beforeYouUpgrade(changelogSection(CHANGELOG, "0.1.0")), null);
});

test("beforeYouUpgrade: null when the heading has nothing under it", () => {
  assert.equal(beforeYouUpgrade("## [0.1.9] - x\n\n**Before you upgrade**\n\n### Fixed\n\n- a fix\n"), null);
});

// ---------------------------------------------------------------- images

test("imageFacts: a single image's config gives its one platform and its env", () => {
  const facts = imageFacts(
    JSON.stringify({ os: "linux", architecture: "amd64", config: { Env: ["PATH=/usr/bin", "ORCA_VERSION=2.5.2"] } }),
  );
  assert.deepEqual(facts.platforms, ["linux/amd64"]);
  assert.equal(facts.env.ORCA_VERSION, "2.5.2");
});

test("imageFacts: a manifest list drops the variant and the attestation entry", () => {
  const config = (architecture, env) => ({ os: "linux", architecture, config: { Env: env } });
  const facts = imageFacts(
    JSON.stringify({
      "linux/arm64/v8": config("arm64", ["WHICH=arm64"]),
      "unknown/unknown": { os: "unknown", architecture: "unknown" },
      "linux/amd64": config("amd64", ["WHICH=amd64"]),
    }),
  );
  assert.deepEqual(facts.platforms, ["linux/amd64", "linux/arm64"]);
  assert.equal(facts.env.WHICH, "amd64");
});

test("imageFacts: throws on JSON it cannot read, or with no platform", () => {
  assert.throws(() => imageFacts("not json"));
  assert.throws(() => imageFacts(JSON.stringify({ "unknown/unknown": { os: "unknown", architecture: "unknown" } })));
});

// The platform strings and ORCA_VERSION come from the registry and land in the
// Images table: a | or a line break would split its rows and add headings.
test("imageFacts: refuses a platform whose os or architecture is not a plain name", () => {
  const config = (architecture) => ({ os: "linux", architecture, config: { Env: [] } });
  assert.throws(
    () => imageFacts(JSON.stringify({ "linux/amd64|x\n## injected": config("amd64") })),
    /"linux\/amd64\|x\\n## injected"/,
  );
  assert.throws(() => imageFacts(JSON.stringify({ "Linux/amd64": config("amd64") })), /"Linux\/amd64"/);
  assert.throws(() => imageFacts(JSON.stringify({ os: "linux", architecture: "amd 64", config: {} })), /"linux\/amd 64"/);
});

test("imagesTable: refuses an Orca version that is not a plain version, naming ORCA_VERSION", () => {
  assert.throws(
    () => imagesTable({ ...V011, slicer: { ...V011.slicer, orcaVersion: "2.5.2 | x\n## hi" } }),
    (err) => err.message.includes("ORCA_VERSION") && err.message.includes('"2.5.2 | x\\n## hi"'),
  );
  assert.ok(imagesTable({ ...V011, slicer: { ...V011.slicer, orcaVersion: "2.6.0-beta+1" } }).includes("OrcaSlicer 2.6.0-beta+1"));
});

test("imagesTable: 0.1.1's table, as the Images section shows it", () => {
  assert.equal(
    imagesTable(V011),
    [
      "| Image | Tags | Platforms | Digest |",
      "| --- | --- | --- | --- |",
      "| `ghcr.io/jonathanmcohen/platehouse` | `0.1.1`, `latest` | linux/amd64, linux/arm64 | `sha256:7b8547b2499404ed549119b04c8f9d4e065b632a41ef5ae915c57aafd5564ba5` |",
      "| `ghcr.io/jonathanmcohen/platehouse-slicer` | `0.1.1` | linux/amd64 (OrcaSlicer 2.5.2) | `sha256:7fcbbdb365bfab50ac88c14b74ad6b935423932314c28d8f49183afdef05ab6d` |",
    ].join("\n"),
  );
});

test("imagesTable: a release that is not latest lists only its version tag", () => {
  const appRow = imagesTable({ ...V011, app: { ...V011.app, latest: false } }).split("\n")[2];
  assert.equal(appRow.split(" | ")[1], "`0.1.1`");
});

test("imagesTable: throws on a short digest or an empty Orca version", () => {
  assert.throws(() => imagesTable({ ...V011, app: { ...V011.app, digest: "sha256:abc" } }), /sha256:abc/);
  assert.throws(() => imagesTable({ ...V011, slicer: { ...V011.slicer, orcaVersion: "" } }), /Orca/);
});

// ---------------------------------------------------------------- render

test("render: a placeholder with no value throws, naming it", () => {
  assert.throws(() => render("{{a}} {{b}}", { a: "1" }), /\bb\b/);
});

test("render: a value no placeholder uses throws, naming it", () => {
  assert.throws(() => render("{{a}}", { a: "1", c: "2" }), /\bc\b/);
});

test("render: a value holding {{ is never read again", () => {
  assert.equal(render("{{a}}", { a: "{{b}}" }), "{{b}}");
});

test("the real template with 0.1.1's values", () => {
  const { values, warnings } = releaseValues({ tag: "v0.1.1", changelog: CHANGELOG, ...V011 });
  const body = render(TEMPLATE, values);
  assert.ok(!body.includes("{{"), body);
  assert.deepEqual(
    body
      .split("\n")
      .filter((l) => l.startsWith("## "))
      .map((l) => l.slice(3)),
    SECTIONS,
  );
  assert.ok(body.includes(APP_DIGEST));
  assert.ok(body.includes(SLICER_DIGEST));
  assert.ok(body.includes("#011---2026-11-24"));
  assert.ok(body.includes("/compare/v0.1.0...v0.1.1"));
  assert.equal(body.split(TODO_COMMENT).length - 1, 4);
  assert.deepEqual(warnings, []);
});

test("releaseValues gives exactly the template's keys", () => {
  const { values } = releaseValues({ tag: "v0.1.1", changelog: CHANGELOG, ...V011 });
  assert.deepEqual(Object.keys(values).sort(), [
    "before_you_upgrade",
    "changelog_url",
    "compare_url",
    "images_table",
    "tag",
    "todo",
    "version",
  ]);
});

test("releaseValues: refuses a previous release that is not a vX.Y.Z tag", () => {
  assert.throws(
    () => releaseValues({ ...V011, tag: "v0.1.1", previous: "v0.1.0-rc.1", changelog: CHANGELOG }),
    /v0\.1\.0-rc\.1/,
  );
});

test("releaseValues: refuses a tag that is not a vX.Y.Z release tag", () => {
  for (const tag of ["v0.1.1-rc.1", "v0.0.0-test", "0.1.1", "v0.1.1$(touch pwned)"]) {
    assert.throws(() => releaseValues({ ...V011, tag, changelog: CHANGELOG }), /not a vX\.Y\.Z release tag/, tag);
  }
});

// A refused value is quoted as JSON, so a line break in it cannot start a
// line of its own in the run's log.
test("releaseValues: a refused value is quoted, its line breaks escaped", () => {
  assert.throws(
    () => releaseValues({ ...V011, tag: "v0.1.1\n::error::x", changelog: CHANGELOG }),
    (err) => err.message.includes('"v0.1.1\\n::error::x"') && !err.message.includes("\n"),
  );
});

test("a version with no CHANGELOG section still renders", () => {
  const { values, warnings } = releaseValues({ ...V011, tag: "v0.1.9", changelog: CHANGELOG });
  assert.ok(warnings.some((w) => w.includes("0.1.9")), warnings.join("\n"));
  assert.ok(values.changelog_url.endsWith("/blob/v0.1.9/CHANGELOG.md"), values.changelog_url);
  assert.ok(values.before_you_upgrade.includes("TODO"), values.before_you_upgrade);
  assert.ok(values.before_you_upgrade.includes("0.1.9"), values.before_you_upgrade);
  assert.ok(!render(TEMPLATE, values).includes("{{"));
  const first = releaseValues({ ...V011, tag: "v0.1.9", previous: null, changelog: CHANGELOG });
  assert.equal(first.values.compare_url, `${REPO_URL}/commits/v0.1.9`);
});

test("a CHANGELOG section still headed unreleased renders with its anchor, and warns", () => {
  const changelog = "# Changelog\n\n## [0.1.2] - unreleased\n\n### Fixed\n\n- a fix\n";
  const { values, warnings } = releaseValues({ ...V011, tag: "v0.1.2", changelog });
  assert.equal(values.changelog_url, `${REPO_URL}/blob/v0.1.2/CHANGELOG.md#012---unreleased`);
  assert.ok(warnings.some((w) => w.includes("0.1.2") && w.includes("unreleased")), warnings.join("\n"));
});

// ---------------------------------------------------------- command line

const cli = (args, { input = "", env = {} } = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    input,
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });

test("the command line", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-notes-"));
  try {
    const appJson = join(dir, "app.json");
    const slicerJson = join(dir, "slicer.json");
    const bareJson = join(dir, "bare.json");
    const config = (architecture, env) => ({ os: "linux", architecture, config: { Env: env } });
    writeFileSync(
      appJson,
      JSON.stringify({
        "linux/amd64": config("amd64", ["PATH=/usr/bin"]),
        "linux/arm64": config("arm64", ["PATH=/usr/bin"]),
        "unknown/unknown": { os: "unknown", architecture: "unknown" },
      }),
    );
    writeFileSync(slicerJson, JSON.stringify(config("amd64", ["PATH=/usr/bin", "ORCA_VERSION=2.5.2"])));
    writeFileSync(bareJson, JSON.stringify(config("amd64", ["PATH=/usr/bin"])));
    const env = {
      TAG: "v0.1.1",
      PREVIOUS: "v0.1.0",
      REPO_URL,
      APP_DIGEST,
      SLICER_DIGEST,
      APP_LATEST: "true",
    };

    const r = cli(["body", TEMPLATE_FILE, CHANGELOG_FILE, appJson, slicerJson], { env });
    assert.equal(r.status, 0, r.stderr);
    const { values } = releaseValues({ tag: "v0.1.1", changelog: CHANGELOG, ...V011 });
    assert.equal(r.stdout, render(TEMPLATE, values));
    assert.equal(r.stderr, "");

    const missing = cli(["body", TEMPLATE_FILE, CHANGELOG_FILE, appJson, bareJson], { env });
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /ORCA_VERSION/);
    assert.equal(missing.stdout, "");

    const unlisted = cli(["body", TEMPLATE_FILE, CHANGELOG_FILE, appJson, slicerJson], {
      env: { ...env, TAG: "v0.1.9", PREVIOUS: "" },
    });
    assert.equal(unlisted.status, 0, unlisted.stderr);
    assert.match(unlisted.stderr, /^::warning::.*0\.1\.9/m);
    assert.ok(unlisted.stdout.includes(`${REPO_URL}/commits/v0.1.9`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A body run with 0.1.1's images, in a scratch directory; over replaces env
// values, and changelog the CHANGELOG text.
function bodyRun(over = {}, changelog = CHANGELOG) {
  const dir = mkdtempSync(join(tmpdir(), "release-notes-"));
  try {
    const config = (architecture, env) => ({ os: "linux", architecture, config: { Env: env } });
    const appJson = join(dir, "app.json");
    const slicerJson = join(dir, "slicer.json");
    const changelogFile = join(dir, "CHANGELOG.md");
    writeFileSync(appJson, JSON.stringify({ "linux/amd64": config("amd64", []), "linux/arm64": config("arm64", []) }));
    writeFileSync(slicerJson, JSON.stringify(config("amd64", ["ORCA_VERSION=2.5.2"])));
    writeFileSync(changelogFile, changelog);
    return cli(["body", TEMPLATE_FILE, changelogFile, appJson, slicerJson], {
      env: { TAG: "v0.1.1", PREVIOUS: "v0.1.0", REPO_URL, APP_DIGEST, SLICER_DIGEST, APP_LATEST: "true", ...over },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the command line: APP_LATEST other than true or false is refused", () => {
  const r = bodyRun({ APP_LATEST: "yes" });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /APP_LATEST/);
  assert.equal(r.stdout, "");
});

test("the command line: APP_LATEST false lists only the version tag on the app row", () => {
  const r = bodyRun({ APP_LATEST: "false" });
  assert.equal(r.status, 0, r.stderr);
  const appRow = r.stdout.split("\n").find((l) => l.startsWith("| `ghcr.io/jonathanmcohen/platehouse` |"));
  assert.equal(appRow.split(" | ")[1], "`0.1.1`");
  assert.doesNotMatch(r.stdout, /`latest` \|/);
});

// The workflow-command format: %, CR and LF in the message are encoded, so a
// heading cannot end the warning and start a command of its own.
test("the command line: a warning's text is encoded for the workflow command", () => {
  const r = bodyRun({ TAG: "v0.1.2", PREVIOUS: "v0.1.1" }, "## [0.1.2] - unreleased 100%\r::error::x\n\n### Fixed\n\n- a fix\n");
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stderr.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, r.stderr);
  assert.match(lines[0], /^::warning::/);
  assert.ok(lines[0].includes("unreleased 100%25%0D::error::x"), lines[0]);
  assert.doesNotMatch(lines[0], /\r/);
});

test("the command line: a refusal is one ::error:: line, its value quoted", () => {
  const r = bodyRun({ TAG: "v0.1.1\n::error::x" });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, "");
  const lines = r.stderr.split("\n").filter(Boolean);
  assert.equal(lines.length, 1, r.stderr);
  assert.match(lines[0], /^::error::.*"v0\.1\.1\\n::error::x"/);
});

test("the command line: is-release-tag and previous", () => {
  assert.equal(cli(["is-release-tag", "v0.1.2"]).stdout, "true\n");
  assert.equal(cli(["is-release-tag", "v0.1.2$(touch pwned)"]).stdout, "false\n");
  assert.equal(cli(["previous", "v0.1.2"], { input: "v0.1.1\nv0.1.2\n" }).stdout, "v0.1.1\n");
  assert.equal(cli(["previous", "v0.1.0"], { input: "v0.1.0\n" }).stdout, "");
});

test("the command line: a usage error exits 2, a refused tag 1", () => {
  assert.equal(cli([]).status, 2);
  assert.equal(cli(["other"]).status, 2);
  assert.equal(cli(["previous", "v0.1.2-rc.1"], { input: "v0.1.1\n" }).status, 1);
});
