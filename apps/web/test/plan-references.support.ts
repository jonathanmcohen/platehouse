// The patterns of the plan-citation guard (plan-references.test.ts), kept
// apart so a one-off script can run the same patterns over other text, such
// as every line a change removed. Each entry is one known form of citation;
// the test's header says how the list was made and how a new form is added.
//
// Two kinds of entry:
//
// - A form, such as a plan task number, is a readable pattern. Those patterns
//   are written so they do not match their own text: a word is split by WRAP.
// - A name, such as a private project's or repository's, is never written
//   here, since this file is part of the tree that becomes the public
//   repository. The entry holds the SHA-256 of each name, as
//   personal-names.test.ts does, and a readable pattern that finds text of
//   the name's shape (a word, two words, two words joined by a hyphen, a
//   commit hash); the guard hashes what that pattern finds and compares
//   hashes. A hash keeps a name from being read off the page; a short name or
//   a seven-digit commit hash can still be recovered by trying candidates, so
//   the list says only what class of name each entry is.
//
// To add a name: printf '%s' 'the name' | shasum -a 256, with the name as
// nameText() reads it (lowercased when the entry is caseless, the words of a
// two-word name joined by one space, a commit hash cut to its first seven
// digits), and put the hash in the entry of its class and shape. To check the
// list against the names themselves, run plan-references.test.ts with
// PLATEHOUSE_PLAN_NAMES set (see its last test); the names are never written
// to the repository or to CI.
import { createHash } from "node:crypto";

/** A comment marker (and the space around it) that may sit between two words of a wrapped comment. */
export const WRAP = String.raw`\s*(?:\/\/|#|--|\*)?\s*`;

/** Space, and a comment marker after it, between the two words of a name, wrapped or not. */
const SEP = String.raw`\s+(?:(?:\/\/|#|--|\*)\s*)?`;

/** A word of a name, its hyphenated parts included. */
const NAME_WORD = "[A-Za-z]+(?:-[A-Za-z]+)*";

/**
 * The shapes a name is found in. Each pattern finds every piece of text of
 * that shape, and the hash decides whether it is a listed name; a pattern
 * with a capture group hashes the group. example() is a line that holds the
 * name, used by the test that proves the list against the real names.
 */
export const SHAPES = {
  /** One word, underscores included, such as a project name or a method name. */
  word: {
    pattern: /(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9_]*(?![A-Za-z0-9_])/g,
    example: (name: string) => `// see ${name} here`,
  },
  /** Two words, wrapped across a comment line or not; each may be hyphenated. */
  pair: {
    pattern: new RegExp(
      `(?<![A-Za-z0-9_-])(?=(${NAME_WORD}${SEP}${NAME_WORD})(?![A-Za-z0-9_-]))`,
      "g",
    ),
    example: (name: string) => `// see ${name} here`,
  },
  /** Two words joined by one hyphen, such as a repository or a role. */
  hyphen: {
    pattern: /(?<![A-Za-z0-9_])(?=([A-Za-z]+-[A-Za-z]+)(?![A-Za-z0-9_]))/g,
    example: (name: string) => `// see ${name} here`,
  },
  /** A commit hash, short or full, by its first seven digits. */
  commit: {
    pattern: /(?<![0-9A-Za-z])[0-9a-f]{7,40}(?![0-9A-Za-z])/gi,
    example: (name: string) => `// see ${name} here`,
  },
  /** A repository named by the word before a commit hash. */
  wordBeforeCommit: {
    pattern: new RegExp(String.raw`(?<![A-Za-z0-9_])[A-Za-z]+(?=${SEP}[0-9a-f]{7,40}\b)`, "gi"),
    example: (name: string) => `// see ${name} 0123abc here`,
  },
  /** A repository and its folder: two words, then a slash. */
  pairBeforeSlash: {
    pattern: new RegExp(String.raw`(?<![A-Za-z0-9_-])(?=(${NAME_WORD}${SEP}${NAME_WORD})\/)`, "g"),
    example: (name: string) => `// see ${name}/x here`,
  },
} as const;

export type Shape = keyof typeof SHAPES;

/** The hashed names of a name entry. */
export interface Names {
  shape: Shape;
  /** Names are lowercased before hashing. */
  caseless: boolean;
  /** SHA-256 of each name as nameText() reads it, as lowercase hex. */
  sha256: ReadonlySet<string>;
}

export interface Reference {
  /** What the pattern finds, for the failure message. */
  what: string;
  pattern: RegExp;
  /** Set for a name entry: a match counts only when its hash is listed. */
  names?: Names;
}

