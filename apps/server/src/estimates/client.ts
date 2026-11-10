// The app's client for slicer contract v1 (build plan Task 12). The slicer is
// on the internal network only, has no auth and holds no secrets; nothing the
// app sends it is secret either (a printer name, a plate number, the .3mf).
//
// Every answer is read with the contract's own zod schemas
// (packages/slicer-contract), so an answer outside contract v1 is a refusal,
// never a result. Errors come in four kinds, because the slice job treats
// them differently:
// - SlicerBusy: 409 busy, the slicer is running another heavy job;
// - SlicerUnreachable: no connection, a connection lost before the answer
//   (the slicer restarted mid-slice), or no answer in time; neverConnected
//   tells the first, where the slicer never saw the request, from the rest;
// - SlicerRefused: any other answer that is not a result (400, 404, 413, 422,
//   a 500 from the slicer, or a body the contract does not allow);
// - SliceBodyUnreadable: the .3mf stream failed while it was being sent (the
//   store dropped the read), which is not the slicer's doing.
// The job retries the first two with the slicer queue's retry settings (and
// waits for a slicer that took no connection without using a retry), records
// the third as a failed estimate, and waits out the fourth as a store outage,
// using no retry (service.ts).
//
// The slicer kills a plate itself at SLICE_TIMEOUT_SECONDS, --mstpp + 60 by
// default, and the app's HTTP timeout is that plus 30 s (Slicer HTTP contract
// v1). The request is plain node:http, as the slicer's own server is, so a
// 409 sent before the body is read is answered even while the body is still
// going out.
import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Readable } from "node:stream";
import {
  type Health,
  type Profiles,
  type SliceResult,
  slicerContract,
} from "@platehouse/slicer-contract";
import type { z } from "zod";

export interface SliceRequest {
  printerId: string;
  plate: number;
  /** The .3mf's bytes, streamed from the bucket. */
  body: Readable;
  /** Its exact size, sent as Content-Length. */
  size: number;
}

export interface SlicerClient {
  health(): Promise<Health>;
  profiles(): Promise<Profiles>;
  slice(request: SliceRequest): Promise<SliceResult>;
}

/** 409 busy: the slicer is running another slice, render or conversion. */
export class SlicerBusy extends Error {
  constructor() {
    super("The slicer is busy with another job");
    this.name = "SlicerBusy";
  }
}

/**
 * The network codes that mean no connection was made at all: the slicer is
 * down, restarting or not on the network, and never saw the request.
 */
const NO_CONNECTION_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
]);

/** No connection, a connection lost before the answer, or no answer in time. */
export class SlicerUnreachable extends Error {
  readonly reason: string;
  /**
   * True when no connection was made, so the slicer never saw the request:
   * the slicer is down, and the request is not what brought it down. False
   * when a connection was lost or timed out, which a plate that crashes the
   * slicer also causes.
   */
  readonly neverConnected: boolean;

  constructor(reason: string) {
    super(`The slicer could not be reached (${reason})`);
    this.name = "SlicerUnreachable";
    this.reason = reason;
    this.neverConnected = NO_CONNECTION_CODES.has(reason);
  }
}

/**
 * The .3mf stream failed partway through being sent: the store restarted or
 * timed out mid-read. Not a slicer fault and not a lost slicer connection.
 */
export class SliceBodyUnreadable extends Error {
  constructor() {
    super("The file could not be read while it was sent to the slicer");
    this.name = "SliceBodyUnreadable";
  }
}

/** The slicer answered, and the answer is not a result. */
export class SlicerRefused extends Error {
  /** The HTTP status, or 200 for a 200 whose body the contract does not allow. */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "SlicerRefused";
    this.status = status;
  }
}

/** The slicer's own kill time (--mstpp + 60) plus 30 s, in milliseconds. */
export function sliceTimeoutMs(plateSeconds: number): number {
  return (plateSeconds + 60 + 30) * 1000;
}

export interface SlicerClientOptions {
  /** SLICER_URL, e.g. http://slicer:8080. */
  url: string;
  /** SLICE_PLATE_SECONDS, the --mstpp the slicer runs with. */
  plateSeconds: number;
  /** For health and profiles; 10 s when left out. */
  requestTimeoutMs?: number;
  /** For a slice; sliceTimeoutMs(plateSeconds) when left out. */
  sliceTimeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** The largest answer read: contract answers are small JSON. */
const MAX_ANSWER_BYTES = 1024 * 1024;

/** A slicer message quoted into an error is cut to this. */
const MESSAGE_CHARS = 300;

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
]);

