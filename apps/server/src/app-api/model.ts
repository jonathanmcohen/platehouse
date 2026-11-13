// The model page's app API (build plan Task 20; AC-030, AC-032 to AC-034
// display, AC-040, AC-050, AC-051, AC-072), for the web app's model page:
//
//   GET  /app/api/models/:id            ModelView: the model, its files in
//                                       upload order, each .3mf's plates in
//                                       plate order with their numbers
//   POST /app/api/estimates/:id/retry   202 {queued: true}: a failed estimate
//                                       is queued again (Task 12's
//                                       retryEstimate, from the stored file)
//                                       409 {error: "not_retryable"}
//
// - Both routes are session-class (the Route classes contract: /app/api is
//   unlisted, so session); the gate (auth/gate.ts) refuses a request without
//   a session before these handlers run, and the retry, which changes state,
//   also needs Origin to be PUBLIC_ORIGIN. The Open buttons mint their link
//   at Task 17's POST /app/api/files/:id/slicer-link, not here.
// - A trashed, unknown or malformed model is 404, as is a malformed
//   estimate id; nothing about the model is in the answer.
// - The model is read from the database alone; this module is given no
//   store. Every image or mesh the page loads is named as /blobs/<id>
//   (Task 17's route), and only a stored blob of this model and of the
//   kind its place calls for is ever named: a plate's thumbnail (thumbnail),
//   an STL's own bytes (source), a STEP's mesh (mesh_glb), a SCAD's
//   rendered STL (render_stl) and preview (render_png). Anything else is
//   null, so the page shows no image rather than another file's bytes. A
//   .3mf has no 3D view (AC-051).
// - Each plate's numbers are Task 12's plateNumbers, with the display
//   context (the settings row and the printer menu, readDisplayContext)
//   read once per page and at most PLATE_NUMBERS_CONCURRENCY lookups at a
//   time, as the library page does (app-api/library.ts).
// - Answers are JSON and never cached. Errors carry no detail from the
//   database.
import type { FastifyInstance } from "fastify";
import { type Kysely, sql } from "kysely";
import { isUuid } from "../db/ids.js";
import type { BlobKind, DB, FileKind, ParseStatus } from "../db/types.js";
import type { DisplayContext, PlateNumbers } from "../estimates/display.js";
import { createRepos } from "../repos/index.js";
import { BLOB_PREFIX, mapLimit, PLATE_NUMBERS_CONCURRENCY } from "./library.js";

/** The model page's routes, every one session-class (the Route classes contract). */
export const MODEL_API_PATHS: readonly string[] = Object.freeze([
  "/app/api/models/:id",
  "/app/api/estimates/:id/retry",
]);

export interface ModelPlate {
  id: string;
  index: number;
  name: string | null;
  objectCount: number;
  /** /blobs/<id> of the plate's stored thumbnail; null when there is none. */
  thumbnail: string | null;
  numbers: PlateNumbers;
}

export interface ModelFileView {
  id: string;
  /** The display name (a rename changes only this). */
  name: string;
  kind: FileKind;
  size: number;
  parseStatus: ParseStatus;
  derivedStatus: string | null;
  derivedMessage: string | null;
  /** Task 17's download route for the file. */
  download: string;
  /** What the 3D viewer loads: an STL or a GLB blob; null for a .3mf or nothing stored yet. */
  view: { kind: "stl" | "glb"; url: string } | null;
  /** A SCAD file's rendered preview image; null otherwise. */
  preview: string | null;
  /** The project filament list of a .3mf (file_filaments). */
  filaments: Array<{ slot: number; type: string; color: string | null }>;
  /** A .3mf's plates in plate order; empty for every other kind. */
  plates: ModelPlate[];
}

export interface ModelView {
  id: string;
  name: string;
  caption: string | null;
  /** The description as Markdown; the page renders it with renderMarkdown (Task 7). */
  description: string | null;
  creator: string | null;
  /** The SPDX licence id. */
  license: string | null;
  /** The stored licence note, such as a MakerWorld-only licence. */
  licenseNote: string | null;
  tags: string[];
  collections: string[];
  /** The selected printer the numbers are for. */
  printer: string;
  files: ModelFileView[];
}

