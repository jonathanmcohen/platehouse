import type { ColumnType, Generated, Selectable } from "kysely";

// The Kysely view of the SQL in migrations/ (0001_init.sql, then each later
// file in number order). Names here are camelCase; kysely.ts installs
// Kysely's CamelCasePlugin, which maps each one to the snake_case table or
// column in the SQL (descriptionMd -> description_md, modelTags ->
// model_tags). The SQL is the schema of record: when a migration
// changes a table, this file changes in the same commit.
//
// Generated<T> marks a column the database fills by default when an insert
// leaves it out. bigint columns read as number (kysely.ts sets the parser and
// refuses a value past Number.MAX_SAFE_INTEGER); bytea reads as Buffer;
// timestamptz as Date.

export type BlobKind = "source" | "thumbnail" | "render_stl" | "render_png" | "mesh_glb";
export type BlobState = "pending" | "stored";
export type FileKind = "3mf" | "stl" | "step" | "scad";
export type ParseStatus = "pending" | "ok" | "no_plate_data" | "unavailable";
export type EstimateSource = "file" | "platehouse";
export type EstimateStatus = "pending" | "running" | "ok" | "failed";
export type BucketVersioning = "enabled" | "suspended" | "off" | "unknown";
export type FilamentProfileSource = "bambu" | "generic" | "file";
export type NameSource = "file" | "title" | "user";

type CreatedAt = Generated<Date>;
// A timestamp the app may also set on update.
type UpdatedAt = ColumnType<Date, Date | undefined, Date>;

export interface SchemaMigrationsTable {
  name: string;
  checksum: string;
  appliedAt: CreatedAt;
}

export interface CreatorsTable {
  id: string;
  name: string;
  createdAt: CreatedAt;
}

export interface ModelsTable {
  id: string;
  name: string;
  caption: string | null;
  descriptionMd: string | null;
  creatorId: string | null;
  licenseSpdx: string | null;
  licenseNote: string | null;
  externalRef: string | null;
  trashedAt: Date | null;
  /** Set when a purge of the trashed model began (0002); restore then refuses it. */
  purgeStartedAt: Date | null;
  /** Who named the model (0005): its file, its .3mf's title, or a person. */
  nameSource: Generated<NameSource>;
  /** The MakerWorld design ID its .3mf carries, digits only (0005). */
  makerworldDesignId: string | null;
  createdAt: CreatedAt;
  updatedAt: UpdatedAt;
}

export interface TagsTable {
  id: string;
  name: string;
}

export interface ModelTagsTable {
  modelId: string;
  tagId: string;
}

export interface CollectionsTable {
  id: string;
  name: string;
}

export interface CollectionModelsTable {
  collectionId: string;
  modelId: string;
}

export interface BlobsTable {
  id: string;
  modelId: string;
  key: string;
  kind: BlobKind;
  size: number | null;
  sha256: Buffer | null;
  contentType: string;
  state: Generated<BlobState>;
  createdAt: CreatedAt;
}

export interface FilesTable {
  id: string;
  modelId: string;
  blobId: string;
  name: string;
  originalName: string;
  kind: FileKind;
  size: number;
  sha256: Buffer;
  externalRef: string | null;
  parseStatus: Generated<ParseStatus>;
  derivedStatus: string | null;
  derivedMessage: string | null;
  meshBlobId: string | null;
  renderStlBlobId: string | null;
  renderPngBlobId: string | null;
  createdAt: CreatedAt;
  updatedAt: UpdatedAt;
}

export interface FileFilamentsTable {
  fileId: string;
  slot: number;
  type: string;
  color: string | null;
}

export interface PlatesTable {
  id: string;
  fileId: string;
  index: number;
  name: string | null;
  objectCount: number;
  thumbnailBlobId: string | null;
}

export interface EstimatesTable {
  id: string;
  plateId: string;
  source: EstimateSource;
  printerId: string;
  printerModelId: string | null;
  nozzle: number | null;
  slicer: string | null;
  slicerVersion: string | null;
  processProfile: string | null;
  /** The filament preset per project slot, in slot order; null where the file's own was kept. */
  filamentProfiles: Generated<(string | null)[]>;
  status: Generated<EstimateStatus>;
  timeSeconds: number | null;
  weightGrams: number | null;
  failureCode: number | null;
  failureReason: string | null;
  failureDetail: string | null;
  attempts: Generated<number>;
  createdAt: CreatedAt;
  finishedAt: Date | null;
}

export interface EstimateFilamentsTable {
  estimateId: string;
  slot: number;
  type: string;
  color: string | null;
  grams: number | null;
  /** The preset the slicer used for the slot (0003); null for the file's own filament. */
  profile: ColumnType<string | null, string | null | undefined, string | null>;
  /** 'bambu', 'generic' or 'file' (0003); null on a file's own numbers. */
  profileSource: ColumnType<
    FilamentProfileSource | null,
    FilamentProfileSource | null | undefined,
    FilamentProfileSource | null
  >;
}

export interface SettingsTable {
  id: Generated<boolean>;
  /** The default printer (0007): one of My printers (userPrinters). */
  printerId: Generated<string>;
  lastOrcaVersion: string | null;
  bucketVersioning: Generated<BucketVersioning>;
  /** Bumped by every write to My printers or the default (0007). */
  printersVersion: Generated<number>;
  updatedAt: UpdatedAt;
}

/**
 * My printers (0007): the printers the user owns, in display order. The default
 * is settings.printerId, which must be one of them.
 */
export interface UserPrintersTable {
  printerId: string;
  position: number;
  addedAt: CreatedAt;
}

export interface ApiTokensTable {
  id: string;
  name: string;
  prefix: string;
  tokenHash: Buffer;
  createdAt: CreatedAt;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  /** The OIDC subject that made the token (0011); null when made before it was recorded. */
  createdBySubject: ColumnType<string | null, string | null | undefined, never>;
  /** The maker's display name when the token was made (0011), or null. */
  createdByName: ColumnType<string | null, string | null | undefined, never>;
}

export interface SessionsTable {
  id: string;
  subject: string;
  createdAt: CreatedAt;
  expiresAt: Date;
  idleExpiresAt: Date;
  /** The display name the issuer gave at sign-in (0011), or null. */
  displayName: ColumnType<string | null, string | null | undefined, never>;
}

export interface DB {
  schemaMigrations: SchemaMigrationsTable;
  creators: CreatorsTable;
  models: ModelsTable;
  tags: TagsTable;
  modelTags: ModelTagsTable;
  collections: CollectionsTable;
  collectionModels: CollectionModelsTable;
  blobs: BlobsTable;
  files: FilesTable;
  fileFilaments: FileFilamentsTable;
  plates: PlatesTable;
  estimates: EstimatesTable;
  estimateFilaments: EstimateFilamentsTable;
  settings: SettingsTable;
  userPrinters: UserPrintersTable;
  apiTokens: ApiTokensTable;
  sessions: SessionsTable;
}

export type Blob = Selectable<BlobsTable>;
export type ModelFile = Selectable<FilesTable>;
export type Plate = Selectable<PlatesTable>;
export type ApiToken = Selectable<ApiTokensTable>;
export type Session = Selectable<SessionsTable>;
