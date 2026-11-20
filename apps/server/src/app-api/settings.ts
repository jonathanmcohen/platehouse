// The settings page's app API (build plan Task 21; AC-013 warning, AC-031
// menu). The web app's own JSON routes live under /app/api, which the Route
// classes table leaves unlisted, so they are session-class: Task 15's gate
// answers a request without a live session 401 and a state-changing one
// whose Origin is not PUBLIC_ORIGIN 403, before any of these handlers runs.
//
//   GET /app/api/settings           SettingsView: the default printer, My
//                                   printers and their version, the menu,
//                                   bucketVersioning
//   PUT /app/api/settings/printers  {printers, defaultId, version} -> 200
//                                   SavedPrinters | 400 refused (a sentence
//                                   in message) | 409 printers_changed, the
//                                   list or the default changed since
//                                   version and nothing changed | 503 the
//                                   slicer cannot be asked
//
// - The printer menu is Task 12's listPrinters (the slicer's /v1/profiles),
//   grouped by printer model with each model's nozzle choices, in the order
//   the slicer lists them, each printer named in full ("Bambu Lab P1S,
//   0.4 mm nozzle"). While the slicer cannot be asked, printers is null and
//   the page says so; My printers are still shown.
// - My printers are the printers Jon owns, in his order, one of them the
//   default. The page saves the whole list at once (add, remove, reorder or
//   a new default) through the estimates service's savePrinters: an added
//   printer has every live plate queued for it, which takes hours on a big
//   library (SLICES_PER_MINUTE), and a removed one has its waiting work
//   dropped. GET answers printersVersion, which every save of the list or
//   the default bumps, and the page sends back the one it last read; a save
//   whose version is no longer the stored one is refused with 409 and
//   changes nothing. A page open in another window would otherwise undo
//   whatever changed there: remove a printer added there (cancelling its
//   slices), bring back one removed there, or put back the old default,
//   which decides what the library, the model page and the public API v1
//   show first. One token covers the whole save, not field by field. Each
//   listed printer says how many plate
//   estimates it still has waiting, how many slices run up to and including
//   its last one across every printer (through: one queue, one slice at a
//   time, so a printer behind another's work waits for it too), and whether
//   the slicer still offers it.
// - The library's and the model page's printer switch read their choices
//   from those pages' own answers (app-api/library.ts printerChoices), and
//   switching reads numbers only; nothing there starts a slice.
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
import { printerName } from "../estimates/display.js";
import {
  type Estimates,
  MAX_MY_PRINTERS,
  PrinterListRefused,
  PrintersChanged,
  type SavedPrinters,
  UnknownPrinter,
} from "../estimates/service.js";
import type { SettingsRepo } from "../repos/settings.js";
import { type BlobStore, StoreUnavailable } from "../storage/s3.js";

/** Where the web app's own JSON API is mounted. */
export const APP_API_PREFIX = "/app/api";

/** The largest JSON body an /app/api route reads. */
export const APP_API_BODY_LIMIT = 64 * 1024;

/**
 * Plates the slicer estimates a minute, as measured on the maintainer's own
 * test machine running the example compose file (Jon, about 3 a minute): the page uses it to say how long a printer it just added will
 * take. The slicer runs one plate at a time, so this is the whole rate.
 */
export const SLICES_PER_MINUTE = 3;

/** One printer model in the menu, with its nozzle choices. */
export interface PrinterGroup {
  model: string;
  /** name is the printer in full, such as "Bambu Lab P1S, 0.4 mm nozzle". */
  printers: Array<{ id: string; nozzle: number; name: string }>;
}

/** One of My printers, as the settings page lists it. */
export interface MyPrinterView {
  id: string;
  /** The printer in full (estimates/display.ts printerName). */
  name: string;
  /** Whether the slicer still offers it; null while the menu cannot be read. */
  offered: boolean | null;
  /** Plate estimates still queued or slicing for it at the current Orca version. */
  waiting: number;
  /**
   * Slices that run up to and including its last waiting one, every
   * printer's work counted: the slicer is one queue, one plate at a time.
   * The page's "about how long" is this over SLICES_PER_MINUTE; 0 with
   * nothing waiting.
   */
  through: number;
}

/** What GET /app/api/settings answers. */
export interface SettingsView {
  /** The default printer. */
  printerId: string;
  /** My printers, in order. */
  myPrinters: MyPrinterView[];
  /**
   * The version of My printers and the default together; a save sends back
   * the one its page read, and an older one is refused (409).
   */
  printersVersion: number;
  /** The menu grouped by model; null while the slicer cannot be asked. */
  printers: PrinterGroup[] | null;
  /** SLICES_PER_MINUTE, for the page's "this will take about" sentence. */
  slicesPerMinute: number;
  bucketVersioning: BucketVersioning;
}

