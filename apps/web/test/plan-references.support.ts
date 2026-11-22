// The patterns of the plan-citation guard (plan-references.test.ts), kept
// apart so a one-off script can run the same patterns over other text, such
// as every line a change removed. Each entry is one known form of citation;
// the test's header says how the list was made and how a new form is added.
//
// The patterns are written so they do not match their own text: a word is
// split by WRAP, or its last letter is put in brackets.

/** A comment marker (and the space around it) that may sit between two words of a wrapped comment. */
export const WRAP = String.raw`\s*(?:\/\/|#|--|\*)?\s*`;

export interface Reference {
  /** What the pattern finds, for the failure message. */
  what: string;
  pattern: RegExp;
}

/** Words that, after "the plan" or "plan's", cite the private plan rather than the importer's or a rename's plan. */
const PLAN_VERBS = [
  "says",
  "sets",
  "was",
  "names",
  "pins",
  "leaves",
  "wrote",
  "puts",
  "maps",
  "fails",
];
const PLAN_NOUNS = [
  "first",
  "contents",
  "form",
  "original",
  "exact",
  "colou?rs",
  "configuration",
  "contract",
  "map",
  "own",
  "body",
  "example",
  "slot",
  "hostile",
  "slicer",
  "rule",
  "sample",
  "reason",
  "steps",
  "permissions",
  "three",
  "decisions",
  "tests",
  "interfaces",
];

