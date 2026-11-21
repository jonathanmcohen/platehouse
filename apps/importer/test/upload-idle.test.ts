// A file upload's time limit is an idle limit, like a download's: a PATCH
// fails only when Platehouse takes no byte, and sends no answer, for that
// long, never because the whole file takes longer (issue #354). It used to
// be one fixed 30-minute cap on each PATCH, and a timed-out PATCH used up an
// attempt even when Platehouse had kept part of it, so a large file over a
// slow link failed after attempts x 30 minutes while bytes kept arriving.
// The limit is --upload-idle-timeout or PLATEHOUSE_UPLOAD_IDLE_TIMEOUT, in
// seconds. Platehouse keeps the bytes of a PATCH that is cut off, so a
// failed PATCH that moved the upload's offset forward resumes from there
// without using up an attempt.
//
// The client tests below call createPlatehouse with a fetch that plays
// Platehouse's upload routes on real timers. Its PATCH reads the request
// body as Platehouse does, keeps what it read, and, like the real fetch,
// rejects when the request's signal aborts. The command-line tests use the
// MSW stubs, except for the one stalled upload.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { createPlatehouse, PlatehouseError } from "../src/platehouse.js";
import { ENV, PLATEHOUSE, setup, useServer } from "./support/harness.js";
import { library } from "./support/library.js";

useServer();

const BASE = "https://platehouse.test.invalid";
const UPLOAD = "/api/v1/uploads/u1";
const MODEL_ID = "m-1";
const FILE_ID = "f-1";

/**
 * How the fake's PATCH reads the body:
 * - slow: reads each chunk `every` ms after the last, then answers 204;
 * - stall: keeps the first `take` bytes it reads, then reads nothing more
 *   and never answers;
 * - cut: keeps the first `take` bytes, then the connection drops;
 * - script: the nth PATCH keeps takes[n] bytes and then the connection
 *   drops; a PATCH past the list takes the rest and answers 204.
 */
type PatchMode =
  | { kind: "slow"; every: number }
  | { kind: "stall"; take: number }
  | { kind: "cut"; take: number }
  | { kind: "script"; takes: number[] };

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Rejects with the signal's reason once it aborts. */
function aborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** A reader over a request body, a stream or a buffer. */
function readerOf(body: RequestInit["body"]): ReadableStreamDefaultReader<Uint8Array> {
  if (body instanceof ReadableStream) return body.getReader();
  const bytes = new Uint8Array(body as ArrayBufferLike);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }).getReader();
}

function fakePlatehouse(length: number, mode: PatchMode, headStatus = 200) {
  const stored: Buffer[] = [];
  let offset = 0;
  const patches: number[] = [];
  /** Each PATCH's Content-Length, which must be the rest of the file. */
  const lengths: number[] = [];
  const keep = (chunk: Uint8Array, room: number) => {
    const part = Buffer.from(chunk.subarray(0, Math.max(0, room)));
    stored.push(part);
    offset += part.length;
    return part.length;
  };

  async function patch(init: RequestInit): Promise<Response> {
    const signal = init.signal ?? undefined;
    const reader = readerOf(init.body);
    const headers = new Headers(init.headers);
    patches.push(Number(headers.get("upload-offset")));
    lengths.push(Number(headers.get("content-length")));
    if (mode.kind === "slow") {
      for (;;) {
        await Promise.race([wait(mode.every), aborted(signal)]);
        const { done, value } = await Promise.race([reader.read(), aborted(signal)]);
        if (done) break;
        keep(value, length - offset);
      }
      return new Response(null, { status: 204, headers: { "upload-offset": String(offset) } });
    }
    const scripted = mode.kind === "script" ? mode.takes[patches.length - 1] : undefined;
    const take = mode.kind === "script" ? (scripted ?? length) : mode.take;
    let taken = 0;
    while (taken < take && offset < length) {
      const { done, value } = await Promise.race([reader.read(), aborted(signal)]);
      if (done) break;
      taken += keep(value, Math.min(take - taken, length - offset));
    }
    if (mode.kind === "script" && scripted === undefined) {
      return new Response(null, { status: 204, headers: { "upload-offset": String(offset) } });
    }
    if (mode.kind === "cut" || mode.kind === "script") throw new TypeError("fetch failed");
    return aborted(signal);
  }

  const impl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init.method ?? "GET";
    if (method === "POST" && url.pathname === "/api/v1/uploads") {
      return new Response(null, { status: 201, headers: { location: UPLOAD } });
    }
    if (method === "PATCH" && url.pathname === UPLOAD) return patch(init);
    if (method === "HEAD" && url.pathname === UPLOAD) {
      if (headStatus !== 200) return new Response(null, { status: headStatus });
      return new Response(null, { status: 200, headers: { "upload-offset": String(offset) } });
    }
    if (method === "GET" && url.pathname === `${UPLOAD}/result`) {
      return Response.json({ status: "done", modelId: MODEL_ID, fileId: FILE_ID });
    }
    if (method === "GET" && url.pathname === `/api/v1/files/${FILE_ID}`) {
      const all = Buffer.concat(stored);
      return Response.json({
        id: FILE_ID,
        modelId: MODEL_ID,
        name: "box.3mf",
        size: all.length,
        sha256: createHash("sha256").update(all).digest("hex"),
      });
    }
    return new Response(null, { status: 404 });
  };
  return { fetch: impl as typeof fetch, patches, lengths, stored: () => Buffer.concat(stored) };
}

