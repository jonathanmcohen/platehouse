// The Manyfold side of an import (build plan Task 23; AC-001, AC-003): one
// read-scoped token per run, redirects, origin rules, retries and paging,
// all against the stub built from Manyfold 0.154.1's recorded OpenAPI.
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
  MANYFOLD,
  manyfoldCalls,
  OBJECTS,
  seen,
  server,
  setup,
  useServer,
} from "./support/harness.js";
import { library } from "./support/library.js";

useServer();

describe("the Manyfold token", () => {
  it("is asked for exactly once per run", async () => {
    const s = setup(library());
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(0);
    expect(s.manyfold.tokenRequests).toHaveLength(1);
    expect(manyfoldCalls().filter((c) => c === "POST /oauth/token")).toHaveLength(1);
  });

  it("is asked for once per run even when a dry run reads everything", async () => {
    const s = setup(library());
    const r = await s.run([]);
    expect(r.code).toBe(0);
    expect(s.manyfold.tokenRequests).toHaveLength(1);
  });

  it("asks for the read scope only, with the client credentials grant, in a dry run", async () => {
    const s = setup(library());
    await s.run([]);
    expect(s.manyfold.tokenRequests).toEqual([
      { grantType: "client_credentials", scope: "read", basicOk: true },
    ]);
  });

  it("asks for the read scope only under --apply too", async () => {
    const s = setup(library());
    await s.run(["--apply"]);
    expect(s.manyfold.tokenRequests).toEqual([
      { grantType: "client_credentials", scope: "read", basicOk: true },
    ]);
  });

  it.each([
    ["read write", '"read write"'],
    ["write", '"write"'],
    ["public", '"public"'],
    ["", '""'],
  ])(
    "stops the run with exit 2 when Manyfold grants scope %j, not read only",
    async (scope, shown) => {
      const s = setup(library());
      server.use(
        http.post(`${MANYFOLD}/oauth/token`, () =>
          HttpResponse.json({
            access_token: s.manyfold.accessToken,
            token_type: "Bearer",
            expires_in: 7200,
            scope,
            created_at: 1_794_000_000,
          }),
        ),
      );
      const r = await s.run(["--apply"]);
      expect(r.code).toBe(2);
      expect(r.stderr.join("\n")).toContain(
        `could not start: Manyfold granted scope ${shown}, not read only; nothing was read`,
      );
      expect(manyfoldCalls()).toEqual(["POST /oauth/token"]);
      expect(s.platehouse.models.size).toBe(0);
      expect(r.output).not.toContain(s.manyfold.accessToken);
    },
  );

  it("stops the run with exit 2 when the token answer names no scope", async () => {
    const s = setup(library());
    server.use(
      http.post(`${MANYFOLD}/oauth/token`, () =>
        HttpResponse.json({ access_token: s.manyfold.accessToken, token_type: "Bearer" }),
      ),
    );
    const r = await s.run([]);
    expect(r.code).toBe(2);
    expect(r.stderr.join("\n")).toContain(
      "could not start: the token answer names no scope, so it cannot be shown to be read only",
    );
    expect(manyfoldCalls()).toEqual(["POST /oauth/token"]);
    expect(r.output).not.toContain(s.manyfold.accessToken);
  });

  it("does not quote a granted scope that is not plain words", async () => {
    const s = setup(library());
    server.use(
      http.post(`${MANYFOLD}/oauth/token`, () =>
        HttpResponse.json({
          access_token: s.manyfold.accessToken,
          scope: `read ${s.manyfold.accessToken}`,
        }),
      ),
    );
    const r = await s.run([]);
    expect(r.code).toBe(2);
    expect(r.stderr.join("\n")).toContain(
      "could not start: Manyfold granted a scope that is not read only; nothing was read",
    );
    expect(r.output).not.toContain(s.manyfold.accessToken);
  });

  it("accepts the read scope however it is spaced or repeated", async () => {
    const s = setup(library());
    server.use(
      http.post(`${MANYFOLD}/oauth/token`, () =>
        HttpResponse.json({ access_token: s.manyfold.accessToken, scope: " read  read " }),
      ),
    );
    const r = await s.run([]);
    expect(r.code).toBe(0);
  });

  it("is not asked for again when a later request is refused", async () => {
    const s = setup(library());
    server.use(http.get(`${MANYFOLD}/models/m2`, () => new HttpResponse(null, { status: 401 })));
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    expect(s.manyfold.tokenRequests).toHaveLength(1);
  });
});

