// The draft Release's body (.github/workflows/release-notes.yml, issue #496).
//
// The functions here are pure: they turn a tag, CHANGELOG.md and the two
// images' facts into the values of .github/release-notes-template.md, and fill
// it in. The sections only the maintainer can write get a TODO comment; a
// version with no CHANGELOG section still gets a body, with warnings.
//
// Command line, used by the workflow (exit 0 done, 1 refused, 2 usage):
//   node release-notes.mjs is-release-tag <tag>   prints true or false
//   node release-notes.mjs previous <tag>         tag names on stdin, one per line;
//                                                 prints the previous release, or nothing
//   node release-notes.mjs body <template> <changelog> <app-image.json> <slicer-image.json>
//                                                 the image files hold the output of
//                                                 docker buildx imagetools inspect <ref>
//                                                 --format '{{json .Image}}'. Reads TAG,
//                                                 PREVIOUS (may be empty), REPO_URL,
//                                                 APP_DIGEST, SLICER_DIGEST and APP_LATEST
//                                                 (true or false) from the env; prints the
//                                                 body, and each warning to stderr as
//                                                 ::warning::. Refuses a slicer image with
//                                                 no ORCA_VERSION in its env.
// A refusal is one ::error:: line on stderr. Workflow-command text is encoded
// (% CR LF), and a refused value is quoted as JSON, so neither can start a
// line, or a command, of its own in the run's log.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { compareTags, parseTag } from "./rc-target.mjs";

export const TODO_COMMENT = "<!-- TODO: write this section, or delete it, before publishing -->";

const APP_IMAGE = "ghcr.io/jonathanmcohen/platehouse";
const SLICER_IMAGE = "ghcr.io/jonathanmcohen/platehouse-slicer";
const DIGEST = /^sha256:[0-9a-f]{64}$/;
// What the registry may name in the Images table: a platform's os and
// architecture, and the OrcaSlicer version. Nothing that could split a row.
const PLATFORM_PART = /^[a-z0-9_.-]+$/;
const ORCA_VERSION = /^[0-9A-Za-z.+-]+$/;

/** A message as workflow-command text: %, CR and LF encoded. @param {string} s @returns {string} */
const commandText = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

/** @param {unknown} tag @returns {boolean} true only for a plain vX.Y.Z, never an rc */
export function isReleaseTag(tag) {
  const p = parseTag(tag);
  return p !== null && p.rc === null;
}

/**
 * The highest release tag below tag, or null. Other tags are ignored, so a
 * backport's previous release is the one below it, not the highest.
 * @param {string} tag @param {string[]} tags @returns {string | null}
 */
export function previousRelease(tag, tags) {
  if (!isReleaseTag(tag)) throw new Error(`not a vX.Y.Z release tag: ${JSON.stringify(tag)}`);
  let best = null;
  for (const t of tags) {
    if (!isReleaseTag(t) || compareTags(t, tag) >= 0) continue;
    if (best === null || compareTags(t, best) > 0) best = t;
  }
  return best;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The CHANGELOG section of version, its heading line included, up to the next
 * "## " line; null when there is none.
 * @param {string} text @param {string} version @returns {string | null}
 */
export function changelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\]`);
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start, end < 0 ? lines.length : end).join("\n");
}

/**
 * The list under a "**Before you upgrade**" line, up to the next "### " line;
 * null when there is none or it is empty.
 * @param {string} section @returns {string | null}
 */
export function beforeYouUpgrade(section) {
  const lines = section.split(/\r?\n/);
  const start = lines.indexOf("**Before you upgrade**");
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("### "));
  const list = (end < 0 ? rest : rest.slice(0, end))
    .map((l) => l.trimEnd())
    .join("\n")
    .trim();
  return list === "" ? null : list;
}

/** The anchor GitHub gives a Markdown heading. @param {string} heading @returns {string} */
export function githubAnchor(heading) {
  return heading
    .replace(/^[# ]+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .replace(/ /g, "-");
}

const envOf = (config) => {
  const list = config?.config?.Env;
  if (!Array.isArray(list)) return {};
  return Object.fromEntries(
    list
      .filter((e) => typeof e === "string" && e.indexOf("=") > 0)
      .map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]),
  );
};

/**
 * The platforms and env of an image, from one config object (a single image)
 * or a map from platform to config (a manifest list). Variants and unknown
 * (attestation) entries are dropped; env is the first platform's.
 * @param {string} imageJson
 * @returns {{ platforms: string[]; env: Record<string, string> }}
 */
export function imageFacts(imageJson) {
  let data;
  try {
    data = JSON.parse(imageJson);
  } catch (err) {
    throw new Error(
      `cannot read the image JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("cannot read the image JSON: it is not an object");
  }
  const entries =
    typeof data.os === "string" && typeof data.architecture === "string"
      ? [[`${data.os}/${data.architecture}`, data]]
      : Object.entries(data).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const configs = new Map();
  for (const [key, config] of entries) {
    const [os, arch] = key.split("/");
    if (!os || !arch || os === "unknown" || arch === "unknown") continue;
    if (!PLATFORM_PART.test(os) || !PLATFORM_PART.test(arch)) {
      throw new Error(
        `the image JSON names a platform that is not a plain os/architecture: ${JSON.stringify(key)}`,
      );
    }
    const platform = `${os}/${arch}`;
    if (!configs.has(platform)) configs.set(platform, config);
  }
  if (configs.size === 0) throw new Error("the image JSON names no platform");
  const platforms = [...configs.keys()].sort();
  return { platforms, env: envOf(configs.get(platforms[0])) };
}

