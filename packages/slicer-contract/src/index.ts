// Slicer HTTP contract v2: the zod schemas the slicer
// server answers with and the app's slicer client (apps/server/src/estimates/client.ts) reads with. The
// slicer is on the internal network only, has no auth and holds no secrets.
//
//   GET  /v1/health                         -> health
//   GET  /v1/profiles                       -> profiles
//   POST /v1/slice?printer=<id>&plate=<n>   -> sliceResult | 400 bad_request | 409 busy
//                                              | 413 too_large | 422 not_3mf
//                                              | 503 sandboxOff
//   POST /v1/scad/stl, /v1/scad/png         -> model/stl, image/png | 409 busy | 413 too_large
//                                              | 422 renderError | 503 sandboxOff
//   POST /v1/step/glb                       -> model/gltf-binary | 409 busy | 413 too_large
//                                              | 422 convertError | 503 sandboxOff
//   POST /v1/stl/png                        -> image/png | 409 busy | 413 too_large
//                                              | 422 renderError | 503 sandboxOff
//
// 503 sandboxOff (contract 2) says the slicer's sandbox is off, so the route
// did not run: the answer is about the slicer, never about the file, and the
// same file may be sent again once health reports the sandbox on. "reason"
// is old_kernel when the kernel's Landlock ABI is below what the sandbox
// needs and check_failed for any other failure of the slicer's own check.
// The slicer runs that check at start-up, holding the heavy-job lock (so
// health.busy is true and a job is 409 busy while it runs), and runs it again
// after a check_failed, never after an old_kernel. health.sandbox reports
// where it stands. With SLICER_ALLOW_UNSANDBOXED set, a slice or a STEP
// conversion runs without the sandbox instead of answering 503; a render or
// an STL picture never does. health.timeouts are the time caps, in whole
// seconds, so a caller can size its own timers from them.
//
// POST /v1/stl/png (issue #316) renders a preview picture of an STL, binary
// or ASCII, sent as application/octet-stream: the same OpenSCAD, sandbox,
// time cap and 800 x 800 image as /v1/scad/png, on a .scad the slicer writes
// itself, a single import of the STL. A body that is not an STL with at
// least one triangle is 422 renderError before OpenSCAD runs (OpenSCAD would
// draw an empty picture of it); one OpenSCAD cannot read is 422 renderError
// with OpenSCAD's own message.
//
// Versioning. CONTRACT_VERSION is the number /v1/health reports. It stays
// the same while the contract only grows in ways an app built for that
// number never sees: a new route, or a new limit for a new route. Anything
// that changes what an existing route takes or answers, or removes one, is a
// new number, and the schemas below then refuse the old one (health takes
// only its own number). Contract 2 added the 503 sandboxOff answer and the
// sandbox and timeouts parts of health: an app built for it refuses a
// contract 1 health, and an older app refuses this one. /v1/stl/png was
// added without a new number, so an app that calls it on a slicer image
// without it gets 404 not_found, which the app treats as a slicer that
// cannot render yet, not as a fault of the file.
//
// 413 too_large comes before the body is read when its Content-Length is
// over the route's limit (LIMITS), and as soon as it passes the limit when
// there is none. An answer is never over its route's output limit
// (renderOutputBytes, stepOutputBytes): an output over it is refused with
// the route's 422 instead, so a caller may stop reading at the limit. Any
// route answers an unexpected server error with 500 and a plain-text body,
// not an error schema.
//
// The slicer runs one heavy job at a time: a slice, a render (a .scad's or
// an STL preview) or a STEP conversion. A POST to any of those routes while
// one runs is 409 busy, answered at once without reading the body; the
// caller retries later. health.busy is true while one runs.
//
// Where the contract's first description left a case open, these schemas
// settle it: a malformed query or an unknown printer is 400 bad_request, an
// unknown path is 404 not_found, a failed slice with no Orca return code (the
// slicer's own kill, or no result.json) has code null, and an ok slice's
// process is null when the file names none.
//
// Filaments (the maintainer, 2026-11-08: "I use mostly
// Bambu Filaments"): a printer's default filament for a type is Bambu's own
// preset for that printer where Orca has one, else the Generic preset for
// that printer. /v1/profiles lists that default once per printer and type,
// naming the printer; a printer and type with neither is not listed, and a
// slice keeps the file's own filament there. A slice reports the preset used
// for each project slot in filamentProfiles (null where the file's own was
// kept). The filament entries carry only the fields contract 2
// names: where a preset came from is not part of contract 2.
import { z } from "zod";

