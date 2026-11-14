// The library the end-to-end specs run against (build plan Task 22), made
// by the global setup through the real app: an API token minted on the
// settings route, three generated .3mf files uploaded through the public API
// over Traefik, one model tagged and put in a collection, one moved to the
// trash. Every file comes from the repo's fixture builder (buildSliceable),
// never a designer file.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { APIRequestContext } from "@playwright/test";
import { ORIGIN, SEED_PATH } from "./env.js";

/** A name with a space, an accent, %, #, ; and ?: everything a link must make safe. */
export const HOSTILE_NAME = "Caf\u00e9 50% off #1; a?b.3mf";

export interface SeededFile {
  modelId: string;
  fileId: string;
  /** The name the file was uploaded under. */
  name: string;
  /** The uploaded bytes' SHA-256, hex. */
  sha256: string;
}

export interface Seed {
  /** A Public API v1 token, made for this run only. Never printed. */
  token: string;
  /** Three plates, two filaments, tagged and in a collection. */
  calibration: SeededFile;
  /** A file whose name holds characters a link must encode. */
  hostile: SeededFile;
  /** A model in the trash. */
  trashed: SeededFile;
}

export function readSeed(): Seed {
  return JSON.parse(readFileSync(SEED_PATH, "utf8")) as Seed;
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A Public API v1 upload result (GET /api/v1/uploads/:id/result). */
interface UploadResult {
  status: "pending" | "done" | "failed";
  modelId?: string;
  fileId?: string;
  error?: string;
}

/**
 * Uploads one file through the public API's tus endpoint in a single PATCH,
 * as curl would, then waits for ingest to finish. api must carry the bearer
 * token and no cookie.
 */
export async function uploadFile(
  api: APIRequestContext,
  name: string,
  bytes: Buffer,
): Promise<SeededFile> {
  const created = await api.post("/api/v1/uploads", {
    headers: {
      "tus-resumable": "1.0.0",
      "upload-length": String(bytes.length),
      "upload-metadata": `filename ${Buffer.from(name, "utf8").toString("base64")}`,
    },
    maxRedirects: 0,
  });
  if (created.status() !== 201) {
    throw new Error(`creating the upload of ${name} answered ${created.status()}`);
  }
  const location = created.headers().location;
  if (location === undefined) throw new Error(`the upload of ${name} has no Location`);
  const uploadUrl = new URL(location, ORIGIN);
  const patched = await api.patch(uploadUrl.pathname, {
    headers: {
      "tus-resumable": "1.0.0",
      "upload-offset": "0",
      "content-type": "application/offset+octet-stream",
    },
    data: bytes,
  });
  if (patched.status() !== 204) {
    throw new Error(`sending ${name} answered ${patched.status()}`);
  }
  const deadline = Date.now() + 60_000;
  for (;;) {
    const res = await api.get(`${uploadUrl.pathname}/result`);
    const result = (await res.json()) as UploadResult;
    if (result.status === "done" && result.modelId && result.fileId) {
      return { modelId: result.modelId, fileId: result.fileId, name, sha256: sha256(bytes) };
    }
    if (result.status === "failed") {
      throw new Error(`ingest of ${name} failed: ${result.error ?? "no reason"}`);
    }
    if (Date.now() > deadline) throw new Error(`ingest of ${name} did not finish in 60 s`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

interface ApiPlate {
  numbers: {
    file?: unknown;
    platehouse?: { state: string };
    failure?: unknown;
  };
}

interface ApiModelDetail {
  files: { plates: ApiPlate[] }[];
}

/**
 * Waits until every plate of the model has numbers, current Platehouse
 * numbers or a recorded failure, so the model page shows a settled state
 * rather than "estimating" when the specs look at it.
 */
export async function waitForNumbers(api: APIRequestContext, modelId: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const res = await api.get(`/api/v1/models/${modelId}`);
    if (res.ok()) {
      const model = (await res.json()) as ApiModelDetail;
      const plates = model.files.flatMap((f) => f.plates);
      const settled = (p: ApiPlate) =>
        p.numbers.file !== undefined ||
        p.numbers.failure !== undefined ||
        p.numbers.platehouse?.state === "current";
      if (plates.length > 0 && plates.every(settled)) return;
    }
    if (Date.now() > deadline) throw new Error(`model ${modelId} has no numbers after 90 s`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}
