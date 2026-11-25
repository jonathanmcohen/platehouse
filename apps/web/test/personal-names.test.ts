// Keeps private infrastructure names and the maintainer's name out of the
// public tree. The names themselves are not in this file: FORBIDDEN holds the
// SHA-256 of each one, lowercased, and the check hashes what it reads and
// compares hashes.
//
// Two guards share that list:
//
// 1. Shipped text (PR #230). Platehouse is published as public images, so
//    text a user sees, such as a placeholder or a help line, must be generic.
//    Every non-comment line of the .ts and .tsx files of apps/web/src,
//    apps/server/src and packages/i18n/src, of apps/web/index.html and of the
//    translation catalogs in packages/i18n/locales is checked against every
//    entry. Other files under those trees (CSS, the generated
//    apps/web/src/api-docs/openapi.json, which is built from server .ts
//    strings checked here) are covered by guard 2. Comment lines are
//    left out here: guard 2 covers them.
// 2. The whole tracked tree (git ls-files), comments, docs, CI, fixtures and
//    file paths included, because the 0.1.0 tree becomes the public
//    repository. It checks every entry except the shipped-only ones. A line is
//    also checked with its backslashes removed, so a regex-escaped name (a dot
//    written as backslash-dot) is still found.
//
// How a line is read (tokens()): any Subresource Integrity value (sha512-
// and its base64, as in a lockfile) is left out first, being noise, not text.
// Then the line is lowercased and split into words at every character that is
// not a-z or 0-9. Each run of letters and digits is also split into its
// camelCase words ("approvedByName" gives "approved", "by", "name";
// "HTTPName" gives "http", "name"), so a name joined to other letters is
// still a word; a run that is an allowed token as a whole is not split. Plus
// each pair of neighbouring words joined by one space, counting camelCase
// words as words ("myBlueHeronHost" gives "my blue", "blue heron" and
// "heron host"), so a two-word name written as an identifier is still a
// pair; plus every dotted run
// of numbers cut into its dotted prefixes ("a.", "a.b.", "a.b.c.", from each
// starting number). An entry matches by kind:
// - word: a word, a camelCase word, or a pair of words, equals the name.
// - prefix: a word or a camelCase word starts with the name (length says how
//   many characters).
// - address: a dotted prefix equals the name, so a whole address range is
//   one entry and is never written out.
//
// To add a name: printf '%s' 'the name, lowercased' | shasum -a 256, and put
// the hash in FORBIDDEN with its kind. To check the list against the names
// themselves, run this file with PLATEHOUSE_GUARD_NAMES set (see the last
// test); the names are never written to the repository or to CI.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

type Kind = "word" | "prefix" | "address";

interface Forbidden {
  /** SHA-256 of the lowercased name, as lowercase hex. */
  sha256: string;
  kind: Kind;
  /** For a prefix entry, the name's length in characters. */
  length?: number;
  /** shipped: checked in shipped text only (guard 1); tree: both guards. */
  scope: "tree" | "shipped";
  /** The class of name, never the name. */
  what: string;
}

const w = (sha256: string, what: string): Forbidden => ({
  sha256,
  kind: "word",
  scope: "tree",
  what,
});
const addr = (sha256: string): Forbidden => ({
  sha256,
  kind: "address",
  scope: "tree",
  what: "a private address range",
});