export interface AppModel {
  /** The model page's data; undefined for a trashed, unknown or malformed id. */
  get(id: string): Promise<ModelView | undefined>;
  /** Queues a failed estimate again; false when it is not one that can be. */
  retry(estimateId: string): Promise<boolean>;
}

export interface AppModelDeps {
  db: Kysely<DB>;
  /** The selected printer, the Orca version and the printer menu, read once per page. */
  displayContext(): Promise<DisplayContext>;
  /** Task 12's plateNumbers for one plate with that context (estimates/display.ts). */
  plateNumbers(ctx: DisplayContext, plateId: string): Promise<PlateNumbers>;
  /** Task 12's retryEstimate (estimates/service.ts). */
  retryEstimate(estimateId: string): Promise<boolean>;
}

/** The blob kind a file's 3D view is made from, by file kind. */
const VIEW_BLOB: Partial<Record<FileKind, { kind: BlobKind; as: "stl" | "glb" }>> = {
  stl: { kind: "source", as: "stl" },
  step: { kind: "mesh_glb", as: "glb" },
  scad: { kind: "render_stl", as: "stl" },
};

function blobUrl(id: string): string {
  return `${BLOB_PREFIX}${id}`;
}

export function createAppModel(deps: AppModelDeps): AppModel {
  const { db } = deps;
  const repos = createRepos(db);

  return {
    async get(id) {
      const model = await repos.models.get(id);
      if (model === undefined) return undefined;
      const [ctx, tagRows, collectionRows, files] = await Promise.all([
        deps.displayContext(),
        db
          .selectFrom("modelTags")
          .innerJoin("tags", "tags.id", "modelTags.tagId")
          .select("tags.name")
          .where("modelTags.modelId", "=", model.id)
          .orderBy(sql`lower(tags.name)`)
          .orderBy("tags.name")
          .execute(),
        db
          .selectFrom("collectionModels")
          .innerJoin("collections", "collections.id", "collectionModels.collectionId")
          .select("collections.name")
          .where("collectionModels.modelId", "=", model.id)
          .orderBy(sql`lower(collections.name)`)
          .orderBy("collections.name")
          .execute(),
        db
          .selectFrom("files")
          .select([
            "id",
            "name",
            "kind",
            "size",
            "parseStatus",
            "derivedStatus",
            "derivedMessage",
            "blobId",
            "meshBlobId",
            "renderStlBlobId",
            "renderPngBlobId",
          ])
          .where("modelId", "=", model.id)
          .orderBy("createdAt")
          .orderBy("id")
          .execute(),
      ]);
      const fileIds = files.map((f) => f.id);

      // The stored blobs of this model a file may name, by id.
      const candidates = files.flatMap((f) =>
        [f.blobId, f.meshBlobId, f.renderStlBlobId, f.renderPngBlobId].filter(
          (b): b is string => b !== null,
        ),
      );
      const [blobs, plates, filaments] = await Promise.all([
        candidates.length === 0
          ? []
          : db
              .selectFrom("blobs")
              .select(["id", "kind"])
              .where("id", "in", candidates)
              .where("modelId", "=", model.id)
              .where("state", "=", "stored")
              .execute(),
        fileIds.length === 0
          ? []
          : db
              .selectFrom("plates")
              .innerJoin("files", "files.id", "plates.fileId")
              .leftJoin("blobs", (join) =>
                join
                  .onRef("blobs.id", "=", "plates.thumbnailBlobId")
                  .onRef("blobs.modelId", "=", "files.modelId")
                  .on("blobs.kind", "=", "thumbnail")
                  .on("blobs.state", "=", "stored"),
              )
              .select([
                "plates.id",
                "plates.fileId",
                "plates.index",
                "plates.name",
                "plates.objectCount",
                "blobs.id as thumbnailId",
              ])
              .where("plates.fileId", "in", fileIds)
              .where("files.kind", "=", "3mf")
              .orderBy("plates.index")
              .execute(),
        fileIds.length === 0
          ? []
          : db
              .selectFrom("fileFilaments")
              .select(["fileId", "slot", "type", "color"])
              .where("fileId", "in", fileIds)
              .orderBy("slot")
              .execute(),
      ]);
      const kindOf = new Map(blobs.map((b) => [b.id, b.kind]));
      const stored = (blobId: string | null, kind: BlobKind): string | null =>
        blobId !== null && kindOf.get(blobId) === kind ? blobId : null;

      const numbers = new Map(
        await mapLimit(
          plates,
          PLATE_NUMBERS_CONCURRENCY,
          async (p) => [p.id, await deps.plateNumbers(ctx, p.id)] as const,
        ),
      );

      return {
        id: model.id,
        name: model.name,
        caption: model.caption,
        description: model.descriptionMd,
        creator: model.creator,
        license: model.licenseSpdx,
        licenseNote: model.licenseNote,
        tags: tagRows.map((t) => t.name),
        collections: collectionRows.map((c) => c.name),
        printer: ctx.printerId,
        files: files.map((f): ModelFileView => {
          const viewFrom = VIEW_BLOB[f.kind];
          const viewSource =
            f.kind === "stl"
              ? f.blobId
              : f.kind === "step"
                ? f.meshBlobId
                : f.kind === "scad"
                  ? f.renderStlBlobId
                  : null;
          const viewBlob = viewFrom === undefined ? null : stored(viewSource, viewFrom.kind);
          const previewBlob = f.kind === "scad" ? stored(f.renderPngBlobId, "render_png") : null;
          return {
            id: f.id,
            name: f.name,
            kind: f.kind,
            size: Number(f.size),
            parseStatus: f.parseStatus,
            derivedStatus: f.derivedStatus,
            derivedMessage: f.derivedMessage,
            download: `/files/${f.id}/download`,
            view:
              viewFrom === undefined || viewBlob === null
                ? null
                : { kind: viewFrom.as, url: blobUrl(viewBlob) },
            preview: previewBlob === null ? null : blobUrl(previewBlob),
            filaments: filaments
              .filter((x) => x.fileId === f.id)
              .map((x) => ({ slot: x.slot, type: x.type, color: x.color })),
            plates: plates
              .filter((p) => p.fileId === f.id)
              .map((p) => ({
                id: p.id,
                index: p.index,
                name: p.name,
                objectCount: p.objectCount,
                thumbnail: p.thumbnailId === null ? null : blobUrl(p.thumbnailId),
                numbers: numbers.get(p.id) ?? {},
              })),
          };
        }),
      };
    },

    retry: (estimateId) => deps.retryEstimate(estimateId),
  };
}

