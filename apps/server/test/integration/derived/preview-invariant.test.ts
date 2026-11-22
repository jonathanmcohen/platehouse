// Issue #389: a property test for the preview picture's status. Two review
// rounds each found another sequence (a replacement, a stale job, an outage)
// that left preview_status wrong, because each transition wrote the status
// itself. The invariant this test holds the code to, at every step:
//
// - a picture made from the file's current source is stored -> ok (shown);
// - else a preview job for the current source is queued or running -> pending;
// - else the newest preview attempt for the current source failed because of
//   the file -> failed, with a reason that is not retried;
// - else it failed because the slicer or storage stayed down -> failed, with
//   a reason that says it is tried again automatically (the backfill does);
// - else -> null, which the backfill picks up.
//
// A replacement that is not saved never changes the facts about the current
// source, so it never changes the picture's status.
//
// Each test is one seeded random sequence of: replacing the file (with a
// healthy or a broken source), running the oldest queued job normally, with
// the slicer down, with the slicer down past the 2-hour wait, or with the
// slicer failing on the last attempt, losing a job (it fails in pg-boss and
// the render check runs), and backfill and render check ticks. Jobs run in
// queue order, so an older job whose file has changed since runs stale.
// No slicer worker runs: the test runs every job itself, through runJob,
// as the queue's worker would. The expected status is computed here, from
// what the test can see for itself (the stored picture's bytes against the
// current source's, the live jobs, and the outcomes of the jobs it ran), not
// from the code under test. After the sequence, a drain (the slicer up,
// backfill ticks and every job run) must leave every file whose current
// source is healthy with its picture.
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createDerived,
  DERIVED_KINDS,
  type Derived,
  type DerivedJob,
  RENDER_CHECK_GRACE_MS,
} from "../../../src/derived/derived.js";
import { QUEUE } from "../../../src/jobs/queues.js";
import { renderedBytes } from "../../support/slicer-stub.js";
import {
  type DerivedEnv,
  meshPreviewBytes,
  meshStl,
  readObject,
  startDerivedEnv,
} from "../support/derived.js";
import { STEP_TEXT, writeUpload } from "../support/ingest.js";

let env: DerivedEnv;

beforeAll(async () => {
  env = await startDerivedEnv({ slicerWorker: false });
});

afterAll(async () => {
  await env?.stop();
});

const LIVE = new Set(["created", "retry", "active"]);
const PREVIEW_KINDS: readonly string[] = [DERIVED_KINDS.renderStl, DERIVED_KINDS.previewStep];
const BROKEN_MESSAGE = "ERROR: STL import: this synthetic source is broken";

/** A small seeded PRNG (mulberry32), so a failing sequence can be run again. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** STL preview bodies the stub answers as OpenSCAD rejecting them, by SHA-256. */
const brokenBodies = new Set<string>();

function stlText(label: string): string {
  const name = `${label}_${randomBytes(6).toString("hex")}`;
  return (
    `solid ${name}\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n` +
    `   vertex 0 1 0\n  endloop\n endfacet\nendsolid ${name}\n`
  );
}

function stepText(label: string): string {
  return STEP_TEXT.replace(
    "HEADER;\n",
    `HEADER;\n/* ${label} ${randomBytes(6).toString("hex")} */\n`,
  );
}

type Kind = "stl" | "step";
type Category = "file" | "outage";
type Expected = { status: "ok" | "pending" | "failed" | null; category?: Category };

/** The body the slicer is sent for a source's preview. */
async function previewBody(kind: Kind, text: string): Promise<Buffer> {
  return kind === "stl" ? Buffer.from(text) : meshStl(renderedBytes("/v1/step/glb", text));
}

/** The picture the stub renders for a source. */
async function pictureOf(kind: Kind, text: string): Promise<Buffer> {
  return kind === "stl"
    ? renderedBytes("/v1/stl/png", text)
    : meshPreviewBytes(renderedBytes("/v1/step/glb", text));
}

class Sequence {
  readonly rand: () => number;
  readonly derived: Derived;
  clock = Date.now();
  fileId = "";
  modelId = "";
  /** Every source the file has had or been offered, by blob id. */
  readonly texts = new Map<string, { text: string; broken: boolean }>();
  /** The outcome of the newest finished preview attempt for each source. */
  readonly lastFailure = new Map<string, Category>();
  /** Attempts already used by a job the test left queued after it threw. */
  readonly attempts = new Map<string, number>();
  slicerDown = false;
  readonly log: string[] = [];
  readonly seed: number;
  readonly kind: Kind;