/**
 * The Images section's table: a header, a rule, the app row and the slicer row.
 * @param {{ version: string; app: { digest: string; platforms: string[]; latest: boolean }; slicer: { digest: string; platforms: string[]; orcaVersion: string } }} f
 * @returns {string}
 */
export function imagesTable({ version, app, slicer }) {
  for (const [name, digest] of [
    ["app", app.digest],
    ["slicer", slicer.digest],
  ]) {
    if (typeof digest !== "string" || !DIGEST.test(digest)) {
      throw new Error(
        `the ${name} image's digest is not sha256: and 64 hex characters: ${JSON.stringify(digest)}`,
      );
    }
  }
  if (typeof slicer.orcaVersion !== "string" || slicer.orcaVersion.trim() === "") {
    throw new Error("the slicer image has no OrcaSlicer version (ORCA_VERSION)");
  }
  if (!ORCA_VERSION.test(slicer.orcaVersion)) {
    throw new Error(
      `the slicer image's OrcaSlicer version (ORCA_VERSION) is not a plain version: ${JSON.stringify(slicer.orcaVersion)}`,
    );
  }
  const appTags = app.latest === true ? `\`${version}\`, \`latest\`` : `\`${version}\``;
  return [
    "| Image | Tags | Platforms | Digest |",
    "| --- | --- | --- | --- |",
    `| \`${APP_IMAGE}\` | ${appTags} | ${app.platforms.join(", ")} | \`${app.digest}\` |`,
    `| \`${SLICER_IMAGE}\` | \`${version}\` | ${slicer.platforms.join(", ")} (OrcaSlicer ${slicer.orcaVersion}) | \`${slicer.digest}\` |`,
  ].join("\n");
}

/**
 * The template's values for a release, and the warnings to show the run.
 * @param {{ tag: string; previous: string | null; repoUrl: string; changelog: string; app: { digest: string; platforms: string[]; latest: boolean }; slicer: { digest: string; platforms: string[]; orcaVersion: string } }} i
 * @returns {{ values: Record<string, string>; warnings: string[] }}
 */
