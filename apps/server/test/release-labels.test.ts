// The app image's version labels (issue #317, the rc.3 live check: nothing on
// a running container said which version or commit it was built from).
//
// The release workflow (.github/workflows/release.yml) sets the standard OCI
// labels docker/metadata-action computes (version, revision, source, created,
// title, description, url, licenses) on both per-arch builds, the tested
// load and the push by digest, and the same keys as annotations on the
// multi-arch index. docker/check-image-labels.sh reads them back: from the
// loaded image before the push, from each pushed digest's config, and from
// the index's annotations once it is tagged.
//
// This file runs the script against a stub docker that answers with the JSON
// the real commands give, so it proves the checks the script makes and the
// commands it runs. It cannot prove what a real registry stores; the
// workflow's own read-back does that on every release. The workflow wiring
// is read as text (the workspace has no YAML parser of its own), so those
// tests prove the steps are there, not that GitHub runs them.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = join(ROOT, "docker", "check-image-labels.sh");
const WORKFLOW = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");

const VERSION = "0.1.1";
const REVISION = "0123456789abcdef0123456789abcdef01234567";
const SOURCE = "https://github.com/jonathanmcohen/platehouse";
/** A dollar sign, so the workflow's ${...} text can be written in a template literal. */
const D = "$";

/** The labels metadata-action gives for a v0.1.1 tag, as the image config holds them. */
function goodLabels(): Record<string, string> {
  return {
    "org.opencontainers.image.created": "2026-11-21T20:00:00.000Z",
    "org.opencontainers.image.description": "Self-hosted library for 3D print files",
    "org.opencontainers.image.licenses": "AGPL-3.0",
    "org.opencontainers.image.revision": REVISION,
    "org.opencontainers.image.source": SOURCE,
    "org.opencontainers.image.title": "platehouse",
    "org.opencontainers.image.url": SOURCE,
    "org.opencontainers.image.version": VERSION,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ph-labels-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs the script with a stub docker first on PATH that prints answer and
 * records its arguments, one per line, in a file.
 */
function run(where: string, ref: string, answer: unknown, expected = [VERSION, REVISION, SOURCE]) {
  const bin = join(dir, "bin");
  spawnSync("mkdir", ["-p", bin]);
  writeFileSync(join(dir, "answer.json"), JSON.stringify(answer));
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${dir}/args"\ncat "${dir}/answer.json"\n`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  const res = spawnSync("bash", [SCRIPT, where, ref, ...expected], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });
  let args: string[] = [];
  try {
    args = readFileSync(join(dir, "args"), "utf8").trimEnd().split("\n");
  } catch {
    // docker was never run
  }
  return { status: res.status, out: `${res.stdout}${res.stderr}`, args };
}

describe("docker/check-image-labels.sh", () => {
  describe("the loaded image (before the push)", () => {
    test("passes with every label right, reading the image config", () => {
      const res = run("local", "platehouse:release-amd64", goodLabels());
      expect(res.out).toContain("org.opencontainers.image.version");
      expect(res.status, res.out).toBe(0);
      expect(res.args).toEqual([
        "image",
        "inspect",
        "--format",
        "{{json .Config.Labels}}",
        "platehouse:release-amd64",
      ]);
    });

    test.each([
      ["version", "org.opencontainers.image.version", "0.1.0"],
      ["revision", "org.opencontainers.image.revision", "ffff"],
      ["source", "org.opencontainers.image.source", "https://example.invalid/fork"],
    ])("fails when the %s label is wrong, naming it", (_name, key, value) => {
      const labels = { ...goodLabels(), [key]: value };
      const res = run("local", "platehouse:release-amd64", labels);
      expect(res.status).toBe(1);
      expect(res.out).toContain(`::error::`);
      expect(res.out).toContain(key);
    });

    test.each([
      "org.opencontainers.image.version",
      "org.opencontainers.image.revision",
      "org.opencontainers.image.source",
      "org.opencontainers.image.created",
      "org.opencontainers.image.title",
      "org.opencontainers.image.url",
      "org.opencontainers.image.licenses",
      "org.opencontainers.image.description",
    ])("fails when %s is missing or empty", (key) => {
      const missing = goodLabels();
      delete missing[key];
      const gone = run("local", "platehouse:release-amd64", missing);
      expect(gone.status).toBe(1);
      expect(gone.out).toContain(key);
      const empty = run("local", "platehouse:release-amd64", { ...goodLabels(), [key]: "" });
      expect(empty.status).toBe(1);
      expect(empty.out).toContain(key);
    });

    test("fails when the image has no labels at all", () => {
      const res = run("local", "platehouse:release-amd64", null);
      expect(res.status).toBe(1);
      expect(res.out).toContain("org.opencontainers.image.version");
    });
  });

  describe("a pushed per-arch digest", () => {
    const ref = `ghcr.io/jonathanmcohen/platehouse@sha256:${"a".repeat(64)}`;

    test("passes with every label right, reading the config from the registry", () => {
      const res = run("pushed", ref, { config: { Labels: goodLabels() }, os: "linux" });
      expect(res.status, res.out).toBe(0);
      expect(res.args).toEqual([
        "buildx",
        "imagetools",
        "inspect",
        ref,
        "--format",
        "{{json .Image}}",
      ]);
    });

    test("fails when the pushed config lost a label", () => {
      const labels = goodLabels();
      delete labels["org.opencontainers.image.revision"];
      const res = run("pushed", ref, { config: { Labels: labels } });
      expect(res.status).toBe(1);
      expect(res.out).toContain("org.opencontainers.image.revision");
    });

    test("fails when the registry answers a manifest list rather than one image", () => {
      const res = run("pushed", ref, { "linux/amd64": { config: { Labels: goodLabels() } } });
      expect(res.status).toBe(1);
    });
  });

  describe("the multi-arch index", () => {
    const ref = `ghcr.io/jonathanmcohen/platehouse:${VERSION}`;

    test("passes with every annotation right, reading the raw index", () => {
      const res = run("index", ref, {
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.index.v1+json",
        manifests: [],
        annotations: goodLabels(),
      });
      expect(res.status, res.out).toBe(0);
      expect(res.args).toEqual(["buildx", "imagetools", "inspect", "--raw", ref]);
    });

    test("fails when the index carries no annotations", () => {
      const res = run("index", ref, { schemaVersion: 2, manifests: [] });
      expect(res.status).toBe(1);
      expect(res.out).toContain("org.opencontainers.image.version");
    });
  });

  test("refuses an unknown place to read from, or missing arguments, before running docker", () => {
    const bad = run("somewhere", "x", goodLabels());
    expect(bad.status).toBe(2);
    expect(bad.args).toEqual([]);
    const short = run("local", "x", goodLabels(), [VERSION]);
    expect(short.status).toBe(2);
    expect(short.args).toEqual([]);
  });

  test("fails when docker itself fails", () => {
    const bin = join(dir, "bin");
    spawnSync("mkdir", ["-p", bin]);
    writeFileSync(join(bin, "docker"), "#!/usr/bin/env bash\necho 'no such image' >&2\nexit 1\n");
    chmodSync(join(bin, "docker"), 0o755);
    const res = spawnSync("bash", [SCRIPT, "local", "x", VERSION, REVISION, SOURCE], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    expect(res.status).toBe(1);
  });
});

/** The lines of one job in the workflow, from its "  name:" key to the next job. */
function job(name: string): string {
  const lines = WORKFLOW.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  if (start === -1) throw new Error(`no job ${name}`);
  const end = lines.findIndex((l, i) => i > start && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

/** The text of each step in a job, split at its "      - name:" lines. */
function steps(jobText: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of jobText.split(/\n(?= {6}- name: )/).slice(1)) {
    const name = /^ {6}- name: (.+)$/m.exec(part)?.[1]?.trim();
    if (name !== undefined) out.set(name, part);
  }
  return out;
}

describe("release.yml sets the labels and reads them back", () => {
  const build = steps(job("build"));
  const merge = steps(job("merge"));

  test("the build job computes the labels with metadata-action, for the tag's semver version", () => {
    const meta = [...build.values()].find((s) => s.includes("id: labels"));
    expect(meta).toBeDefined();
    expect(meta).toContain("uses: docker/metadata-action@v6.2.0");
    expect(meta).toContain("type=semver,pattern={{version}}");
  });

  test("both builds, the tested load and the push by digest, carry the same labels", () => {
    const builds = [...build.values()].filter((s) => s.includes("uses: docker/build-push-action@"));
    expect(builds).toHaveLength(2);
    for (const step of builds)
      expect(step).toContain(`labels: ${D}{{ steps.labels.outputs.labels }}`);
  });

  test("the loaded image's labels are checked before anything is pushed", () => {
    const names = [...build.keys()];
    const check = names.findIndex((n) =>
      (build.get(n) ?? "").includes("check-image-labels.sh local"),
    );
    const push = names.indexOf("Push by digest");
    expect(check).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(check);
  });

  test("the index gets the annotations, and the merge reads back both digests and the index", () => {
    const meta = [...merge.values()].find((s) => s.includes("id: annotations"));
    expect(meta).toContain("uses: docker/metadata-action@v6.2.0");
    expect(meta).toContain("DOCKER_METADATA_ANNOTATIONS_LEVELS: index");
    const create = merge.get("Create the manifest list and check it") ?? "";
    expect(create).toContain("--annotation");
    expect(create).toContain(`check-image-labels.sh pushed "${D}{IMAGE}@${D}{amd64}"`);
    expect(create).toContain(`check-image-labels.sh pushed "${D}{IMAGE}@${D}{arm64}"`);
    expect(create).toContain(`check-image-labels.sh index "${D}{IMAGE}:${D}{VERSION}"`);
  });

  test("the merge job checks out the repository first, so the check script is there", () => {
    const names = [...merge.keys()];
    expect(names[0]).toBe("Check out");
    expect(merge.get("Check out")).toContain("uses: actions/checkout@v7.0.1");
  });
});
