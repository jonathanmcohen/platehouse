// Keeps citations of private documents and projects out of the tracked tree
// (issue #325). Platehouse was built from a private plan and a private
// list of requirements, and ported parts of earlier private projects. A
// public reader can open none of them, so a plan task number, a requirement
// id or a private repository's name leads nowhere. Code, tests and docs say
// the rule itself, in plain words, instead.
//
// The guard catches the known forms of such a citation. The list was made by
// sweeping every line the rewrite for #325 removed (PR #399): each form found
// in those lines has a pattern in plan-references.support.ts (REFERENCES) and
// a synthetic sample in FORMS below, and the patterns match every removed
// line that held a citation. A denylist cannot know a form nobody has seen,
// so when a new form turns up later, it is added the same way: a pattern in
// the support file and a sample in FORMS, which the self-test then requires.
//
// The known forms, one REFERENCES entry each: a plan task number; a short
// plan task id (T and one or two digits beside a plan word); the words build
// and plan; the private plan called the plan where it is cited; a
// requirement id; a plan question id; a numbered plan decision; a numbered
// lesson; a requirements section; the plan's section names and parts; the
// plan's contracts by name; another of the owner's projects by name; the
// earlier private parser project, its source, test and issue names; a
// private repository; a private project's commit by hash; and the
// maintainer's own tooling and setup. A comment wrapped across two lines
// still counts: the comment marker between the words is skipped.
//
// The patterns are written so they do not match their own text, and the
// samples in the self-test are put together at run time, so neither file
// holds a reference or needs an allow-list entry. The names (projects,
// repositories, commits, tooling) are listed by hash only, so neither file
// holds one: the self-test proves each name shape on neutral stand-ins, and
// against the real names when PLATEHOUSE_PLAN_NAMES gives them.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  isNameEntry,
  type NameReference,
  type Names,
  nameEntry,
  nameText,
  REFERENCES,
  referencesIn,
  SHAPES,
  type Shape,
  sha256,
} from "./plan-references.support.js";

/**
 * Files that may still hold references, each with the last line the check
 * reads (every line after it is left alone) and the reason. Keep it as short as it can be: every entry must
 * still hold a reference, so the list cannot go stale.
 */
const ALLOWED: Record<string, { lastLine: (text: string) => number; why: string }> = {
  // The released history: entries are kept as they shipped. Everything above
  // the 0.1.0 heading, the entries still being written, is checked.
  "CHANGELOG.md": {
    // Fails closed: with the heading renamed or gone, the whole file is
    // checked rather than none of it.
    lastLine: (text) => {
      const heading = text.split("\n").findIndex((l) => l.startsWith("## [0.1.0]"));
      if (heading < 0) throw new Error("CHANGELOG.md has no '## [0.1.0]' heading to stop at");
      return heading;
    },
    why: "the 0.1.0 release notes are history and keep their text",
  },
};

/**
 * Applied migrations, which migrate.ts checks by the SHA-256 of their bytes:
 * a reworded comment would stop every database that applied the old bytes
 * from starting (only the rewordings listed in PREVIOUS_CHECKSUMS are
 * accepted, and that list is closed). So these keep their comments; any new
 * migration is checked like every other file.
 *
 * 0001 to 0009 shipped in v0.1.0, so every 0.1.0 server has applied them.
 * 0010 to 0015 shipped in no published image, but they are on the 0.1.1
 * branch, and a server that ran a build of it has applied them, so they keep
 * their bytes too. Each still cites a numbered lesson, and 0001 the plan too.
 */