export const CONTRACT_VERSION = 2;

export const LIMITS = Object.freeze({
  /** Largest .3mf POST /v1/slice takes (512 MiB). */
  sliceBodyBytes: 536_870_912,
  /** Largest .scad POST /v1/scad/* takes (1 MiB). */
  scadBodyBytes: 1_048_576,
  /** Largest STEP file POST /v1/step/glb takes (256 MiB). */
  stepBodyBytes: 268_435_456,
  /**
   * Largest STL POST /v1/stl/png takes (256 MiB): the same as a STEP file,
   * about 5 million triangles of binary STL, and the most a render may
   * write, so an STL preview fits /work beside its PNG.
   */
  stlBodyBytes: 268_435_456,
  /**
   * Largest STL or PNG a render answers with (256 MiB): /v1/scad/stl,
   * /v1/scad/png and /v1/stl/png. It is OpenSCAD's file-size limit in the
   * sandbox, so a bigger output is never written; the route answers 422
   * renderError instead. The app streams the answer to disk under this cap.
   */
  renderOutputBytes: 268_435_456,
  /**
   * Largest GLB POST /v1/step/glb answers with (256 MiB). A mesh the
   * converter makes over this is not sent: the route answers 422
   * convertError, saying how large it was. The app streams the answer to
   * disk under this cap, and reads a stored mesh this size for a preview.
   */
  stepOutputBytes: 268_435_456,
  /** Plates are numbered 1 to 128 (a file has at most 128 plates). */
  maxPlate: 128,
  /** A failed slice's detail is Orca's error_string, cut to this length. */
  detailChars: 2000,
});

export type Limits = { [K in keyof typeof LIMITS]: number };

/**
 * Why a plate could not be sliced. The reason map as amended: Orca v2.5.0's
 * own codes, with -62 and -101 legitimate refusals (the maintainer, 2026-11-08).
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

/** Why the sandbox is off; see the 503 sandboxOff note at the top. */
export const SANDBOX_OFF_REASONS = ["old_kernel", "check_failed"] as const;
const sandboxOffReason = z.enum(SANDBOX_OFF_REASONS);

/** SLICER_ALLOW_UNSANDBOXED: a slice or STEP conversion may run unsandboxed. */
const allowUnsandboxed = z.boolean();

const wholeSeconds = z.number().int().positive();

export const health = z.strictObject({
  contract,
  orca: z.string().min(1),
  openscad: z.string().min(1),
  busy: z.boolean(),
  sandbox: z.discriminatedUnion("state", [
    z.strictObject({
      state: z.literal("checking"),
      reason: z.null(),
      detail: z.null(),
      allowUnsandboxed,
    }),
    z.strictObject({
      state: z.literal("on"),
      reason: z.null(),
      detail: z.null(),
      allowUnsandboxed,
    }),
    z.strictObject({
      state: z.literal("off"),
      reason: sandboxOffReason,
      detail: z.string().min(1),
      allowUnsandboxed,
    }),
  ]),
  timeouts: z.strictObject({
    sliceSeconds: wholeSeconds,
    scadSeconds: wholeSeconds,
    stepSeconds: wholeSeconds,
    /** The time the slicer allows a body to arrive (its request timeout, less the caps). */
    uploadSeconds: wholeSeconds,
  }),
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

/** 503: the sandbox is off, so the route did not run. */
export const sandboxOff = z.strictObject({
  error: z.literal("sandbox_off"),
  reason: sandboxOffReason,
  detail: z.string(),
});

export const slicerContract = Object.freeze({
  health,
  profiles,
  sliceQuery,
  sliceResult,
  error,
  renderError,
  convertError,
  sandboxOff,
});

export type Health = z.infer<typeof health>;
export type SandboxState = Health["sandbox"];
export type SlicerTimeouts = Health["timeouts"];
export type SandboxOffBody = z.infer<typeof sandboxOff>;
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
