// The settings page's app API (build plan Task 21; AC-013 warning, AC-031
// menu). The web app's own JSON routes live under /app/api, which the Route
// classes table leaves unlisted, so they are session-class: Task 15's gate
// answers a request without a live session 401 and a state-changing one
// whose Origin is not PUBLIC_ORIGIN 403, before any of these handlers runs.
//
//   GET /app/api/settings          {printerId, printers, bucketVersioning}
//   PUT /app/api/settings/printer  {printerId} -> 204 | 400 not in the menu |
//                                  503 the slicer cannot be asked
//
// - The printer menu is Task 12's listPrinters (the slicer's /v1/profiles),
//   grouped by printer model with each model's nozzle choices, in the order
//   the slicer lists them. While the slicer cannot be asked, printers is
//   null and the page says so; the selected printer is still shown.
// - A printer change is Task 12's setPrinter: it stores the printer, cancels
//   the queued slices of other printers and queues re-estimation of every
//   live plate. Until a plate's new estimate lands its old one stays
//   visible, marked as for the previous printer (estimates/display.ts).
// - bucketVersioning is settings.bucket_versioning, which recordVersioning
//   writes at startup from Task 5's readVersioning (main.ts calls it). A
//   store that cannot be reached leaves the last state recorded, and the
//   page's red banner (anything but enabled or unknown) follows it.
//
// appApiScope is the scope every /app/api module registers its routes in:
// JSON bodies are parsed there only (the root app parses none, so nothing
// is read before the gate answers), every answer is Cache-Control: no-store,
// and an error answers JSON with no detail from the database, the store or
// the slicer, whose message goes to the log only. A module given no
// dependencies (a test app that is not about the app API) still registers
// its routes, so the route-class gate and its test cover them, and each
// answers 503.
import type { Printer } from "@platehouse/slicer-contract";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { BucketVersioning } from "../db/types.js";
import { SlicerBusy, SlicerRefused, SlicerUnreachable } from "../estimates/client.js";
import { type Estimates, UnknownPrinter } from "../estimates/service.js";
import type { SettingsRepo } from "../repos/settings.js";
import { type BlobStore, StoreUnavailable } from "../storage/s3.js";

/** Where the web app's own JSON API is mounted. */
export const APP_API_PREFIX = "/app/api";

/** The largest JSON body an /app/api route reads. */
export const APP_API_BODY_LIMIT = 64 * 1024;

/** One printer model in the menu, with its nozzle choices. */
export interface PrinterGroup {
  model: string;
  printers: Array<{ id: string; nozzle: number }>;
}

/** What GET /app/api/settings answers. */
export interface SettingsView {
  printerId: string;
  /** The menu grouped by model; null while the slicer cannot be asked. */
  printers: PrinterGroup[] | null;
  bucketVersioning: BucketVersioning;
}

export interface SettingsApiDeps {
  settings: Pick<SettingsRepo, "get">;
  estimates: Pick<Estimates, "listPrinters" | "setPrinter">;
}

/** An /app/api module was given no dependencies: its routes answer 503. */
export class AppApiUnavailable extends Error {
  constructor() {
    super("This part of the app API is not set up");
    this.name = "AppApiUnavailable";
  }
}

/** The dependencies, or AppApiUnavailable (503) when the app was built without them. */
export function need<T>(deps: T | undefined): T {
  if (deps === undefined) throw new AppApiUnavailable();
  return deps;
}

/** An answer with no detail: an error word and, for the page, a plain sentence. */
export function refuse(reply: FastifyReply, status: number, error: string, message?: string) {
  return reply.code(status).send(message === undefined ? { error } : { error, message });
}

/**
 * Registers routes in an /app/api scope: JSON bodies, no-store answers and
 * the error answers described at the top of this file.
 */
