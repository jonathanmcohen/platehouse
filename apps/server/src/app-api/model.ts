// The model page's app API (build plan Task 20; AC-030, AC-032 to AC-034
// display, AC-040, AC-050, AC-051, AC-072), for the web app's model page:
//
//   GET  /app/api/models/:id?printer    ModelView: the model, its files in
//                                       upload order, each .3mf's plates in
//                                       plate order with their numbers, for
//                                       printer (the page's printer switch)
//                                       when it is one of My printers, else
//                                       the default printer, with the
//                                       switch's choices; reading never
//                                       queues a slice
//   POST /app/api/estimates/:id/retry   202 {queued: true}: a failed estimate
//                                       is queued again (Task 12's
//                                       retryEstimate, from the stored file)
//                                       409 {error: "not_retryable"}
//   GET  /app/api/models/title-names    TitleNamePlan: the "Use file titles"
//                                       preview (repos/models.ts), which
//                                       changes nothing, with its planId
//   POST /app/api/models/title-names    {planId} -> {renamed}: runs the
//                                       previewed plan. 409 {error:
//                                       "plan_changed"} when the plan is no
//                                       longer that one, and nothing is
//                                       renamed; 400 without a planId. Only
//                                       the Settings page's button calls it,
//                                       after its own confirmation; nothing
//                                       runs it on its own
//
// - Every route is session-class (the Route classes contract: /app/api is
//   unlisted, so session); the gate (auth/gate.ts) refuses a request without
//   a session before these handlers run, and each POST, which changes state,
//   also needs Origin to be PUBLIC_ORIGIN. The Open buttons mint their link
//   at Task 17's POST /app/api/files/:id/slicer-link, not here.
// - A trashed, unknown or malformed model is 404, as is a malformed
//   estimate id; nothing about the model is in the answer.
// - The model is read from the database alone; this module is given no
//   store. Every image or mesh the page loads is named as /blobs/<id>
//   (Task 17's route), and only a stored blob of this model and of the
//   kind its place calls for is ever named: a plate's thumbnail (thumbnail),
//   an STL's own bytes (source), a STEP's mesh (mesh_glb), a SCAD's
//   rendered STL (render_stl), and the preview picture (render_png) of a
//   SCAD, an STL or a STEP file (issue #316). Anything else is
//   null, so the page shows no image rather than another file's bytes. A
//   .3mf has no 3D view (AC-051).
// - Each plate's numbers are Task 12's plateNumbers, with the display
//   context (the settings row and the printer menu, readDisplayContext)
//   read once per page, as the library page does (app-api/library.ts).
//   Beside them, estimatePending says whether an estimate for the selected
//   printer and Orca version is queued or slicing. Both are read in one
//   read-only REPEATABLE READ transaction, so they come from one snapshot:
//   an estimate that lands or is queued while the answer is being read can
//   never leave a stale set beside estimatePending false, which would stop
//   the page's polling with the finished estimate never shown. The plates
//   are read one after another on that transaction's connection.
// - A file's render or conversion message (files.derived_message, OpenSCAD's
//   or the STEP converter's own text) is cleaned by scrubDerivedMessage
//   (src/scrub.ts; issue #260) as it is read, so no slicer temp path or
//   address reaches the page; the whole stored message is kept, and a longer
//   one keeps its end, where the program's error line is. The stored row is
//   left as it is.
// - Answers are JSON and never cached. Errors carry no detail from the
//   database.

import { createHash } from "node:crypto";
import { makerWorldUrl } from "@platehouse/threemf";
import type { FastifyInstance } from "fastify";
import { type Kysely, sql } from "kysely";
import { isUuid } from "../db/ids.js";
import type { BlobKind, DB, FileKind, ParseStatus } from "../db/types.js";
import { derivedParts } from "../derived/client.js";
import {
  type DisplayContext,
  type PlateNumbers,
  plateNumbers,
  printerName,
} from "../estimates/display.js";
import { createRepos } from "../repos/index.js";
import type { TitleNamePlan } from "../repos/models.js";
import { scrubDerivedMessage } from "../scrub.js";
import { BLOB_PREFIX, forPrinter, type PrinterChoice, printerChoices } from "./library.js";

/** What Use file titles says when it is run with no preview (400, code titles_not_previewed). */
export const TITLES_NOT_PREVIEWED_MESSAGE = "Press Use file titles to see the list first.";

/** What Use file titles says when the library changed after its preview (409 plan_changed). */
export const PLAN_CHANGED_MESSAGE =
  "The library changed after this preview, so nothing was renamed. Cancel, then press Use file titles again to see the new list.";

/** A "Use file titles" planId: the SHA-256 of the plan's renames, in hex. */
const PLAN_ID = /^[0-9a-f]{64}$/;

/** The largest body POST /app/api/models/title-names reads: {planId} is under 100 bytes. */
const PLAN_BODY_LIMIT = 1024;