function client(
  length: number,
  mode: PatchMode,
  opts: { idleMs: number; retries?: number; headStatus?: number },
) {
  const fake = fakePlatehouse(length, mode, opts.headStatus);
  const platehouse = createPlatehouse({
    base: BASE,
    bearer: "stub-bearer",
    fetch: fake.fetch,
    sleep: async () => {},
    uploadTimeoutMs: opts.idleMs,
    ...(opts.retries === undefined ? {} : { retries: opts.retries }),
  });
  return { platehouse, ...fake };
}

/** A file of this length whose bytes are not all the same, so a misplaced piece shows. */
function fileOf(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) bytes[i] = i % 251;
  return bytes;
}

describe("a file upload's time limit", () => {
  it("lets an upload that takes longer than the limit in total finish while bytes keep being taken", async () => {
    // Read in 64 KiB chunks 40 ms apart: about 360 ms in all, never 150 ms
    // without taking a byte.
    const bytes = fileOf(8 * 65_536);
    const { platehouse, patches, lengths, stored } = client(
      bytes.length,
      { kind: "slow", every: 40 },
      { idleMs: 150 },
    );
    const file = await platehouse.upload(MODEL_ID, "box.3mf", bytes);
    expect(file.size).toBe(bytes.length);
    expect(stored().equals(bytes)).toBe(true);
    expect(patches).toEqual([0]);
    // A fixed-length request, as when the body was one buffer.
    expect(lengths).toEqual([bytes.length]);
  });

  it("fails an upload Platehouse stops taking, naming the idle limit, without waiting for the whole transfer", async () => {
    const { platehouse, patches } = client(200_000, { kind: "stall", take: 0 }, { idleMs: 100 });
    const started = Date.now();
    const error = await platehouse.upload(MODEL_ID, "box.3mf", fileOf(200_000)).catch((e) => e);
    expect(error).toBeInstanceOf(PlatehouseError);
    expect((error as Error).message).toBe(`PATCH ${UPLOAD}: no progress for 0.1 s`);
    expect(patches).toEqual([0, 0, 0, 0]);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("resumes a PATCH that stalled after Platehouse kept part of it, without using up an attempt", async () => {
    // Each PATCH is kept for 100 000 bytes and then stalls. Two attempts
    // would run out on the second stall if a stall that moved the offset
    // used one up.
    const bytes = fileOf(300_000);
    const { platehouse, patches, stored } = client(
      bytes.length,
      { kind: "stall", take: 100_000 },
      { idleMs: 100, retries: 2 },
    );
    const file = await platehouse.upload(MODEL_ID, "box.3mf", bytes);
    expect(file.size).toBe(bytes.length);
    expect(stored().equals(bytes)).toBe(true);
    expect(patches).toEqual([0, 100_000, 200_000]);
  });
});

describe("a failed PATCH that moved the upload's offset forward", () => {
  it("does not use up an attempt, so a cut-off upload that keeps moving finishes", async () => {
    const bytes = fileOf(6000);
    const { platehouse, patches, lengths, stored } = client(
      bytes.length,
      { kind: "cut", take: 1000 },
      { idleMs: 60_000, retries: 2 },
    );
    const file = await platehouse.upload(MODEL_ID, "box.3mf", bytes);
    expect(file.size).toBe(6000);
    expect(stored().equals(bytes)).toBe(true);
    expect(patches).toEqual([0, 1000, 2000, 3000, 4000, 5000]);
    expect(lengths).toEqual([6000, 5000, 4000, 3000, 2000, 1000]);
  });

  it("gives back every attempt, so the failures after it are counted from the start again", async () => {
    // Three attempts: the first PATCH moves the offset, then two move
    // nothing, then one finishes. Counted without the progress, the third
    // failure in a row would end the upload.
    const bytes = fileOf(3000);
    const { platehouse, patches, stored } = client(
      bytes.length,
      { kind: "script", takes: [1000, 0, 0] },
      { idleMs: 60_000, retries: 3 },
    );
    const file = await platehouse.upload(MODEL_ID, "box.3mf", bytes);
    expect(file.size).toBe(3000);
    expect(stored().equals(bytes)).toBe(true);
    expect(patches).toEqual([0, 1000, 1000, 1000]);
  });

  it("with one attempt in all, an upload that keeps moving still finishes", async () => {
    // Every attempt is the last one here, so the upload is asked where it
    // stands after the last attempt too, rather than given up at once.
    const bytes = fileOf(3000);
    const { platehouse, patches, stored } = client(
      bytes.length,
      { kind: "cut", take: 1000 },
      { idleMs: 60_000, retries: 1 },
    );
    const file = await platehouse.upload(MODEL_ID, "box.3mf", bytes);
    expect(file.size).toBe(3000);
    expect(stored().equals(bytes)).toBe(true);
    expect(patches).toEqual([0, 1000, 2000]);
  });

  it("keeps the PATCH's own problem as the error when asking where the upload stands fails after the last attempt", async () => {
    const { platehouse } = client(
      3000,
      { kind: "cut", take: 0 },
      { idleMs: 60_000, retries: 1, headStatus: 500 },
    );
    const error = await platehouse.upload(MODEL_ID, "box.3mf", fileOf(3000)).catch((e) => e);
    expect((error as Error).message).toBe(`PATCH ${UPLOAD}: fetch failed`);
  });

  it("still fails after the attempts when the offset does not move", async () => {
    const { platehouse, patches } = client(
      6000,
      { kind: "cut", take: 0 },
      { idleMs: 60_000, retries: 3 },
    );
    const error = await platehouse.upload(MODEL_ID, "box.3mf", fileOf(6000)).catch((e) => e);
    expect(error).toBeInstanceOf(PlatehouseError);
    expect((error as Error).message).toBe(`PATCH ${UPLOAD}: fetch failed`);
    expect(patches).toEqual([0, 0, 0]);
  });
});

describe("--upload-idle-timeout and PLATEHOUSE_UPLOAD_IDLE_TIMEOUT", () => {
  it.each(["0", "-1", "1.5", "abc", "86401", ""])(
    "refuse %j for the flag with exit 2 before anything is read",
    async (value) => {
      const s = setup(library());
      const r = await s.run([`--upload-idle-timeout=${value}`]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(
        "--upload-idle-timeout takes a whole number of seconds from 1 to 86400",
      );
      expect(s.manyfold.tokenRequests).toHaveLength(0);
    },
  );

  it("refuses a bad PLATEHOUSE_UPLOAD_IDLE_TIMEOUT with exit 2, naming the variable", async () => {
    const s = setup(library());
    const r = await s.run([], { ...ENV, PLATEHOUSE_UPLOAD_IDLE_TIMEOUT: "soon" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      "PLATEHOUSE_UPLOAD_IDLE_TIMEOUT takes a whole number of seconds from 1 to 86400",
    );
  });

  it("lists the flag and the variable in the usage text", async () => {
    const s = setup(library());
    const r = await s.run(["--no-such-flag"]);
    expect(r.code).toBe(2);
    expect(r.output).toContain("--upload-idle-timeout <seconds>");
    expect(r.output).toContain("PLATEHOUSE_UPLOAD_IDLE_TIMEOUT");
  });

  it.each([
    ["the flag", ["--apply", "--model", "m3", "--upload-idle-timeout", "1"], ENV],
    ["the variable", ["--apply", "--model", "m3"], { ...ENV, PLATEHOUSE_UPLOAD_IDLE_TIMEOUT: "1" }],
  ])(
    "applies %s to an upload that stalls",
    async (_, argv, env) => {
      setup(library());
      // The stalled PATCH is served here rather than by MSW, as the stalled
      // download is in download-idle.test.ts; everything else goes to the
      // stubs. It reads nothing, answers nothing and rejects on abort.
      const fetchWithStall = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (init?.method !== "PATCH" || !url.startsWith(`${PLATEHOUSE}/api/v1/uploads/`)) {
          return globalThis.fetch(input, init);
        }
        return aborted(init.signal ?? undefined);
      }) as typeof fetch;
      const stderr: string[] = [];
      const r = await run({
        argv,
        env,
        stdout: () => {},
        stderr: (line) => stderr.push(line),
        fetch: fetchWithStall,
        sleep: async () => {},
      });
      expect(stderr).toEqual([]);
      expect(r.code).toBe(1);
      const m3 = r.report?.models.find((m) => m.manyfoldId === "m3");
      expect(m3?.files[0]?.status).toBe("failed");
      expect(m3?.files[0]?.reason).toMatch(
        /^upload: PATCH \/api\/v1\/uploads\/[^ ]+: no progress for 1 s$/,
      );
    },
    15_000,
  );
});
