// Errors the importer did not expect (security minor 3): the catch-all in
// run(), an error thrown by fetch itself, and errors raised outside run()
// that reach the process as an uncaught exception or an unhandled rejection.
// Each goes through the redactor and exits 2 when the run had not started.
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { onFatal, run } from "../src/cli.js";
import { createRedactor, REDACTED } from "../src/redact.js";
import {
  ENV,
  FAKE_BEARER,
  FAKE_KEY,
  MANYFOLD,
  PLATEHOUSE,
  setup,
  useServer,
} from "./support/harness.js";
import { library } from "./support/library.js";

useServer();

const noSleep = async () => {};

describe("the catch-all in run()", () => {
  it("prints an error thrown before the run started through the redactor, and exits 2", async () => {
    setup(library());
    const stderr: string[] = [];
    const r = await run({
      argv: [],
      env: ENV,
      stdout: () => {
        throw new Error(`stdout broke on ${FAKE_BEARER}`);
      },
      stderr: (line) => stderr.push(line),
      sleep: noSleep,
      manyfoldBase: MANYFOLD,
      platehouseBase: PLATEHOUSE,
    });
    expect(r.code).toBe(2);
    expect(stderr).toEqual([`platehouse-import: unexpected error: stdout broke on ${REDACTED}`]);
  });

  it("prints an error thrown once models were reported through the redactor, and exits 1", async () => {
    setup(library());
    const stderr: string[] = [];
    const r = await run({
      argv: [],
      env: ENV,
      stdout: (line) => {
        if (line.includes("Benchy Stand")) throw new Error(`write failed\u0007 ${FAKE_KEY}`);
      },
      stderr: (line) => stderr.push(line),
      sleep: noSleep,
      manyfoldBase: MANYFOLD,
      platehouseBase: PLATEHOUSE,
    });
    expect(r.code).toBe(1);
    expect(stderr).toEqual([`platehouse-import: unexpected error: write failed ${REDACTED}`]);
  });

  it("redacts an error that fetch itself throws with a credential in its message", async () => {
    const stderr: string[] = [];
    const stdout: string[] = [];
    const r = await run({
      argv: ["--apply"],
      env: ENV,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      sleep: noSleep,
      fetch: async () => {
        throw new Error(`socket closed after ${FAKE_BEARER} and ${FAKE_KEY}`);
      },
      manyfoldBase: MANYFOLD,
      platehouseBase: PLATEHOUSE,
    });
    expect(r.code).toBe(2);
    const output = [...stdout, ...stderr].join("\n");
    expect(output).not.toContain(FAKE_BEARER);
    expect(output).not.toContain(FAKE_KEY);
    expect(stderr).toEqual([
      `could not start: GET /api/v1/models: socket closed after ${REDACTED} and ${REDACTED}`,
    ]);
  });
});

describe("errors raised outside run()", () => {
  function harness(secrets: string[] = []) {
    const target = new EventEmitter();
    const lines: string[] = [];
    const exits: number[] = [];
    const redactor = createRedactor(secrets);
    const fail = onFatal(
      target,
      redactor,
      (line) => lines.push(line),
      (code) => exits.push(code),
    );
    return { target, lines, exits, redactor, fail };
  }

  it("prints an uncaught exception through the redactor and exits 2", () => {
    const h = harness([FAKE_KEY]);
    h.target.emit("uncaughtException", new Error(`boom ${FAKE_KEY}\u001b[2J`));
    expect(h.lines).toEqual([`platehouse-import: unexpected error: boom ${REDACTED}[2J`]);
    expect(h.exits).toEqual([2]);
  });

  it("prints an unhandled rejection that is not an Error through the redactor and exits 2", () => {
    const h = harness([FAKE_BEARER]);
    h.target.emit("unhandledRejection", `lost ${FAKE_BEARER}`);
    expect(h.lines).toEqual([`platehouse-import: unexpected error: lost ${REDACTED}`]);
    expect(h.exits).toEqual([2]);
  });

  it("prints only the message, never the stack", () => {
    const h = harness();
    const error = new Error("plain");
    error.stack = `Error: plain\n    at secret-place (${FAKE_KEY})`;
    h.target.emit("uncaughtException", error);
    expect(h.lines).toEqual(["platehouse-import: unexpected error: plain"]);
  });

  it("knows the credentials run() was given, when they share one redactor", async () => {
    setup(library());
    const h = harness();
    const r = await run({
      argv: [],
      env: ENV,
      stdout: () => {},
      stderr: () => {},
      sleep: noSleep,
      manyfoldBase: MANYFOLD,
      platehouseBase: PLATEHOUSE,
      redactor: h.redactor,
    });
    expect(r.code).toBe(0);
    h.fail(new Error(`late failure with ${FAKE_BEARER}`));
    expect(h.lines).toEqual([`platehouse-import: unexpected error: late failure with ${REDACTED}`]);
    expect(h.exits).toEqual([2]);
  });
});