/** The planId of a plan with no renames (the SHA-256 of "[]"). */
const EMPTY_PLAN_ID = createHash("sha256").update("[]").digest("hex");

/** The model page's routes, every one session-class (the Route classes contract). */
export const MODEL_API_PATHS: readonly string[] = Object.freeze([
  "/app/api/models/:id",
  "/app/api/estimates/:id/retry",
  "/app/api/models/title-names",
]);

export interface ModelPlate {
  id: string;
  index: number;
  name: string | null;
  objectCount: number;
  /** /blobs/<id> of the plate's stored thumbnail; null when there is none. */
  thumbnail: string | null;
  numbers: PlateNumbers;
  /**
   * Whether a Platehouse estimate for the selected printer and the current
   * Orca version is queued or slicing now. The page polls on this, not on a
   * stale set alone: plateNumbers keeps an older estimate shown (stale) also
   * when no new one was ever queued, such as when the stored printer is no
   * longer in the slicer's menu or the menu could not be read.
   */
  estimatePending: boolean;
}

export interface ModelFileView {
  id: string;
  /** The display name (a rename changes only this). */
  name: string;
  kind: FileKind;
  size: number;
  parseStatus: ParseStatus;
  derivedStatus: string | null;
  /** The render or conversion message, cleaned by scrubDerivedMessage, its end kept (issue #260); null with none. */
  derivedMessage: string | null;
  /**
   * The sentences Platehouse wrote at the start of derivedMessage, by code
   * (derived/client.ts splitDerivedMessage), for the page to show in its
   * language (the maintainer, 2026-11-19); empty when it holds none.
   */
  derivedCodes: string[];
  /** What derivedMessage holds after those sentences (the program's own words), or null. */
  derivedDetail: string | null;
  /** Task 17's download route for the file. */
  download: string;
  /** What the 3D viewer loads: an STL or a GLB blob; null for a .3mf or nothing stored yet. */
  view: { kind: "stl" | "glb"; url: string } | null;
  /** A SCAD, STL or STEP file's rendered preview image (issue #316 for STL and STEP); null otherwise. */
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
  /**
   * The design's MakerWorld page, https://makerworld.com/models/<id>, built
   * from the stored design ID alone (packages/threemf makerWorldUrl); null
   * when the model's .3mf carried no valid one. No URL text from a file is
   * ever passed through.
   */
  makerWorldUrl: string | null;
  tags: string[];
  collections: string[];
  /** The printer the numbers are for: the default printer, or the switch's choice. */
  printer: string;
  /** That printer in full, such as "Bambu Lab P1S, 0.4 mm nozzle". */
  printerName: string;
  /** The printer switch's choices: My printers, in order. */
  printers: PrinterChoice[];
  files: ModelFileView[];
}

export interface AppModel {
  /**
   * The model page's data, with each plate's numbers for printer when it is
   * one of My printers, else for the default printer; undefined for a
   * trashed, unknown or malformed id.
   */
  get(id: string, printer?: string): Promise<ModelView | undefined>;
  /** Queues a failed estimate again; false when it is not one that can be. */
  retry(estimateId: string): Promise<boolean>;
  /** The "Use file titles" preview: what it would rename, and what it skips and why. */
  titleNames(): Promise<TitleNamePlan>;
  /**
   * Runs the "Use file titles" plan the preview with this planId showed;
   * null, renaming nothing, when the plan has changed since. Only ever from
   * the user's own action in Settings.
   */
  useTitleNames(planId: string): Promise<{ renamed: number } | null>;
}

export interface AppModelDeps {
  db: Kysely<DB>;
  /** The selected printer, the Orca version and the printer menu, read once per page. */
  displayContext(): Promise<DisplayContext>;
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
    async get(id, printer) {
      const model = await repos.models.get(id);
      if (model === undefined) return undefined;
      const [read, tagRows, collectionRows, files] = await Promise.all([
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
      const ctx = forPrinter(read, printer);
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

      // Every plate's numbers and estimatePending from one snapshot.
      const numbers = new Map<string, PlateNumbers>();
      const pending = new Set<string>();
      if (plates.length > 0) {
        await db
          .transaction()
          .setIsolationLevel("repeatable read")
          .setAccessMode("read only")
          .execute(async (trx) => {
            const pendingRows = await trx
              .selectFrom("estimates")
              .select("plateId")
              .where(
                "plateId",
                "in",
                plates.map((p) => p.id),
              )
              .where("source", "=", "platehouse")
              .where("printerId", "=", ctx.printerId)
              .where((eb) =>
                ctx.orcaVersion === null
                  ? eb("slicerVersion", "is", null)
                  : eb("slicerVersion", "=", ctx.orcaVersion),
              )
              .where("status", "in", ["pending", "running"])
              .execute();
            for (const r of pendingRows) pending.add(r.plateId);
            for (const p of plates) numbers.set(p.id, await plateNumbers(trx, ctx, p.id));
          });
      }

      return {
        id: model.id,
        name: model.name,
        caption: model.caption,
        description: model.descriptionMd,
        creator: model.creator,
        license: model.licenseSpdx,
        licenseNote: model.licenseNote,
        makerWorldUrl: makerWorldUrl(model.makerworldDesignId),
        tags: tagRows.map((t) => t.name),
        collections: collectionRows.map((c) => c.name),
        printer: ctx.printerId,
        printerName: printerName(ctx.printerId, ctx.printers),
        printers: printerChoices(ctx),
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
          // A SCAD's rendered PNG, or an STL's or STEP's preview picture (issue #316).
          const previewBlob = f.kind === "3mf" ? null : stored(f.renderPngBlobId, "render_png");
          return {
            id: f.id,
            name: f.name,
            kind: f.kind,
            size: Number(f.size),
            parseStatus: f.parseStatus,
            derivedStatus: f.derivedStatus,
            derivedMessage: scrubDerivedMessage(f.derivedMessage),
            ...derivedParts(scrubDerivedMessage(f.derivedMessage)),
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
                estimatePending: pending.has(p.id),
              })),
          };
        }),
      };
    },

    retry: (estimateId) => deps.retryEstimate(estimateId),

    titleNames: () => repos.models.titleNamePlan(),

    useTitleNames: (planId) => repos.models.applyTitleNames(planId),
  };
}