const FORBIDDEN: Forbidden[] = [
  // Machine names: ten in one numbered series, then two more.
  w("3f6b196b7943e5dd4bfa3864d01c14f3d4e87f3af06d19e88a279454b6c9d3d0", "a machine name"),
  w("2ad11f7a4c4331def86958277d245f17768db37844e18dc309190b6adf8567e4", "a machine name"),
  w("1810ca955a0c2d85cea6e8fc6d32f823dd1828600d41e25f2cfb1c6463875281", "a machine name"),
  w("d3b30bc212dc4d6e8daaa905512b8ccfcfa9a4e4f71cf3d015c5f018c8f7dd65", "a machine name"),
  w("0359118981c0136ab38a709832e623c663308f86bb2ee38fa035ce95648652aa", "a machine name"),
  w("0bd35274279238332db392f36e136f4fad3d43b540120cebf9201778826c89b5", "a machine name"),
  w("47edcdb807884a7f1e7c9e84a518823a023eb123a65625479ec7f3b2694d31ae", "a machine name"),
  w("0dcf7c79df2f32f5603e875a19a54d33d7d79e1e5f4d6a15d6ebeaba66177da2", "a machine name"),
  w("8bc40e3a42844fab81382c1f0f9bc7ba9aaec5aa4b539339fcaa5b2ffef8707d", "a machine name"),
  w("6459b3e267f295cf43a2fec58c38aa90a627402547a65e6fa7f1e500f3425936", "a machine name"),
  w("90783486b4b0693c1256f2a1d03a668c0eab9e0a8bba7b71a01d0028ec6f47f7", "a machine name"),
  w("d856510a42c52e52f8d643fe3bd6e97284e7e40b52d726ed95878d8d98975e47", "a machine name"),
  // Server names, then DNS server names written two ways.
  w("915320dfdd5b3b49a99bc9d67d33458b52cc7f59b4c33340ab3822d80e494a93", "a server name"),
  w("5839ecdfd43bc7467f77cba4a40ea64c8ee5f986f61cf16a0e024ed2225891a4", "a server name"),
  w("59195c6c541c8307f1da2d1e768d6f2280c984df217ad5f4c64c3542b04111a4", "a server name"),
  w("c23cd87798a83c7818a4d14b487eeda6f781dd82b10f877b13fefc0069ba4827", "a server name"),
  w("e5b12ff7a936a9ad6040cfdaa40623a654659b54bfec8d0f8c8d7fc4cdf44cd0", "a DNS server name"),
  w("b3666d1909dc06380370f78d4d0ca18275e98599c812ff1cf13e3976ce824358", "a DNS server name"),
  w("90f0e4987558e4c1c24e388e2897115a2eabefb08e8b523cfbf3e7ebef3d74e3", "a DNS server name"),
  w("ca9aefd37c0357da487e583fce9036bacc8c7266f7083ff0a83e1a1e45c70ee5", "a DNS server name"),
  // A domain, a company, a disk, a path, an undefined server name and a tool.
  w("b7afecb055107fd18da01557ada651b77c2efab057bbc7b8ce310902bd9bac28", "a private domain"),
  w("8ff777cfeaea9b983dfb159bcd76fecabe75267d1f3489723b3869bb50e10178", "a company name"),
  w("ce2e3a9c7e44f4158387458df50d391c5cef657bb875bd01ca40111d36f835ed", "a personal disk name"),
  w("989569c1688dbdf37140251cc3b6376bb3c4c4b1c563b86d4710177361ee2166", "a server's project root"),
  w(
    "ccf5fa14b0b28488ab631ccfcd2800b5cbd5e7497ef0ba8520baeb0239942e42",
    "a server name the public repo never defines (issue #305)",
  ),
  w("7e50628dd9f471bfbc6243965eed2ae17dfffd515a4b9697fb83a6873a75c919", "a personal tool name"),
  // The maintainer's surname, as a word. (Joined into the GitHub owner name
  // it stays allowed: see ALLOWED.)
  w("ce4e149f7e786b226e23bbefe9e0075a96b4abcda9dfb36a08a136205386d21c", "the maintainer's surname"),
  // The maintainer's first name, as the start of a word.
  {
    sha256: "bb472edb86809a761936d90c70aeb4346618aa71da7a00c16e334863499108fd",
    kind: "prefix",
    length: 3,
    scope: "tree",
    what: "the maintainer's first name",
  },
  // Private address ranges, one entry per dotted prefix.
  addr("ba59ea25cd00862ef176856f124234eb07cebdfa6c9382282e894e8a1197545f"),
  addr("946b42930dae6b8e76904f3cddb64bda2433754043d24fae2582954d5abb244f"),
  addr("0efc1c4883baa39c404dda3e5ff9ddbe14eed025ce47d517d2fdd4a0ea9acffe"),
  addr("1f042223e37556a61f2ca4d7182379af12f0a2653f33c171c337efeb92e1273c"),
  addr("4503b50d0fe138343b708feb2ec26a6e42684ab50c07545df39291fc56035a1b"),
  addr("bb64962db7919d9a28903ba2ebbb4bc64d6b860f7b308357e63399cc7ba28470"),
  addr("203b9a64dd7ff59fce9ff1c33ba9472ee2e3f7fa22a60aecba360b03a8db3ec9"),
  addr("c024179dfb9e98f887eee672fb445df26be11489b3498fe675a6c5329b4635a4"),
  addr("eb422c285f4b2a03fc8cb50cceea27251ed557d1c4e8bfac47d6cca23d8c9336"),
  addr("d35ab0c7ee8a8ced74803eaacd34945034202636e658027bbeb93fc6eeb84341"),
  addr("567d0883b283adb05fcccd4f2ee97feba25e6c24333e1737f8a43ceaee00a03b"),
  addr("fde4313108d0e8c3398bbf8dce5e4676b70aa5b76bb8b642a9883ce98cde03e1"),
  addr("36ff41debdb8ca45c03adeb8bf7e34331ad8e4cc9b664f4e20e3eaa7174d0709"),
  addr("d475ae3899776dfe5c1eaea682c20343b31b86605e7a8aab6e64e3f1f2c0f273"),
  addr("c3835c03c380c982e0c267a045f4cce4db9b23eeedd4c22381789382d746486c"),
  addr("01e0d10098f7c538e24b03d0dbb65728bd8fd99de469779c420022406e6ba4e7"),
  addr("1192aeb8d07a065e7d627055ee94b8a11fb1a07058168cbddb31ec5b0f8197cd"),
  addr("3696796a13f2173582290b7bffd464818eac62abd27d425bb816eaded14daf2f"),
  addr("34f4c421695ddaff1ddcba590069b192900ca048f61819764be8eb3423b29668"),
  addr("af77ce39f4b41e75343ecff7f26baa31bc7b2236c1925d3f246663cf9cd51d7e"),
  addr("6cc591f87b5f013af7185cc103f23b14b7cedb8b261fac8335aa6815b3135195"),
  addr("e5bc9cfe4733eed9621e9142280295657f276d8d2dfbbf999415e35fc0ebf5b7"),
  addr("8e2f953186c935d83bd511690366e6eb73c07fdf467df6df2f32cc8d77262891"),
  addr("3cb794a79eb35208124e2432ce11727eb09da99dcb56be5af331f6155634ff25"),
  addr("0cc0d667be180e2c64f5ff42dab38353ccaf3dab344296802cb878cb88484243"),
  addr("18c232d91adf6aad66b08393483a612bcea07535e71ec8e193b96c0cd4c09ec8"),
  addr("0e0634006db31e7dc6fb2f5e99fd483aecb7e6f24b8c4d50280f48b47a06131a"),
  addr("5d13517943166a7f47d7ed30308f6a4c22360faf03b8c7324344b7d586f3b89f"),
  addr("a80685774b70f25b5fa0ada5f542a5ece7fdbb966af52499a7d840d7bcc728d7"),
  addr("c84d67b69db903a562f31128dc5f208322390e6e54870f22e157ff937ad80637"),
  addr("f43b5477a2309a7dd8a3f1a33b5fe1fea53f7ae52b0d4f91cfd9bb7e488eb9b5"),
  addr("c3487073fe8b1afd47dec2e28e8cd62c617d55958cd630a0d1ceee2d3327292e"),
  addr("89049a5deb5807543803f52d633c479969cd65ec2080bddbe7efdf00523e758c"),
  addr("c28923427a94e1ddb3d561511d03d4bf0f6c2faa291558e21fbd2c61c29cea2a"),
  addr("7a4ed24fcc83246fb33933535a7538ff56324b112e5a868735fd9bfff186be46"),
  addr("88f81c8cd4264aefcbf85bb5938351df173ceb72797b0e470c3690bb5ee9d173"),
  addr("6f0053a0d34829b1d0b11eb88d0f7779d5d3e53dd240f4d876ad8eb69006a20e"),
  addr("44c4346bf365f4997bfeef4a30ee53a9ad3bc5010d193e170c78d36a410589a0"),
  addr("16d3ef06a7502fc73cbce1644bd53c104ab91c9130d8aeda9b6fb2af996ae3c9"),
  addr("3051c1dc9e0ebb2afd23a127dfb67ee0fa8f2f3330f73d9472bd5b6787972119"),
  addr("fe3e651166ca2903dd49d1b30853ee726ff2d95b23c97ed7fbb0eea66c5adecb"),
  addr("376ab4f8f50c10a65bb0bee1a96e080b8ce5b0906699d06e0424ea09449c943e"),
  addr("dabcaa5707af2db02e3dde80ca0eb32134a0d389d8a89089fa015af2b4f17055"),
  addr("9e26649de4ea4e776888027575e4698f4ca53deb0b463d8a3bc939012d363934"),
  addr("0ed09a6ab75bc36d239363e25aef3f9dafb149261442f0857fb58aeb2f93245f"),
  addr("fc2a351ec531072908b737fe28c6b10a102135e491261d17f3f57df7959ebd72"),
  addr("230af6b0acf04e7c7d2d7b5960aead51f6786e6d1b38e9565aa3993c3268ad7a"),
  addr("018f26aafc9c9dc76c3a5cbdd3726e274bbe74859f07bc5012afe4da2bc7bfbc"),
  addr("1e5d07ac2d80caefffdc0a71c9101531275178b0412735aa6d0eac1b31d31f71"),
  addr("59644bd0a2738e0b24a3e81a547399db640c424df4366dddd9deaf2db3b49058"),
  addr("a6e9ffdd9b37b39f9309b4ae08285c24a2bac2235b427c7ee6b3d6d9af96b7aa"),
  addr("2d4d64d5143d57e5933cea7fe840517aa28a76bde00394ffebcc9821544b1bba"),
  addr("4bd832a419002563e8daf684448e2def200bfd4a7f56f5736611e39a75734dea"),
  addr("06baa15c3e61b05ecf413e28948076fa150487d360a0d18e6ea53dbc66b68ca1"),
  addr("f6948c66d7facdbdd172b2976133767dbf57871879fb84068e8089684a41af0c"),
  addr("912bc397f102351d54cbe28f748edd382d9230e150a5dede6914f2ce7586a9d7"),
  addr("6a0f750b8ea44386b2178176358402dcca1bbc8fa95b8225a3a0aa57bb3214a4"),
  addr("baa98452163492e5bb9b648a7428252ec3bb7d89ddee9c91ec6a420e248cbd9e"),
  addr("bcea7febd15ed9dd4eb9efd4cbe0d850ab6893de49d2febeba0ee81f5b9fd1c1"),
  addr("508b59b826df5ad09f6da3d6c9012cefc147649ff5d23f41e2453cc00f100e68"),
  addr("59ea028563d5c892a968d0395b4ce51d6b87edbb71e3d265b020921df0413bd8"),
  addr("e2ac4c1561683e976efc270a2769295ccf3a81a80a452b49fc63dc88bee28054"),
  addr("eca73e3d5513fea9b7cb4169b0fa01887754c5341ae53da29e455fcd9207c6c1"),
  addr("25ff6bbefca84d4587a830aa34c5903200e54c8b6e493918ccf60e38ac91133c"),
  addr("6b298c0f70c84fbec127c83a3d41391f9797d010f36ac1fd9d43198bd18088fd"),
  // Shipped text only: a client product, named as if it were the user's own.
  {
    sha256: "a625159d18da57180b7215e56c4ca20cabf8bcd9b7030c8c460aeed7b5588c6c",
    kind: "word",
    scope: "shipped",
    what: "a client product named as the user's own",
  },
];

