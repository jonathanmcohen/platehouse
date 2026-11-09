// Build plan Task 12: the app's slicer client against a slicer stub that
// answers only what slicer contract v1 allows. A 409 busy and a lost
// connection are told apart from a refusal, because the slice job retries the
// first two and records the third.
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  createSlicerClient,
  SlicerBusy,
  SlicerRefused,
  SlicerUnreachable,
  sliceTimeoutMs,
} from "../../src/estimates/client.js";
import { build3mf } from "../integration/support/ingest.js";
import {
  type SlicerStub,
  STUB_FILAMENTS,
  STUB_PRINTERS,
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
    // default, and the app waits 30 s longer (Slicer HTTP contract v1).
    expect(sliceTimeoutMs(120)).toBe(210_000);
    expect(sliceTimeoutMs(600)).toBe(690_000);
  });

  test("health and profiles come back as the contract has them", async () => {
    const client = createSlicerClient({ url: stub.url, plateSeconds: 5 });
    expect(await client.health()).toEqual({
      contract: 1,
      orca: "2.5.0",
      openscad: "2026.11-RC0",
      busy: false,
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

  test("409 busy is SlicerBusy", async () => {
    stub.onSlice(() => ({ kind: "busy" }));
    const client = createSlicerClient({ url: stub.url, plateSeconds: 5 });
    await expect(
      client.slice({ printerId: P1S, plate: 1, ...body(build3mf({ plates: 1 })) }),
    ).rejects.toBeInstanceOf(SlicerBusy);
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

  test("a slice that never answers is SlicerUnreachable after the timeout", async () => {
    stub.onSlice(() => ({ kind: "hang" }));
    const client = createSlicerClient({ url: stub.url, plateSeconds: 5, sliceTimeoutMs: 300 });
    await expect(
      client.slice({ printerId: P1S, plate: 1, ...body(build3mf({ plates: 1 })) }),
    ).rejects.toBeInstanceOf(SlicerUnreachable);
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
    // the contract's: health reports contract 2.
    const { createServer } = await import("node:http");
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ contract: 2, orca: "9.9.9", openscad: "x", busy: false }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      const client = createSlicerClient({
        url: `http://127.0.0.1:${address.port}`,
        plateSeconds: 5,
      });
      await expect(client.health()).rejects.toBeInstanceOf(SlicerRefused);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
