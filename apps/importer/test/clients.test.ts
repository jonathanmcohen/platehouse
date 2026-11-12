// The two clients on their own, with no CLI and no redactor in front of
// them, so each rule below is shown to hold in the client itself and not
// only because the CLI's redactor would mask a slip (AC-003).
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { createManyfold, type ManyfoldError } from "../src/manyfold.js";
import { createPlatehouse } from "../src/platehouse.js";
import {
  FAKE_BEARER,
  FAKE_ID,
  FAKE_KEY,
  MANYFOLD,
  manyfoldCalls,
  OBJECTS,
  PLATEHOUSE,
  seen,
  server,
  setup,
  useServer,
} from "./support/harness.js";
import { library, sha256 } from "./support/library.js";

useServer();

const noSleep = async () => {};

function manyfoldClient(lines: string[] = [], seenValues: string[] = []) {
  return createManyfold({
    base: MANYFOLD,
    clientId: FAKE_ID,
    clientKey: FAKE_KEY,
    sleep: noSleep,
    log: (line) => lines.push(line),
    sensitive: (value) => seenValues.push(value),
  });
}

describe("the Manyfold client", () => {
  it("asks for the token once, however often authenticate is called", async () => {
    setup(library());
    const mf = manyfoldClient();
    await mf.authenticate();
    await mf.authenticate();
    expect(manyfoldCalls()).toEqual(["POST /oauth/token"]);
  });

  it("does not ask again after a refused token request", async () => {
    setup(library());
    server.use(
      http.post(`${MANYFOLD}/oauth/token`, () =>
        HttpResponse.json({ error: "invalid_client" }, { status: 401 }),
      ),
    );
    const mf = manyfoldClient();
    await expect(mf.authenticate()).rejects.toThrow(/refused/);
    await expect(mf.authenticate()).rejects.toThrow();
    expect(manyfoldCalls()).toEqual(["POST /oauth/token"]);
  });

  it("hands the token and each signed query to the sensitive callback", async () => {
    const s = setup(library());
    const values: string[] = [];
    const mf = manyfoldClient([], values);
    await mf.authenticate();
    const file = await mf.getFile(`${MANYFOLD}/models/m1/model_files/f1`);
    await mf.download(file.contentUrl, 3000);
    expect(values).toContain(s.manyfold.accessToken);
    expect(values).toContain(s.manyfold.signedQueries[0]);
  });

  it("logs a retried object-store request by host and path, never its query", async () => {
    const s = setup(library());
    server.use(
      http.get(`${OBJECTS}/manyfold/m1/f1`, () => new HttpResponse(null, { status: 503 }), {
        once: true,
      }),
    );
    const lines: string[] = [];
    const mf = manyfoldClient(lines);
    await mf.authenticate();
    const file = await mf.getFile(`${MANYFOLD}/models/m1/model_files/f1`);
    const bytes = await mf.download(file.contentUrl, 3000);
    expect(bytes.length).toBe(3000);
    const text = lines.join("\n");
    expect(text).toContain("objects.example.test/manyfold/m1/f1");
    for (const q of s.manyfold.signedQueries) expect(text).not.toContain(q);
    expect(text).not.toContain("X-Amz");
  });

  it("does not quote an object store's error body, which may echo the signed URL", async () => {
    setup(library());
    server.use(
      http.get(
        `${OBJECTS}/manyfold/m1/f1`,
        ({ request }) => new HttpResponse(`<Error>${request.url}</Error>`, { status: 403 }),
      ),
    );
    const mf = manyfoldClient();
    await mf.authenticate();
    const file = await mf.getFile(`${MANYFOLD}/models/m1/model_files/f1`);
    const failure = (await mf.download(file.contentUrl, 3000).catch((e) => e)) as ManyfoldError;
    expect(failure.status).toBe(403);
    expect(failure.message).toBe("GET objects.example.test/manyfold/m1/f1: HTTP 403");
  });
});

