// The app's slicer client against a slicer stub that
// answers only what slicer contract v2 allows. A 409 busy and a lost
// connection are told apart from a refusal, because the slice job retries the
// first two and records the third.
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  createSlicerClient,
  SliceBodyUnreadable,
  SlicerBusy,
  SlicerRefused,
  SlicerSandboxOff,
  SlicerUnreachable,
  sliceTimeoutMs,
} from "../../src/estimates/client.js";
import { build3mf } from "../integration/support/ingest.js";
import {
  type SlicerStub,
  STUB_FILAMENTS,
  STUB_PRINTERS,
  sandboxOff,
  startSlicerStub,
} from "../support/slicer-stub.js";

let stub: SlicerStub;

const P1S = "Bambu Lab P1S 0.4 nozzle";
const A1 = "Bambu Lab A1 0.4 nozzle";

function body(bytes: Buffer) {
  return { body: Readable.from([bytes]), size: bytes.length };
}

beforeAll(async () => {
  stub = await startSlicerStub();
});

afterAll(async () => {
  await stub?.stop();
});

beforeEach(() => {
  stub.onSlice(() => ({ kind: "ok" }));
  stub.setOrca("2.5.0");
});

describe("slicer client", () => {
  test("the HTTP timeout is the slicer's own kill time plus 30 s", () => {
    // The slicer kills a plate at SLICE_TIMEOUT_SECONDS, --mstpp + 60 by
    // default, and the app waits 30 s longer (Slicer HTTP contract v2).
    expect(sliceTimeoutMs(120)).toBe(210_000);
    expect(sliceTimeoutMs(600)).toBe(690_000);
  });

  test("health and profiles come back as the contract has them", async () => {
    const client = createSlicerClient({ url: stub.url, plateSeconds: 5 });
    expect(await client.health()).toEqual({
      contract: 2,
      orca: "2.5.0",
      openscad: "2026.11-RC0",
      busy: false,
      sandbox: { state: "on", reason: null, detail: null, allowUnsandboxed: false },
      timeouts: { sliceSeconds: 180, scadSeconds: 120, stepSeconds: 120, uploadSeconds: 600 },
    });
    const profiles = await client.profiles();
    expect(profiles.printers).toEqual(STUB_PRINTERS);
    expect(profiles.filaments).toEqual(STUB_FILAMENTS);
  });

  test("an ok slice returns its numbers and the preset used for each slot", async () => {
    const client = createSlicerClient({ url: stub.url, plateSeconds: 5 });
    const file = build3mf({ plates: 2 });
    const result = await client.slice({ printerId: P1S, plate: 2, ...body(file) });
    expect(result).toMatchObject({
      status: "ok",
      plate: 2,
      printer: P1S,
      orca: "2.5.0",
      timeSeconds: 1200,
      filamentProfiles: ["Bambu PLA Basic @BBL P1S", "Generic PETG @BBL P1S"],
    });
    expect(stub.calls.at(-1)).toEqual({ printer: P1S, plate: 2, bytes: file.length });
  });

  test("a slot with no preset for the printer comes back null", async () => {
    const client = createSlicerClient({ url: stub.url, plateSeconds: 5 });
    const result = await client.slice({
      printerId: A1,
      plate: 1,
      ...body(build3mf({ plates: 1 })),
    });
    expect(result.status === "ok" && result.filamentProfiles).toEqual([
      "Generic PLA @BBL A1",
      null,
    ]);
  });

  test("a refused plate is a failed result, not an error", async () => {
    stub.onSlice(() => ({ kind: "failed", code: -52, reason: "bed_too_small", detail: "outside" }));
    const client = createSlicerClient({ url: stub.url, plateSeconds: 5 });
    const result = await client.slice({
      printerId: P1S,
      plate: 1,
      ...body(build3mf({ plates: 1 })),
    });
    expect(result).toMatchObject({ status: "failed", code: -52, reason: "bed_too_small" });
  });

  test.each([0, -1, 129, 1.5, Number.NaN])(
    "plate %s is refused at the app with a plain message, with no slicer call",
    async (plate) => {
      const client = createSlicerClient({ url: stub.url, plateSeconds: 5 });
      const before = stub.calls.length;
      const refused = await client
        .slice({ printerId: P1S, plate, ...body(build3mf({ plates: 1 })) })
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(SlicerRefused);
      expect((refused as SlicerRefused).status).toBe(400);
      expect((refused as SlicerRefused).message).toBe(
        `Plate ${plate} is outside the 1 to 128 plates this server can estimate.`,
      );
      expect(stub.calls.length).toBe(before);
    },
  );

  test("the first and last plate numbers are sent", async () => {
    const client = createSlicerClient({ url: stub.url, plateSeconds: 5 });
    const before = stub.calls.length;
    for (const plate of [1, 128]) {
      await client.slice({ printerId: P1S, plate, ...body(build3mf({ plates: 1 })) });
    }
    expect(stub.calls.length).toBe(before + 2);
  });

  test("409 busy is SlicerBusy", async () => {
    stub.onSlice(() => ({ kind: "busy" }));
    const client = createSlicerClient({ url: stub.url, plateSeconds: 5 });
    await expect(
      client.slice({ printerId: P1S, plate: 1, ...body(build3mf({ plates: 1 })) }),
    ).rejects.toBeInstanceOf(SlicerBusy);
  });

  test("503 sandbox_off is SlicerSandboxOff, with its reason", async () => {
    const client = createSlicerClient({ url: stub.url, plateSeconds: 5 });
    for (const reason of ["old_kernel", "check_failed"] as const) {
      stub.onSlice(() => sandboxOff(reason));
      const error = await client
        .slice({ printerId: P1S, plate: 1, ...body(build3mf({ plates: 1 })) })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SlicerSandboxOff);
      expect((error as SlicerSandboxOff).reason).toBe(reason);
    }
  });

  test("a 503 that is not a valid sandbox_off body stays SlicerRefused", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(503, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ error: "sandbox_off", reason: "other", detail: "x" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      const client = createSlicerClient({
        url: `http://127.0.0.1:${address.port}`,
        plateSeconds: 5,
      });
      await expect(
        client.slice({ printerId: P1S, plate: 1, ...body(build3mf({ plates: 1 })) }),
      ).rejects.toMatchObject({ name: "SlicerRefused", status: 503 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("a busy answer to a large body is still SlicerBusy, not a lost connection", async () => {
    stub.onSlice(() => ({ kind: "busy" }));
    const client = createSlicerClient({ url: stub.url, plateSeconds: 5 });
    const big = Buffer.alloc(32 * 1024 * 1024, 7);
    await expect(client.slice({ printerId: P1S, plate: 1, ...body(big) })).rejects.toBeInstanceOf(
      SlicerBusy,
    );
  });

  test("a connection cut mid-slice is SlicerUnreachable", async () => {
    stub.onSlice(() => ({ kind: "drop" }));
    const client = createSlicerClient({ url: stub.url, plateSeconds: 5 });
    const error = await client
      .slice({ printerId: P1S, plate: 1, ...body(build3mf({ plates: 1 })) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SlicerUnreachable);
    // The slicer had the plate, so the plate may be what brought it down.
    expect((error as SlicerUnreachable).neverConnected).toBe(false);
  });

  test("a file that fails partway through being read is SliceBodyUnreadable, not a lost connection", async () => {
    // The stored .3mf comes from the bucket as a stream; a store that drops
    // the read mid-file is a store fault, and the slice job must not count it
    // as a connection the slicer accepted and then lost.
    const client = createSlicerClient({ url: stub.url, plateSeconds: 5 });
    const file = build3mf({ plates: 1 });
    let reads = 0;
    const broken = new Readable({
      read() {
        reads += 1;
        if (reads === 1) this.push(file.subarray(0, 16));
        else this.destroy(new Error("synthetic: the store dropped the read"));
      },
    });
    const error = await client
      .slice({ printerId: P1S, plate: 1, body: broken, size: file.length })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SliceBodyUnreadable);
    expect(error).not.toBeInstanceOf(SlicerUnreachable);
  });

  test("a slice that never answers is SlicerUnreachable after the timeout", async () => {
    stub.onSlice(() => ({ kind: "hang" }));
    const client = createSlicerClient({ url: stub.url, plateSeconds: 5, sliceTimeoutMs: 300 });
    await expect(
      client.slice({ printerId: P1S, plate: 1, ...body(build3mf({ plates: 1 })) }),
    ).rejects.toBeInstanceOf(SlicerUnreachable);
  });

  test("the answer timer starts when the body ends: a slow body then a slow answer succeeds", async () => {
    // Body 600 ms (under a 900 ms upload allowance), then an answer 600 ms
    // later (under a 900 ms answer allowance). One timer over both would
    // have run out at 900 ms.
    stub.onSlice(() => ({ kind: "ok" }));
    const gate = stub.hold();
    const file = build3mf({ plates: 1 });
    const cut = Math.ceil(file.length / 3);
    const slow = new Readable({ read() {} });
    const client = createSlicerClient({ url: stub.url, plateSeconds: 5 });
    const pending = client.slice({
      printerId: P1S,
      plate: 1,
      body: slow,
      size: file.length,
      timeouts: { uploadMs: 900, answerMs: 900 },
    });
    for (let i = 0; i < 3; i++) {
      slow.push(file.subarray(i * cut, (i + 1) * cut));
      await sleep(200);
    }
    slow.push(null);
    await sleep(600);
    gate.release();
    await expect(pending).resolves.toMatchObject({ status: "ok" });
  });

  test("a body that stalls fails after the upload allowance with SlicerUnreachable", async () => {
    const file = build3mf({ plates: 1 });
    let pushed = false;
    const stuck = new Readable({
      read() {
        if (!pushed) {
          pushed = true;
          this.push(file.subarray(0, 16));
        }
      },
    });
    const client = createSlicerClient({ url: stub.url, plateSeconds: 5 });
    const started = Date.now();
    const error = await client
      .slice({
        printerId: P1S,
        plate: 1,
        body: stuck,
        size: file.length,
        timeouts: { uploadMs: 300, answerMs: 60_000 },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SlicerUnreachable);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a slicer that is not listening is SlicerUnreachable", async () => {
    const down = await startSlicerStub();
    const url = down.url;
    await down.stop();
    const client = createSlicerClient({ url, plateSeconds: 5 });
    await expect(client.health()).rejects.toBeInstanceOf(SlicerUnreachable);
    const error = await client
      .slice({ printerId: P1S, plate: 1, ...body(build3mf({ plates: 1 })) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SlicerUnreachable);
    // No connection was made, so the slicer never saw the plate.
    expect((error as SlicerUnreachable).neverConnected).toBe(true);
  });

  test("a slicer that goes down refuses every connection until it is up again", async () => {
    const restarting = await startSlicerStub();
    try {
      const client = createSlicerClient({ url: restarting.url, plateSeconds: 5 });
      await expect(client.health()).resolves.toMatchObject({ orca: "2.5.0" });
      await restarting.down();
      // A pooled keep-alive connection the slicer has just closed reads as a
      // lost connection until the client sees it close.
      await sleep(100);
      const error = await client.health().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SlicerUnreachable);
      expect((error as SlicerUnreachable).neverConnected).toBe(true);
      await restarting.up();
      await expect(client.health()).resolves.toMatchObject({ orca: "2.5.0" });
    } finally {
      await restarting.stop();
    }
  });

  test("a body that is not a .3mf and an unknown printer are refusals", async () => {
    const client = createSlicerClient({ url: stub.url, plateSeconds: 5 });
    const notZip = client.slice({ printerId: P1S, plate: 1, ...body(Buffer.from("solid x")) });
    await expect(notZip).rejects.toBeInstanceOf(SlicerRefused);
    await expect(notZip).rejects.toMatchObject({ status: 422 });
    const unknown = client.slice({
      printerId: "Bambu Lab Q9 0.4 nozzle",
      plate: 1,
      ...body(build3mf({ plates: 1 })),
    });
    await expect(unknown).rejects.toMatchObject({ status: 400 });
  });

  test("an answer outside the contract is a refusal, not a result", async () => {
    // A slicer of another contract version, simulated by a stub that is not
    // the contract's: health reports contract 1.
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ contract: 1, orca: "9.9.9", openscad: "x", busy: false }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      const client = createSlicerClient({
        url: `http://127.0.0.1:${address.port}`,
        plateSeconds: 5,
      });
      const refused = client.health();
      await expect(refused).rejects.toBeInstanceOf(SlicerRefused);
      await expect(refused).rejects.toMatchObject({
        message: "The slicer's answer is not one slicer contract 2 allows",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