/** SHA-256 of a string, as lowercase hex. */
function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Hashes are cached: the tree repeats the same words many times. */
const HASHES = new Map<string, string>();
function hashOf(token: string): string {
  let h = HASHES.get(token);
  if (h === undefined) {
    h = sha256(token);
    HASHES.set(token, h);
  }
  return h;
}

/**
 * A Subresource Integrity value, such as a lockfile's integrity line: base64,
 * so its runs of letters are noise, not words. Left out before a line is read.
 */
const INTEGRITY = /\bsha(?:1|256|384|512)-[A-Za-z0-9+/]+=*/g;

/** Where a run of letters and digits splits into camelCase words. */
const CAMEL = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;

/** A run of letters and digits that holds camelCase words, and those words. */
interface Camel {
  whole: string;
  parts: string[];
}

/**
 * The word tokens of a line, its camelCase words, and the dotted-prefix
 * tokens of its numbers.
 */
function tokens(line: string): {
  words: string[];
  camel: Camel[];
  runs: Camel[];
  pairs: string[];
  dotted: string[];
} {
  const text = line.replace(INTEGRITY, " ");
  const lower = text.toLowerCase();
  const words = lower.split(/[^a-z0-9]+/).filter((t) => t !== "");
  // Every run in order, with its camelCase words (the run alone when it has
  // none), so names() can pair neighbouring words across both kinds of break.
  const runs: Camel[] = [...text.matchAll(/[A-Za-z0-9]+/g)].map(([run]) => ({
    whole: run.toLowerCase(),
    parts: run.split(CAMEL).map((p) => p.toLowerCase()),
  }));
  const camel = runs.filter((r) => r.parts.length > 1);
  const pairs = words.slice(1).map((t, i) => `${words[i]} ${t}`);
  const dotted: string[] = [];
  for (const [run] of lower.matchAll(/\d+(?:\.\d+)*\.?/g)) {
    if (!run.includes(".")) continue;
    const parts = run.replace(/\.$/, "").split(".");
    // How many of the parts have a dot after them.
    const dotsAfter = run.endsWith(".") ? parts.length : parts.length - 1;
    for (let start = 0; start < dotsAfter; start++) {
      for (let end = start + 1; end <= dotsAfter; end++) {
        dotted.push(`${parts.slice(start, end).join(".")}.`);
      }
    }
  }
  return { words, camel, runs, pairs, dotted };
}

