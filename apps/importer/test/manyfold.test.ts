// The Manyfold side of an import, which never changes Manyfold and keeps
// credentials out of the output: one
// read-scoped token per run, redirects, origin rules, retries and paging,
// all against the stub built from Manyfold 0.154.1's recorded OpenAPI.
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { signedQueryValues } from "../src/manyfold.js";
import {
  ENV,
  MANYFOLD,
  manyfoldCalls,
  OBJECTS,
  seen,
  server,
  setup,
  useServer,
} from "./support/harness.js";
import { library, sha256 } from "./support/library.js";
import { bytesOf } from "./support/manyfold-stub.js";

useServer();

/**
 * A clock that is jumped ahead by this many ms once a model's own record has
 * been asked for, which is after the start-up listing.
 */
const jumped = (ms: number) => () =>
  Date.now() + (seen.some((x) => /\/models\/[^/?]+$/.test(x.url)) ? ms : 0);

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

  it("is not asked for again when the start-up request is refused", async () => {
    const s = setup(library());
    server.use(
      http.post(`${MANYFOLD}/oauth/token`, () =>
        HttpResponse.json({ error: "invalid_client" }, { status: 401 }),
      ),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(2);
    expect(manyfoldCalls().filter((c) => c === "POST /oauth/token")).toHaveLength(1);
  });

  it("is renewed before it expires, and the run carries on", async () => {
    // The clock jumps 590 s once the first model has been read.
    const s = setup(library(), { manyfold: { token: { expiresIn: 600 } }, now: jumped(590_000) });
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(0);
    expect(s.manyfold.tokenRequests).toHaveLength(2);
    expect(r.report?.models.map((m) => m.outcome)).not.toContain("failed");
    expect(r.report?.models).toHaveLength(3);
  });

  it("a 401 from Manyfold mid-model renews the token once, retries, and uses the new token after", async () => {
    // Six reads list the library; the first token is refused from the ninth on.
    const s = setup(library(), {
      manyfold: { token: { expireAfterRequests: 8 } },
      now: jumped(120_000),
    });
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(0);
    expect(s.manyfold.tokenRequests).toHaveLength(2);
    expect(r.report?.models.map((m) => m.outcome)).not.toContain("failed");
    const [, renewed] = s.manyfold.tokens;
    const reads = seen.filter((x) => x.url.startsWith(MANYFOLD) && x.method === "GET");
    const first = reads.findIndex((x) => x.authorization === `Bearer ${renewed}`);
    // The renewal came while model m1's records were being read.
    expect(reads.slice(0, first).some((x) => x.url.endsWith("/models/m1"))).toBe(true);
    for (const x of reads.slice(first)) expect(x.authorization).toBe(`Bearer ${renewed}`);
  });

  it("a second 401 after renewing fails that model only", async () => {
    const s = setup(library(), { now: jumped(120_000) });
    server.use(http.get(`${MANYFOLD}/models/m2`, () => new HttpResponse(null, { status: 401 })));
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    // The start-up request, and one renewal; the second 401 is the model's failure.
    expect(s.manyfold.tokenRequests).toHaveLength(2);
    const byId = new Map(r.report?.models.map((m) => [m.manyfoldId, m]));
    expect(byId.get("m2")?.outcome).toBe("failed");
    expect(byId.get("m2")?.reason).toContain("HTTP 401");
    expect(byId.get("m1")?.outcome).not.toBe("failed");
    expect(byId.get("m3")?.outcome).not.toBe("failed");
  });

  it("a Manyfold that answers 401 everywhere cannot make it spend token requests", async () => {
    const data = library();
    for (let i = 1; i <= 12; i++) {
      data.models.push({
        id: `x${i}`,
        name: `Extra ${i}`,
        files: [
          {
            id: `xf${i}`,
            filename: `x${i}.stl`,
            encodingFormat: "model/stl",
            bytes: bytesOf(`x${i}`, 40),
          },
        ],
      });
    }
    const s = setup(data, { now: jumped(120_000) });
    server.use(
      http.get(`${MANYFOLD}/models/:id`, ({ params }) =>
        String(params.id).startsWith("x") ? new HttpResponse(null, { status: 401 }) : undefined,
      ),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    expect(s.manyfold.tokenRequests.length).toBeLessThanOrEqual(2);
    const outcomes = new Map(r.report?.models.map((m) => [m.manyfoldId, m.outcome]));
    expect(r.report?.models).toHaveLength(15);
    for (const id of ["m1", "m2", "m3"]) expect(outcomes.get(id)).not.toBe("failed");
    for (let i = 1; i <= 12; i++) expect(outcomes.get(`x${i}`)).toBe("failed");
  });

  it("a renewal granted more than read stops the run, after its summary", async () => {
    const s = setup(library(), {
      manyfold: { token: { expireAfterRequests: 8, renewScope: "read write" } },
      now: jumped(120_000),
    });
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    expect(r.stdout.join("\n")).toContain("the Manyfold token could not be renewed:");
    expect(r.stdout.join("\n")).toContain(
      'scope "read write", not read only; the import stops here',
    );
    expect(r.stdout.join("\n")).toMatch(/stopped: .*; 2 models not attempted/);
    expect(r.stdout.join("\n")).toContain("apply done: found 3");
    expect(r.stderr.join("\n")).not.toContain("unexpected error");
    expect(r.report?.models).toHaveLength(1);
    // Nothing more was read after the refused renewal.
    const lastToken = seen.findLastIndex((x) => x.url.endsWith("/oauth/token"));
    expect(seen.slice(lastToken + 1).filter((x) => x.url.startsWith(MANYFOLD))).toEqual([]);
    expect(s.manyfold.tokenRequests).toHaveLength(2);
  });

  it("a renewal that names no scope stops the run at once", async () => {
    const s = setup(library(), {
      manyfold: { token: { expireAfterRequests: 8 } },
      now: jumped(120_000),
    });
    let asked = 0;
    server.use(
      http.post(`${MANYFOLD}/oauth/token`, () => {
        asked++;
        return HttpResponse.json({
          access_token: s.manyfold.accessToken,
          expires_in: 7200,
          ...(asked === 1 ? { scope: "read" } : {}),
        });
      }),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    expect(r.stdout.join("\n")).toContain("the Manyfold token could not be renewed:");
    expect(r.stdout.join("\n")).toContain("names no scope");
    expect(r.stdout.join("\n")).toMatch(/stopped: .*; 2 models not attempted/);
    expect(asked).toBe(2);
  });

  it("two failed renewals in a row stop the run", async () => {
    const s = setup(library(), {
      manyfold: { token: { expireAfterRequests: 8 } },
      now: jumped(120_000),
    });
    let asked = 0;
    server.use(
      http.post(`${MANYFOLD}/oauth/token`, () => {
        asked++;
        if (asked > 1) return new HttpResponse(null, { status: 503 });
        return HttpResponse.json({
          access_token: s.manyfold.accessToken,
          expires_in: 7200,
          scope: "read",
        });
      }),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    expect(r.stdout.join("\n")).toContain("the Manyfold token could not be renewed:");
    expect(r.stdout.join("\n")).toContain("models not attempted");
    expect(r.stderr.join("\n")).not.toContain("unexpected error");
    expect(asked).toBe(3);
  });

  it("a failed early renewal, while the token still holds, does not fail anything", async () => {
    const s = setup(library(), { now: jumped(590_000) });
    let asked = 0;
    server.use(
      http.post(`${MANYFOLD}/oauth/token`, () => {
        asked++;
        if (asked === 2) return new HttpResponse(null, { status: 503 });
        return HttpResponse.json({
          access_token: s.manyfold.accessToken,
          expires_in: 600,
          scope: "read",
        });
      }),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(0);
    expect(r.report?.models.map((m) => m.outcome)).not.toContain("failed");
    expect(r.output).toContain("could not be renewed");
    expect(asked).toBe(2);
  });

  it("is not renewed early when expires_in is under a minute", async () => {
    const s = setup(library(), {
      manyfold: { token: { expiresIn: 59 } },
      now: jumped(55_000),
    });
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(0);
    expect(s.manyfold.tokenRequests).toHaveLength(1);
  });

  it.each([
    ["absent", undefined],
    ["not a number", "soon"],
    ["negative", -5],
  ])("is not renewed early when expires_in is %s", async (_what, expiresIn) => {
    const s = setup(library(), { now: jumped(100_000_000) });
    server.use(
      http.post(`${MANYFOLD}/oauth/token`, () =>
        HttpResponse.json({
          access_token: s.manyfold.accessToken,
          scope: "read",
          ...(expiresIn === undefined ? {} : { expires_in: expiresIn }),
        }),
      ),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(0);
    expect(manyfoldCalls().filter((c) => c === "POST /oauth/token")).toHaveLength(1);
  });

  it("a 401 from the object store never renews the token", async () => {
    const s = setup(library(), { now: jumped(120_000) });
    server.use(
      http.get(`${OBJECTS}/manyfold/m3/f5`, () => new HttpResponse(null, { status: 401 })),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    expect(s.manyfold.tokenRequests).toHaveLength(1);
    const m3 = r.report?.models.find((m) => m.manyfoldId === "m3");
    expect(m3?.files[0]?.status).toBe("failed");
    const f5 = seen.filter((x) => x.url.startsWith(`${OBJECTS}/manyfold/m3/f5`));
    expect(f5.length).toBeGreaterThan(0);
    for (const req of seen.filter((x) => x.url.startsWith(OBJECTS))) {
      expect(req.authorization).toBeNull();
    }
  });

  it("a renewed token is never printed, nor the one it replaced, even when Manyfold echoes it", async () => {
    const s = setup(library(), {
      manyfold: { token: { expireAfterRequests: 8 } },
      now: jumped(120_000),
    });
    server.use(
      http.get(
        `${MANYFOLD}/models/m3`,
        () => new HttpResponse(`denied ${s.manyfold.accessToken}`, { status: 403 }),
      ),
    );
    const r = await s.run(["--apply"]);
    expect(s.manyfold.tokens).toHaveLength(2);
    expect(r.output).toContain("HTTP 403");
    for (const t of s.manyfold.tokens) expect(r.output).not.toContain(t);
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

  // A non-https redirect is always refused. That holds on Manyfold's own
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

  it("refuse a redirect to a private address and import nothing for that file", async () => {
    const s = setup(library());
    server.use(
      http.get(
        `${MANYFOLD}/models/m3/model_files/f5.3mf`,
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: { location: "https://10.0.0.5/x?sig=abcdefgh12345" },
          }),
      ),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    const m3 = r.report?.models.find((m) => m.manyfoldId === "m3");
    expect(m3?.files[0]?.status).toBe("failed");
    expect(m3?.files[0]?.reason).toMatch(/private address/);
    expect(m3?.files[0]?.reason).toContain("10.0.0.5");
    expect(seen.some((x) => x.url.includes("10.0.0.5"))).toBe(false);
    const ref = [...s.platehouse.models.values()].find((m) => m.externalRef === "manyfold:m3");
    expect(ref === undefined ? [] : s.platehouse.filesOf(ref.id)).toHaveLength(0);
  });

  it.each([
    "https://intranet/x",
    "https://[::ffff:10.0.0.1]/x",
    "https://[fe80::1]/x",
    "https://2130706433/x",
  ])("refuse a redirect to %s", async (target) => {
    const s = setup(library());
    server.use(
      http.get(
        `${MANYFOLD}/models/m3/model_files/f5.3mf`,
        () => new HttpResponse(null, { status: 302, headers: { location: target } }),
      ),
    );
    const r = await s.run(["--apply"]);
    const m3 = r.report?.models.find((m) => m.manyfoldId === "m3");
    expect(m3?.files[0]?.status).toBe("failed");
    expect(m3?.files[0]?.reason).toMatch(/private address/);
  });

  it("still follow a redirect to a public object store", async () => {
    const s = setup(library());
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(0);
    expect(seen.some((x) => x.url.startsWith(OBJECTS))).toBe(true);
  });

  it("hand over exactly the bytes of a file larger than one chunk", async () => {
    const big = bytesOf("big", 256 * 1024);
    const data = library();
    data.models[2]?.files.push({ id: "f9", filename: "big.3mf", bytes: big });
    const s = setup(data);
    // Served as a stream of 32 chunks, so every chunk lands at its own offset.
    server.use(
      http.get(`${OBJECTS}/manyfold/m3/f9`, () => {
        let at = 0;
        return new HttpResponse(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (at >= big.length) return controller.close();
              controller.enqueue(new Uint8Array(big.subarray(at, at + 8192)));
              at += 8192;
            },
          }),
        );
      }),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(0);
    const m3 = [...s.platehouse.models.values()].find((m) => m.externalRef === "manyfold:m3");
    const stored = s.platehouse.filesOf(m3?.id ?? "").find((f) => f.originalName === "big.3mf");
    expect(stored?.size).toBe(big.length);
    expect(stored?.sha256).toBe(sha256(big));
  });

  it("import an empty file", async () => {
    const data = library();
    data.models[2]?.files.push({ id: "f8", filename: "empty.3mf", bytes: Buffer.alloc(0) });
    const s = setup(data);
    const r = await s.run(["--apply"]);
    const file = r.report?.models
      .find((m) => m.manyfoldId === "m3")
      ?.files.find((f) => f.name === "empty.3mf");
    expect(file?.status).not.toBe("failed");
  });

  it("refuse a private address the object store redirects to", async () => {
    const s = setup(library());
    server.use(
      http.get(
        `${OBJECTS}/manyfold/m3/f5`,
        () => new HttpResponse(null, { status: 302, headers: { location: "https://10.0.0.5/x" } }),
      ),
    );
    const r = await s.run(["--apply"]);
    const m3 = r.report?.models.find((m) => m.manyfoldId === "m3");
    expect(m3?.files[0]?.status).toBe("failed");
    expect(m3?.files[0]?.reason).toMatch(/private address/);
    expect(seen.some((x) => x.url.includes("10.0.0.5"))).toBe(false);
  });

  describe("--allow-redirect-host", () => {
    const lan = (target: string) =>
      http.get(
        `${MANYFOLD}/models/m3/model_files/f5.3mf`,
        () => new HttpResponse(null, { status: 302, headers: { location: target } }),
      );
    const lanStore = (origin: string, auth: Array<string | null>) =>
      http.get(`${origin}/x`, ({ request }) => {
        auth.push(request.headers.get("authorization"));
        return new HttpResponse(new Uint8Array(bytesOf("f5", 5000)));
      });

    it("follows an allowed LAN host without the token", async () => {
      const s = setup(library());
      const auth: Array<string | null> = [];
      server.use(lan("https://192.168.1.20:9000/x"), lanStore("https://192.168.1.20:9000", auth));
      const r = await s.run(["--apply", "--allow-redirect-host", "192.168.1.20"]);
      expect(r.code).toBe(0);
      expect(auth).toEqual([null]);
    });

    it("still refuses a different private host, naming the way out", async () => {
      const s = setup(library());
      server.use(lan("https://192.168.1.99/x"));
      const r = await s.run(["--apply", "--allow-redirect-host", "192.168.1.20"]);
      const m3 = r.report?.models.find((m) => m.manyfoldId === "m3");
      expect(m3?.files[0]?.reason).toContain(
        "refusing a redirect to a private address, to 192.168.1.99; " +
          "if this is your object store, allow it with --allow-redirect-host",
      );
      expect(m3?.files[0]?.reason).not.toContain("--allow-redirect-host 192.168.1.99");
      expect(seen.some((x) => x.url.includes("192.168.1.99"))).toBe(false);
    });

    it("still refuses an allowed host that is not https", async () => {
      const s = setup(library());
      server.use(lan("http://minio/x"));
      const r = await s.run(["--apply", "--allow-redirect-host", "minio"]);
      expect(r.report?.models.find((m) => m.manyfoldId === "m3")?.files[0]?.reason).toMatch(
        /not https/,
      );
    });

    it("reads MANYFOLD_ALLOW_REDIRECT_HOSTS, comma-separated and case-insensitive", async () => {
      const s = setup(library());
      const auth: Array<string | null> = [];
      server.use(lan("https://minio/x"), lanStore("https://minio", auth));
      const r = await s.run(["--apply"], {
        ...ENV,
        MANYFOLD_ALLOW_REDIRECT_HOSTS: "other.lan, MinIO.",
      });
      expect(r.code).toBe(0);
      expect(auth).toEqual([null]);
    });

    it.each([["https://minio"], ["minio:9000"], ["a..b"]])(
      "refuses %j at start-up with exit 2",
      async (entry) => {
        const s = setup(library());
        const r = await s.run(["--allow-redirect-host", entry]);
        expect(r.code).toBe(2);
        expect(r.stderr).toContain(
          "--allow-redirect-host takes a host name or address, with no scheme, port or path",
        );
        expect(s.manyfold.tokenRequests).toHaveLength(0);
      },
    );

    it("refuses a bad MANYFOLD_ALLOW_REDIRECT_HOSTS entry with exit 2, naming the variable", async () => {
      const s = setup(library());
      const r = await s.run([], { ...ENV, MANYFOLD_ALLOW_REDIRECT_HOSTS: "ok.lan,minio:9000" });
      expect(r.code).toBe(2);
      expect(r.stderr.join("\n")).toContain("MANYFOLD_ALLOW_REDIRECT_HOSTS takes a host name");
    });
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

// What a redirect hop's query registers with the redactor (issue #168; PR
// #211 review). A whole query under 8 characters is never registered, as no
// single value under 8 is, and with requireSigned (a hop on Manyfold's own
// host) a query is registered only when it holds a sensitive parameter.
describe("signedQueryValues", () => {
  const signature = ["sig", "0123456789abcdef"].join("-");

  it("registers a signed query whole and its sensitive value on its own", () => {
    expect(signedQueryValues(`?X-Amz-Signature=${signature}&X-Amz-Expires=300`)).toEqual([
      `X-Amz-Signature=${signature}&X-Amz-Expires=300`,
      signature,
    ]);
  });

  it("registers a signed query on Manyfold's own host as well", () => {
    expect(signedQueryValues(`?sig=${signature}`, { requireSigned: true })).toEqual([
      `sig=${signature}`,
      signature,
    ]);
  });

  it.each([["?download"], ["?v=1"], ["?download=1&v=2"], ["?format=3mf&inline=false"]])(
    "registers nothing for %j on Manyfold's own host, which holds no sensitive parameter",
    (search) => {
      expect(signedQueryValues(search, { requireSigned: true })).toEqual([]);
    },
  );

  it("still registers a long unsigned query whole off Manyfold's host", () => {
    expect(signedQueryValues("?Expires=1700000000&Policy=abcdefgh")).toEqual([
      "Expires=1700000000&Policy=abcdefgh",
    ]);
  });

  it.each([["?v=1"], ["?a=b&c=d"], ["?dl"], [""], ["?"]])(
    "registers no whole query under 8 characters: %j",
    (search) => {
      expect(signedQueryValues(search)).toEqual([]);
    },
  );
});
