// AC-003: the Manyfold client id and secret, the Manyfold token, the
// Platehouse token and the signed query of any object-store redirect never
// appear in what the importer prints, on its happy path or its error paths.
// stdout and stderr are captured whole and searched for each value, raw,
// URL-encoded and as the Basic header Manyfold's token request carries.
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
  ENV,
  FAKE_BEARER,
  FAKE_ID,
  FAKE_KEY,
  MANYFOLD,
  OBJECTS,
  PLATEHOUSE,
  type Setup,
  server,
  setup,
  useServer,
} from "./support/harness.js";
import { library } from "./support/library.js";

useServer();

function forbidden(s: Setup): string[] {
  const basic = Buffer.from(`${FAKE_ID}:${FAKE_KEY}`).toString("base64");
  return [
    FAKE_ID,
    FAKE_KEY,
    encodeURIComponent(FAKE_KEY),
    FAKE_BEARER,
    FAKE_BEARER.slice(3), // the token without its ph_ prefix
    s.manyfold.accessToken,
    basic,
    ...s.manyfold.signedQueries,
    ...s.manyfold.signedQueries.map((q) => q.split("X-Amz-Signature=")[1] ?? q),
  ];
}

function expectClean(s: Setup, output: string): void {
  for (const value of forbidden(s)) expect(output).not.toContain(value);
  expect(output).not.toContain("X-Amz-Signature");
}

describe("the output never shows a credential or a signed query", () => {
  it("over a full import with retries, a skipped file and a size mismatch", async () => {
    const lib = library();
    const stand = lib.models[0]?.files[1];
    if (stand === undefined) throw new Error("unreachable");
    stand.contentSize = 1199;
    const s = setup(lib);
    server.use(
      http.get(
        `${MANYFOLD}/models/m2`,
        () => new HttpResponse(null, { status: 429, headers: { "retry-after": "1" } }),
        { once: true },
      ),
      http.get(`${OBJECTS}/manyfold/m3/f5`, () => new HttpResponse(null, { status: 500 }), {
        once: true,
      }),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    expect(s.manyfold.signedQueries.length).toBeGreaterThan(0);
    expectClean(s, r.output);
  });

  it("in a dry run", async () => {
    const s = setup(library());
    const r = await s.run([]);
    expect(r.code).toBe(0);
    expectClean(s, r.output);
  });

  it("when Manyfold refuses the token", async () => {
    const s = setup(library());
    server.use(
      http.post(`${MANYFOLD}/oauth/token`, async ({ request }) =>
        HttpResponse.json(
          {
            error: "invalid_client",
            error_description: `bad credentials: ${request.headers.get("authorization")} ${await request.text()}`,
          },
          { status: 401 },
        ),
      ),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(2);
    expectClean(s, r.output);
  });

  it("when Manyfold echoes the token back in an error body", async () => {
    const s = setup(library());
    server.use(
      http.get(
        `${MANYFOLD}/models/m1`,
        ({ request }) =>
          new HttpResponse(`denied for ${request.headers.get("authorization")}`, { status: 403 }),
      ),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    expectClean(s, r.output);
  });

  it("when the object store echoes its signed URL back in an error body", async () => {
    const s = setup(library());
    server.use(
      http.get(
        `${OBJECTS}/manyfold/m1/f1`,
        ({ request }) => new HttpResponse(`<Error>${request.url}</Error>`, { status: 403 }),
      ),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    expectClean(s, r.output);
  });

  it("when Platehouse refuses its token and echoes it back", async () => {
    const s = setup(library());
    server.use(
      http.get(`${PLATEHOUSE}/api/v1/models`, ({ request }) =>
        HttpResponse.json(
          { error: "unauthorized", message: `${request.headers.get("authorization")}` },
          { status: 401 },
        ),
      ),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(2);
    expectClean(s, r.output);
  });

  it("when Platehouse echoes its token back while an upload fails", async () => {
    const s = setup(library());
    server.use(
      http.post(
        `${PLATEHOUSE}/api/v1/uploads`,
        ({ request }) =>
          new HttpResponse(`refused ${request.headers.get("authorization")}`, { status: 500 }),
      ),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    expectClean(s, r.output);
  });

  it("when a credential variable is missing", async () => {
    const s = setup(library());
    const env: Record<string, string | undefined> = { ...ENV };
    delete env.MANYFOLD_CLIENT_ID;
    const r = await s.run([], env);
    expect(r.code).toBe(2);
    expectClean(s, r.output);
  });
});