/** A compiled list: hash sets per kind, the prefix lengths, and the allowed tokens. */
interface Matcher {
  words: Set<string>;
  addresses: Set<string>;
  prefixes: Map<number, Set<string>>;
  allowed: Set<string>;
}

function compile(list: Forbidden[], allowed: Record<string, string>): Matcher {
  const m: Matcher = {
    words: new Set(),
    addresses: new Set(),
    prefixes: new Map(),
    allowed: new Set(Object.keys(allowed)),
  };
  for (const f of list) {
    if (f.kind === "word") m.words.add(f.sha256);
    else if (f.kind === "address") m.addresses.add(f.sha256);
    else {
      const length = f.length ?? 0;
      const set = m.prefixes.get(length) ?? new Set<string>();
      set.add(f.sha256);
      m.prefixes.set(length, set);
    }
  }
  return m;
}

/** True when a word, unless allowed, equals a word entry or starts with a prefix entry. */
function wordHit(m: Matcher, t: string): boolean {
  const h = hashOf(t);
  if (m.allowed.has(h)) return false;
  if (m.words.has(h)) return true;
  for (const [length, set] of m.prefixes) {
    if (t.length >= length && set.has(hashOf(t.slice(0, length)))) return true;
  }
  return false;
}

/** True when a line, or the line with its backslashes removed, has a forbidden token. */
function names(m: Matcher, line: string): boolean {
  for (const text of line.includes("\\") ? [line, line.replaceAll("\\", "")] : [line]) {
    const { words, camel, runs, pairs, dotted } = tokens(text);
    for (const t of words) if (wordHit(m, t)) return true;
    // The camelCase words of a run, unless the whole run is an allowed token.
    for (const { whole, parts } of camel) {
      if (m.allowed.has(hashOf(whole))) continue;
      for (const t of parts) if (wordHit(m, t)) return true;
    }
    for (const t of pairs) if (m.words.has(hashOf(t))) return true;
    // Pairs of neighbouring words with each run cut into its camelCase words
    // (an allowed run stays whole), so a two-word name written as an
    // identifier ("blueHeron", "myBlueHeronHost") is still a pair.
    const fine = runs.flatMap(({ whole, parts }) =>
      parts.length > 1 && !m.allowed.has(hashOf(whole)) ? parts : [whole],
    );
    for (let i = 1; i < fine.length; i++) {
      if (m.words.has(hashOf(`${fine[i - 1]} ${fine[i]}`))) return true;
    }
    for (const t of dotted) if (m.addresses.has(hashOf(t))) return true;
  }
  return false;
}

