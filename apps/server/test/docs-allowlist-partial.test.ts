// The allowlist warning is written once, in docs/reverse-proxy/_allowlist-warning.md,
// and six docs pages render it as an MDX component. Six pasted copies had
// drifted apart, so this guards the one copy: no other page repeats its text,
// and each of the six pages imports it exactly once.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const PARTIAL = "docs/reverse-proxy/_allowlist-warning.md";
const OPENING =
  "If the proxy runs in Docker and you use an allowlist, prefer `network_mode: host` (Docker Engine on Linux), or run it on the host.";
const LEADS = [
  "**Let the proxy see real addresses.**",
  "**Do not allow Docker's networks.**",
  "**Test IPv6 from the host's addresses, not from DNS.**",
  "**Docker's userland proxy.**",
];
const PAGES: [string, string][] = [
  ["docs/reverse-proxy/nginx.md", "./_allowlist-warning.md"],
  ["docs/reverse-proxy/caddy.md", "./_allowlist-warning.md"],
  ["docs/reverse-proxy/traefik.md", "./_allowlist-warning.md"],
  ["docs/reverse-proxy/apache.md", "./_allowlist-warning.md"],
  ["docs/reverse-proxy/checklist.md", "./_allowlist-warning.md"],
  ["docs/security.md", "./reverse-proxy/_allowlist-warning.md"],
];

/** Whitespace runs collapsed to one space, so a line break never hides a match. */
const flat = (text: string): string => text.replace(/\s+/g, " ");
const read = (path: string): string => flat(readFileSync(join(ROOT, path), "utf8"));

/** Every Markdown file under docs/, as [path from the repo root, text]. */
function docs(dir = join(ROOT, "docs")): [string, string][] {
  return readdirSync(dir).flatMap((name): [string, string][] => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return docs(path);
    return name.endsWith(".md") ? [[relative(ROOT, path), readFileSync(path, "utf8")]] : [];
  });
}

describe("the allowlist warning", () => {
  it("the partial holds the shared warning", () => {
    const partial = read(PARTIAL);
    expect(partial).toContain(OPENING);
    for (const lead of LEADS) expect(partial).toContain(lead);
  });

  it("no other docs page copies it", () => {
    for (const [path, text] of docs()) {
      if (path === PARTIAL) continue;
      const flatText = flat(text);
      expect(flatText.includes(OPENING), `${path} repeats the opening`).toBe(false);
      for (const lead of LEADS)
        expect(flatText.includes(lead), `${path} repeats ${lead}`).toBe(false);
    }
  });

  it.each(PAGES)("%s renders the partial", (path, importPath) => {
    const text = readFileSync(join(ROOT, path), "utf8");
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
    expect(front?.[1], `${path} has front matter`).toContain("mdx:\n  format: mdx");
    const body = text.slice(front?.[0].length ?? 0);
    expect(body.split(`import AllowlistWarning from "${importPath}";`)).toHaveLength(2);
    expect(body.split("<AllowlistWarning />")).toHaveLength(2);
  });
});
