// A read-only Manyfold API client (port of manyfold.mjs at automation 1ce8c57).

/** The media type of Manyfold's JSON API (v0). */
export const MANYFOLD_MEDIA_TYPE = "application/vnd.manyfold.v0+json";

export class ManyfoldError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ManyfoldError";
    this.status = status;
  }
}

/** A download whose byte count is not Manyfold's contentSize. */
export class SizeMismatch extends ManyfoldError {
  readonly expected: number;
  readonly actual: number;
  constructor(message: string, expected: number, actual: number) {
    super(message);
    this.name = "SizeMismatch";
    this.expected = expected;
    this.actual = actual;
  }
}

export interface ManyfoldOptions {
  base: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Called with every value the output must never show: the token, a signed query. */
  secret?: (value: string) => void;
  retries?: number;
  timeoutMs?: number;
  downloadTimeoutMs?: number;
}

export interface ManyfoldListEntry {
  id: string;
  url: string;
  name: string;
}

export interface ManyfoldModel {
  id: string;
  url: string;
  name: string;
  caption: string | null;
  description: string | null;
  creatorUrl: string | null;
  license: string | null;
  keywords: string[];
  collectionUrls: string[];
  parts: Array<{ url: string; name: string | null }>;
}

export interface ManyfoldFile {
  url: string;
  filename: string;
  contentUrl: string;
  contentSize: number | null;
}

export interface Manyfold {
  /** Asks for the run's one token (scope read). */
  authenticate(): Promise<void>;
  listModels(): Promise<ManyfoldListEntry[]>;
  /** Creator URL to name, every page. */
  listCreators(): Promise<Map<string, string>>;
  /** Collection URL to name, every page. */
  listCollections(): Promise<Map<string, string>>;
  modelUrl(id: string): string;
  getModel(url: string): Promise<ManyfoldModel>;
  /** The name of a creator or collection, read by its URL. */
  getName(url: string): Promise<string | null>;
  getFile(url: string): Promise<ManyfoldFile>;
  download(url: string, expectedSize: number): Promise<Buffer>;
}

export function createManyfold(_options: ManyfoldOptions): Manyfold {
  throw new Error("not implemented");
}