/** A name entry, whose names are always set. */
export type NameReference = Reference & { names: Names };

/** True for a name entry. */
export function isNameEntry(r: Reference): r is NameReference {
  return r.names !== undefined;
}

/** A name entry: the pattern of its shape, and the hashes of its names. */
export function nameEntry(
  what: string,
  shape: Shape,
  caseless: boolean,
  sha256: readonly string[],
): NameReference {
  const { pattern } = SHAPES[shape];
  return {
    what,
    pattern: new RegExp(pattern.source, pattern.flags),
    names: { shape, caseless, sha256: new Set(sha256) },
  };
}

/**
 * A matched name as it is hashed: the space and comment marker between two
 * words become one space, lowercased when caseless, and a commit hash cut to
 * its first seven digits.
 */
export function nameText(text: string, shape: Shape, caseless: boolean): string {
  let t = text.replace(new RegExp(SEP, "g"), " ");
  if (caseless || shape === "commit") t = t.toLowerCase();
  return shape === "commit" ? t.slice(0, 7) : t;
}

/** Hashes are cached: the tree repeats the same words many times. */
const HASHES = new Map<string, string>();
export function sha256(text: string): string {
  let h = HASHES.get(text);
  if (h === undefined) {
    h = createHash("sha256").update(text).digest("hex");
    HASHES.set(text, h);
  }
  return h;
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
  // The owner's other projects, by name: four one-word names, as written.
  nameEntry("another of the owner's projects", "word", false, [
    "ff872964e5ec9c9b11e9caa568f1359de26efab51f18a091aac47041607eb101",
    "b4e06092970e08ebdc6f97c4e2817fcd20d3411ee87af0f821693820980a1540",
    "37e12d0fac7dca1a38121583487ff5e7c1056ac447f9b2c63bb28e1b6375fb50",
    "be9b97528c0331659abcab4cfac4ecb2ca56bddd5e7cdd3b3dcad66d7a9ca72a",
  ]),
  // And one two-word name, as written.
  nameEntry("another of the owner's projects", "pair", false, [
    "c64b8d08cba23784799fde87ecbca469591ddd0be04313bf5cd63481536856d6",
  ]),
  // The earlier parser project's name, two words in any case.
  nameEntry("the earlier private parser project", "pair", true, [
    "7e2fc72107d2a2195c2163fd193148947e5dba04d0f85015f41e64d5d5d04070",
  ]),
  // Its own method and constant names, in any case.
  nameEntry("the earlier private parser project", "word", true, [
    "d6fed56e83a4341385e3a6c16cb05bf079bc270f42d0210f7bd815d5bb37e64a",
    "cdb3cb05ed823d6a232c97d0be57529bb39968430516e4c955e5e2c0fbcccd69",
    "21e4a8085c98a23cc574a3c86aa5d6a362d452b6adf08a9648cdbbcbf9cbbaa8",
    "10676bb03c5106252e5c7795b154f5fa6cf4b450d2b5c46b0d5334d939ed8009",
  ]),
  {
    what: "the earlier private parser project",
    pattern: new RegExp(
      [
        String.raw`\bparser(?:_test)?\.rb\b`,
        // Its XML library.
        String.raw`\bNokogir[i]\b`,
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
    // Any repository of the GitHub owner but Platehouse's own two.
    what: "a private repository",
    pattern: /\bjonathanmcohen\/(?!platehouse(?:-slicer)?\b)[A-Za-z0-9._-]+/gi,
  },
  // Private repositories by name: four hyphenated names, in any case.
  nameEntry("a private repository", "hyphen", true, [
    "b88f5e7a92ccd1671d7c61c7bcd6160acb2741fffacb29f5693ff6634ff8c23d",
    "b7b4658532c14919b1c7457a788158ea1dedbb916193523038178f812291f8fb",
    "6da820768a3a1605808c263a8a897a6b1757a7dea84aa3a6d3d56dd78f362df6",
    "a7923cd3405ee275ef9e1bbcec6a6c16a37209ec5482b7453b96fecc2b7d8118",
  ]),
  // A private repository cited by a commit after its name (issue #329).
  nameEntry("a private repository", "wordBeforeCommit", true, [
    "6d65ed5c750019a199c61a33ea9202fb727c05e257560f38f014e6b1520e50ed",
  ]),
  // A private repository and a folder in it.
  nameEntry("a private repository", "pairBeforeSlash", true, [
    "f8011503c0d11a0914f63c2fd5773ca1dc368111b56c21f602227c18c600c63f",
  ]),
  // The known commits of the private projects, by hash alone (the stylesheet
  // project's and a private repository's), short or full.
  nameEntry("a private project's commit", "commit", true, [
    "91a2b48b786fdd11bec96b1dc5ba25f382841b59e5436cd73d9cdafec9f4697b",
    "3792cff77c7a5937f817f610cae2f0bd47ec071ad93cbe015f87fd39084b1ab6",
    "a66509197eace62e1ab6f392c344a60048ed6cf963510b28211637803b9bec0a",
  ]),
  // The maintainer's tooling roles, hyphenated, in any case: eight teams each
  // with two role suffixes, then three more roles.
  nameEntry("the maintainer's own tooling or setup", "hyphen", true, [
    "241957cf85dc17fc786655bb196dc41cfb3591e247285edc04cef59647d4f5c9",
    "0122c5e1734058405020314bf7156ec425101f94944e5ee9820757747b0e963d",
    "372a547bf05aae3e49881fc87c071f11b2e01d4085aa6edddc5b1278d784f712",
    "ec0e436553372c7c3648a0068f73ca9e50f425e638067d211b4294e38a6577ff",
    "1ebd8d10ce8a4ca46f653dd428bc2be574cadd5c48194fe968e89f51df2bb373",
    "70866f8f253dd96cb050c1945002a1fe8d76ac2dc7bdb6aa8f00852873e2c242",
    "b7dc958f5f28ae54dd10511109a3d313c5af80ca89221c4c0015e0f2fa9f7c8c",
    "be9715c4b5769fda82f5fb3907fde107e236405fcf72f9b7c91d0e64cac16dc3",
    "9cd71544a03d6ffc47e0fe7d30dbea28fb6290184d66f039a5e3d6f100885689",
    "edc914b00a88079c0ed1aed4345212d59c2a836c7fbc514731b8acd4a90e646d",
    "33b5107a3739d2260026d43438cbf001678bf020949c864f72f331e559496c84",
    "764fa284c5441850bf3a3445159e36f8cf61aff726d2da6411c8a09bae3dadd2",
    "d486cedccc37190ea91259de8c44dd9c427aa16cc491f7cc311d23e5c443dee9",
    "4ffbb9947c76e8369ba16776eeb5397b2644ac8b8365c6f6be0e79eb0a740478",
    "f0fd389242ab47764bf86d1a6caa502b6d762519815256a8446d4c6b0252257b",
    "ce98a2f178156323c19bf6b73165ae46883b0d013638baff35d31d15cb1a5f92",
    "e08ba693bb6ad36a0cfc77cb678d2e638e4013f69c1e55a4d81768cd7d4d6a56",
    "b1dac0837ce17d7a7c604b81ea8f83f7c85345f8d56e7cd5ef132ee6b41a0b5d",
    "ee38ec3eb04ec7e364c29a60e6af7528ed2b83b599fa2c9434e7fb96abcca6a8",
  ]),
  // The maintainer's monitoring alert, named by two word pairs, in any case.
  nameEntry("the maintainer's own tooling or setup", "pair", true, [
    "5a3931aff21ff3e853b1f2446d9cf840db84f422c5e3e3198b53504937a97c33",
    "876b6c366a9cc1a7b4bc967ac99b5751fdd6d741f4a015bde54e98664afe4c77",
  ]),
  {
    what: "the maintainer's own tooling or setup",
    pattern: new RegExp(String.raw`\blive${WRAP}dry${WRAP}run\b`, "gi"),
  },
];

/** Every reference in a text, as "file:line: [what] text". */
export function referencesIn(
  file: string,
  text: string,
  lastLine = Number.POSITIVE_INFINITY,
  references: readonly Reference[] = REFERENCES,
): string[] {
  const hits: string[] = [];
  for (const { what, pattern, names } of references) {
    pattern.lastIndex = 0;
    for (const m of text.matchAll(pattern)) {
      if (names) {
        const found = nameText(m[1] ?? m[0], names.shape, names.caseless);
        if (!names.sha256.has(sha256(found))) continue;
      }
      const line = text.slice(0, m.index).split("\n").length;
      if (line > lastLine) continue;
      const shown = text.split("\n")[line - 1]?.trim() ?? "";
      hits.push(`${file}:${line}: [${what}] ${shown}`);
    }
  }
  return hits.sort();
}
