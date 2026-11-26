// A scripted stand-in for an S3 endpoint, for the storage layer's error paths
// that need no real store: refused connections, a server that never answers,
// and the error and status responses a real provider can send. Each test
// gives the reply for every request; nothing here is an S3 implementation.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { type AddressInfo, createServer as createTcpServer, type Socket } from "node:net";

export interface SeenRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

export interface Reply {
  status: number;
  headers?: Record<string, string>;
  /** Text is sent as UTF-8; a Buffer is sent as it is, for an object's bytes. */
  body?: string | Buffer;
}

export type Handler = (req: SeenRequest) => Reply;

export interface FakeS3 {
  endpoint: string;
  requests: SeenRequest[];
  close(): Promise<void>;
}

function listen(server: Server | ReturnType<typeof createTcpServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

export async function startFakeS3(handler: Handler): Promise<FakeS3> {
  const requests: SeenRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const seen: SeenRequest = {
        method: req.method ?? "GET",
        path: decodeURIComponent(url.pathname),
        query: url.searchParams,
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(seen);
      const reply = handler(seen);
      const body = req.method === "HEAD" ? "" : (reply.body ?? "");
      res.writeHead(reply.status, {
        "content-type": "application/xml",
        "content-length": String(Buffer.byteLength(reply.body ?? "")),
        ...reply.headers,
      });
      res.end(body);
    });
  });
  const port = await listen(server);
  return {
    endpoint: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// Accepts TCP connections and never sends a byte: a store that hangs.
export async function startBlackHole(): Promise<{ endpoint: string; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  const port = await listen(server);
  return {
    endpoint: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

// Answers every GET with a 200 for an object of `total` bytes, sends the first
// `sent` of them, and then either drops the connection ("reset") or sends
// nothing more ("stall"): a store that goes away while a body is being read.
export async function startCutOffS3(opts: {
  total: number;
  sent: number;
  after: "reset" | "stall";
}): Promise<{ endpoint: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(opts.total),
      });
      res.write(Buffer.alloc(opts.sent, 0x61), () => {
        if (opts.after === "reset") res.socket?.destroy();
      });
    });
  });
  const port = await listen(server);
  return {
    endpoint: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// A port with nothing listening on it: bound once to learn a free port, then
// released.
export async function closedPortEndpoint(): Promise<string> {
  const server = createTcpServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

export function s3Error(status: number, code: string, message = "synthetic error"): Reply {
  return {
    status,
    body: `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message><RequestId>fake</RequestId></Error>`,
  };
}

export function xml(body: string): Reply {
  return { status: 200, body: `<?xml version="1.0" encoding="UTF-8"?>${body}` };
}

// Answers ranged GETs as S3 does for an object holding exactly these bytes: a
// range that runs past the last byte is cut short at it (so the Content-Range
// names a shorter range and the object's real length), and a range that starts
// past it is a 416 InvalidRange. An object stored shorter than its record
// looks like this to a reader that asks for the recorded size.
export function storedObject(bytes: Buffer): Handler {
  return (req) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range ?? ""));
    if (!match)
      return { status: 200, headers: { "content-type": "application/octet-stream" }, body: bytes };
    const start = Number(match[1]);
    if (start >= bytes.length) return s3Error(416, "InvalidRange");
    const last = Math.min(Number(match[2]), bytes.length - 1);
    return {
      status: 206,
      headers: {
        "content-type": "application/octet-stream",
        "content-range": `bytes ${start}-${last}/${bytes.length}`,
      },
      body: bytes.subarray(start, last + 1),
    };
  };
}

// Answers every request with this status and these headers, declares a body
// of `total` bytes, sends the first `sent` of them and holds the rest back, so
// the connection stays open until the client gives the body up. closed
// resolves when it does: a reader that refuses an answer must destroy its
// body, or the connection would be held until the socket timed out.
export async function startHeldBodyS3(reply: {
  status: number;
  headers: Record<string, string>;
  total: number;
  sent: number;
}): Promise<{ endpoint: string; closed: Promise<void>; close(): Promise<void> }> {
  let onClosed = () => {};
  const closed = new Promise<void>((resolve) => {
    onClosed = resolve;
  });
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.socket?.once("close", () => onClosed());
      res.writeHead(reply.status, {
        "content-type": "application/octet-stream",
        "content-length": String(reply.total),
        ...reply.headers,
      });
      res.write(Buffer.alloc(reply.sent, 0x61));
    });
  });
  const port = await listen(server);
  return {
    endpoint: `http://127.0.0.1:${port}`,
    closed,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
