// The MakerWorld text of a .3mf read on its own, through ranged reads of
// wherever the file is kept (#357). The description re-conversion reads it
// from the object store for every model it checks; readProject would need the
// whole file on disk, thumbnails and mesh included, where this needs the
// zip's end record and central directory, then one entry's local header and
// as much of that entry as the prefix takes.
import { PassThrough, type Readable } from "node:stream";
import yauzl from "yauzl";
import { Damaged, ReadUnavailable } from "./errors.js";
import { listEntries, MODEL, ownRead, readModelPrefix } from "./parse.js";

/**
 * The bytes of the file from start up to, not including, end. Any error it
 * throws or its stream emits is a read that failed now, never damage.
 */
export type RangeSource = (start: number, end: number) => Promise<Readable>;

/**
 * Each small read (the end record, the central directory, a local header)
 * asks for at least this much and keeps it, so the reads that follow it in
 * the same stretch of the file, one per central directory entry, cost no
 * request of their own. yauzl looks for the end record in the last 64 KiB
 * plus 22 bytes, so the central directory of a Bambu project, a few dozen
 * entries, is usually inside that first read.
 */
const WINDOW = 64 * 1024;

function unavailable(err: unknown): ReadUnavailable {
  return err instanceof ReadUnavailable ? err : new ReadUnavailable(err as NodeJS.ErrnoException);
}

class SourceReader extends yauzl.RandomAccessReader {
  private readonly source: RangeSource;
  private readonly size: number;
  private window: { start: number; bytes: Buffer } | undefined;

  constructor(source: RangeSource, size: number) {
    super();
    this.source = source;
    this.size = size;
  }

  // An entry's data, streamed from the source. When the reader stops early
  // (the prefix found <resources), the source's stream is destroyed with it,
  // so the rest of the entry is not fetched.
  override _readStreamForRange(start: number, end: number): Readable {
    const out = new PassThrough();
    this.source(start, end).then(
      (stream) => {
        stream.on("error", (err) => out.destroy(unavailable(err)));
        out.on("close", () => stream.destroy());
        stream.pipe(out);
      },
      (err: unknown) => out.destroy(unavailable(err)),
    );
    return out;
  }

  override read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
    callback: (err: Error | null, bytesRead?: number) => void,
  ): void {
    // A read at or past the end of the file gets no bytes back, as fs.read
    // gives, so yauzl reports unexpected EOF and the file reads as damaged.
    // An offset there comes only from a damaged or crafted end record or
    // central directory, which yauzl does not bounds-check; asking the source
    // for that empty range would be refused as a failed read instead.
    if (position >= this.size) {
      callback(null, 0);
      return;
    }
    const w = this.window;
    if (w && position >= w.start && position + length <= w.start + w.bytes.length) {
      w.bytes.copy(buffer, offset, position - w.start, position - w.start + length);
      callback(null, length);
      return;
    }
    const end = Math.min(this.size, Math.max(position + length, position + WINDOW));
    collect(this._readStreamForRange(position, end)).then(
      (bytes) => {
        this.window = { start: position, bytes };
        const n = Math.min(length, bytes.length);
        bytes.copy(buffer, offset, 0, n);
        callback(null, n);
      },
      (err: Error) => callback(err),
    );
  }
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * 3D/3dmodel.model up to <resources, at most 256 KiB: the text readProject
 * gives as makerWorldXml, which the MakerWorld reader takes, with the same
 * caps and the same NUL rule. Unlike readProject it needs no plate data.
 * Null when the bytes are not a zip yauzl can read or hold no
 * 3D/3dmodel.model. ReadUnavailable, with the source's error as its cause,
 * when the source fails.
 */
export async function readMakerWorldXml(source: RangeSource, size: number): Promise<string | null> {
  try {
    const zip = await ownRead(() =>
      yauzl.fromRandomAccessReaderPromise(new SourceReader(source, size), size, {
        lazyEntries: true,
        autoClose: false,
        validateEntrySizes: true,
        decodeStrings: false,
      }),
    );
    try {
      const entry = (await ownRead(() => listEntries(zip))).get(MODEL);
      return entry ? await readModelPrefix(zip, entry) : null;
    } finally {
      zip.close();
    }
  } catch (err) {
    if (err instanceof Damaged) return null;
    throw err;
  }
}
