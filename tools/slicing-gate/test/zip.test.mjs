import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openZip, ZipDamaged } from "../lib/zip.mjs";
import { buildZip } from "./support/zipwriter.mjs";

function tmpFile(buf) {
  const dir = mkdtempSync(join(tmpdir(), "gate-zip-"));
  const file = join(dir, "a.zip");
  writeFileSync(file, buf);
  return file;
}

test("reads a deflated and a stored entry by exact name", () => {
  const file = tmpFile(
    buildZip([
      { name: "Metadata/a.config", data: "hello" },
      { name: "Metadata/b.config", data: "stored", method: 0 },
    ]),
  );
  const zip = openZip(file);
  try {
    assert.equal(zip.readEntry("Metadata/a.config", 100).toString(), "hello");
    assert.equal(zip.readEntry("Metadata/b.config", 100).toString(), "stored");
  } finally {
    zip.close();
  }
});

test("a missing entry is null, and names are matched exactly", () => {
  const file = tmpFile(buildZip([{ name: "Metadata/a.config", data: "x" }]));
  const zip = openZip(file);
  try {
    assert.equal(zip.readEntry("metadata/a.config", 100), null);
    assert.equal(zip.readEntry("Metadata/missing", 100), null);
    assert.deepEqual(zip.names(), ["Metadata/a.config"]);
  } finally {
    zip.close();
  }
});

test("an entry over the cap is damage, counted on inflated bytes not declared size", () => {
  const big = "a".repeat(5000);
  const file = tmpFile(buildZip([{ name: "x", data: big, declaredSize: 10 }]));
  const zip = openZip(file);
  try {
    assert.throws(() => zip.readEntry("x", 1000), ZipDamaged);
  } finally {
    zip.close();
  }
});

test("hostile inputs throw ZipDamaged and nothing else", () => {
  const good = buildZip([{ name: "x", data: "y" }]);
  const truncated = good.subarray(0, good.length - 30);
  const cdPastEof = Buffer.from(good);
  cdPastEof.writeUInt32LE(good.length + 1000, good.length - 6);
  const cases = {
    "random bytes": Buffer.from("not a zip at all, just text"),
    empty: Buffer.alloc(0),
    truncated,
    "central directory past EOF": cdPastEof,
  };
  for (const [label, buf] of Object.entries(cases)) {
    assert.throws(() => openZip(tmpFile(buf)), ZipDamaged, label);
  }
});

test("a local header pointing past EOF is damage on read, not a crash", () => {
  const good = buildZip([{ name: "x", data: "y" }]);
  const bad = Buffer.from(good);
  const cdStart = bad.readUInt32LE(bad.length - 6);
  bad.writeUInt32LE(0x7fffffff, cdStart + 42);
  const zip = openZip(tmpFile(bad));
  try {
    assert.throws(() => zip.readEntry("x", 100), ZipDamaged);
  } finally {
    zip.close();
  }
});
