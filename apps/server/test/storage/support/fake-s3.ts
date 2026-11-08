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
  body?: string;
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
