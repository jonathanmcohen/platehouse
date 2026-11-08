// check-profile-version.mjs compares the version in the BBL.json the gate
// fetches from Orca's source with the version stamped in the BBL.opc Orca's
// AppImage ships. The .opc layout below follows OrcaSlicer
// src/libslic3r/PresetCacheFormat.cpp at v2.5.0: a 20-byte header (magic
// "ZCRO" = 0x4F52435A little-endian, format version, body size, CRC-32), then
// the body: the cache version (uint32), the vendor name and the vendor
// version, each a uint64 length and its bytes. Orca writes the version as
// Semver::parse(BBL.json version).to_string(), so 02.08.00.16 is 2.8.0.16.
// The buffers here are crafted; no Orca file is committed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readOpcStamp, sameVersion } from "../check-profile-version.mjs";

const CHECK = join(dirname(fileURLToPath(import.meta.url)), "..", "check-profile-version.mjs");
const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function str(s) {
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(Buffer.byteLength(s)));
  return Buffer.concat([len, Buffer.from(s)]);
}

function opc({ magic = 0x4f52435a, format = 2, cacheVersion = 2, vendor = "BBL", version = "2.8.0.16", rest = Buffer.from("rest") } = {}) {
  const cv = Buffer.alloc(4);
  cv.writeUInt32LE(cacheVersion);
  const body = Buffer.concat([cv, str(vendor), str(version), rest]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(magic, 0);
  header.writeUInt32LE(format, 4);
  header.writeBigUInt64LE(BigInt(body.length), 8);
  header.writeUInt32LE(0, 16);
  return Buffer.concat([header, body]);
}

test("the header magic is the bytes ZCRO", () => {
  assert.equal(opc().subarray(0, 4).toString("latin1"), "ZCRO");
});

test("readOpcStamp reads the cache version, vendor and vendor version", () => {
  assert.deepEqual(readOpcStamp(opc()), { cacheVersion: 2, vendor: "BBL", version: "2.8.0.16" });
});

test("readOpcStamp refuses a file that is not a preset cache it can read", async (t) => {
  const cases = [
    { name: "short file", buf: Buffer.from("ZCRO"), err: /too short/ },
    { name: "wrong magic", buf: opc({ magic: 0x12345678 }), err: /magic/ },
    { name: "another format version", buf: opc({ format: 3 }), err: /format version 3/ },
    { name: "another cache version", buf: opc({ cacheVersion: 3 }), err: /cache version 3/ },
    { name: "a stamp length past the end", buf: opc().subarray(0, 30), err: /past the end|too short/ },
  ];
  for (const c of cases) await t.test(c.name, () => assert.throws(() => readOpcStamp(c.buf), c.err));
});

test("sameVersion compares the dotted numbers, so 02.08.00.16 equals 2.8.0.16", () => {
  assert.equal(sameVersion("02.08.00.16", "2.8.0.16"), true);
  assert.equal(sameVersion("02.08.00.16", "2.8.0.17"), false);
  assert.equal(sameVersion("02.08.00.16", "2.8.0"), false);
  assert.equal(sameVersion("02.08.00.16", "2.8.0.16-rc"), false);
  assert.equal(sameVersion("", ""), false);
});

function files(json, opcBuf) {
  const dir = mkdtempSync(join(tmpdir(), "gate-pver-"));
  made.push(dir);
  writeFileSync(join(dir, "BBL.json"), JSON.stringify(json));
  writeFileSync(join(dir, "BBL.opc"), opcBuf);
  return { json: join(dir, "BBL.json"), opc: join(dir, "BBL.opc") };
}

const run = (args) => spawnSync(process.execPath, [CHECK, ...args], { encoding: "utf8" });

test("the command exits 0 and prints both stamps when they match", () => {
  const f = files({ name: "Bambulab", version: "02.08.00.16" }, opc());
  const r = run([f.opc, f.json]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "profile version match: BBL.json 02.08.00.16 = BBL.opc 2.8.0.16 (vendor BBL)\n");
});

test("the command exits 1 naming both versions when they differ", () => {
  const f = files({ version: "02.08.00.17" }, opc());
  const r = run([f.opc, f.json]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /profile version mismatch: BBL\.json 02\.08\.00\.17 but BBL\.opc 2\.8\.0\.16/);
});

test("the command exits 1 when the .opc names another vendor than the .json file", () => {
  const f = files({ version: "02.08.00.16" }, opc({ vendor: "Creality" }));
  const r = run([f.opc, f.json]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /names vendor Creality, expected BBL/);
});

test("the command exits 1 when it cannot read a version from either file", () => {
  const noVersion = files({ name: "Bambulab" }, opc());
  assert.match(run([noVersion.opc, noVersion.json]).stderr, /no version in .*BBL\.json/);
  const badOpc = files({ version: "02.08.00.16" }, Buffer.from("not a cache"));
  const r = run([badOpc.opc, badOpc.json]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read a version from .*BBL\.opc/);
  assert.equal(run([]).status, 2);
});