/** Every allowed token's hash that a text holds, so ALLOWED cannot go stale. */
function allowedSeen(m: Matcher, text: string, seen: Set<string>): void {
  for (const line of text.split("\n")) {
    const { words, camel } = tokens(line);
    for (const t of [...words, ...camel.flatMap((c) => c.parts)]) {
      const h = hashOf(t);
      if (m.allowed.has(h)) seen.add(h);
    }
  }
}

/**
 * Tokens that match an entry but must stay, by the SHA-256 of the exact
 * token, each with its reason. Keep it as short as it can be.
 */
const ALLOWED: Record<string, string> = {
  "03e62fe753f873189e21e8b4b213d458b28d396558e7d6504f9b56041cfd9a67":
    "The GitHub owner name: the image names (ghcr.io/<owner>/...) and the repository URLs (github.com/<owner>/...) need it.",
};

/**
 * Tracked files whose text may still match, by exact path, each with its
 * reason; their paths are still checked. Every entry must still match, so
 * the list cannot go stale. Keep it empty unless a file genuinely cannot
 * change yet.
 */
const ALLOWED_FILES: Record<string, string> = {};

const SHIPPED = compile(FORBIDDEN, ALLOWED);
const TREE = compile(
  FORBIDDEN.filter((f) => f.scope === "tree"),
  ALLOWED,
);

