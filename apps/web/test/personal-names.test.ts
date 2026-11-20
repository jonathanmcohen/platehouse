// Two guards against naming Jon's own machines and home network.
//
// 1. The shipped web app and server (PR #230). Platehouse is published as
//    public images, so text a user sees, such as a placeholder or a help line,
//    must be generic. Every non-comment line of apps/web/src,
//    apps/web/index.html, apps/server/src, packages/i18n/src and the
//    translation catalogs in packages/i18n/locales is checked. Comment lines
//    are left out here: guard 2 covers them.
// 2. The whole tracked tree (git ls-files), comments, docs, CI, fixtures and
//    file paths included, because the 0.1.0 tree becomes the public
//    repository. It looks for his hosts, addresses, domains and paths. A line
//    is also checked with its backslashes removed, so a regex-escaped name
//    (a dot written as backslash-dot) is still found. ALLOWED lists what must
//    stay, each with its reason.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

// Every name below is joined from parts, so this file does not name them
// itself and a search of the tree finds the code it guards only.
const j = (...parts: string[]) => parts.join("");
const MINI = j("mini", "01");
const SERVER = j("Ha", "des");
const DOMAIN = j("jon", "co.dev");

// --- 1. Shipped text ---------------------------------------------------------

const NAMES = [
  j("mini", "0[0-9]"),
  j("m", "ba"),
  j("Ha", "des"),
  j("jon", "co\\.dev"),
  j("Claude", " Code"),
];
const PERSONAL = new RegExp(`\\b(?:${NAMES.join("|")})\\b`, "i");

/** A line that is only a comment: //, a block comment's lines, or a JSX comment. */
const COMMENT = /^\s*(?:\/\/|\/\*|\*|\{\s*\/\*)/;

/** Each non-comment line that names a machine or the home network, as "file:line: text". */
function personalLines(file: string, source: string): string[] {
  return source
    .split("\n")
    .flatMap((line, i) =>
      !COMMENT.test(line) && PERSONAL.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [],
    );
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(name)) files.push(path);
  }
  return files;
}

describe("no machine or home-network name in shipped text", () => {
  test("the check finds each name, and skips comments", () => {
    const sample = [
      `placeholder="Script on ${MINI}"`,
      `label: 'from the ${j("m", "ba")}'`,
      `const host = '${SERVER.toLowerCase()}';`,
      `const issuer = "https://id.local.${DOMAIN}";`,
      `<p>Each client, such as ${j("Claude", " Code")}, gets a token.</p>`,
      `// a comment that names ${MINI}`,
      ` * a block comment that names ${SERVER}`,
      `{/* a JSX comment that names ${j("m", "ba")} */}`,
      `const fine = "an ambassador, minimal, ${j("sha", "des")}";`,
    ].join("\n");
    expect(personalLines("sample", sample)).toEqual([
      `sample:1: placeholder="Script on ${MINI}"`,
      `sample:2: label: 'from the ${j("m", "ba")}'`,
      `sample:3: const host = '${SERVER.toLowerCase()}';`,
      `sample:4: const issuer = "https://id.local.${DOMAIN}";`,
      `sample:5: <p>Each client, such as ${j("Claude", " Code")}, gets a token.</p>`,
    ]);
  });

  test("apps/web, apps/server and the translation catalogs name none", () => {
    const web = fileURLToPath(new URL("../src", import.meta.url));
    const server = fileURLToPath(new URL("../../server/src", import.meta.url));
    // Since the translations (PR #287) the text a user sees lives in the
    // catalogs, so they and the i18n package's code are shipped text too.
    const i18n = fileURLToPath(new URL("../../../packages/i18n/src", import.meta.url));
    const locales = fileURLToPath(new URL("../../../packages/i18n/locales", import.meta.url));
    const files = [
      ...sourceFiles(web),
      ...sourceFiles(server),
      ...sourceFiles(i18n),
      ...readdirSync(locales)
        .filter((name) => name.endsWith(".json"))
        .map((name) => join(locales, name)),
      fileURLToPath(new URL("../index.html", import.meta.url)),
    ];
    // Every tree was read: a file from each is in the list.
    expect(files.some((f) => f.endsWith(join("settings", "Tokens.tsx")))).toBe(true);
    expect(files.some((f) => f.endsWith(join("server", "src", "config.ts")))).toBe(true);
    expect(files.some((f) => f.endsWith(join("i18n", "src", "translator.ts")))).toBe(true);
    expect(files.some((f) => f.endsWith(join("locales", "en.json")))).toBe(true);
    const found = files.flatMap((file) => personalLines(file, readFileSync(file, "utf8")));
    expect(found).toEqual([]);
  });
});

