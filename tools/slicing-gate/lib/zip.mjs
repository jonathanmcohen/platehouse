// Minimal read-only zip reader for the slicing gate. No dependencies, so the
// gate tools run with plain Node on mini01 and in the gate image.
//
// It opens the archive for random access, lists the central directory, and
// reads an entry only by exact name. Every read is capped on the bytes
// actually inflated, never on the size the archive declares (the Bambu Plates
// lesson, AC-023). Anything wrong with the archive itself throws ZipDamaged;
// filesystem errors (EIO, EACCES, ENOENT) reach the caller unchanged.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

export class ZipDamaged extends Error {
  constructor(message) {
    super(message);
    this.name = "ZipDamaged";
  }
}

const EOCD_SIG = 0x06054b50;
const Z64_LOCATOR_SIG = 0x07064b50;
const Z64_EOCD_SIG = 0x06064b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const MAX_CENTRAL_DIRECTORY = 64 * 1024 * 1024;
const MAX_ENTRIES = 100000;
const MAX_COMPRESSED_READ = 256 * 1024 * 1024;

function readAt(fd, size, position, fileSize) {
  if (position < 0 || size < 0 || position + size > fileSize) {
    throw new ZipDamaged("record lies outside the file");
  }
  const buf = Buffer.alloc(size);
  let done = 0;
  while (done < size) {
    const n = readSync(fd, buf, done, size - done, position + done);
    if (n === 0) throw new ZipDamaged("file ended early");
    done += n;
  }
  return buf;
}

function findEocd(fd, fileSize) {
  if (fileSize < 22) throw new ZipDamaged("too small to be a zip");
  const tail = Math.min(fileSize, 22 + 65535);
  const buf = readAt(fd, tail, fileSize - tail, fileSize);
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return { buf, at: i, base: fileSize - tail };
  }
  throw new ZipDamaged("no end of central directory record");
}

function zip64Directory(fd, fileSize, eocdPos) {
  const locPos = eocdPos - 20;
  if (locPos < 0) return null;
  const loc = readAt(fd, 20, locPos, fileSize);
  if (loc.readUInt32LE(0) !== Z64_LOCATOR_SIG) return null;
  const z64Pos = Number(loc.readBigUInt64LE(8));
  const rec = readAt(fd, 56, z64Pos, fileSize);
  if (rec.readUInt32LE(0) !== Z64_EOCD_SIG) throw new ZipDamaged("bad zip64 end record");
  return {
    count: Number(rec.readBigUInt64LE(32)),
    size: Number(rec.readBigUInt64LE(40)),
    offset: Number(rec.readBigUInt64LE(48)),
  };
}

function zip64Extra(extra, entry) {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    if (p + 4 + len > extra.length) throw new ZipDamaged("truncated extra field");
    if (id === 0x0001) {
      let q = p + 4;
      const take = () => {
        if (q + 8 > p + 4 + len) throw new ZipDamaged("truncated zip64 field");
        const v = Number(extra.readBigUInt64LE(q));
        q += 8;
        return v;
      };
      if (entry.size === 0xffffffff) entry.size = take();
      if (entry.compressedSize === 0xffffffff) entry.compressedSize = take();
      if (entry.offset === 0xffffffff) entry.offset = take();
    }
    p += 4 + len;
  }
}

/**
 * Opens a zip for reading. Returns { names(), readEntry(name, cap), close() }.
 * readEntry returns a Buffer, or null when no entry has exactly that name, and
 * throws ZipDamaged when the entry is over cap or cannot be inflated.
 */
export function openZip(path) {
  const fd = openSync(path, "r");
  try {
    const fileSize = fstatSync(fd).size;
    const { buf, at, base } = findEocd(fd, fileSize);
    let count = buf.readUInt16LE(at + 10);
    let cdSize = buf.readUInt32LE(at + 12);
    let cdOffset = buf.readUInt32LE(at + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const z64 = zip64Directory(fd, fileSize, base + at);
      if (!z64) throw new ZipDamaged("zip64 values without a zip64 record");
      count = z64.count;
      cdSize = z64.size;
      cdOffset = z64.offset;
    }
    if (count > MAX_ENTRIES || cdSize > MAX_CENTRAL_DIRECTORY) {
      throw new ZipDamaged("central directory too large");
    }
    const cd = readAt(fd, cdSize, cdOffset, fileSize);
    const entries = new Map();
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CEN_SIG) {
        throw new ZipDamaged("bad central directory entry");
      }
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      if (p + 46 + nameLen + extraLen + commentLen > cd.length) {
        throw new ZipDamaged("truncated central directory entry");
      }
      const entry = {
        method: cd.readUInt16LE(p + 10),
        compressedSize: cd.readUInt32LE(p + 20),
        size: cd.readUInt32LE(p + 24),
        offset: cd.readUInt32LE(p + 42),
      };
      const name = cd.toString("utf8", p + 46, p + 46 + nameLen);
      zip64Extra(cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), entry);
      if (!entries.has(name)) entries.set(name, entry);
      p += 46 + nameLen + extraLen + commentLen;
    }

    let closed = false;
    return {
      names() {
        return [...entries.keys()];
      },
      readEntry(name, cap) {
        const entry = entries.get(name);
        if (!entry) return null;
        if (entry.compressedSize > MAX_COMPRESSED_READ) {
          throw new ZipDamaged("entry too large to read");
        }
        const local = readAt(fd, 30, entry.offset, fileSize);
        if (local.readUInt32LE(0) !== LOC_SIG) throw new ZipDamaged("bad local header");
        const dataStart = entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
        const body = readAt(fd, entry.compressedSize, dataStart, fileSize);
        let out;
        if (entry.method === 0) {
          out = body;
        } else if (entry.method === 8) {
          try {
            out = inflateRawSync(body, { maxOutputLength: cap + 1 });
          } catch (err) {
            throw new ZipDamaged(`cannot inflate entry: ${err.code ?? err.message}`);
          }
        } else {
          throw new ZipDamaged(`unsupported compression method ${entry.method}`);
        }
        if (out.length > cap) throw new ZipDamaged("entry over its cap");
        return out;
      },
      close() {
        if (!closed) {
          closed = true;
          closeSync(fd);
        }
      },
    };
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}