describe("file downloads", () => {
  it("fetch the object-store redirect without an Authorization header", async () => {
    const s = setup(library());
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(0);
    // benchy.3mf, stand.stl, clip.3mf and air-dry.3mf; photo.png is never fetched.
    expect(s.manyfold.objectRequests).toHaveLength(4);
    for (const req of s.manyfold.objectRequests) expect(req.authorization).toBeNull();
    for (const req of seen.filter((x) => x.url.startsWith(OBJECTS))) {
      expect(req.authorization).toBeNull();
    }
  });

  it("send the token on every Manyfold request", async () => {
    const s = setup(library());
    await s.run(["--apply"]);
    const reads = seen.filter((x) => x.url.startsWith(MANYFOLD) && x.method === "GET");
    expect(reads.length).toBeGreaterThan(0);
    for (const req of reads) expect(req.authorization).toBe(`Bearer ${s.manyfold.accessToken}`);
  });

  it("never log the signed query of the redirect, even when the object store fails once", async () => {
    const s = setup(library());
    server.use(
      http.get(`${OBJECTS}/manyfold/m1/f1`, () => new HttpResponse(null, { status: 503 }), {
        once: true,
      }),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(0);
    expect(s.manyfold.signedQueries.length).toBeGreaterThanOrEqual(4);
    // The retry was logged, by host and path only.
    expect(r.output).toContain("objects.example.test/manyfold/m1/f1");
    for (const q of s.manyfold.signedQueries) expect(r.output).not.toContain(q);
    expect(r.output).not.toContain("X-Amz-Signature");
    expect(r.output).not.toContain("X-Amz-Credential");
  });

  it("keep the token on an https redirect to Manyfold's own host", async () => {
    const s = setup(library());
    const rawAuth: Array<string | null> = [];
    server.use(
      http.get(
        `${MANYFOLD}/models/m3/model_files/f5.3mf`,
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { location: "https://manyfold.example.test/models/m3/raw/air-dry.3mf" },
          }),
        { once: true },
      ),
      http.get(`${MANYFOLD}/models/m3/raw/air-dry.3mf`, ({ request }) => {
        rawAuth.push(request.headers.get("authorization"));
        const f = library().models[2]?.files[0];
        return new HttpResponse(new Uint8Array(f?.bytes ?? Buffer.alloc(0)));
      }),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(0);
    expect(rawAuth).toEqual([`Bearer ${s.manyfold.accessToken}`]);
  });

  // The plan: a non-https redirect is refused. That holds on Manyfold's own
  // host too: the redirect is not upgraded to https and followed.
  it("refuse an http:// redirect to Manyfold's own host and import nothing for that file", async () => {
    const s = setup(library());
    const rawAuth: Array<string | null> = [];
    server.use(
      http.get(
        `${MANYFOLD}/models/m3/model_files/f5.3mf`,
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { location: "http://manyfold.example.test/models/m3/raw/air-dry.3mf" },
          }),
      ),
      http.get(`${MANYFOLD}/models/m3/raw/air-dry.3mf`, ({ request }) => {
        rawAuth.push(request.headers.get("authorization"));
        return new HttpResponse(null, { status: 500 });
      }),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    expect(rawAuth).toEqual([]);
    expect(seen.some((x) => x.url.startsWith("http://"))).toBe(false);
    const m3 = r.report?.models.find((m) => m.manyfoldId === "m3");
    expect(m3?.files[0]?.status).toBe("failed");
    expect(m3?.files[0]?.reason).toBe(
      "GET /models/m3/model_files/f5.3mf: refusing a redirect that is not https, to manyfold.example.test",
    );
  });

  it("refuse a redirect that is not https and import nothing for that file", async () => {
    const s = setup(library());
    server.use(
      http.get(
        `${MANYFOLD}/models/m3/model_files/f5.3mf`,
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { location: "http://objects.example.test/manyfold/m3/f5?sig=abc" },
          }),
      ),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    const m3 = r.report?.models.find((m) => m.manyfoldId === "m3");
    expect(m3?.outcome).toBe("failed");
    expect(m3?.files[0]?.status).toBe("failed");
    expect(m3?.files[0]?.reason).toMatch(/https/);
    expect(seen.some((x) => x.url.startsWith("http://objects.example.test"))).toBe(false);
    const ref = [...s.platehouse.models.values()].find((m) => m.externalRef === "manyfold:m3");
    expect(ref === undefined ? [] : s.platehouse.filesOf(ref.id)).toHaveLength(0);
  });

  it("follow at most a few redirects", async () => {
    const s = setup(library());
    server.use(
      http.get(
        `${MANYFOLD}/models/m3/model_files/f5.3mf`,
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { location: "https://manyfold.example.test/models/m3/model_files/f5.3mf" },
          }),
      ),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    const hops = seen.filter((x) => x.url === `${MANYFOLD}/models/m3/model_files/f5.3mf`);
    expect(hops.length).toBeGreaterThan(1);
    expect(hops.length).toBeLessThanOrEqual(5);
  });
});

describe("requests stay on Manyfold's origin", () => {
  it("rewriting the http:// links Manyfold sends to https", async () => {
    const s = setup(library());
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((x) => x.url.startsWith("http://"))).toBe(false);
  });

  it("refusing a link to another host and sending nothing there", async () => {
    const s = setup(library());
    server.use(
      http.get(`${MANYFOLD}/models/m2`, () =>
        HttpResponse.json(
          {
            "@context": ["https://schema.org/"],
            "@id": "http://manyfold.example.test/models/m2",
            "@type": "3DModel",
            name: "Cable Clip",
            hasPart: [
              {
                "@id": "https://elsewhere.example.test/models/m2/model_files/f3",
                "@type": "3DModel",
                name: "clip",
                encodingFormat: "model/3mf",
              },
            ],
          },
          { headers: { "content-type": "application/vnd.manyfold.v0+json" } },
        ),
      ),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    expect(seen.some((x) => x.url.includes("elsewhere.example.test"))).toBe(false);
    const m2 = r.report?.models.find((m) => m.manyfoldId === "m2");
    expect(m2?.outcome).toBe("failed");
    expect(m2?.reason).toMatch(/elsewhere\.example\.test/);
  });
});

