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

// The three caps below bound the memory used while listing the zip directory,
// which is read whole before any entry is opened: how many entries, how many
// bytes of directory records, and how many extra fields one entry may carry.

/** A Bambu project has a few dozen entries; a directory claiming more is refused. */
export const MAX_ZIP_ENTRIES = 10000;

/** Bytes of directory records (46 + name + extra field + comment each) listed in all. */
export const MAX_ZIP_DIRECTORY_BYTES = 4 * MiB;

/** Extra fields on one entry; a real project's entries carry a few. */
export const MAX_EXTRA_FIELDS = 32;

/**
 * The most bytes one readProject holds at once (parse.ts): the zip
 * directory's records (MAX_ZIP_DIRECTORY_BYTES); the three config entries
 * (model_settings, slice_info, project_settings), each kept as text of at
 * most LIMITS.configBytes, plus the one being read, whose chunks and their
 * Buffer.concat copy are two more LIMITS.configBytes (readCapped); one
 * thumbnail, pass 2 handing them over one at a time, again as chunks and a
 * copy, 2 * LIMITS.pngBytes (pass 1 counts bytes and holds none, so the
 * file's thumbnailBytesPerFile total is never held); and the model prefix
 * with its concatenation copy, 2 * MODEL_PREFIX_BYTES (readModelPrefix).
 * That is 4 + 25 + 20 + 0.5 = 49.5 MiB.
 */
export const PROJECT_READ_PEAK_BYTES =
  MAX_ZIP_DIRECTORY_BYTES +
  (3 + 2) * LIMITS.configBytes +
  2 * LIMITS.pngBytes +
  2 * MODEL_PREFIX_BYTES;

/**
 * The most bytes one readMakerWorldXml holds at once (model-xml.ts): the zip
 * directory's records (MAX_ZIP_DIRECTORY_BYTES), the model prefix with its
 * concatenation copy (2 * MODEL_PREFIX_BYTES), and the reader's range window
 * with the copy made while it is collected, at most 2 * 256 KiB (a window is
 * 64 KiB, or the one record being read if that is larger, at most about 192
 * KiB). That is 5 MiB.
 */
export const MAKERWORLD_XML_READ_PEAK_BYTES =
  MAX_ZIP_DIRECTORY_BYTES + 2 * MODEL_PREFIX_BYTES + 2 * 256 * 1024;
