export interface Filament {
  /** 1-based slot. */
  slot: number;
  type: string;
  /** #RRGGBB or #RRGGBBAA exactly as the file has it, else null. */
  colour: string | null;
  /** Grams used on a sliced plate; null in the project list or when absent. */
  grams: number | null;
}

export interface Plate {
  /** Bambu's plate index, from 1. */
  index: number;
  name: string | null;
  /** Object instances on the plate; 0 when the list came from thumbnail names. */
  objectCount: number;
  /** True when the file carries Bambu's own slice numbers for this plate. */
  sliced: boolean;
  predictionSeconds?: number;
  weightGrams?: number;
  /** The sliced plate's filaments; empty when not sliced. */
  filaments: Filament[];
}

export interface Project {
  /** In plate order. Never empty. */
  plates: Plate[];
  projectFilaments: Filament[];
  /** The printer the embedded slice data is for (slice_info printer_model_id and nozzle_diameters). */
  slicedFor?: { printerModelId: string; nozzle: number };
  /** project_settings print_settings_id. */
  processName?: string;
  /** 3D/3dmodel.model up to <resources, at most 256 KiB, for the MakerWorld reader. */
  makerWorldXml?: string;
}

export interface ReadOptions {
  /**
   * Lowers the per-file thumbnail budget (parser.rb max_thumbnail_bytes); it
   * cannot raise it past LIMITS.thumbnailBytesPerFile. Every byte read from a
   * thumbnail entry counts, one passed over for being over LIMITS.pngBytes
   * included, and a file over the budget is damaged (null). A value that is
   * not a positive finite number (NaN, 0, a negative number, Infinity) is
   * ignored and the default applies. The 10 MiB per-thumbnail ceiling is
   * fixed: a plate_N.png over it gives way to plate_N_small.png.
   */
  maxThumbnailBytes?: number;
  /**
   * Receives each plate thumbnail, one at a time in plate order; the next is
   * read only after the returned promise settles. Called only for a file
   * that has already passed every ceiling. Whatever it throws or rejects
   * with reaches the caller of readProject as the same value, never as null
   * or ReadUnavailable, and no further thumbnail is handed over.
   */
  onThumbnail?: (index: number, png: Buffer) => Promise<void>;
}