// --- 1. Shipped text ---------------------------------------------------------

/** A line that is only a comment: //, a block comment's lines, or a JSX comment. */
const COMMENT = /^\s*(?:\/\/|\/\*|\*|\{\s*\/\*)/;

/** Each non-comment line that names one, as "file:line: text". */
function shippedLines(m: Matcher, file: string, source: string): string[] {
  return source
    .split("\n")
    .flatMap((line, i) =>
      !COMMENT.test(line) && names(m, line) ? [`${file}:${i + 1}: ${line.trim()}`] : [],
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

// Neutral stand-ins, hashed at test time, prove the reading and matching
// without the real names: one entry of each kind.
const NEUTRAL: Forbidden[] = [
  { sha256: sha256("quokka"), kind: "word", scope: "tree", what: "a word" },
  { sha256: sha256("blue heron"), kind: "word", scope: "tree", what: "two words" },
  { sha256: sha256("zeb"), kind: "prefix", length: 3, scope: "tree", what: "a prefix" },
  { sha256: sha256("198.51.100."), kind: "address", scope: "tree", what: "an address range" },
  { sha256: sha256("wombat"), kind: "word", scope: "shipped", what: "a shipped-only word" },
];
const NEUTRAL_ALLOWED: Record<string, string> = { [sha256("zebrafish")]: "an allowed token" };

describe("no private name in shipped text", () => {
  test("the check finds each kind of entry, and skips comments", () => {
    const m = compile(NEUTRAL, NEUTRAL_ALLOWED);
    const sample = [
      `placeholder="Script on Quokka"`,
      `label: 'from the blue-heron'`,
      `const host = 'zebra';`,
      `const issuer = "https://198.51.100.7";`,
      `<p>Each client, such as a Wombat, gets a token.</p>`,
      `// a comment that names quokka`,
      ` * a block comment that names quokka`,
      `{/* a JSX comment that names quokka */}`,
      `const fine = "quokkas, blue sky, a heron, a zebrafish, 198.51.10.1, 1198.51.100.1";`,
    ].join("\n");
    expect(shippedLines(m, "sample", sample)).toEqual([
      `sample:1: placeholder="Script on Quokka"`,
      `sample:2: label: 'from the blue-heron'`,
      `sample:3: const host = 'zebra';`,
      `sample:4: const issuer = "https://198.51.100.7";`,
      `sample:5: <p>Each client, such as a Wombat, gets a token.</p>`,
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
    const found = files.flatMap((file) => shippedLines(SHIPPED, file, readFileSync(file, "utf8")));
    expect(found).toEqual([]);
  });
});

// --- 2. The whole tracked tree -----------------------------------------------

/** Each line of a file (or its path, as line 0) that names one, as "file:line: text". */
function treeLines(m: Matcher, file: string, source: string): string[] {
  const hits = names(m, file) ? [`${file}:0: (the path)`] : [];
  source.split("\n").forEach((line, i) => {
    if (names(m, line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
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

describe("no private name anywhere in the tracked tree", () => {
  test("the check finds each kind of entry, in a path or a regex, and leaves look-alikes alone", () => {
    const m = compile(
      NEUTRAL.filter((f) => f.scope === "tree"),
      NEUTRAL_ALLOWED,
    );
    const named = [
      "ssh quokka uptime",
      "copied from QUOKKA",
      "the blue heron runs it",
      "the Blue_Heron runs it",
      "zeb",
      "a zebra crossing",
      "connect 198.51.100.105:5432",
      // Found only with the backslashes removed.
      "/198\\.51\\.100\\.\\d+/",
      "/(?:local|quok\\ka)/",
      "allow 10.198.51.100.0/24",
      // A name joined to other letters in camelCase or after an acronym.
      "approvedByZeb: true",
      "askZEB()",
      "the HTTPQuokka client",
      "myQuokkaHost",
      // A two-word name written as an identifier, or split across a word
      // boundary and a camelCase one.
      "const myBlueHeronHost = 1",
      "blueHeron: x",
      "the blue HeronHost",
      "BlueHeron",
    ];
    const lookAlikes = [
      "quokkas, blue sky, grey heron, heron blue, a zebrafish, ze, wombat",
      "198.51.10.1, 1198.51.100.1, 198.51.1000.1, 192.0.2.10, platehouse.example.com",
      // An allowed token in camelCase, whole or inside a longer identifier.
      "ZebraFish, theZebrafishTank, isZeBRa",
      // Two-word look-alikes in camelCase.
      "blueSky, greyHeron, heronBlue, BlueHerons, blue_skyHeron",
      // A Subresource Integrity value (a lockfile's integrity line) is base64,
      // not text: its runs of letters are left alone.
      "resolution: {integrity: sha512-abcZebXy+/zeb0Quokka/QuokkaZ==}",
      "integrity sha1-Zeb9/zebQ= and sha384-x+ZEBq",
    ];
    expect(treeLines(m, "sample", [...named, ...lookAlikes].join("\n"))).toEqual(
      named.map((line, i) => `sample:${i + 1}: ${line.trim()}`),
    );
    expect(treeLines(m, "deploy/quokka/x.yml", "")).toEqual(["deploy/quokka/x.yml:0: (the path)"]);
    expect(treeLines(m, "deploy/zebrafish/x.yml", "")).toEqual([]);
  });

  test("the list is well formed", () => {
    const seen = new Set<string>();
    for (const f of FORBIDDEN) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(seen.has(f.sha256), `${f.sha256} is listed once`).toBe(false);
      seen.add(f.sha256);
      expect(f.what).not.toBe("");
      if (f.kind === "prefix") expect(f.length).toBeGreaterThan(0);
      else expect(f.length).toBeUndefined();
    }
    for (const h of Object.keys(ALLOWED)) expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Every kind is in use, so each is proven by the neutral tests above.
    expect(new Set(FORBIDDEN.map((f) => f.kind))).toEqual(
      new Set<Kind>(["word", "prefix", "address"]),
    );
  });

  test("no tracked file names one, outside ALLOWED and ALLOWED_FILES", () => {
    const files = trackedFiles();
    // git ls-files read the whole tree: files from several parts of it are listed.
    for (const f of ["CHANGELOG.md", ".github/workflows/ci.yml", "tools/slicing-gate/README.md"]) {
      expect(files).toContain(f);
    }
    const seen = new Set<string>();
    const found = files.flatMap((file) => {
      const bytes = readFileSync(join(ROOT, file));
      // A binary file (an image, a font) has a NUL byte; only its path is checked.
      const text = bytes.includes(0) ? "" : bytes.toString("utf8");
      allowedSeen(TREE, `${file}\n${text}`, seen);
      return file in ALLOWED_FILES ? treeLines(TREE, file, "") : treeLines(TREE, file, text);
    });
    expect(found).toEqual([]);
    // Every ALLOWED_FILES entry is still needed.
    for (const file of Object.keys(ALLOWED_FILES)) {
      expect(
        treeLines(TREE, file, readFileSync(join(ROOT, file), "utf8")).length,
        file,
      ).toBeGreaterThan(0);
    }
    // Every ALLOWED entry is still needed, so the list cannot go stale.
    expect(Object.keys(ALLOWED).filter((h) => !seen.has(h))).toEqual([]);
  });

  // The proof that the list finds the real names. The names live outside the
  // repository: give them in PLATEHOUSE_GUARD_NAMES, one per line, each as
  // "kind:name" (word:, prefix:, address:), and this checks that the hashes
  // of the names are exactly the list, and that a line holding each name is
  // found by the real guard. Nothing it prints holds a name, only hashes.
  //
  // Without the variable, as in CI (the workflow holds no secrets, by its own
  // test in tools/slicing-gate), the same steps run over NEUTRAL: each
  // neutral name, given the same way, hashes to its entry and is found. The
  // real list is then covered by the tests above: each kind is read and
  // matched the way the neutral entries prove, and the list is well formed.
  test("each listed name is found, from PLATEHOUSE_GUARD_NAMES or the neutral stand-ins", () => {
    const given = process.env.PLATEHOUSE_GUARD_NAMES;
    const list = given ? FORBIDDEN : NEUTRAL;
    const lines = given
      ? given.split(/\r?\n|,/)
      : ["word:quokka", "word:blue heron", "prefix:zeb", "address:198.51.100.", "word:wombat"];
    const entries = lines
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .map((l) => {
        const at = l.indexOf(":");
        return { kind: l.slice(0, at) as Kind, name: l.slice(at + 1).toLowerCase() };
      });
    const byHash = new Map(list.map((f) => [f.sha256, f]));
    // Each name hashes to an entry of its kind, and every entry has a name.
    const unknown = entries
      .filter((e) => byHash.get(sha256(e.name))?.kind !== e.kind)
      .map((e) => sha256(e.name));
    expect(unknown).toEqual([]);
    const named = new Set(entries.map((e) => sha256(e.name)));
    expect(list.filter((f) => !named.has(f.sha256)).map((f) => f.sha256)).toEqual([]);
    // A line holding each name is found: shipped-only names by guard 1 on a
    // code line, the rest by guard 2 as well.
    const shipped = compile(list, {});
    const tree = compile(
      list.filter((f) => f.scope === "tree"),
      {},
    );
    const missed = entries.flatMap((e) => {
      const entry = byHash.get(sha256(e.name));
      const line = e.kind === "address" ? `connect ${e.name}7 now` : `see ${e.name} now`;
      const ok =
        shippedLines(shipped, "sample", line).length === 1 &&
        (entry?.scope !== "tree" || treeLines(tree, "sample", line).length === 1);
      return ok ? [] : [sha256(e.name)];
    });
    expect(missed).toEqual([]);
  });
});