// --- 2. The whole tracked tree -----------------------------------------------

/** What the tree must not name, each as a case-insensitive pattern. */
const HOMELAB: { what: string; pattern: string }[] = [
  { what: "his workstations", pattern: j("\\bmini", "0[12]\\b") },
  { what: "his laptop", pattern: j("\\bm", "ba\\b") },
  { what: "his server", pattern: j("\\bha", "des\\b") },
  { what: "his domain", pattern: j("\\bjon", "co\\b") },
  { what: "his LAN", pattern: j("\\b10\\.1", "\\.50\\.") },
  { what: "his tailnet range", pattern: j("\\b100\\.", "64\\.") },
  { what: "his server's project root", pattern: j("/opt/", "projects\\b") },
  { what: "his DNS servers", pattern: j("\\bdns", "0[12]\\b") },
  { what: "his other hosts", pattern: j("\\b(?:lui", "gi|mar", "io)\\b") },
  { what: "his company", pattern: j("techser", "vicez") },
];
const HOMELAB_RE = new RegExp(HOMELAB.map((h) => `(?:${h.pattern})`).join("|"), "i");

/**
 * The only tracked files allowed to match, by exact path, each with a
 * one-line reason. Keep it empty unless a match genuinely must stay.
 */
const ALLOWED: Record<string, string> = {};

/** Each line of a file (or its path, as line 0) that names the homelab, as "file:line: text". */
function homelabLines(file: string, source: string): string[] {
  const hits = HOMELAB_RE.test(file) ? [`${file}:0: (the path)`] : [];
  source.split("\n").forEach((line, i) => {
    if (HOMELAB_RE.test(line) || HOMELAB_RE.test(line.replaceAll("\\", ""))) {
      hits.push(`${file}:${i + 1}: ${line.trim()}`);
    }
  });
  return hits;
}

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Every tracked file that is still on disk, as a path relative to the repository root. */
function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((f) => f !== "" && existsSync(join(ROOT, f)));
}

describe("no homelab name anywhere in the tracked tree", () => {
  test("the check finds each name, in a path or a regex, and leaves look-alikes alone", () => {
    const named = [
      `ssh ${MINI} uptime`,
      `copied from ${j("mini", "02")}`,
      `token for ${j("m", "ba")}`,
      `runs on ${SERVER}`,
      `https://id.local.${DOMAIN}`,
      `/(?:local|lan|${j("jon", "co\\.dev")})/`,
      `connect ${j("10.1", ".50.105")}:5432`,
      // Found only with the backslashes removed.
      `/${j("10\\.1", "\\.50\\.")}\\d+/`,
      `allow ${j("100.", "64.0.0/10")}`,
      `${j("/opt/", "projects")}/docker/appdata`,
      `resolver ${j("dns", "01")}`,
      `Pocket ID on ${j("Mar", "io")}`,
      `${j("lui", "gi")} backs up`,
      `mail ${j("techser", "vicez")}`,
    ];
    const lookAlikes = [
      `${j("sha", "des")}, minimal, ambassador, scenario, Marion,${j("dns", "010")}, 10.1.500.1, ${j("1100.", "64.1.1")}`,
      "192.0.2.10, 198.51.100.7, 10.0.0.5, platehouse.example.com, /opt/orca",
    ];
    expect(homelabLines("sample", [...named, ...lookAlikes].join("\n"))).toEqual(
      named.map((line, i) => `sample:${i + 1}: ${line}`),
    );
    expect(homelabLines(`deploy/${SERVER.toLowerCase()}/x.yml`, "")).toEqual([
      `deploy/${SERVER.toLowerCase()}/x.yml:0: (the path)`,
    ]);
  });

  test("no tracked file names one, outside ALLOWED", () => {
    const files = trackedFiles();
    // git ls-files read the whole tree: files from several parts of it are listed.
    for (const f of ["CHANGELOG.md", ".github/workflows/ci.yml", "tools/slicing-gate/README.md"]) {
      expect(files).toContain(f);
    }
    const found = files.flatMap((file) => {
      const bytes = readFileSync(join(ROOT, file));
      // A binary file (an image, a font) has a NUL byte; only its path is checked.
      const text = bytes.includes(0) ? "" : bytes.toString("utf8");
      const hits = homelabLines(file, text);
      return file in ALLOWED ? [] : hits;
    });
    expect(found).toEqual([]);
    // Every ALLOWED entry is still needed, so the list cannot go stale.
    for (const file of Object.keys(ALLOWED)) {
      expect(homelabLines(file, readFileSync(join(ROOT, file), "utf8")).length).toBeGreaterThan(0);
    }
  });
});