const APPLIED_MIGRATIONS = [
  "apps/server/src/db/migrations/0001_init.sql",
  "apps/server/src/db/migrations/0002_purge_started.sql",
  "apps/server/src/db/migrations/0003_estimate_filament_profiles.sql",
  "apps/server/src/db/migrations/0004_files_sha256.sql",
  "apps/server/src/db/migrations/0005_model_name_source.sql",
  "apps/server/src/db/migrations/0006_model_name_source_user.sql",
  "apps/server/src/db/migrations/0007_my_printers.sql",
  "apps/server/src/db/migrations/0008_library_sort.sql",
  "apps/server/src/db/migrations/0009_name_sort_prefix.sql",
  "apps/server/src/db/migrations/0010_drop_unused_tags.sql",
  "apps/server/src/db/migrations/0011_estimate_started_at.sql",
  "apps/server/src/db/migrations/0012_file_preview_status.sql",
  "apps/server/src/db/migrations/0013_token_creators.sql",
  "apps/server/src/db/migrations/0014_description_source.sql",
  "apps/server/src/db/migrations/0015_plate_mesh.sql",
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

// Neutral stand-ins, hashed at test time, prove each shape a name entry
// finds without the real names: one name per shape, lines that hold it, and
// look-alikes that must be left alone.
const NEUTRAL: Record<Shape, { name: string; found: string[]; lookAlikes: string[] }> = {
  word: {
    name: "quokka",
    found: ["// quokka's theme bug showed only on a fresh load", "// (quokka login loop)"],
    lookAlikes: ["// quokkas, a quokka_x, xquokka, quokka1"],
  },
  pair: {
    name: "blue heron",
    found: [
      "// a port of the blue heron parser",
      "// a port of the blue\n// heron parser",
      "-- the blue\n-- heron",
      " * the blue\n * heron",
    ],
    lookAlikes: ["// blue herons, a blue-heron, blueheron, the blue sky heron, a blue_heron"],
  },
  hyphen: {
    name: "blue-heron",
    found: ["// live checks are blue-heron's", "// the x-blue-heron-y job"],
    lookAlikes: ["// blue-herons, blue heron, a blue-heronx, blue_heron, blue--heron"],
  },
  commit: {
    name: "c0ffee1",
    found: [
      "// where they are compared with c0ffee1",
      `// the full commit ${"c0ffee1".padEnd(40, "0")} here`,
    ],
    lookAlikes: [`// c0ffee, c0ffee1g, xc0ffee1, 0c0ffee1, ${"c0ffee1".padEnd(41, "0")}`],
  },
  wordBeforeCommit: {
    name: "quokka",
    found: [
      "// the prior art a.mjs at quokka 0123abc",
      "// ported from a.mjs at quokka\n// 0123abc",
    ],
    lookAlikes: ["// quokka abc, quokka 0123ab, quokka-0123abc, quokka"],
  },
  pairBeforeSlash: {
    name: "blue heron",
    found: ["// in blue heron/x-meta", "// in blue\n// heron/x"],
    lookAlikes: ["// blue heron x/, blue heron /x, blue-heron/x, blue heron"],
  },
};

/** A name entry's copy that holds only its shape's stand-in name. */
function neutralEntry(what: string, names: Names): NameReference {
  const { shape, caseless } = names;
  return nameEntry(what, shape, caseless, [sha256(nameText(NEUTRAL[shape].name, shape, caseless))]);
}

describe("no citation of a private plan, requirement or project", () => {
  // One or more synthetic samples per known form, each with the REFERENCES
  // entry that must find it. Built at run time, so this file holds none.
  const t = "Task";
  const FORMS: Array<[string, string]> = [
    ["a plan task", `// the estimates (${t} 12) queue`],
    ["a plan task", `// ${t}s 4 and 5 build on this`],
    ["a plan task", `// a limit (see ${t}\n// 17's route)`],
    ["a plan task", `// the pages of ${t}s 19 to\n// 21 add their own`],
    ["a plan task", `// the estimates (${"task"} 12) queue`],
    ["a short plan task id", `// the ${"T"}11 form, run as evidence`],
    ["a short plan task id", `// ${"T"}26's runtime hardening`],
    ["a short plan task id", `// the plan (${"T"}11) does not use them`],
    ["a short plan task id", `// the pages arrive with ${"T"}19 to ${"T"}21`],
    ["a short plan task id", `// The ${"T"}11 --ro form is run and printed`],
    ["a short plan task id", `// recorded as evidence for ${"T"}11, whatever it does`],
    ["a short plan task id", `state.unused = ["QA ${"T"}28 test"];`],
    ["the words build and plan", `# the ${"build"} plan says so`],
    ["the words build and plan", `// the ${"Build"}\n// plan says so`],
    ["the private plan, as the plan", `// The ${"plan"}: a redirect to http is refused`],
    ["the private plan, as the plan", `// the banner's words (the ${"plan"}'s exact sentence)`],
    ["the private plan, as the plan", `// the six sentences are the ${"plan"}'s, word for word`],
    ["the private plan, as the plan", `// the database image the ${"plan"} pins`],
    ["the private plan, as the plan", `// added after the ${"plan"} was written`],
    ["the private plan, as the plan", `// a schema that drifts from the ${"plan"} fails here`],
    ["the private plan, as the plan", `// a field beyond the ${"plan"} is refused`],
    ["the private plan, as the plan", `// not upgraded: the ${"plan"}\n// says so`],
    ["a requirement id", `// as ${"AC"}-031 requires`],
    ["a plan question id", `// works for ten minutes (${"Q"}14)`],
    ["a plan question id", `// the versioning check (one rule, decided ${"Q"}20)`],
    ["a plan question id", `// the generic preset (${"Q"}4 / the rule)`],
    ["a plan question id", `// collections are flat (one rule, ${"Q"}17)`],
    ["a numbered plan decision", `// the importer's fields (${"decision"} 5)`],
    ["a numbered plan decision", `// never a presigned URL (plan ${"decision"} 7)`],
    ["a numbered plan decision", `// one plate per request (${"decision"}\n// 3)`],
    ["a numbered lesson", `-- every statement is read in review (${"lesson"} 14)`],
    [
      "a numbered lesson",
      `-- every statement is read in review (${"lesson"}\n-- 14). Never edit it`,
    ],
    ["a requirements section", `// a separate item (${"requirements"} section 6)`],
    ["a plan section", `// (${"Review"} Focus 4)`],
    ["a plan section", `// the ${"Global"} Constraints`],
    ["a plan section", `// the types (${"Global"}\n// Constraints)`],
    ["a plan section", `// the test S3 server the image pins (${"Tech"} Stack)`],
    ["a plan section", `// not proof on its own (${"Verify"} a Change)`],
    ["a plan section", `// the key never changes (${"Bucket"} key layout)`],
    ["a plan contract", `// session-class (the ${"Route"} classes contract)`],
    ["a plan contract", `/** The session cookie (${"Database"} schema contract). */`],
    ["a plan contract", `// encoded once by the server (the ${"slicer"} link\n// contract)`],
    ["a plan contract", `// the answer is the ${"Public"} API v1 contract: a`],
    ["a plan contract", `// the environment only (the ${"Configuration"} contract)`],
    ["a plan contract", `// the ${"bucket"} key contract wants lowercase ids`],
    ["a plan contract", `// the routes are the ${"contract"}'s table, as listed`],
    ["a plan contract", `// Origin check. The operations are the ${"contract"}'s:`],
    ["a plan contract", `// sets nothing beyond what the ${"contract"} defaults say`],
    ["a plan part", `// the auth hooks belong to ${"Part"} C, so`],
    ["a plan part", `// ${"Parts"} C and D hold the sign-in work`],
    ["the earlier private parser project", `// parser${".rb"} reads it`],
    [
      "the earlier private parser project",
      `// never the file (${"test"}_garbage_model_settings_returns_nil)`,
    ],
    ["the earlier private parser project", `    ${"issue"}: "#5",`],
    ["the earlier private parser project", `//   #${"6"}  no plate limit`],
    ["a private repository", `// see ${"jonathanmcohen"}/example at the tip`],
    ["the maintainer's own tooling or setup", `// the live ${"dry"} run skipped such a file`],
  ];

  test("every known form is found by its own pattern, wrapped samples too", () => {
    const missed = FORMS.filter(
      ([what, sample]) => !referencesIn("sample", sample).some((hit) => hit.includes(`[${what}]`)),
    );
    expect(missed).toEqual([]);
  });

  test("every readable pattern has a sample, so none is untested", () => {
    // A name entry is proven by the neutral stand-ins below instead.
    const sampled = new Set(FORMS.map(([what]) => what));
    expect(
      REFERENCES.filter((r) => !r.names)
        .map((r) => r.what)
        .filter((what) => !sampled.has(what)),
    ).toEqual([]);
  });

  test("each name entry finds a stand-in name in its shape, wrapped too, and leaves look-alikes alone", () => {
    const entries = REFERENCES.filter(isNameEntry);
    // Every shape is in use, so each is proven here.
    expect(new Set(entries.map((r) => r.names.shape))).toEqual(new Set(Object.keys(SHAPES)));
    for (const { what, names } of entries) {
      const { found, lookAlikes } = NEUTRAL[names.shape];
      const neutral = [neutralEntry(what, names)];
      for (const line of found) {
        expect(referencesIn("sample", line, undefined, neutral), `${what}: ${line}`).toHaveLength(
          1,
        );
        // In another case: found only by a caseless entry.
        expect(
          referencesIn("sample", line.toUpperCase(), undefined, neutral),
          `${what}: ${line.toUpperCase()}`,
        ).toHaveLength(names.caseless ? 1 : 0);
      }
      expect(referencesIn("sample", lookAlikes.join("\n"), undefined, neutral), what).toEqual([]);
    }
  });

  test("the name list is well formed", () => {
    for (const { what, names } of REFERENCES.filter(isNameEntry)) {
      expect(names.sha256.size, what).toBeGreaterThan(0);
      for (const h of names.sha256) expect(h, what).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test("look-alikes are left alone", () => {
    const lookAlikes = [
      "// a task queue, the planner, AC power, AC-31, TAC-031",
      "// the gate's plan step, a plan id",
      "// github.com/jonathanmcohen/platehouse and ghcr.io/jonathanmcohen/platehouse-slicer",
      "// T0 = new Date(), T0.getTime(), Q9, a 1:1 task, mint(key, T0)",
      "// Example Kit Alpha | Part A & Part B, Example Kit | Part A &amp;amp; Part B",
      "// Part 2, Part E, Party C, a part C, function pair<T1, T2>(a: T1, b: T2)",
      "// a lesson learned, the lessons of 0.1.0",
      "// the route classes table, slicer contract v1, the Slicer HTTP contract, a slicer link, the Public API v1's document",
      "// the importer: the plan skips it, the plan compares names, the plan's renames, the plan has changed, the plan is no longer that one",
      "// the maintainer's decision, needs-decision 0, decision 0, failed 0",
      "// the contract's reasons, the contract's 256 MiB limit, the contract's own zod schemas",
      "// a Bambu Lab Q9 0.4 nozzle, a tech stack, requirements in the RFC",
      "// inbox_test_disk_full, test_one_two, the S3 test server, issue #78, platehouse #78",
    ].join("\n");
    expect(referencesIn("sample", lookAlikes)).toEqual([]);
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
    // A renamed or missing heading fails rather than leaving the file unchecked.
    expect(() => ALLOWED["CHANGELOG.md"]?.lastLine("# Changelog\n## 0.1.0 - x\n")).toThrow(
      /no '## \[0\.1\.0\]' heading/,
    );
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
  // The proof that the name entries find the real names. The names live
  // outside the repository: give them in PLATEHOUSE_PLAN_NAMES, one per line,
  // written as nameText() reads them, and this checks that each name hashes
  // to an entry, that every entry's hash has a name, and that a line holding
  // each name is found by its entry. Nothing it prints holds a name, only
  // hashes.
  //
  // Without the variable, as in CI, the same steps run over the neutral
  // stand-ins, one copy of each entry. The real hashes are then covered by
  // the tests above: each shape is read and matched the way the stand-ins
  // prove, and the list is well formed.
  test("each listed name is found, from PLATEHOUSE_PLAN_NAMES or the neutral stand-ins", () => {
    const given = process.env.PLATEHOUSE_PLAN_NAMES;
    const real = REFERENCES.filter(isNameEntry);
    const list = given ? real : real.map(({ what, names }) => neutralEntry(what, names));
    const names = given
      ? given.split(/\r?\n|,/)
      : [...new Set(Object.values(NEUTRAL).map((n) => n.name))];
    const hashOf = (name: string, e: NameReference) =>
      sha256(nameText(name, e.names.shape, e.names.caseless));
    const named = new Set<string>();
    const unknown: string[] = [];
    const missed: string[] = [];
    for (const name of names.map((n) => n.trim()).filter((n) => n !== "")) {
      const holders = list.filter((e) => e.names.sha256.has(hashOf(name, e)));
      if (holders.length === 0) unknown.push(sha256(name));
      for (const e of holders) {
        named.add(hashOf(name, e));
        const line = SHAPES[e.names.shape].example(name);
        if (referencesIn("sample", line, undefined, [e]).length === 0) missed.push(sha256(name));
      }
    }
    expect(unknown).toEqual([]);
    expect(missed).toEqual([]);
    // Every listed hash has a name.
    expect(list.flatMap((e) => [...e.names.sha256]).filter((h) => !named.has(h))).toEqual([]);
  });
});
