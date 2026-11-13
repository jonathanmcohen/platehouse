// The model page's app API (build plan Task 20). Interface stub.
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { DB, FileKind, ParseStatus } from "../db/types.js";
import type { DisplayContext, PlateNumbers } from "../estimates/display.js";

export const MODEL_API_PATHS: readonly string[] = Object.freeze([]);

export interface ModelPlate {
  id: string;
  index: number;
  name: string | null;
  objectCount: number;
  thumbnail: string | null;
  numbers: PlateNumbers;
}

export interface ModelFileView {
  id: string;
  name: string;
  kind: FileKind;
  size: number;
  parseStatus: ParseStatus;
  derivedStatus: string | null;
  derivedMessage: string | null;
  download: string;
  view: { kind: "stl" | "glb"; url: string } | null;
  preview: string | null;
  filaments: Array<{ slot: number; type: string; color: string | null }>;
  plates: ModelPlate[];
}

export interface ModelView {
  id: string;
  name: string;
  caption: string | null;
  description: string | null;
  creator: string | null;
  license: string | null;
  licenseNote: string | null;
  tags: string[];
  collections: string[];
  printer: string;
  files: ModelFileView[];
}

export interface AppModel {
  get(id: string): Promise<ModelView | undefined>;
  retry(estimateId: string): Promise<boolean>;
}

export interface AppModelDeps {
  db: Kysely<DB>;
  displayContext(): Promise<DisplayContext>;
  plateNumbers(ctx: DisplayContext, plateId: string): Promise<PlateNumbers>;
  retryEstimate(estimateId: string): Promise<boolean>;
}

export function createAppModel(_deps: AppModelDeps): AppModel {
  return { get: async () => undefined, retry: async () => false };
}

export const emptyAppModel: AppModel = Object.freeze({
  get: async () => undefined,
  retry: async () => false,
});

export async function registerModelApi(app: FastifyInstance, _model: AppModel): Promise<void> {
  app.get("/app/api/models/:id", async (_request, reply) => reply.code(501).send());
  app.post("/app/api/estimates/:id/retry", async (_request, reply) => reply.code(501).send());
}
