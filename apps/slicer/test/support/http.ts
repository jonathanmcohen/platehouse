// HTTP helpers shared by the slicer's unit and container tests.
import { request } from "node:http";

export type Sent = { status: number; body: string } | { error: string };

/**
 * Sends a body with no Content-Length (Node then uses chunked transfer
 * encoding), a chunk at a time, until the server answers or drops the
 * connection. With `abortAfter`, the client gives up once it has sent that
 * many bytes, as a client that dies mid-upload would.
 */
export function streamChunked(
  url: string,
  total: number,
  opts: { chunk?: number; abortAfter?: number } = {},
): Promise<Sent> {
  const chunk = opts.chunk ?? 16 * 1024;
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: Sent) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    const req = request(
      url,
      { method: "POST", headers: { "content-type": "application/octet-stream" } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => finish({ status: res.statusCode ?? 0, body }));
        res.on("error", (e) => finish({ error: e.message }));
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) => finish({ error: e.code ?? e.message }));
    let sent = 0;
    const pump = () => {
      if (done || req.destroyed) return;
      if (opts.abortAfter !== undefined && sent >= opts.abortAfter) {
        req.destroy();
        finish({ error: "aborted by the client" });
        return;
      }
      if (sent >= total) {
        req.end();
        return;
      }
      const n = Math.min(chunk, total - sent);
      sent += n;
      if (req.write(Buffer.alloc(n, 1))) setTimeout(pump, 1);
      else req.once("drain", pump);
    };
    pump();
  });
}