function networkReason(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && NETWORK_CODES.has(code)) return code;
  return "the connection was lost";
}

interface Answer {
  status: number;
  body: Buffer;
}

function send(
  base: URL,
  method: "GET" | "POST",
  path: string,
  timeoutMs: number,
  upload?: { body: Readable; size: number },
): Promise<Answer> {
  return new Promise<Answer>((resolve, reject) => {
    const url = new URL(path, base);
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    let settled = false;
    let req: ClientRequest | undefined;
    const finish = (outcome: { answer: Answer } | { error: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Whatever is still going out is no longer wanted.
      upload?.body.unpipe();
      upload?.body.destroy();
      if ("answer" in outcome) {
        req?.destroy();
        resolve(outcome.answer);
      } else {
        req?.destroy();
        reject(outcome.error);
      }
    };
    const timer = setTimeout(
      () => finish({ error: new SlicerUnreachable(`no answer within ${timeoutMs} ms`) }),
      timeoutMs,
    );
    req = request(
      url,
      {
        method,
        headers: upload
          ? { "content-type": "application/octet-stream", "content-length": String(upload.size) }
          : {},
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_ANSWER_BYTES) {
            finish({
              error: new SlicerRefused(res.statusCode ?? 0, "The slicer's answer is too large"),
            });
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          finish({ answer: { status: res.statusCode ?? 0, body: Buffer.concat(chunks) } }),
        );
        res.on("aborted", () =>
          finish({ error: new SlicerUnreachable("the connection was lost") }),
        );
        res.on("error", (error) => finish({ error: new SlicerUnreachable(networkReason(error)) }));
      },
    );
    let answered = false;
    req.on("response", () => {
      answered = true;
    });
    req.on("error", (error) => {
      // A write error after the answer has started (a 409 sent before the
      // body was read, then the connection closed) is not the outcome: the
      // answer is.
      if (answered) return;
      finish({ error: new SlicerUnreachable(networkReason(error)) });
    });
    if (upload) {
      upload.body.on("error", () => finish({ error: new SliceBodyUnreadable() }));
      upload.body.pipe(req);
    } else {
      req.end();
    }
  });
}

function cut(text: string): string {
  const clean = text.replace(/[^\x20-\x7e]+/g, " ").trim();
  return clean.length > MESSAGE_CHARS ? `${clean.slice(0, MESSAGE_CHARS)}...` : clean;
}

function readJson(answer: Answer): unknown {
  try {
    return JSON.parse(answer.body.toString("utf8"));
  } catch {
    return undefined;
  }
}

/** The answer's body read with a contract schema, or SlicerRefused. */
function parsed<T extends z.ZodType>(answer: Answer, schema: T): z.infer<T> {
  const result = schema.safeParse(readJson(answer));
  if (!result.success) {
    throw new SlicerRefused(
      answer.status,
      "The slicer's answer is not one slicer contract v1 allows",
    );
  }
  return result.data;
}

/** Any answer that is not a 200 result, as an error. */
function refusal(answer: Answer): Error {
  if (answer.status === 409) return new SlicerBusy();
  const body = slicerContract.error.safeParse(readJson(answer));
  if (body.success) {
    const detail = "message" in body.data ? `: ${cut(body.data.message)}` : "";
    return new SlicerRefused(
      answer.status,
      `The slicer refused the request (${body.data.error}${detail})`,
    );
  }
  return new SlicerRefused(
    answer.status,
    `The slicer answered ${answer.status}: ${cut(answer.body.toString("utf8")) || "no message"}`,
  );
}

export function createSlicerClient(opts: SlicerClientOptions): SlicerClient {
  const base = new URL(opts.url);
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const sliceMs = opts.sliceTimeoutMs ?? sliceTimeoutMs(opts.plateSeconds);

  async function get<T extends z.ZodType>(path: string, schema: T): Promise<z.infer<T>> {
    const answer = await send(base, "GET", path, requestTimeoutMs);
    if (answer.status !== 200) throw refusal(answer);
    return parsed(answer, schema);
  }

  return {
    health: () => get("/v1/health", slicerContract.health),
    profiles: () => get("/v1/profiles", slicerContract.profiles),
    async slice({ printerId, plate, body, size }) {
      const query = new URLSearchParams({ printer: printerId, plate: String(plate) });
      const answer = await send(base, "POST", `/v1/slice?${query.toString()}`, sliceMs, {
        body,
        size,
      });
      if (answer.status !== 200) throw refusal(answer);
      return parsed(answer, slicerContract.sliceResult);
    },
  };
}