/** The model API when the server is given none: every model unknown, nothing retried. */
export const emptyAppModel: AppModel = Object.freeze({
  get: async () => undefined,
  retry: async () => false,
  titleNames: async () => ({
    planId: EMPTY_PLAN_ID,
    renames: [],
    skipped: {
      renamedByUser: 0,
      namedFromTitle: 0,
      noTitle: 0,
      sameName: 0,
      nameNotFromFile: 0,
      imported: 0,
      captionNotFromFile: 0,
    },
  }),
  useTitleNames: async (planId: string) => (planId === EMPTY_PLAN_ID ? { renamed: 0 } : null),
});

/** printer is the page's printer switch: one of My printers. */
const MODEL_QUERY = {
  type: "object",
  properties: { printer: { type: "string", maxLength: 200 } },
} as const;

/** Registers the model page's routes on the root app, after the gate. */
export async function registerModelApi(app: FastifyInstance, model: AppModel): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook("onSend", async (_request, reply, payload) => {
      reply.header("cache-control", "no-store");
      return payload;
    });
    scope.setErrorHandler(async (error, request, reply) => {
      // A request the schema refuses (an over-long or repeated printer) is
      // the client's mistake: 400, and not logged as a server failure.
      const err = error as Error & { validation?: unknown; statusCode?: number };
      if (err.validation !== undefined) return reply.code(400).send({ error: "bad_request" });
      if (err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500) {
        return reply.code(err.statusCode).send({ error: "bad_request" });
      }
      // The cause (a database host) goes to the log only.
      request.log.error({ err: error }, "model: the request failed");
      return reply.code(500).send({ error: "internal" });
    });

    scope.get<{ Params: { id: string }; Querystring: { printer?: string } }>(
      "/app/api/models/:id",
      { schema: { querystring: MODEL_QUERY } },
      async (request, reply) => {
        const found = isUuid(request.params.id)
          ? await model.get(request.params.id, request.query.printer)
          : undefined;
        if (found === undefined) return reply.code(404).send({ error: "not_found" });
        return found;
      },
    );

    // Registered beside /app/api/models/:id; Fastify matches the fixed
    // segment first, so "title-names" never reaches the id route.
    scope.get("/app/api/models/title-names", async () => model.titleNames());

    // The one route here with a body. The gate removes every body parser
    // from the root app, so this context alone reads small JSON bodies; a
    // body it cannot read is a 4xx, never the scope's 500.
    await scope.register(async (json) => {
      json.removeAllContentTypeParsers();
      json.addContentTypeParser(
        "application/json",
        { parseAs: "string", bodyLimit: PLAN_BODY_LIMIT },
        json.getDefaultJsonParser("error", "error"),
      );
      json.setErrorHandler(async (error, request, reply) => {
        const status = (error as { statusCode?: number }).statusCode;
        if (status !== undefined && status >= 400 && status < 500) {
          return reply.code(status).send({ error: "bad_request" });
        }
        request.log.error({ err: error }, "model: the request failed");
        return reply.code(500).send({ error: "internal" });
      });
      json.post("/app/api/models/title-names", async (request, reply) => {
        const planId = (request.body as { planId?: unknown } | null | undefined)?.planId;
        if (typeof planId !== "string" || !PLAN_ID.test(planId)) {
          return reply.code(400).send({
            error: "bad_request",
            message: TITLES_NOT_PREVIEWED_MESSAGE,
            code: "titles_not_previewed",
          });
        }
        const done = await model.useTitleNames(planId);
        if (done === null) {
          return reply.code(409).send({
            error: "plan_changed",
            message: PLAN_CHANGED_MESSAGE,
          });
        }
        return done;
      });
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