export function releaseValues({ tag, previous, repoUrl, changelog, app, slicer }) {
  if (!isReleaseTag(tag)) throw new Error(`not a vX.Y.Z release tag: ${JSON.stringify(tag)}`);
  if (previous !== null && !isReleaseTag(previous))
    throw new Error(`the previous release is not a vX.Y.Z tag: ${JSON.stringify(previous)}`);
  const version = tag.slice(1);
  const warnings = [];
  const blob = `${repoUrl}/blob/${tag}/CHANGELOG.md`;
  let changelogUrl = blob;
  let list = null;
  const section = changelogSection(changelog, version);
  if (section === null) {
    warnings.push(
      `CHANGELOG.md at ${tag} has no section for ${version}: the changelog link has no anchor, and Before you upgrade is a TODO comment.`,
    );
  } else {
    const heading = section.split("\n")[0];
    changelogUrl = `${blob}#${githubAnchor(heading)}`;
    if (/unreleased/i.test(heading)) {
      warnings.push(`CHANGELOG.md at ${tag} still heads ${version} unreleased: ${heading}`);
    }
    list = beforeYouUpgrade(section);
  }
  return {
    values: {
      version,
      tag,
      before_you_upgrade:
        list ??
        `<!-- TODO: CHANGELOG.md has no Before you upgrade list for ${version}; write this section, or delete it, before publishing -->`,
      images_table: imagesTable({ version, app, slicer }),
      changelog_url: changelogUrl,
      compare_url:
        previous === null ? `${repoUrl}/commits/${tag}` : `${repoUrl}/compare/${previous}...${tag}`,
      todo: TODO_COMMENT,
    },
    warnings,
  };
}

/**
 * Fills in each {{name}} in one pass, so a value holding {{ is never read
 * again. Throws naming a placeholder with no value, or a value no placeholder
 * uses.
 * @param {string} template @param {Record<string, string>} values @returns {string}
 */
export function render(template, values) {
  const used = new Set();
  const missing = new Set();
  const out = template.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (whole, name) => {
    if (!Object.hasOwn(values, name)) {
      missing.add(name);
      return whole;
    }
    used.add(name);
    return values[name];
  });
  if (missing.size > 0)
    throw new Error(`the template's placeholders have no value: ${[...missing].join(", ")}`);
  const unused = Object.keys(values).filter((k) => !used.has(k));
  if (unused.length > 0)
    throw new Error(`no placeholder in the template uses: ${unused.join(", ")}`);
  return out;
}

const USAGE =
  "usage: release-notes.mjs is-release-tag <tag> | previous <tag> | body <template> <changelog> <app-image.json> <slicer-image.json>";

function requiredEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

function body([templatePath, changelogPath, appPath, slicerPath]) {
  const tag = requiredEnv("TAG");
  const latest = requiredEnv("APP_LATEST");
  if (latest !== "true" && latest !== "false")
    throw new Error(`APP_LATEST is not true or false: ${JSON.stringify(latest)}`);
  const app = imageFacts(readFileSync(appPath, "utf8"));
  const slicer = imageFacts(readFileSync(slicerPath, "utf8"));
  const orcaVersion = slicer.env.ORCA_VERSION;
  if (!orcaVersion) throw new Error(`the slicer image's env has no ORCA_VERSION (${slicerPath})`);
  const { values, warnings } = releaseValues({
    tag,
    previous: process.env.PREVIOUS || null,
    repoUrl: requiredEnv("REPO_URL"),
    changelog: readFileSync(changelogPath, "utf8"),
    app: { digest: requiredEnv("APP_DIGEST"), platforms: app.platforms, latest: latest === "true" },
    slicer: { digest: requiredEnv("SLICER_DIGEST"), platforms: slicer.platforms, orcaVersion },
  });
  const out = render(readFileSync(templatePath, "utf8"), values);
  for (const w of warnings) process.stderr.write(`::warning::${commandText(w)}\n`);
  process.stdout.write(out);
}

function main(argv) {
  const [mode, ...args] = argv;
  if (mode === "is-release-tag" && args.length === 1) {
    process.stdout.write(`${isReleaseTag(args[0])}\n`);
    return 0;
  }
  if (mode === "previous" && args.length === 1) {
    const tags = readFileSync(0, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const previous = previousRelease(args[0], tags);
    if (previous !== null) process.stdout.write(`${previous}\n`);
    return 0;
  }
  if (mode === "body" && args.length === 4) {
    body(args);
    return 0;
  }
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

// exitCode, not exit(): exit() can cut off what is still queued for a pipe.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(
      `::error::${commandText(err instanceof Error ? err.message : String(err))}\n`,
    );
    process.exitCode = 1;
  }
}