export async function appApiScope(
  app: FastifyInstance,
  register: (scope: FastifyInstance) => void | Promise<void>,
): Promise<void> {
  await app.register(
    async (scope) => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser(
        "application/json",
        { parseAs: "string", bodyLimit: APP_API_BODY_LIMIT },
        scope.getDefaultJsonParser("error", "error"),
      );
      scope.addHook("onSend", async (_request, reply, payload) => {
        reply.header("cache-control", "no-store");
        return payload;
      });
      scope.setErrorHandler(async (error, request, reply) => {
        const err = error as Error & { statusCode?: number; validation?: unknown };
        if (err.validation !== undefined) return refuse(reply, 400, "bad_request", err.message);
        if (error instanceof AppApiUnavailable) return refuse(reply, 503, "unavailable");
        // Task 14's calls refuse an empty name with RangeError.
        if (error instanceof RangeError) return refuse(reply, 400, "bad_request", err.message);
        const status = err.statusCode;
        if (status !== undefined && status >= 400 && status < 500) {
          return refuse(reply, status, "bad_request", err.message);
        }
        // The cause (a database host, a bucket, the slicer's address) goes to the log only.
        request.log.error({ err: error }, "app api: the request failed");
        if (error instanceof StoreUnavailable) return refuse(reply, 503, "unavailable");
        return refuse(reply, 500, "internal");
      });
      await register(scope);
    },
    { prefix: APP_API_PREFIX },
  );
}

/** The printer menu grouped by model, each model's nozzles in the order the slicer lists them. */
export function groupPrinters(printers: readonly Printer[]): PrinterGroup[] {
  const groups = new Map<string, PrinterGroup>();
  for (const p of printers) {
    let group = groups.get(p.model);
    if (group === undefined) {
      group = { model: p.model, printers: [] };
      groups.set(p.model, group);
    }
    group.printers.push({ id: p.id, nozzle: p.nozzle });
  }
  return [...groups.values()];
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

/** The slicer could not be asked: down, busy or answering something else. */
function isSlicerProblem(error: unknown): boolean {
  return (
    error instanceof SlicerUnreachable ||
    error instanceof SlicerBusy ||
    error instanceof SlicerRefused
  );
}

/**
 * Reads the bucket's versioning state and records it in settings (AC-013),
 * returning what it recorded. main.ts calls it at startup. It never throws:
 * a store that cannot be reached, or a write that fails, is logged and the
 * last state recorded stays (undefined is returned).
 */
export async function recordVersioning(deps: {
  store: Pick<BlobStore, "readVersioning">;
  settings: Pick<SettingsRepo, "update">;
  log?: (line: string) => void;
}): Promise<BucketVersioning | undefined> {
  const log = deps.log ?? ((line: string) => console.warn(line));
  try {
    const state = await deps.store.readVersioning();
    await deps.settings.update({ bucketVersioning: state });
    return state;
  } catch (error) {
    log(
      `settings: could not read and record the bucket's versioning state; the last one recorded stays: ${describe(error)}`,
    );
    return undefined;
  }
}

const PRINTER_BODY = {
  type: "object",
  properties: { printerId: { type: "string", minLength: 1, maxLength: 200 } },
  required: ["printerId"],
} as const;

/** Registers GET /app/api/settings and PUT /app/api/settings/printer. */
export async function registerSettingsApi(
  app: FastifyInstance,
  deps: SettingsApiDeps | undefined,
): Promise<void> {
  await appApiScope(app, (scope) => {
    scope.get("/settings", async (request): Promise<SettingsView> => {
      const { settings, estimates } = need(deps);
      const current = await settings.get();
      let printers: PrinterGroup[] | null = null;
      try {
        printers = groupPrinters(await estimates.listPrinters());
      } catch (error) {
        if (!isSlicerProblem(error)) throw error;
        request.log.warn({ err: error }, "app api: the slicer's printer list is unavailable");
      }
      return {
        printerId: current.printerId,
        printers,
        bucketVersioning: current.bucketVersioning,
      };
    });

    scope.put<{ Body: { printerId: string } }>(
      "/settings/printer",
      { schema: { body: PRINTER_BODY } },
      async (request, reply) => {
        const { estimates } = need(deps);
        try {
          await estimates.setPrinter(request.body.printerId);
        } catch (error) {
          if (error instanceof UnknownPrinter) {
            return refuse(reply, 400, "unknown_printer", "That printer is not in the menu.");
          }
          if (isSlicerProblem(error)) {
            request.log.warn({ err: error }, "app api: the slicer's printer list is unavailable");
            return refuse(
              reply,
              503,
              "unavailable",
              "The slicer cannot be reached, so the printer cannot be changed right now.",
            );
          }
          throw error;
        }
        return reply.code(204).send();
      },
    );
  });
}
