// The AC-023 ceilings, carried from Bambu Plates 0.1.1. Every ceiling is
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

/** A Bambu project has a few dozen entries; a directory claiming more is hostile. */
export const MAX_ZIP_ENTRIES = 100000;
