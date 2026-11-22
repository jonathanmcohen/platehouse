// Keeps citations of private documents and projects out of the tracked tree
// (issue #325). Platehouse was built from a private plan and a private
// list of requirements, and ported parts of earlier private projects. A
// public reader can open none of them, so a plan task number, a requirement
// id or a private repository's name leads nowhere. Code, tests and docs say
// the rule itself, in plain words, instead.
//
// What counts as a reference (REFERENCES below):
// - a plan task: the word Task or Tasks followed by a number;
// - the words build and plan side by side;
// - a requirement id: AC, a hyphen and three digits;
// - two section names of that plan (see the pattern);
// - the earlier private parser project by name, or its Ruby source files;
// - any repository of the owner other than platehouse and platehouse-slicer,
//   and the private projects named in issues #325 and #329.
// A comment wrapped across two lines (the first word at the end of one line,
// the second at the start of the next) still counts: the comment marker
// between the words is skipped.
//
// The patterns are written so they do not match their own text, and the
// samples in the self-test are put together at run time, so this file holds
// no reference and needs no allow-list entry.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/** A comment marker (and the space around it) that may sit between two words of a wrapped comment. */
const WRAP = String.raw`\s*(?:\/\/|#|--|\*)?\s*`;

interface Reference {
  /** What the pattern finds, for the failure message. */
  what: string;
  pattern: RegExp;
}

const REFERENCES: Reference[] = [
  { what: "a plan task", pattern: new RegExp(String.raw`\bTasks?${WRAP}\d+`, "g") },
  { what: "the words build and plan", pattern: new RegExp(String.raw`\bbuild${WRAP}plan\b`, "gi") },
  { what: "a requirement id", pattern: /\bAC-\d{3}\b/g },
  { what: "a plan section", pattern: /\b(?:Review[ ]Focus|Global[ ]Constraints)\b/g },
  {
    what: "the earlier private parser project",
    pattern: new RegExp(String.raw`\bBambu${WRAP}Plates\b|\bparser(?:_test)?\.rb\b`, "gi"),
  },
  {
    what: "a private repository",
    pattern: new RegExp(
      [
        String.raw`\bjonathanmcohen\/(?!platehouse(?:-slicer)?\b)[A-Za-z0-9._-]+`,
        String.raw`\bmanyfold-(?:studio|bambu)`,
        String.raw`\bmakerworld-meta(?:data)\b`,
        String.raw`\bautomation\s+Manyfold\/`,
        // The private automation repository cited by a commit after its
        // name (issue #329).
        String.raw`\bautomation\s+[0-9a-f]{7,40}\b`,
      ].join("|"),
      "gi",
    ),
  },
];

/** Every reference in a text, as "file:line: [what] text". */
function referencesIn(file: string, text: string, lastLine = Number.POSITIVE_INFINITY): string[] {
  const hits: string[] = [];
  for (const { what, pattern } of REFERENCES) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      const line = text.slice(0, m.index).split("\n").length;
      if (line > lastLine) continue;
      const shown = text.split("\n")[line - 1]?.trim() ?? "";
      hits.push(`${file}:${line}: [${what}] ${shown}`);
    }
  }
  return hits.sort();
}

/**
 * Files that may still hold references, each with the last line the check
 * reads (every line after it is left alone) and the reason. Keep it as short as it can be: every entry must
 * still hold a reference, so the list cannot go stale.
 */
const ALLOWED: Record<string, { lastLine: (text: string) => number; why: string }> = {
  // The released history: entries are kept as they shipped. Everything above
  // the 0.1.0 heading, the entries still being written, is checked.
  "CHANGELOG.md": {
    lastLine: (text) => text.split("\n").findIndex((l) => l.startsWith("## [0.1.0]")),
    why: "the 0.1.0 release notes are history and keep their text",
  },
};

/**
 * Applied migrations, which migrate.ts checks by the SHA-256 of their bytes:
 * a reworded comment would stop every database that applied the old bytes
 * from starting (only the rewordings listed in PREVIOUS_CHECKSUMS are
 * accepted, and that list is closed). So these keep their comments; any new
 * migration is checked like every other file.
 */
