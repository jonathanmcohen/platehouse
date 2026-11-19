// releaseUnreadBody (apps/server/src/uploads/tus.ts): the gate's onSend hook
// runs it on every answer, to read off and drop a body that was answered
// before it was read. A body the route has already read to its end has
// nothing left to drain. A real Node request says so with raw.complete; an
// injected one (light-my-request, used by every integration test) has no
// complete flag, so the drain was armed anyway, and 5 s later its timer
// called destroy() on a mock socket that has none: an uncaught TypeError that
// failed PR #240's CI after every test had passed. readableEnded says the
// same thing for both.
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, test } from "vitest";
import { releaseUnreadBody } from "../../src/uploads/tus.js";

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(): Promise<FastifyInstance> {
  const built = Fastify();
  built.addHook("onRequest", async (request, reply) => {
    if (request.url === "/early") return reply.code(403).send({ error: "forbidden" });
  });
  built.addHook("onSend", async (request, reply, payload) => {
    if (reply.getHeader("connection") !== "close") releaseUnreadBody(request, reply);
    return payload;
  });
  built.put("/read", async (request) => ({ got: request.body }));
  built.put("/early", async () => ({ never: true }));
  await built.ready();
  return built;
}

describe("releaseUnreadBody", () => {
  test("a body the route read to its end is left alone: no drain, no Connection: close", async () => {
    app = await build();
    const res = await app.inject({ method: "PUT", url: "/read", payload: { a: 1 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ got: { a: 1 } });
    expect(res.headers.connection).not.toBe("close");
  });

  test("a body answered before it was read is still drained, with Connection: close", async () => {
    app = await build();
    const res = await app.inject({ method: "PUT", url: "/early", payload: { a: 1 } });
    expect(res.statusCode).toBe(403);
    expect(res.headers.connection).toBe("close");
  });
});