describe("retries", () => {
  it("wait out a 429 for its Retry-After and go on", async () => {
    const s = setup(library());
    server.use(
      http.get(
        `${MANYFOLD}/models/m1`,
        () => new HttpResponse(null, { status: 429, headers: { "retry-after": "7" } }),
        { once: true },
      ),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(0);
    expect(s.waits).toContain(7000);
    expect(seen.filter((x) => x.url === `${MANYFOLD}/models/m1`)).toHaveLength(2);
  });

  it.each(["-5", "0", "soon", "Wed, 21 Oct 2026 07:28:00 GMT", "1e999x"])(
    "back off as normal on a 429 whose Retry-After is %j, never waiting zero",
    async (after) => {
      const s = setup(library());
      server.use(
        http.get(
          `${MANYFOLD}/models/m1`,
          () => new HttpResponse(null, { status: 429, headers: { "retry-after": after } }),
          { once: true },
        ),
      );
      const r = await s.run(["--apply"]);
      expect(r.code).toBe(0);
      expect(s.waits[0]).toBe(2000);
      expect(s.waits.every((ms) => ms > 0)).toBe(true);
      expect(seen.filter((x) => x.url === `${MANYFOLD}/models/m1`)).toHaveLength(2);
    },
  );

  it("wait 60 s on a 429 with no Retry-After at all", async () => {
    const s = setup(library());
    server.use(
      http.get(`${MANYFOLD}/models/m1`, () => new HttpResponse(null, { status: 429 }), {
        once: true,
      }),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(0);
    expect(s.waits[0]).toBe(60_000);
  });

  it("back off after a 5xx and go on", async () => {
    const s = setup(library());
    server.use(
      http.get(
        `${MANYFOLD}/models/m1/model_files/f2`,
        () => new HttpResponse(null, { status: 502 }),
        {
          once: true,
        },
      ),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(0);
    expect(s.waits.length).toBeGreaterThan(0);
    expect(s.waits.every((ms) => ms > 0)).toBe(true);
    expect(seen.filter((x) => x.url === `${MANYFOLD}/models/m1/model_files/f2`)).toHaveLength(2);
  });

  it("are bounded: a model that keeps failing is reported failed and the rest import", async () => {
    const s = setup(library());
    server.use(http.get(`${MANYFOLD}/models/m1`, () => new HttpResponse(null, { status: 503 })));
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    const tries = seen.filter((x) => x.url === `${MANYFOLD}/models/m1`).length;
    expect(tries).toBeGreaterThan(1);
    expect(tries).toBeLessThanOrEqual(5);
    expect(r.report?.models.map((m) => [m.manyfoldId, m.outcome])).toEqual([
      ["m1", "failed"],
      ["m2", "imported"],
      ["m3", "imported"],
    ]);
  });

  it("never repeat the token request", async () => {
    const s = setup(library());
    server.use(
      http.post(`${MANYFOLD}/oauth/token`, () => new HttpResponse(null, { status: 503 }), {
        once: true,
      }),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(2);
    expect(manyfoldCalls()).toEqual(["POST /oauth/token"]);
  });
});

describe("the model list", () => {
  it("is read page by page through view.next", async () => {
    const s = setup(library());
    const r = await s.run([]);
    expect(r.code).toBe(0);
    expect(r.report?.found).toBe(3);
    expect(manyfoldCalls().filter((c) => c === "GET /models")).toHaveLength(2);
  });

  it("stops the run, saying where it stopped, when it ends short of totalItems", async () => {
    const s = setup(library());
    server.use(
      http.get(`${MANYFOLD}/models`, () =>
        HttpResponse.json(
          {
            "@context": ["https://www.w3.org/ns/hydra/core"],
            "@id": "http://manyfold.example.test/models",
            "@type": "hydra:Collection",
            totalItems: 3,
            member: [
              { "@id": "/models/m1", "@type": "3DModel", name: "Benchy Stand" },
              { "@id": "/models/m2", "@type": "3DModel", name: "Cable Clip" },
            ],
            view: {
              "@id": "http://manyfold.example.test/models?page=1",
              "@type": "hydra:PartialCollectionView",
              first: "http://manyfold.example.test/models?page=1",
              last: "http://manyfold.example.test/models?page=1",
            },
          },
          { headers: { "content-type": "application/vnd.manyfold.v0+json" } },
        ),
      ),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(2);
    expect(r.stderr.join("\n")).toMatch(/2 of 3/);
    expect(s.platehouse.models.size).toBe(0);
  });
});