export const REFERENCES: Reference[] = [
  {
    // The word Task or Tasks and a number, or two numbers joined by and, to
    // or a hyphen, in any case.
    what: "a plan task",
    pattern: new RegExp(String.raw`\bTasks?${WRAP}\d+(?:${WRAP}(?:and|to|-)${WRAP}\d+)?`, "gi"),
  },
  {
    what: "a short plan task id",
    pattern: new RegExp(
      [
        String.raw`\bplan(?:'s)?${WRAP}\(?T\d{1,2}\b`,
        String.raw`\bT\d{1,2}(?:'s\b|${WRAP}(?:form|recipe|--ro)\b)`,
        String.raw`\bT\d{1,2}[ ]?(?:-|to)[ ]?T\d{1,2}\b`,
        String.raw`\b(?:[Tt]he|for|QA)${WRAP}T\d{1,2}\b(?!\s*[=.(])`,
      ].join("|"),
      "g",
    ),
  },
  { what: "the words build and plan", pattern: new RegExp(String.raw`\bbuild${WRAP}plan\b`, "gi") },
  {
    what: "the private plan, as the plan",
    pattern: new RegExp(
      [
        String.raw`\bthe${WRAP}plan:`,
        String.raw`\bplan's(?:[,:]|${WRAP}(?:${PLAN_NOUNS.join("|")})\b)`,
        String.raw`\bthe${WRAP}plan${WRAP}(?:${PLAN_VERBS.join("|")}|is${WRAP}refused)\b`,
      ].join("|"),
      "gi",
    ),
  },
  { what: "a requirement id", pattern: /\bAC-\d{3}\b/g },
  {
    // Q and one or two digits, after an opening bracket, after decided, or
    // after a comma or semicolon and before a closing bracket.
    what: "a plan question id",
    pattern: new RegExp(
      String.raw`\(Q\d{1,2}\b|\bdecided${WRAP}Q\d{1,2}\b|[,;]${WRAP}Q\d{1,2}\)`,
      "g",
    ),
  },
  {
    // The word decision and a number from 1, wrapped too. (A count such as
    // the gate report's needs-decision tally of 0 is left alone: no plan
    // decision is numbered 0.)
    what: "a numbered plan decision",
    pattern: new RegExp(String.raw`\bdecisions?${WRAP}[1-9]\d?\b`, "gi"),
  },
  { what: "a numbered lesson", pattern: new RegExp(String.raw`\blessons?${WRAP}\d+`, "gi") },
  {
    what: "a requirements section",
    pattern: new RegExp(String.raw`\brequirements?${WRAP}section${WRAP}\d+`, "gi"),
  },
  {
    what: "a plan section",
    pattern: new RegExp(
      String.raw`\b(?:Review${WRAP}Focus|Global${WRAP}Constraints|Tech${WRAP}Stack|Verify${WRAP}a${WRAP}Change|Bucket${WRAP}key${WRAP}layout)\b`,
      "g",
    ),
  },
  {
    what: "a plan contract",
    pattern: new RegExp(
      [
        String.raw`\b(?:Route${WRAP}classes|Database${WRAP}schema|Slicer${WRAP}link|Public${WRAP}API${WRAP}v1|Configuration|bucket${WRAP}key)${WRAP}contract\b`,
        // The plan contract's table, its list of operations, its defaults
        // (the slicer contract v1, in the repo, is cited in other words).
        String.raw`\bare${WRAP}the${WRAP}contract's:|\bthe${WRAP}contract(?:'s${WRAP}table\b|${WRAP}defaults\b)`,
      ].join("|"),
      "gi",
    ),
  },
  {
    what: "a plan part",
    pattern: new RegExp(
      String.raw`(?<!&[a-z;]*\s*)\bParts?${WRAP}[A-D](?:${WRAP}(?:and|to|-)${WRAP}[A-D])?\b(?!\s*&)`,
      "g",
    ),
  },
  {
    what: "another of the owner's projects",
    pattern: /\b(?:Parchmen[t]|Cair[n]|Pylo[n]|stockbeepno[m]|Market Bo[t])\b/g,
  },
  {
    what: "the earlier private parser project",
    pattern: new RegExp(
      [
        String.raw`\bBambu${WRAP}Plates\b`,
        String.raw`\bparser(?:_test)?\.rb\b`,
        // Its own method and constant names, and its XML library.
        String.raw`\b(?:thumbnail_fro[m]|max_thumbnail_byte[s]|damaged_on_read_erro[r]|READ_ERROR[S]|Nokogir[i])\b`,
        // Its Ruby test names: test_ and four or more words.
        String.raw`\btest_[a-z0-9]+(?:_[a-z0-9]+){3,}\b`,
        // Its issue numbers, as the hostile-file table labelled its rows.
        String.raw`\bissue:\s*"#\d+"`,
        // (a list item: the comment marker, three spaces, the number)
        String.raw`^[ \t]*\/\/ {3}#\d{1,2}[ \t]{1,2}[a-z]`,
      ].join("|"),
      "gim",
    ),
  },
  {
    what: "a private repository",
    pattern: new RegExp(
      [
        String.raw`\bjonathanmcohen\/(?!platehouse(?:-slicer)?\b)[A-Za-z0-9._-]+`,
        String.raw`\bmanyfold-(?:studio|bambu)`,
        String.raw`\bmakerworld-meta(?:data)?\b`,
        String.raw`\bautomation${WRAP}Manyfold\/`,
        // The private automation repository cited by a commit after its
        // name (issue #329).
        String.raw`\bautomation${WRAP}[0-9a-f]{7,40}\b`,
      ].join("|"),
      "gi",
    ),
  },
  {
    // The known commits of the private projects, by hash alone (the
    // stylesheet project's and the automation repository's). Each hash is
    // written with its last digit in brackets so this line holds none of them.
    what: "a private project's commit",
    pattern: /\b(?:4076a6[7]|136fd6[1]|1ce8c5[7])[0-9a-f]{0,33}\b/gi,
  },
  {
    what: "the maintainer's own tooling or setup",
    pattern: new RegExp(
      [
        String.raw`\b(?:release|qa|security|product|bench|automation|platform|devops)-(?:enginee[r]|sr[e])\b`,
        String.raw`\b(?:code-reviewe[r]|pr-revie[w]|tech-lea[d])\b`,
        String.raw`\bfleet${WRAP}restart-loop\b|\brestart-loop${WRAP}alert\b`,
        String.raw`\blive${WRAP}dry${WRAP}run\b`,
      ].join("|"),
      "gi",
    ),
  },
];

/** Every reference in a text, as "file:line: [what] text". */
export function referencesIn(
  file: string,
  text: string,
  lastLine = Number.POSITIVE_INFINITY,
): string[] {
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
