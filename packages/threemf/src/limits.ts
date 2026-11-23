// The hostile-file ceilings, so a crafted or damaged file cannot tie up the
// app, carried from the earlier parser this one was ported from. Every ceiling is
// inclusive: a file at the ceiling reads, one past it is damage (except the
// print-time claim, which only makes that plate count as unsliced).
// Byte ceilings count bytes actually inflated, never a size the archive
// declares.

const MiB = 1024 * 1024;

export const LIMITS = Object.freeze({
  /** Each Metadata/*.config entry. */
  configBytes: 5 * MiB,
  /** Each plate thumbnail. */
  pngBytes: 10 * MiB,
  /** Plates in model_settings.config, in slice_info.config, or as plate_N.png names. */
  plates: 128,
  /** Filaments on one sliced plate, or in the project's type or colour list. */
  filaments: 256,
  /** All thumbnails of one file together. */
  thumbnailBytesPerFile: 128 * MiB,
  /** Ten years. A longer print-time claim counts as unsliced. */
  predictionSeconds: 315360000,
});

/** 3D/3dmodel.model is read only up to <resources, and never past this. */
export const MODEL_PREFIX_BYTES = 256 * 1024;

// The caps below bound the memory used while listing the zip directory,
// which is read whole before any entry is opened: how many entries, how much
// memory the listing holds, and how many extra fields one entry may carry.

/** A Bambu project has a few dozen entries; a directory claiming more is refused. */
export const MAX_ZIP_ENTRIES = 10000;

/**
 * Memory the directory listing may hold, in bytes: each entry's record (46 +
 * name + extra field + comment), plus ZIP_ENTRY_OVERHEAD_BYTES and its name
 * once more (the listing's key) for the objects made of it, plus
 * ZIP_EXTRA_FIELD_OVERHEAD_BYTES for each extra field. 8 MiB is the smallest
 * round size that admits a file of MAX_ZIP_ENTRIES entries with short names
 * and no extra fields (about 7.9 MiB charged).
 */
export const MAX_ZIP_DIRECTORY_BYTES = 8 * MiB;

// The zip reader (yauzl 3.4.0) keeps an Entry object for every listed entry,
// with three Buffer views on its record and an object and a Buffer view for
// each extra field, all on the JavaScript heap, beside the record bytes. Heap
// held after listing 10,000 entries, measured with Node 26 (gc forced before
// and after), over the record bytes: about 650 bytes an entry with no extra
// field (plus one byte per byte of name, for the listing's key), 950 with
// one, 1,240 with three, 1,950 with eight and 5,620 with 32, so about 300
// bytes for the first field and 150 to 200 for each one after. The constants
// below are at or above every one of those, so the charged total is at least
// the heap the listing holds: 10,000 entries of 32 empty fields hold about
// 55 MiB from 1.8 MB of records.

/** Charged for each entry listed, beside its record bytes and its name's copy. */
export const ZIP_ENTRY_OVERHEAD_BYTES = 768;

/** Charged for each extra field of a listed entry, beside its bytes in the record. */
export const ZIP_EXTRA_FIELD_OVERHEAD_BYTES = 320;

/** Extra fields on one entry; a real project's entries carry a few. */
export const MAX_EXTRA_FIELDS = 32;

/**
 * The most bytes one readProject holds at once (parse.ts): the zip
 * directory's listing (MAX_ZIP_DIRECTORY_BYTES); the three config entries
 * (model_settings, slice_info, project_settings), each kept as text of at
 * most LIMITS.configBytes, plus the one being read, whose chunks and their
 * Buffer.concat copy are two more LIMITS.configBytes (readCapped); one
 * thumbnail, pass 2 handing them over one at a time, again as chunks and a
 * copy, 2 * LIMITS.pngBytes (pass 1 counts bytes and holds none, so the
 * file's thumbnailBytesPerFile total is never held); the S3 upload's part
 * buffers for that thumbnail while ingest stores it (the SDK's multipart
 * upload cuts the object into parts it holds until sent; the object is at
 * most LIMITS.pngBytes, so so are the parts), one more LIMITS.pngBytes; and
 * the model prefix with its concatenation copy, 2 * MODEL_PREFIX_BYTES
 * (readModelPrefix). That is 8 + 25 + 20 + 10 + 0.5 = 63.5 MiB.
 */
export const PROJECT_READ_PEAK_BYTES =
  MAX_ZIP_DIRECTORY_BYTES +
  (3 + 2) * LIMITS.configBytes +
  2 * LIMITS.pngBytes +
  LIMITS.pngBytes +
  2 * MODEL_PREFIX_BYTES;

/**
 * The most bytes one readMakerWorldXml holds at once (model-xml.ts): the zip
 * directory's listing (MAX_ZIP_DIRECTORY_BYTES), the model prefix with its
 * concatenation copy (2 * MODEL_PREFIX_BYTES), and the reader's range window
 * with the copy made while it is collected, at most 2 * 256 KiB (a window is
 * 64 KiB, or the one record being read if that is larger, at most about 192
 * KiB). That is 9 MiB.
 */
export const MAKERWORLD_XML_READ_PEAK_BYTES =
  MAX_ZIP_DIRECTORY_BYTES + 2 * MODEL_PREFIX_BYTES + 2 * 256 * 1024;
