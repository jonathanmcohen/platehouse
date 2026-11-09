// Helpers for the upload tests (build plan Task 9), shared by the unit tests
// (a fake queue) and the integration tests (pg-boss, ingest and the S3 test
// server): a Fastify app on a loopback port, raw HTTP requests through
// node:http (fetch cannot set a Host header), tus metadata, and generated
// files. Every byte is synthetic; no designer file is read.
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import Fastify, { type FastifyInstance } from "fastify";

/** The tus version header every tus request but OPTIONS carries. */
export const TUS = { "tus-resumable": "1.0.0" } as const;

/** The content type of a tus PATCH body. */
export const OCTET = "application/offset+octet-stream";

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** One request, answered in full. */
export function send(
  base: string,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: Buffer | string } = {},
): Promise<HttpResult> {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          ...(opts.body === undefined ? {} : { "content-length": Buffer.byteLength(opts.body) }),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(opts.body);
  });
}

/**
 * A PATCH that sends only the first `sendBytes` of `body` while declaring the
 * whole length, then drops the connection, as a phone does when it switches
 * network or a tab is backgrounded. Resolves once the socket is closed.
 */
export function interruptedPatch(
  base: string,
  path: string,
  opts: { headers: Record<string, string>; body: Buffer; sendBytes: number },
): Promise<void> {
  const url = new URL(path, base);
  return new Promise((resolve) => {
    const req = http.request({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "PATCH",
      headers: { ...opts.headers, "content-length": opts.body.length },
    });
    req.on("error", () => resolve());
    req.on("close", () => resolve());
    req.write(opts.body.subarray(0, opts.sendBytes), () => {
      // Give the server a moment to take the bytes, then cut the line.
      setTimeout(() => req.destroy(), 200);
    });
  });
}

export interface LateBodyResult {
  /** The status line and headers of the answer, as received. */
  head: string;
  /** How many body bytes were written before the socket closed or failed. */
  written: number;
  /** The socket's error, if it had one (EPIPE or ECONNRESET for a reset). */
  error: NodeJS.ErrnoException | null;
  /** Whether the server closed the connection within closeWithinMs. */
  closed: boolean;
}

/**
 * A PATCH over a raw socket that sends only the first `firstBytes` of
 * `body`, waits for the server's answer, and only then sends the rest, 64 KiB
 * at a time, as a client on a slow link is still sending when an early
 * answer (409, 413) arrives. The socket stays open for writing after the
 * server's FIN (allowHalfOpen), so every byte the server lets it send is
 * sent. Resolves once the server has closed the connection, or after
 * closeWithinMs.
 */
export async function patchStillSendingAfterAnswer(
  base: string,
  path: string,
  opts: {
    headers: Record<string, string>;
    body: Buffer;
    firstBytes: number;
    closeWithinMs: number;
  },
): Promise<LateBodyResult> {
  const url = new URL(path, base);
  const socket = net.connect({ host: url.hostname, port: Number(url.port), allowHalfOpen: true });
  let received = "";
  let error: NodeJS.ErrnoException | null = null;
  let closed = false;
  const answered = Promise.withResolvers<void>();
  socket.on("data", (chunk: Buffer) => {
    received += chunk.toString("latin1");
    if (received.includes("\r\n\r\n")) answered.resolve();
  });
  socket.on("error", (e: NodeJS.ErrnoException) => {
    error ??= e;
  });
  // Not events.once: it rejects on the socket's error, which is recorded instead.
  const closing = new Promise<void>((resolve) =>
    socket.once("close", () => {
      closed = true;
      answered.resolve();
      resolve();
    }),
  );
  await once(socket, "connect");

  const head = [
    `PATCH ${url.pathname} HTTP/1.1`,
    `Host: ${url.host}`,
    ...Object.entries(opts.headers).map(([name, value]) => `${name}: ${value}`),
    `Content-Length: ${opts.body.length}`,
    "",
    "",
  ].join("\r\n");
  socket.write(head);
  socket.write(opts.body.subarray(0, opts.firstBytes));
  let written = opts.firstBytes;
  await answered.promise;
  // Let the server finish answering (its response's finish handlers run)
  // before the rest of the body is sent.
  await sleep(50);

  const CHUNK_BYTES = 64 * 1024;
  while (written < opts.body.length && error === null && !closed && !socket.destroyed) {
    const chunk = opts.body.subarray(written, written + CHUNK_BYTES);
    const failed = await new Promise<Error | null | undefined>((resolve) =>
      socket.write(chunk, resolve),
    );
    if (failed) break;
    written += chunk.length;
  }
  if (!socket.destroyed) socket.end();
  await Promise.race([closing, sleep(opts.closeWithinMs)]);
  socket.destroy();
  return { head: received.slice(0, received.indexOf("\r\n\r\n")), written, error, closed };
}

/** The Upload-Metadata header for these fields (tus 1.0.0: key, space, base64 value). */
export function meta(fields: Record<string, string | null>): string {
  return Object.entries(fields)
    .map(([k, v]) => (v === null ? k : `${k} ${Buffer.from(v, "utf8").toString("base64")}`))
    .join(",");
}

/** The upload id at the end of a Location header. */
export function idOf(location: string | string[] | undefined): string {
  if (typeof location !== "string") throw new Error("no Location header");
  const id = location.slice(location.lastIndexOf("/") + 1);
  if (id === "") throw new Error(`no id in Location ${location}`);
  return id;
}

export interface LoggedRequest {
  method: string;
  url: string;
  uploadOffset: string | undefined;
  contentLength: string | undefined;
}

export interface TestApp {
  app: FastifyInstance;
  /** http://127.0.0.1:<port> */
  base: string;
  /** Every request the app received, in order. */
  requests: LoggedRequest[];
  close(): Promise<void>;
}

/** A Fastify app on a loopback port with the given plugins registered. */
export async function startApp(setup: (app: FastifyInstance) => Promise<void>): Promise<TestApp> {
  const app = Fastify({ logger: false });
  const requests: LoggedRequest[] = [];
  app.addHook("onRequest", async (request) => {
    const offset = request.headers["upload-offset"];
    const length = request.headers["content-length"];
    requests.push({
      method: request.method,
      url: request.url,
      uploadOffset: typeof offset === "string" ? offset : undefined,
      contentLength: typeof length === "string" ? length : undefined,
    });
  });
  await setup(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = app.server.address() as AddressInfo;
  return { app, base: `http://127.0.0.1:${port}`, requests, close: () => app.close() };
}

/**
 * A binary STL of `triangles` facets with random facet bytes, so a byte
 * written at the wrong offset changes the hash. Its size is 84 + 50 * n,
 * which is what ingest's binary STL check wants.
 */
export function randomBinaryStl(triangles: number): Buffer {
  const out = randomBytes(84 + 50 * triangles);
  out.fill(0, 0, 80);
  out.write("synthetic binary stl from the platehouse upload tests", 0, "ascii");
  out.writeUInt32LE(triangles, 80);
  return out;
}

/** About 90 MiB, the size of Jon's largest file (AC-020): 94,371,834 bytes. */
export const NINETY_MB_TRIANGLES = 1_887_435;

/** 5 MiB, the chunk size of the resumable upload test. */
export const CHUNK = 5 * 1024 * 1024;