/** The model API when the server is given none: every model unknown, nothing retried. */
export const emptyAppModel: AppModel = Object.freeze({
  get: async () => undefined,
  retry: async () => false,
});

/** Registers the model page's routes on the root app, after the gate. */
export async function registerModelApi(app: FastifyInstance, model: AppModel): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook("onSend", async (_request, reply, payload) => {
      reply.header("cache-control", "no-store");
      return payload;
    });
    scope.setErrorHandler(async (error, request, reply) => {
      // The cause (a database host) goes to the log only.
      request.log.error({ err: error }, "model: the request failed");
      return reply.code(500).send({ error: "internal" });
    });

    scope.get<{ Params: { id: string } }>("/app/api/models/:id", async (request, reply) => {
      const found = isUuid(request.params.id) ? await model.get(request.params.id) : undefined;
      if (found === undefined) return reply.code(404).send({ error: "not_found" });
      return found;
    });

    scope.post<{ Params: { id: string } }>(
      "/app/api/estimates/:id/retry",
      async (request, reply) => {
        if (!isUuid(request.params.id)) return reply.code(404).send({ error: "not_found" });
        if (!(await model.retry(request.params.id))) {
          return reply.code(409).send({ error: "not_retryable" });
        }
        return reply.code(202).send({ queued: true });
      },
    );
  });
}