describe("the Platehouse client", () => {
  it("resumes a cut-off PATCH from the offset Platehouse reports, sending only the rest", async () => {
    const s = setup(library());
    const made = await s.run(["--apply", "--model", "m3"]);
    expect(made.code).toBe(0);
    const model = s.platehouse.byRef("manyfold:m3")[0];
    if (model === undefined) throw new Error("unreachable");

    // The first PATCH lands half its bytes, then the connection drops.
    const bytes = Buffer.alloc(4000, 7);
    const offsets: string[] = [];
    let cut = false;
    server.use(
      http.patch(`${PLATEHOUSE}/api/v1/uploads/:id`, async ({ request, params }) => {
        offsets.push(request.headers.get("upload-offset") ?? "");
        if (cut) return undefined;
        cut = true;
        const upload = s.platehouse.uploads.get(String(params.id));
        if (upload === undefined) throw new Error("no such upload in the stub");
        const body = Buffer.from(await request.arrayBuffer());
        upload.chunks.push(body.subarray(0, 1500));
        upload.offset = 1500;
        return HttpResponse.error();
      }),
    );
    const ph = createPlatehouse({ base: PLATEHOUSE, bearer: FAKE_BEARER, sleep: noSleep });
    const stored = await ph.upload(model.id, "extra.stl", bytes);
    expect(offsets).toEqual(["0", "1500"]);
    expect(stored.size).toBe(4000);
    expect(stored.sha256).toBe(sha256(bytes));
  });

  it("sends a tag or collection with a slash or a percent sign as one path segment, to the right route", async () => {
    const s = setup(library());
    const made = await s.run(["--apply", "--model", "m3"]);
    expect(made.code).toBe(0);
    const model = s.platehouse.byRef("manyfold:m3")[0];
    if (model === undefined) throw new Error("unreachable");
    seen.length = 0;
    const ph = createPlatehouse({ base: PLATEHOUSE, bearer: FAKE_BEARER, sleep: noSleep });
    await ph.addTag(model.id, "a/b?c#d");
    await ph.addToCollection(model.id, "x/../y");
    await ph.addTag(model.id, "%2e%2E");
    expect(seen.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      `PUT /api/v1/models/${model.id}/tags/a%2Fb%3Fc%23d`,
      `PUT /api/v1/collections/x%2F..%2Fy/models/${model.id}`,
      `PUT /api/v1/models/${model.id}/tags/%252e%252E`,
    ]);
    expect(s.platehouse.byRef("manyfold:m3")[0]?.tags).toContain("%2e%2E");
    expect(s.platehouse.byRef("manyfold:m3")[0]?.tags).toContain("a/b?c#d");
    expect(s.platehouse.byRef("manyfold:m3")[0]?.collections).toContain("x/../y");
  });

  it.each([".", ".."])(
    "refuses to send a tag or collection named %s, which would reach another route",
    async (label) => {
      setup(library());
      const ph = createPlatehouse({ base: PLATEHOUSE, bearer: FAKE_BEARER, sleep: noSleep });
      await expect(ph.addTag("abc", label)).rejects.toThrow(/one path segment/);
      await expect(ph.addToCollection("abc", label)).rejects.toThrow(/one path segment/);
      expect(seen).toEqual([]);
    },
  );

  it("reads a model back by its externalRef when the answer to its create was lost", async () => {
    const s = setup(library());
    server.use(
      http.post(
        `${PLATEHOUSE}/api/v1/models`,
        async ({ request }) => {
          s.platehouse.createModel((await request.json()) as Record<string, unknown>);
          return HttpResponse.error();
        },
        { once: true },
      ),
    );
    const ph = createPlatehouse({ base: PLATEHOUSE, bearer: FAKE_BEARER, sleep: noSleep });
    const result = await ph.createModel({ name: "Lost Answer", externalRef: "manyfold:zz9" });
    expect("created" in result && result.created.externalRef).toBe("manyfold:zz9");
    expect(s.platehouse.byRef("manyfold:zz9")).toHaveLength(1);
  });
});
