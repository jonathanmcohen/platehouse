// Slicer HTTP contract v1 (build plan, Contracts): the zod schemas the slicer
// server answers with and the app's slicer client (Task 12) reads with. The
// slicer is on the internal network only, has no auth and holds no secrets.
//
//   GET  /v1/health                         -> health
//   GET  /v1/profiles                       -> profiles
//   POST /v1/slice?printer=<id>&plate=<n>   -> sliceResult | 400 bad_request | 409 busy
//                                              | 413 too_large | 422 not_3mf
//   POST /v1/scad/stl, /v1/scad/png         -> model/stl, image/png | 409 busy | 413 too_large
//                                              | 422 renderError
//   POST /v1/step/glb                       -> model/gltf-binary | 409 busy | 413 too_large
//                                              | 422 convertError
//
// 413 too_large comes before the body is read when its Content-Length is
// over the route's limit (LIMITS), and as soon as it passes the limit when
// there is none. Any route answers an unexpected server error with 500 and a
// plain-text body, not an error schema.
//
// The slicer runs one heavy job at a time: a slice, a render or a STEP
// conversion. A POST to any of those three routes while one runs is 409
// busy, answered at once without reading the body; the caller retries
// later. health.busy is true while one runs.
//
// Where the plan leaves a case open, these schemas settle it, and the PR
// says so: a malformed query or an unknown printer is 400 bad_request, an
// unknown path is 404 not_found, a failed slice with no Orca return code (the
// slicer's own kill, or no result.json) has code null, and an ok slice's
// process is null when the file names none.
//
// Filaments (build plan Task 11 Decisions, Jon 2026-11-08: "I use mostly
// Bambu Filaments"): a printer's default filament for a type is Bambu's own
// preset for that printer where Orca has one, else the Generic preset for
// that printer. /v1/profiles lists that default once per printer and type,
// naming the printer; a printer and type with neither is not listed, and a
// slice keeps the file's own filament there. A slice reports the preset used
// for each project slot in filamentProfiles (null where the file's own was
// kept). The filament entries carry only the fields the plan's contract
// names: where a preset came from is not part of contract v1.
import { z } from "zod";

export const CONTRACT_VERSION = 1;

export const LIMITS = Object.freeze({
  /** Largest .3mf POST /v1/slice takes (512 MiB). */
  sliceBodyBytes: 536_870_912,
  /** Largest .scad POST /v1/scad/* takes (1 MiB). */
  scadBodyBytes: 1_048_576,
  /** Largest STEP file POST /v1/step/glb takes (256 MiB). */
  stepBodyBytes: 268_435_456,
  /** Plates are numbered 1 to 128 (AC-023). */
  maxPlate: 128,
  /** A failed slice's detail is Orca's error_string, cut to this length. */
  detailChars: 2000,
});

export type Limits = { [K in keyof typeof LIMITS]: number };

/**
 * Why a plate could not be sliced. The plan's map as amended: Orca v2.5.0's
 * own codes, with -62 and -101 legitimate refusals (Jon, 2026-11-08).
 */
export const REASONS = [
  "process_not_compatible",
  "machine_not_supported",
  "bed_too_small",
  "nozzle_mismatch",
  "filament_temperature",
  "toolpath_conflict",
  "timeout",
  "slicer_error",
] as const;

export const reason = z.enum(REASONS);
export type Reason = z.infer<typeof reason>;

const contract = z.literal(CONTRACT_VERSION);

export const health = z.strictObject({
  contract,
  orca: z.string().min(1),
  openscad: z.string().min(1),
  busy: z.boolean(),
});

export const printer = z.strictObject({
  /** The Orca machine preset name, e.g. "Bambu Lab P1S 0.4 nozzle". */
  id: z.string().min(1),
  model: z.string().min(1),
  /** BBL model_id, as slice_info.config printer_model_id names it. */
  modelId: z.string().min(1),
  nozzle: z.number().positive(),
});

/** A printer's default filament preset for one filament type. */
export const filamentProfile = z.strictObject({
  /** The menu printer (a printers[].id) this default is for. */
  printer: z.string().min(1),
  type: z.string().min(1),
  profile: z.string().min(1),
});

export const profiles = z.strictObject({
  contract,
  orca: z.string().min(1),
  printers: z.array(printer),
  filaments: z.array(filamentProfile),
});

/** Query of POST /v1/slice. plate arrives as a string and must be 1 to 128. */
export const sliceQuery = z.strictObject({
  printer: z.string().min(1),
  plate: z
    .string()
    .regex(/^[1-9]\d{0,2}$/, "plate must be a whole number from 1 to 128")
    .transform(Number)
    .pipe(z.number().int().min(1).max(LIMITS.maxPlate)),
});

/** One filament's numbers on a sliced plate. */
export const sliceFilament = z.strictObject({
  slot: z.number().int().min(1),
  type: z.string(),
  color: z.string().nullable(),
  grams: z.number().nonnegative(),
});

export const sliceOk = z.strictObject({
  contract,
  orca: z.string().min(1),
  plate: z.number().int().min(1).max(LIMITS.maxPlate),
  status: z.literal("ok"),
  printer: z.string().min(1),
  process: z.string().nullable(),
  filamentProfiles: z.array(z.string().nullable()),
  timeSeconds: z.number().positive(),
  weightGrams: z.number().positive(),
  filaments: z.array(sliceFilament),
  wallMs: z.number().int().nonnegative(),
  peakRssBytes: z.number().int().nonnegative(),
});

export const sliceFailed = z.strictObject({
  contract,
  orca: z.string().min(1),
  plate: z.number().int().min(1).max(LIMITS.maxPlate),
  status: z.literal("failed"),
  code: z.number().int().nullable(),
  reason,
  detail: z.string().max(LIMITS.detailChars),
});

export const sliceResult = z.discriminatedUnion("status", [sliceOk, sliceFailed]);

export const error = z.union([
  z.strictObject({ error: z.enum(["busy", "too_large", "not_3mf", "not_found"]) }),
  z.strictObject({ error: z.literal("bad_request"), message: z.string() }),
]);

export const renderError = z.strictObject({
  error: z.literal("render_failed"),
  message: z.string(),
});

export const convertError = z.strictObject({
  error: z.literal("convert_failed"),
  message: z.string(),
});

export const slicerContract = Object.freeze({
  health,
  profiles,
  sliceQuery,
  sliceResult,
  error,
  renderError,
  convertError,
});

export type Health = z.infer<typeof health>;
export type Printer = z.infer<typeof printer>;
export type FilamentProfile = z.infer<typeof filamentProfile>;
export type Profiles = z.infer<typeof profiles>;
export type SliceQuery = z.infer<typeof sliceQuery>;
export type SliceFilament = z.infer<typeof sliceFilament>;
export type SliceOk = z.infer<typeof sliceOk>;
export type SliceFailed = z.infer<typeof sliceFailed>;
export type SliceResult = z.infer<typeof sliceResult>;
export type ErrorBody = z.infer<typeof error>;
export type RenderError = z.infer<typeof renderError>;
export type ConvertError = z.infer<typeof convertError>;
