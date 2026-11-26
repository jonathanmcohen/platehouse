// A signed-out page request is sent to /auth/login with next= naming the page
// asked for, when that page is a path the login keeps (returnPath); any other
// path goes to the plain login.
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import fastifyCookie from "@fastify/cookie";
import Fastify from "fastify";
import { describe, expect, test } from "vitest";
import { installGate } from "../../src/auth/gate.js";

const ORIGIN = "https://platehouse.test";
const MODEL = "/models/0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

async function signedOut(url: string, accept: string, method: "GET" | "HEAD" = "GET") {
  const app = Fastify();
  try {
    await setUp(app);
    return await app.inject({ method, url, headers: { accept } });
  } finally {
    await app.close();
  }
}

/** The Location of a real request, whose target reaches the gate as written (inject tidies dot segments). */
async function rawLocation(target: string): Promise<string | undefined> {
  const app = Fastify();
  try {
    await setUp(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    return await new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, path: target, headers: { accept: "text/html" } },
        (res) => {
          res.resume();
          resolve(res.headers.location);
        },
      );
      req.on("error", reject);
      req.end();
    });
  } finally {
    await app.close();
  }
}

async function setUp(app: ReturnType<typeof Fastify>) {
  await app.register(fastifyCookie);
  installGate(app, {
    sessions: {
      start: async () => {
        throw new Error("not used");
      },
      find: async () => undefined,
      end: async () => {},
      signOutEverywhere: async () => ({
        sessionsEnded: 0,
        tokensRevoked: 0,
        unknownTokensRevoked: 0,
      }),
    },
    publicOrigin: ORIGIN,
    absoluteUrl: (path) => `${ORIGIN}${path}`,
  });
  app.get("/*", async () => "page");
}

describe("the gate's redirect for a signed-out page request", () => {
  test("names the page asked for in next", async () => {
    const res = await signedOut(MODEL, "text/html");
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${ORIGIN}/auth/login?next=${MODEL}`);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("keeps the path only, not the query string", async () => {
    const res = await signedOut(`${MODEL}?tab=files&next=//evil`, "text/html");
    expect(res.headers.location).toBe(`${ORIGIN}/auth/login?next=${MODEL}`);
  });

  test("does the same for HEAD", async () => {
    const res = await signedOut(MODEL, "text/html", "HEAD");
    expect(res.headers.location).toBe(`${ORIGIN}/auth/login?next=${MODEL}`);
  });

  test.each([
    ["a doubled slash", "//evil"],
    ["a path over 200 characters", `/${"a".repeat(200)}`],
    ["the root", "/"],
    ["an escape", "/a%2Fb"],
  ])("sends %s to the plain login", async (_name, url) => {
    const res = await signedOut(url, "text/html");
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${ORIGIN}/auth/login`);
  });

  test("sends a dot segment, as the browser wrote it, to the plain login", async () => {
    expect(await rawLocation("/a/../b")).toBe(`${ORIGIN}/auth/login`);
  });

  test("keeps a path of exactly 200 characters", async () => {
    const path = `/${"a".repeat(199)}`;
    const res = await signedOut(path, "text/html");
    expect(res.headers.location).toBe(`${ORIGIN}/auth/login?next=${path}`);
  });

  test("a request that does not accept HTML still gets 401", async () => {
    const res = await signedOut(MODEL, "application/json");
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
    expect(res.headers.location).toBeUndefined();
  });
});