const APPLIED_MIGRATIONS = [
  "apps/server/src/db/migrations/0001_init.sql",
  "apps/server/src/db/migrations/0002_purge_started.sql",
  "apps/server/src/db/migrations/0003_estimate_filament_profiles.sql",
  "apps/server/src/db/migrations/0005_model_name_source.sql",
  "apps/server/src/db/migrations/0006_model_name_source_user.sql",
];
for (const file of APPLIED_MIGRATIONS) {
  ALLOWED[file] = {
    lastLine: () => 0,
    why: "an applied migration, checksummed by migrate.ts",
  };
}

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** Every tracked text file still on disk, relative to the repository root. */
function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((f) => f !== "" && existsSync(join(ROOT, f)) && f !== "pnpm-lock.yaml");
}

describe("no citation of a private plan, requirement or project", () => {
  test("the check finds each kind of reference, wrapped ones too, and leaves look-alikes alone", () => {
    const t = "Task";
    const named = [
      `// the estimates (${t} 12) queue`,
      `// ${t}s 4 and 5 build on this`,
      `// a limit (see ${t}\n// 17's route)`,
      `# the ${"build"} plan says so`,
      `// the ${"Build"}\n// plan's rule`,
      `// as ${"AC"}-031 requires`,
      `// (${"Review"} Focus 4)`,
      `// the ${"Global"} Constraints`,
      `// a port of the ${"Bambu"} Plates parser`,
      `// parser${".rb"} reads it`,
      `// see ${"jonathanmcohen"}/automation at 1ce8c57`,
      `// ported from ${"manyfold"}-studio`,
      `// in automation ${"Manyfold"}/${"makerworld"}-metadata`,
      `// the prior art manyfold.mjs at ${"automation"} 1ce8c57`,
    ];
    const lookAlikes = [
      "// a task queue, the planner, AC power, AC-31, TAC-031",
      "// the gate's plan step, a plan id, Bambu Studio plates",
      "// github.com/jonathanmcohen/platehouse and ghcr.io/jonathanmcohen/platehouse-slicer",
      "// T0 = new Date(), Q9, a 1:1 task",
    ];
    const text = [...named, ...lookAlikes].join("\n");
    // The line each named sample starts on: every one is found, and nothing
    // else is (a look-alike line never is).
    const starts: number[] = [];
    let line = 1;
    for (const sample of named) {
      starts.push(line);
      line += sample.split("\n").length;
    }
    const hitLines = new Set(referencesIn("sample", text).map((hit) => Number(hit.split(":")[1])));
    expect([...hitLines].sort((x, y) => x - y)).toEqual(starts);
  });

  test("an allowed file is read up to its last checked line", () => {
    const text = [
      "# Changelog",
      `- new: see ${"AC"}-010`,
      "## [0.1.0] - x",
      `- old: see ${"AC"}-010`,
    ].join("\n");
    const lastLine = ALLOWED["CHANGELOG.md"]?.lastLine(text) ?? 0;
    expect(lastLine).toBe(2);
    expect(referencesIn("CHANGELOG.md", text, lastLine)).toEqual([
      `CHANGELOG.md:2: [a requirement id] - new: see ${"AC"}-010`,
    ]);
  });

  test("no tracked file holds one, outside the allowed history", () => {
    const files = trackedFiles();
    for (const f of ["CHANGELOG.md", ".github/workflows/ci.yml", "packages/threemf/src/parse.ts"]) {
      expect(files).toContain(f);
    }
    const found = files.flatMap((file) => {
      const bytes = readFileSync(join(ROOT, file));
      if (bytes.includes(0)) return [];
      const text = bytes.toString("utf8");
      const allowed = ALLOWED[file];
      return referencesIn(file, text, allowed ? allowed.lastLine(text) : undefined);
    });
    expect(found).toEqual([]);
    // Every allowed file still holds a reference, so none stays on the list by accident.
    const stale = Object.keys(ALLOWED).filter(
      (file) =>
        !existsSync(join(ROOT, file)) ||
        referencesIn(file, readFileSync(join(ROOT, file), "utf8")).length === 0,
    );
    expect(stale).toEqual([]);
  });
});
