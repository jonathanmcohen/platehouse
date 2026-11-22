// The zip reading both readers share: readProject (parse.ts) and
// readPlateMesh (plate-mesh.ts). Moved here unchanged from parse.ts, so the
// rules written there hold for both: entries are found by their raw name
// bytes, every cap counts bytes actually inflated, a filesystem error is
// ReadUnavailable and anything else the zip reader or inflate throws is
// Damaged.
import type { FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import yauzl from "yauzl";
import { Damaged, isSystemError, ReadUnavailable } from "./errors.js";
import { MAX_ZIP_ENTRIES } from "./limits.js";

const READ_CHUNK = 64 * 1024;

/**
 * Runs one of the parser's own reads of the archive (yauzl or inflate) and
 * classifies what it throws: a filesystem error is ReadUnavailable, anything
 * else is Damaged, as the earlier parser did. It never
 * wraps the parser's mapping code or the caller's callback.
 */
export async function ownRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (err instanceof Damaged || err instanceof ReadUnavailable) throw err;
    if (isSystemError(err)) throw new ReadUnavailable(err);
    throw new Damaged(`unreadable archive: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function unavailableOr(err: unknown): unknown {
  if (err instanceof ReadUnavailable) return err;
  return isSystemError(err) ? new ReadUnavailable(err) : err;
}

export class HandleReader extends yauzl.RandomAccessReader {
  private readonly handle: FileHandle;

  constructor(handle: FileHandle) {
    super();
    this.handle = handle;
  }

  // Positional reads on the one handle. A FileHandle read stream is not used
  // because destroying it early closes the shared handle.
  override _readStreamForRange(start: number, end: number): Readable {
    const handle = this.handle;
    let position = start;
    return new Readable({
      highWaterMark: READ_CHUNK,
      read(): void {
        const length = Math.min(READ_CHUNK, end - position);
        if (length <= 0) {
          this.push(null);
          return;
        }
        handle.read(Buffer.alloc(length), 0, length, position).then(
          ({ buffer, bytesRead }) => {
            position += bytesRead;
            // A short file ends the stream; yauzl then reports the missing
            // bytes as damage.
            this.push(bytesRead === 0 ? null : buffer.subarray(0, bytesRead));
          },
          (err: Error) => this.destroy(err),
        );
      },
    });
  }

  override read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (err: Error | null, bytesRead?: number) => void,
  ): void {
    this.handle.read(buffer, offset, length, position).then(
      ({ bytesRead }) => callback(null, bytesRead),
      (err: Error) => callback(err),
    );
  }
}

/**
 * Opens the archive with the entry names kept as raw bytes. decodeStrings:
 * false keeps every entry name as the bytes the archive holds. Decoding
 * would turn a backslash into a slash (so Metadata\model_settings.config
 * would pass for the Bambu entry), honour an Info-ZIP Unicode Path field
 * over the real name, and make the whole file damaged when any entry, even
 * one never read, has '..' or an absolute path. listEntries keys on those
 * bytes instead.
 */
export function openArchive(
  reader: yauzl.RandomAccessReader,
  size: number,
): Promise<yauzl.ZipFile> {
  return ownRead(() =>
    yauzl.fromRandomAccessReaderPromise(reader, size, {
      lazyEntries: true,
      autoClose: false,
      validateEntrySizes: true,
      decodeStrings: false,
    }),
  );
}

/**
 * Lists the entries once, keyed by the raw name bytes read as latin1: one
 * character per byte, so a key equals a Bambu name only when the bytes are
 * exactly that ASCII name. The first entry of a duplicated name wins.
 */
export function listEntries(zip: yauzl.ZipFile): Promise<Map<string, yauzl.Entry>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, yauzl.Entry>();
    let count = 0;
    const done = (fn: () => void): void => {
      zip.removeAllListeners("entry");
      zip.removeAllListeners("end");
      zip.removeAllListeners("error");
      zip.on("error", () => undefined);
      fn();
    };
    zip.on("entry", (entry: yauzl.Entry) => {
      count++;
      if (count > MAX_ZIP_ENTRIES) {
        done(() => reject(new Damaged("too many entries")));
        return;
      }
      const name = entry.fileNameRaw.toString("latin1");
      if (!entries.has(name)) entries.set(name, entry);
      zip.readEntry();
    });
    zip.on("end", () => done(() => resolve(entries)));
    zip.on("error", (err: Error) => done(() => reject(err)));
    zip.readEntry();
  });
}

function openStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream)));
  });
}

/**
 * Streams an entry through inflate and hands each chunk to take. take returns
 * false to stop early. Throws Damaged once more than cap bytes have come out.
 */
export async function pump(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  cap: number,
  take: (chunk: Buffer) => boolean,
): Promise<number> {
  const stream = await ownRead(() => openStream(zip, entry));
  const chunks = (stream as AsyncIterable<Buffer>)[Symbol.asyncIterator]();
  let total = 0;
  try {
    // Only pulling the next inflated chunk is a read of the file; take and
    // the cap check are the parser's own code.
    for (;;) {
      const next = await ownRead(() => chunks.next());
      if (next.done) break;
      const chunk = next.value;
      total += chunk.length;
      if (total > cap) throw new Damaged(`entry over ${cap} bytes`);
      if (!take(chunk)) break;
    }
  } finally {
    stream.on("error", () => undefined);
    stream.destroy();
  }
  return total;
}

export async function readCapped(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  cap: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await pump(zip, entry, cap, (chunk) => {
    chunks.push(chunk);
    return true;
  });
  return Buffer.concat(chunks);
}
