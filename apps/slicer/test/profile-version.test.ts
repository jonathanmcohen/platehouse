// The image build checks that the BBL profile JSON fetched from Orca's source
// is the same profile version as the BBL.opc preset cache the AppImage ships,
// so the slicer never flattens profiles from another release than the Orca
// it runs. Ported from the slicing gate's check-profile-version.mjs, whose
// check passed in the image on Hades (run 3: BBL 02.08.00.16 = 2.8.0.16).
// The .opc buffers are crafted; no Orca file is committed.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { checkProfileVersions, readOpcStamp, sameVersion } from "../src/profiles.js";
import { profileTree, put } from "./support/profiles.js";

function str(s: string): Buffer {
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(Buffer.byteLength(s)));
  return Buffer.concat([len, Buffer.from(s)]);
}

function opc(
  o: { magic?: number; format?: number; cache?: number; vendor?: string; version?: string } = {},
) {
  const cv = Buffer.alloc(4);
  cv.writeUInt32LE(o.cache ?? 2);
  const body = Buffer.concat([
    cv,
    str(o.vendor ?? "BBL"),
    str(o.version ?? "2.8.0.16"),
    Buffer.from("rest"),
  ]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(o.magic ?? 0x4f52435a, 0);
  header.writeUInt32LE(o.format ?? 2, 4);
  header.writeBigUInt64LE(BigInt(body.length), 8);
  return Buffer.concat([header, body]);
}

describe("profile version check", () => {
  test("readOpcStamp reads the cache version, vendor and vendor version", () => {
    expect(readOpcStamp(opc())).toEqual({ cacheVersion: 2, vendor: "BBL", version: "2.8.0.16" });
  });

  test.each([
    ["a short file", Buffer.from("ZCRO"), /too short/],
    ["the wrong magic", opc({ magic: 0x12345678 }), /magic/],
    ["another format version", opc({ format: 3 }), /format version 3/],
    ["another cache version", opc({ cache: 3 }), /cache version 3/],
    ["a stamp past the end", opc().subarray(0, 30), /past the end|too short/],
  ])("readOpcStamp refuses %s", (_label, buf, err) => {
    expect(() => readOpcStamp(buf)).toThrow(err);
  });

  test("versions compare number by number", () => {
    expect(sameVersion("02.08.00.16", "2.8.0.16")).toBe(true);
    expect(sameVersion("02.08.00.16", "2.8.0.17")).toBe(false);
    expect(sameVersion("2.8", "2.8.0")).toBe(false);
    expect(sameVersion("2.8.x", "2.8.x")).toBe(false);
  });

  test("the vendor and library JSON must match the .opc files beside the AppImage's profiles", () => {
    const source = profileTree();
    put(source, "OrcaFilamentLibrary.json", {
      name: "OrcaFilamentLibrary",
      version: "02.04.00.26",
      filament_list: [],
    });
    const shipped = join(profileTree(), "shipped");
    put(shipped, "x.json", {});
    writeFileSync(join(shipped, "BBL.opc"), opc({ version: "2.8.0.16" }));
    writeFileSync(
      join(shipped, "OrcaFilamentLibrary.opc"),
      opc({ vendor: "OrcaFilamentLibrary", version: "2.4.0.26" }),
    );
    expect(checkProfileVersions(source, shipped)).toEqual([
      "BBL 02.08.00.16 = 2.8.0.16",
      "OrcaFilamentLibrary 02.04.00.26 = 2.4.0.26",
    ]);
    writeFileSync(join(shipped, "BBL.opc"), opc({ version: "2.8.0.17" }));
    expect(() => checkProfileVersions(source, shipped)).toThrow(
      /BBL.json 02.08.00.16 but BBL.opc 2.8.0.17/,
    );
    writeFileSync(join(shipped, "BBL.opc"), opc({ vendor: "Other", version: "2.8.0.16" }));
    expect(() => checkProfileVersions(source, shipped)).toThrow(/names vendor Other/);
  });
});
