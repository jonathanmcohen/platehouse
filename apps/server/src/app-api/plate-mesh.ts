// A .3mf plate's 3D view (issue #358), for the web app's model page:
//
//   GET /app/api/plates/:id/mesh   200 {url}: /blobs/<id> of the plate's GLB,
//                                  made the first time the plate is opened
//                                  (plate-mesh/plate-mesh.ts) and the same
//                                  blob every time after
//                                  422 {error: "no_mesh", code, message}: the
//                                  plate has no 3D view, and why (code is a
//                                  PlateMeshProblem, for the page to say in
//                                  its language; message is the English)
//                                  404 {error: "not_found"}: an unknown or
//                                  malformed plate, or one whose model is in
//                                  the trash
//                                  503 {error: "unavailable", message}: the
//                                  .3mf could not be read right now (the
//                                  store is down or refused, or the temp
//                                  folder could not be written); nothing is
//                                  recorded, so the next open tries again
//                                  503 {error: "busy", message}, with
//                                  Retry-After: 5: the server is already
//                                  making as many 3D views as it will hold
//                                  (plate-mesh/limit.ts); nothing was started
//
// - The browser going away (its fetch aborted, the connection closed) aborts
//   the signal handed to the service, so a build of this plate that is still
//   waiting, and that no other open is waiting for, is dropped (#385).
// - Session-class, like every /app/api route (the Route classes contract:
//   unlisted, so session); the gate refuses a request without a session
//   before this handler runs. It is a GET: it changes nothing a user can
//   see, and making the mesh twice gives the same answer.
// - The browser then loads the GLB from /blobs/<id> (Task 17's route,
//   immutable and cached), never the whole .3mf.
// - Answers are JSON and never cached. A failure carries no detail from the
//   database, the store or the file system.
import { type PlateMeshProblem, ReadUnavailable } from "@platehouse/threemf";
import type { FastifyInstance } from "fastify";
import { isUuid } from "../db/ids.js";
import { BuildQueueBusy } from "../plate-mesh/limit.js";
import { BlobNotFound, StoreError, StoreUnavailable } from "../storage/s3.js";
import { BLOB_PREFIX } from "./library.js";

/** The plate view's route, session-class (the Route classes contract). */
export const PLATE_MESH_API_PATHS: readonly string[] = Object.freeze(["/app/api/plates/:id/mesh"]);

/** What each problem says in English; the page shows its own words for the code. */
export const PLATE_MESH_MESSAGES: Readonly<Record<PlateMeshProblem, string>> = Object.freeze({
  no_plate: "This plate is not in the file's plate list, so it has no 3D view.",
  no_objects: "This plate has no objects on it.",
  no_mesh: "This file has no mesh Platehouse can read for the objects on this plate.",
  too_large: "The objects on this plate are too large to show in the browser.",
  damaged: "The file could not be read, so this plate has no 3D view.",
});

/** What a plate view says when the file cannot be read right now. */
export const PLATE_MESH_UNAVAILABLE_MESSAGE =
  "The file could not be read right now, so the 3D view could not be made. Try again later.";

/** What a plate view says when the server is already making as many 3D views as it will hold. */
export const PLATE_MESH_BUSY_MESSAGE =
  "Platehouse is making other 3D views right now. Try again in a moment.";

export type PlateMeshAnswer =
  | { status: "ok"; blobId: string }
  | { status: "no_mesh"; problem: PlateMeshProblem }
  | { status: "not_found" };

export interface AppPlateMeshes {
  /**
   * The plate's GLB blob, made now if it has none; why it has no 3D view;
   * or not_found. Throws a store error (StoreUnavailable, StoreError,
   * BlobNotFound) or ReadUnavailable when the file cannot be read right now,
   * BuildQueueBusy when too many builds already wait, and an AbortError when
   * signal aborts first (the browser went away).
   */
  get(plateId: string, signal?: AbortSignal): Promise<PlateMeshAnswer>;
}

/** The plate views when the server is given none: every plate unknown. */
export const emptyPlateMeshes: AppPlateMeshes = Object.freeze({
  get: async (): Promise<PlateMeshAnswer> => ({ status: "not_found" }),
});

function unavailable(error: unknown): boolean {
  return (
    error instanceof StoreUnavailable ||
    error instanceof StoreError ||
    error instanceof BlobNotFound ||
    error instanceof ReadUnavailable
  );
}

/** Registers GET /app/api/plates/:id/mesh on the root app, after the gate. */
export async function registerPlateMeshApi(
  app: FastifyInstance,
  meshes: AppPlateMeshes,
): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook("onSend", async (_request, reply, payload) => {
      reply.header("cache-control", "no-store");
      return payload;
    });
    scope.setErrorHandler(async (error, request, reply) => {
      if (error instanceof BuildQueueBusy) {
        return reply
          .code(503)
          .header("retry-after", "5")
          .send({ error: "busy", message: PLATE_MESH_BUSY_MESSAGE });
      }
      // The browser has gone: nobody reads this answer, and nothing failed.
      if ((error as Error).name === "AbortError") {
        request.log.info("plate mesh: the browser stopped waiting");
        return reply.code(503).send({ error: "gone" });
      }
      if (unavailable(error)) {
        request.log.warn({ err: error }, "plate mesh: the file could not be read");
        return reply
          .code(503)
          .send({ error: "unavailable", message: PLATE_MESH_UNAVAILABLE_MESSAGE });
      }
      // The cause (a database host, a path) goes to the log only.
      request.log.error({ err: error }, "plate mesh: the request failed");
      return reply.code(500).send({ error: "internal" });
    });

    scope.get<{ Params: { id: string } }>("/app/api/plates/:id/mesh", async (request, reply) => {
      if (!isUuid(request.params.id)) return reply.code(404).send({ error: "not_found" });
      // Aborted when the response closes before it was sent: the browser went away.
      // Only while the service works: once it has answered, nothing is left to stop.
      const gone = new AbortController();
      const closed = (): void => {
        if (!reply.raw.writableFinished) gone.abort();
      };
      reply.raw.once("close", closed);
      let answer: PlateMeshAnswer;
      try {
        answer = await meshes.get(request.params.id, gone.signal);
      } finally {
        reply.raw.off("close", closed);
      }
      switch (answer.status) {
        case "ok":
          return { url: `${BLOB_PREFIX}${answer.blobId}` };
        case "no_mesh":
          return reply.code(422).send({
            error: "no_mesh",
            code: answer.problem,
            message: PLATE_MESH_MESSAGES[answer.problem],
          });
        default:
          return reply.code(404).send({ error: "not_found" });
      }
    });
  });
}