  constructor(seed: number, kind: Kind) {
    this.seed = seed;
    this.kind = kind;
    this.rand = prng(seed);
    this.derived = createDerived({
      db: env.db,
      store: env.store,
      slicerUrl: env.stub.url,
      queue: env.boss,
      retryDelaySeconds: 1,
      now: () => new Date(this.clock),
    });
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.rand() * items.length)] as T;
  }

  async newSource(broken: boolean): Promise<string> {
    const text =
      this.kind === "stl" ? stlText(broken ? "broken" : "ok") : stepText(broken ? "broken" : "ok");
    if (broken) brokenBodies.add(sha(await previewBody(this.kind, text)));
    return text;
  }

  async upload(): Promise<void> {
    const broken = this.rand() < 0.2;
    const text = await this.newSource(broken);
    const stored = await env.ingestDerived.ingestFile({
      tmpPath: await writeUpload(env, text),
      originalName: this.kind === "stl" ? "Seq.stl" : "Seq.step",
      target: "new",
    });
    this.fileId = stored.fileId;
    this.modelId = stored.modelId;
    const file = await env.repos.files.get(stored.fileId);
    if (!file) throw new Error("no file");
    this.texts.set(file.blobId, { text, broken });
    this.log.push(`upload ${broken ? "broken" : "healthy"}`);
  }

  async replace(broken: boolean): Promise<void> {
    const text = await this.newSource(broken);
    const { sourceBlobId } = await this.derived.replaceFile(
      this.fileId,
      await writeUpload(env, text),
    );
    this.texts.set(sourceBlobId, { text, broken });
    this.log.push(`replace ${broken ? "broken" : "healthy"}`);
  }

  async liveJobs() {
    return (
      await env.boss.findJobs<DerivedJob>(QUEUE.slicer, { data: { fileId: this.fileId } })
    ).filter((j) => LIVE.has(j.state));
  }

  async setSlicer(down: boolean): Promise<void> {
    if (down && !this.slicerDown) await env.stub.down();
    if (!down && this.slicerDown) await env.stub.up();
    this.slicerDown = down;
  }

  normalStub(): void {
    env.stub.renders.reset();
    env.stub.renders.decide((route, body) =>
      route === "/v1/stl/png" && brokenBodies.has(sha(body))
        ? { kind: "failed", message: BROKEN_MESSAGE }
        : undefined,
    );
  }

  /** Runs the oldest live job of the file, as the queue's worker would, and records its outcome. */
  async runOldest(opts: { lastAttempt?: boolean } = {}): Promise<string> {
    const job = (await this.liveJobs())[0];
    if (!job) return "no job";
    const used = this.attempts.get(job.id) ?? 0;
    // A variable, not a literal, so an attempt carrying the job's id passes
    // to a runJob that does not take one.
    const attempt = {
      retryCount: opts.lastAttempt ? job.retryLimit : used,
      retryLimit: job.retryLimit,
      jobId: job.id,
    };
    let outcome: { status: string; reason?: string };
    try {
      outcome = await this.derived.runJob(job.data, attempt);
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name !== "SlicerBusy" && name !== "SlicerUnreachable") throw error;
      this.attempts.set(job.id, used + 1);
      return `${job.data.kind} threw ${name}`;
    }
    await env.boss.cancel(QUEUE.slicer, job.id);
    if (PREVIEW_KINDS.includes(job.data.kind)) {
      const source = job.data.sourceBlobId;
      if (outcome.status === "ok") this.lastFailure.delete(source);
      if (outcome.status === "failed") {
        const outage = outcome.reason === "slicer_down" || outcome.reason === "store_down";
        this.lastFailure.set(source, outage ? "outage" : "file");
      }
    }
    return `${job.data.kind} ${outcome.status}${outcome.reason ? ` ${outcome.reason}` : ""}`;
  }

  /** A job that dies: pg-boss fails it on every attempt, then the render check runs. */
  async lose(): Promise<string> {
    const job = (await this.liveJobs())[0];
    if (!job) return "no job";
    for (let i = 0; i <= job.retryLimit + 1; i++) {
      const now = await env.boss.getJobById(QUEUE.slicer, job.id);
      if (!now || now.state === "failed") break;
      await env.boss.fail(QUEUE.slicer, job.id, { message: "the process died" });
    }
    const file = await env.repos.files.get(this.fileId);
    if (PREVIEW_KINDS.includes(job.data.kind) && file && job.data.sourceBlobId === file.blobId) {
      // It counts as the source's newest attempt only when no newer preview
      // job for the same source exists.
      const all = await env.boss.findJobs<DerivedJob>(QUEUE.slicer, {
        data: { fileId: this.fileId },
      });
      const forSource = all.filter(
        (j) => PREVIEW_KINDS.includes(j.data.kind) && j.data.sourceBlobId === file.blobId,
      );
      const anyLive = forSource.some((j) => LIVE.has(j.state));
      if (forSource.at(-1)?.id === job.id && !anyLive) this.lastFailure.set(file.blobId, "file");
    }
    await this.derived.checkRenders(new Date(Date.now() + RENDER_CHECK_GRACE_MS + 60_000));
    return `lost ${job.data.kind}`;
  }

  async backfill(): Promise<void> {
    await this.derived.backfillPreviews(new Date(Date.now() + RENDER_CHECK_GRACE_MS + 60_000));
  }

  async check(): Promise<void> {
    await this.derived.checkRenders(new Date(Date.now() + RENDER_CHECK_GRACE_MS + 60_000));
  }

  /** The status the invariant asks for, from what the test can see for itself. */
  async expected(): Promise<Expected> {
    const file = await env.repos.files.get(this.fileId);
    if (!file) throw new Error("file vanished");
    const current = this.texts.get(file.blobId);
    if (!current) throw new Error("the file's source is not one the test made");
    if (file.renderPngBlobId !== null) {
      const png = await env.repos.blobs.get(file.renderPngBlobId);
      if (png?.state === "stored") {
        const bytes = await readObject(env, png.key);
        if (bytes.equals(await pictureOf(this.kind, current.text))) return { status: "ok" };
      }
    }
    const live = (await this.liveJobs()).some(
      (j) => PREVIEW_KINDS.includes(j.data.kind) && j.data.sourceBlobId === file.blobId,
    );
    if (live) return { status: "pending" };
    const failure = this.lastFailure.get(file.blobId);
    if (failure !== undefined) return { status: "failed", category: failure };
    return { status: null };
  }

  async assertInvariant(step: string): Promise<void> {
    const want = await this.expected();
    const file = await env.repos.files.get(this.fileId);
    const where = `seed ${this.seed} (${this.kind}) after ${this.log.length} steps: ${this.log.join(" | ")} | now ${step}`;
    expect(file?.previewStatus ?? null, where).toBe(want.status);
    if (want.status === "failed") {
      const said = file?.previewMessage ?? "";
      if (want.category === "outage") expect(said, where).toMatch(/tried again automatically/i);
      else expect(said, where).not.toMatch(/tried again automatically/i);
    }
    if (want.status !== "failed") expect(file?.previewMessage ?? null, where).toBeNull();
  }

  async step(): Promise<void> {
    const action = this.pick([
      "replaceHealthy",
      "replaceBroken",
      "run",
      "run",
      "run",
      "outage",
      "outageExpired",
      "slicerError",
      "lose",
      "backfill",
      "check",
    ] as const);
    let detail = action as string;
    this.normalStub();
    switch (action) {
      case "replaceHealthy":
        await this.replace(false);
        break;
      case "replaceBroken":
        await this.replace(true);
        break;
      case "run":
        await this.setSlicer(false);
        detail = `run: ${await this.runOldest()}`;
        break;
      case "outage":
        await this.setSlicer(true);
        detail = `outage: ${await this.runOldest()}`;
        await this.setSlicer(false);
        break;
      case "outageExpired": {
        await this.setSlicer(true);
        const first = await this.runOldest();
        this.clock += 3 * 60 * 60 * 1000;
        const second = await this.runOldest();
        detail = `outage past 2 h: ${first}; ${second}`;
        await this.setSlicer(false);
        break;
      }
      case "slicerError":
        env.stub.renders.always("/v1/stl/png", { kind: "busy" });
        env.stub.renders.always("/v1/step/glb", { kind: "busy" });
        detail = `slicer error: ${await this.runOldest({ lastAttempt: true })}`;
        break;
      case "lose":
        detail = await this.lose();
        break;
      case "backfill":
        await this.backfill();
        break;
      case "check":
        await this.check();
        break;
    }
    if (!detail.includes("replace")) this.log.push(detail);
    await this.assertInvariant(detail);
  }

  /** The slicer up and healthy, backfill ticks and every job run, until nothing is left to do. */
  async drain(): Promise<void> {
    await this.setSlicer(false);
    this.normalStub();
    for (let round = 0; round < 8; round++) {
      await this.backfill();
      for (let i = 0; i < 20 && (await this.liveJobs()).length > 0; i++) {
        this.log.push(`drain: ${await this.runOldest()}`);
        await this.assertInvariant("drain");
      }
      await this.check();
      await this.assertInvariant("drain check");
      if ((await this.liveJobs()).length === 0 && round > 0) break;
    }
    const file = await env.repos.files.get(this.fileId);
    if (!file) throw new Error("file vanished");
    const current = this.texts.get(file.blobId);
    const healthy =
      current !== undefined &&
      !current.broken &&
      this.lastFailure.get(file.blobId) !== "file" &&
      (this.kind === "stl" || file.derivedStatus === "ok");
    const where = `seed ${this.seed} (${this.kind}): ${this.log.join(" | ")}`;
    if (healthy) {
      expect(file.previewStatus, where).toBe("ok");
      expect(await this.expected(), where).toEqual({ status: "ok" });
    }
  }
}

const SEEDS = [11, 23, 37, 41, 53, 67, 79, 83, 97, 101, 113, 127];

describe("the preview picture's status is always a function of stored facts (issue #389)", () => {
  test.each(SEEDS)("seeded sequence %i", async (seed) => {
    const run = new Sequence(seed, seed % 2 === 0 ? "step" : "stl");
    run.normalStub();
    await run.upload();
    await run.assertInvariant("upload");
    const steps = 10 + Math.floor(run.rand() * 6);
    try {
      for (let i = 0; i < steps; i++) await run.step();
      await run.drain();
    } finally {
      await run.setSlicer(false);
      env.stub.renders.reset();
    }
  });
});