export interface SettingsApiDeps {
  settings: Pick<SettingsRepo, "get">;
  estimates: Pick<Estimates, "listPrinters" | "savePrinters" | "queueByPrinter">;
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
export function refuse(
  reply: FastifyReply,
  status: number,
  error: string,
  message?: string,
  /**
   * A finer code (and its values) the web app shows the refusal by in a
   * language other than English (Jon, 2026-11-19); message stays the English
   * sentence an English page and an API client read.
   */
  extra?: { code: string } & Record<string, string | number>,
) {
  return reply
    .code(status)
    .send(message === undefined ? { error, ...extra } : { error, message, ...extra });
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
    group.printers.push({ id: p.id, nozzle: p.nozzle, name: printerName(p.id, printers) });
  }
  return [...groups.values()];
}

/** The printer menu, or null when the slicer cannot be asked. */
async function menuOrNull(
  estimates: Pick<Estimates, "listPrinters">,
  log: (error: unknown) => void,
): Promise<Printer[] | null> {
  try {
    return await estimates.listPrinters();
  } catch (error) {
    if (!isSlicerProblem(error)) throw error;
    log(error);
    return null;
  }
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

const PRINTER_ID = { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" } as const;

const PRINTERS_BODY = {
  type: "object",
  properties: {
    printers: { type: "array", items: PRINTER_ID, minItems: 1, maxItems: MAX_MY_PRINTERS },
    defaultId: PRINTER_ID,
    /** The printersVersion the page last read. */
    version: { type: "integer", minimum: 1 },
  },
  required: ["printers", "defaultId", "version"],
} as const;

/** What a printer the slicer's menu lacks says (400 unknown_printer). */
export const UNKNOWN_PRINTER_MESSAGE = "That printer is not in the slicer's printer list.";

/** What a printer save says while the slicer cannot be asked (503, code slicer_unavailable). */
export const SLICER_UNAVAILABLE_MESSAGE =
  "The slicer cannot be reached, so a printer cannot be added right now.";

/**
 * The sentence for a 409 printers_changed. It says only what the server
 * knows: the page adds that the list now shows the change once its own
 * read of the list has worked.
 */
export const PRINTERS_CHANGED =
  "My printers or the default printer were changed somewhere else after this page read them, so nothing was saved.";

/** Registers the settings routes: GET /settings and PUT /settings/printers. */
export async function registerSettingsApi(
  app: FastifyInstance,
  deps: SettingsApiDeps | undefined,
): Promise<void> {
  await appApiScope(app, (scope) => {
    scope.get("/settings", async (request): Promise<SettingsView> => {
      const { settings, estimates } = need(deps);
      const [current, queue, menu] = await Promise.all([
        settings.get(),
        estimates.queueByPrinter(),
        menuOrNull(estimates, (error) =>
          request.log.warn({ err: error }, "app api: the slicer's printer list is unavailable"),
        ),
      ]);
      return {
        printerId: current.printerId,
        printersVersion: current.printersVersion,
        myPrinters: current.myPrinters.map((id) => ({
          id,
          name: printerName(id, menu ?? []),
          offered: menu === null ? null : menu.some((p) => p.id === id),
          waiting: queue.get(id)?.waiting ?? 0,
          through: queue.get(id)?.through ?? 0,
        })),
        printers: menu === null ? null : groupPrinters(menu),
        slicesPerMinute: SLICES_PER_MINUTE,
        bucketVersioning: current.bucketVersioning,
      };
    });

    scope.put<{ Body: { printers: string[]; defaultId: string; version: number } }>(
      "/settings/printers",
      { schema: { body: PRINTERS_BODY } },
      async (request, reply) => {
        const { estimates } = need(deps);
        try {
          const saved: SavedPrinters = await estimates.savePrinters(request.body);
          return saved;
        } catch (error) {
          if (error instanceof PrinterListRefused) {
            return refuse(reply, 400, "bad_request", error.message);
          }
          if (error instanceof PrintersChanged) {
            return refuse(reply, 409, "printers_changed", PRINTERS_CHANGED);
          }
          if (error instanceof UnknownPrinter) {
            return refuse(reply, 400, "unknown_printer", UNKNOWN_PRINTER_MESSAGE);
          }
          if (isSlicerProblem(error)) {
            request.log.warn({ err: error }, "app api: the slicer's printer list is unavailable");
            return refuse(reply, 503, "unavailable", SLICER_UNAVAILABLE_MESSAGE, {
              code: "slicer_unavailable",
            });
          }
          throw error;
        }
      },
    );
  });
}
