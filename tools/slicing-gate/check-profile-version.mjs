#!/usr/bin/env node
// Build-time check that the BBL profile JSON fetched from OrcaSlicer's source
// is the same profile version as the BBL.opc preset cache Orca's AppImage
// ships, so the gate never flattens profiles from another release than the
// slicer it runs.
//
// The .opc layout follows OrcaSlicer src/libslic3r/PresetCacheFormat.cpp at
// v2.5.0 (commit 40ecc66f78ed72dc368e0c1ebe40d77f00cc8a19): a 20-byte header
// (uint32 magic 0x4F52435A, the bytes "ZCRO"; uint32 format version 2; uint64
// body size; uint32 CRC-32), then a cereal body that starts with the uint32
// cache version (2), the vendor name and the vendor version, each a uint64
// length and its bytes. PresetBundle.cpp writes that version as
// Semver::parse(<vendor>.json "version").to_string(), so "02.08.00.16" in
// BBL.json is "2.8.0.16" in BBL.opc; the two are compared number by number.
// Only those stamps are read, not the presets behind them.
//
// Usage: node check-profile-version.mjs <vendor.opc> <vendor.json>
// Exit status: 0 the versions match; 1 they differ, or a version cannot be
// read; 2 bad usage.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { isMain } from "./lib/is-main.mjs";

const MAGIC = 0x4f52435a;
const FORMAT_VERSION = 2;
const CACHE_VERSION = 2;
const HEADER_BYTES = 20;
const MAX_STAMP = 1024;

/** Reads the cache version, vendor name and vendor version from a .opc file's bytes. */
export function readOpcStamp(buf) {
  if (buf.length < HEADER_BYTES + 4) throw new Error("file too short for a preset cache header");
  const magic = buf.readUInt32LE(0);
  if (magic !== MAGIC) throw new Error(`magic 0x${magic.toString(16)} is not ZCRO (0x${MAGIC.toString(16)})`);
  const format = buf.readUInt32LE(4);
  if (format !== FORMAT_VERSION) throw new Error(`format version ${format}, expected ${FORMAT_VERSION}`);
  let at = HEADER_BYTES;
  const cacheVersion = buf.readUInt32LE(at);
  at += 4;
  if (cacheVersion !== CACHE_VERSION) throw new Error(`cache version ${cacheVersion}, expected ${CACHE_VERSION}`);
  const readString = () => {
    if (at + 8 > buf.length) throw new Error("stamp length runs past the end of the file");
    const len = buf.readBigUInt64LE(at);
    at += 8;
    if (len > BigInt(MAX_STAMP) || at + Number(len) > buf.length) throw new Error("stamp runs past the end of the file");
    const s = buf.toString("latin1", at, at + Number(len));
    at += Number(len);
    return s;
  };
  const vendor = readString();
  const version = readString();
  return { cacheVersion, vendor, version };
}

/** True when two dotted versions have the same numbers in the same places (02.08.00.16 = 2.8.0.16). */
export function sameVersion(a, b) {
  const parts = (v) => (/^\d+(\.\d+)*$/.test(v) ? v.split(".").map(Number) : null);
  const pa = parts(String(a));
  const pb = parts(String(b));
  return pa !== null && pb !== null && pa.length === pb.length && pa.every((n, i) => n === pb[i]);
}

function main([opcFile, jsonFile, ...rest]) {
  if (!opcFile || !jsonFile || rest.length) {
    process.stderr.write("usage: check-profile-version.mjs <vendor.opc> <vendor.json>\n");
    return 2;
  }
  const vendor = basename(jsonFile).replace(/\.json$/, "");
  let json;
  try {
    json = JSON.parse(readFileSync(jsonFile, "utf8"));
  } catch (err) {
    process.stderr.write(`check-profile-version: cannot read ${jsonFile}: ${err.message}\n`);
    return 1;
  }
  if (typeof json.version !== "string" || json.version === "") {
    process.stderr.write(`check-profile-version: no version in ${jsonFile}\n`);
    return 1;
  }
  let stamp;
  try {
    stamp = readOpcStamp(readFileSync(opcFile));
  } catch (err) {
    process.stderr.write(`check-profile-version: cannot read a version from ${opcFile}: ${err.message}\n`);
    return 1;
  }
  if (stamp.vendor !== vendor) {
    process.stderr.write(`check-profile-version: ${opcFile} names vendor ${stamp.vendor}, expected ${vendor}\n`);
    return 1;
  }
  const jsonName = basename(jsonFile);
  const opcName = basename(opcFile);
  if (!sameVersion(json.version, stamp.version)) {
    process.stderr.write(`check-profile-version: profile version mismatch: ${jsonName} ${json.version} but ${opcName} ${stamp.version}\n`);
    return 1;
  }
  process.stdout.write(`profile version match: ${jsonName} ${json.version} = ${opcName} ${stamp.version} (vendor ${stamp.vendor})\n`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main(process.argv.slice(2));
