// The importer's Platehouse client, over the Public API v1 (build plan Task 16).

export class PlatehouseError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "PlatehouseError";
    this.status = status;
  }
}

export interface PlatehouseFile {
  id: string;
  modelId: string;
  name: string;
  originalName: string;
  size: number;
  sha256: string;
}

export interface PlatehouseModel {
  id: string;
  name: string;
  externalRef: string | null;
  tags: string[];
  collections: string[];
  files: PlatehouseFile[];
}

export interface NewModel {
  name: string;
  caption?: string;
  description?: string;
  creator?: string;
  license?: string;
  externalRef: string;
  tags?: string[];
  collections?: string[];
}

export type CreateResult = { created: PlatehouseModel } | { exists: true; trashed: boolean };

export interface PlatehouseOptions {
  base: string;
  token: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  retries?: number;
  timeoutMs?: number;
}

export interface Platehouse {
  /** One read that proves the API answers and takes the token. */
  check(): Promise<void>;
  /** The live model with this externalRef, with its files; undefined when none is live. */
  findByExternalRef(ref: string): Promise<PlatehouseModel | undefined>;
  createModel(input: NewModel): Promise<CreateResult>;
  addTag(modelId: string, tag: string): Promise<void>;
  addToCollection(modelId: string, collection: string): Promise<void>;
  /** Uploads one file into the model and returns it as Platehouse stored it. */
  upload(modelId: string, filename: string, bytes: Buffer): Promise<PlatehouseFile>;
}

export function createPlatehouse(_options: PlatehouseOptions): Platehouse {
  throw new Error("not implemented");
}
