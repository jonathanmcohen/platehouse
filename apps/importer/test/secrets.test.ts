// AC-003: the Manyfold client id and secret, the Manyfold token, the
// Platehouse token and the signed query of any object-store redirect never
// appear in what the importer prints, on its happy path or its error paths.
// stdout and stderr are captured whole and searched for each value, raw,
// URL-encoded and as the Basic header Manyfold's token request carries.
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { REDACTED } from "../src/redact.js";
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

  it("when Platehouse's first check fails with an error body that echoes the token", async () => {
    const s = setup(library());
    server.use(
      http.get(
        `${PLATEHOUSE}/api/v1/models`,
        ({ request }) =>
          new HttpResponse(`upstream said ${request.headers.get("authorization")}`, {
            status: 500,
          }),
      ),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(2);
    expect(r.stderr.join("\n")).toMatch(/could not start/);
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

  // The clients quote at most 200 characters of an error body. A credential
  // that crosses that mark must be redacted before the cut, or only its
  // first part is printed and the whole-value redactor no longer sees it.
  it("when Platehouse echoes its token across the 200-character quote limit", async () => {
    const s = setup(library());
    server.use(
      http.post(
        `${PLATEHOUSE}/api/v1/uploads`,
        ({ request }) =>
          new HttpResponse(`${"x".repeat(180)}${request.headers.get("authorization")}`, {
            status: 403,
          }),
      ),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    expectClean(s, r.output);
    expect(r.output).not.toContain(FAKE_BEARER.slice(0, 8));
    expect(r.output).toContain(`${"x".repeat(180)}Bearer ${REDACTED}`);
  });

  it("when Manyfold echoes its token across the 200-character quote limit", async () => {
    const s = setup(library());
    server.use(
      http.get(
        `${MANYFOLD}/models/m1`,
        ({ request }) =>
          new HttpResponse(`${"x".repeat(180)}${request.headers.get("authorization")}`, {
            status: 403,
          }),
      ),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    expectClean(s, r.output);
    expect(r.output).not.toContain(s.manyfold.accessToken.slice(0, 12));
    expect(r.output).toContain(`${"x".repeat(180)}Bearer ${REDACTED}`);
  });

  it("when Manyfold echoes the Basic header across the 200-character quote limit", async () => {
    const s = setup(library());
    const basic = Buffer.from(`${FAKE_ID}:${FAKE_KEY}`).toString("base64");
    server.use(
      http.get(
        `${MANYFOLD}/models/m1`,
        () => new HttpResponse(`${"x".repeat(185)}Basic ${basic}`, { status: 403 }),
      ),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    expectClean(s, r.output);
    expect(r.output).not.toContain(basic.slice(0, 8));
  });

  // Control characters are taken out of what is printed. If that happened
  // after redaction, a credential echoed with control characters inside it
  // would slip past the redactor and then be joined back up.
  it("when Manyfold echoes its token with control characters inside it, across the quote limit", async () => {
    const s = setup(library());
    server.use(
      http.get(`${MANYFOLD}/models/m1`, ({ request }) => {
        const echoed = (request.headers.get("authorization") ?? "").replace("Bearer ", "");
        const broken = `${echoed.slice(0, 10)}\u0001\u001b${echoed.slice(10, 20)}\u007f${echoed.slice(20)}`;
        return new HttpResponse(`${"x".repeat(180)}${broken}`, { status: 403 });
      }),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    expectClean(s, r.output);
    expect(r.output).not.toContain(s.manyfold.accessToken.slice(0, 12));
    expect(r.output).toContain(REDACTED);
  });

  it("when Platehouse echoes its token with control characters inside it, across the quote limit", async () => {
    const s = setup(library());
    const head = FAKE_BEARER.slice(0, 5);
    const rest = FAKE_BEARER.slice(5);
    server.use(
      http.post(
        `${PLATEHOUSE}/api/v1/uploads`,
        () => new HttpResponse(`${"y".repeat(185)}${head}\u0007${rest}`, { status: 403 }),
      ),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    expectClean(s, r.output);
    expect(r.output).not.toContain(FAKE_BEARER.slice(0, 8));
    expect(r.output).toContain(`${"y".repeat(185)}${REDACTED}`);
  });

  it("when Platehouse's first check echoes its token with a control character inside it", async () => {
    const s = setup(library());
    const head = FAKE_BEARER.slice(0, 5);
    const rest = FAKE_BEARER.slice(5);
    server.use(
      http.get(
        `${PLATEHOUSE}/api/v1/models`,
        () => new HttpResponse(`upstream said ${head}\u0000${rest}`, { status: 500 }),
      ),
    );
    const r = await s.run([]);
    expect(r.code).toBe(2);
    expect(r.stderr.join("\n")).toMatch(/could not start/);
    expectClean(s, r.output);
    expect(r.output).toContain(`upstream said ${REDACTED}`);
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
