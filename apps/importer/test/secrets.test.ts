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

const PH_VAR = ["PLATEHOUSE", "TOKEN"].join("_");
const KEY_VAR = ["MANYFOLD", "CLIENT", "SECRET"].join("_");

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

  // Newline, tab and CR are control characters too, and \s matches them. If
  // whitespace were made into spaces before control characters were taken
  // out, a credential echoed with one inside it would reach the redactor as
  // two halves it cannot find, and both would be printed.
  it("when Manyfold echoes its token with a newline and a tab inside it", async () => {
    const s = setup(library());
    server.use(
      http.get(`${MANYFOLD}/models/m1`, ({ request }) => {
        const echoed = (request.headers.get("authorization") ?? "").replace("Bearer ", "");
        const broken = `${echoed.slice(0, 10)}\n${echoed.slice(10, 20)}\t${echoed.slice(20)}`;
        return new HttpResponse(`denied ${broken}`, { status: 403 });
      }),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    expectClean(s, r.output);
    expect(r.output).not.toContain(s.manyfold.accessToken.slice(0, 10));
    expect(r.output).toContain(`denied ${REDACTED}`);
  });

  it("when Manyfold echoes the Basic header with a CR and LF inside it", async () => {
    const s = setup(library());
    const basic = Buffer.from(`${FAKE_ID}:${FAKE_KEY}`).toString("base64");
    server.use(
      http.get(
        `${MANYFOLD}/models/m1`,
        () =>
          new HttpResponse(`denied Basic ${basic.slice(0, 8)}\r\n${basic.slice(8)}`, {
            status: 403,
          }),
      ),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    expectClean(s, r.output);
    expect(r.output).not.toContain(basic.slice(0, 8));
    expect(r.output).toContain(`denied Basic ${REDACTED}`);
  });

  it("when Platehouse echoes its token with a CR, LF and tab inside it", async () => {
    const s = setup(library());
    const head = FAKE_BEARER.slice(0, 5);
    const rest = FAKE_BEARER.slice(5);
    server.use(
      http.post(
        `${PLATEHOUSE}/api/v1/uploads`,
        () => new HttpResponse(`denied ${head}\r\n\t${rest}`, { status: 403 }),
      ),
    );
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    expectClean(s, r.output);
    expect(r.output).not.toContain(head);
    expect(r.output).toContain(`denied ${REDACTED}`);
  });

  it("when a failed PATCH echoes Platehouse's token with a newline inside it, in the retry line", async () => {
    const s = setup(library());
    const head = FAKE_BEARER.slice(0, 5);
    const rest = FAKE_BEARER.slice(5);
    server.use(
      http.patch(
        `${PLATEHOUSE}/api/v1/uploads/:id`,
        () => new HttpResponse(`busy ${head}\n${rest}`, { status: 503 }),
        { once: true },
      ),
    );
    const r = await s.run(["--apply"]);
    expectClean(s, r.output);
    expect(r.output).not.toContain(head);
    expect(r.output).toMatch(/PATCH .*HTTP 503 busy \[redacted\]; asking where the upload stands/);
  });

  // claude-env, or whoever sets the variable, may pass a token with a
  // newline or space before or after it. Fetch strips that from the header,
  // so Platehouse sees, and may echo, the bare token. A 403 is used
  // because its body is quoted; a 401's is not.
  const PADDED = [
    ["a trailing newline", `${FAKE_BEARER}\n`],
    ["a trailing CRLF", `${FAKE_BEARER}\r\n`],
    ["a trailing space", `${FAKE_BEARER} `],
    ["a trailing tab", `${FAKE_BEARER}\t`],
    ["a leading newline", `\n${FAKE_BEARER}`],
    ["a leading space", ` ${FAKE_BEARER}`],
    ["a newline on both sides", `\n${FAKE_BEARER}\n`],
  ] as const;

  for (const [what, padded] of PADDED) {
    it(`when Platehouse's token is set with ${what} and Platehouse echoes what it received`, async () => {
      const s = setup(library());
      server.use(
        http.get(`${PLATEHOUSE}/api/v1/models`, ({ request }) =>
          HttpResponse.json(
            { error: "forbidden", message: `got ${request.headers.get("authorization")}` },
            { status: 403 },
          ),
        ),
      );
      const r = await s.run(["--apply"], { ...ENV, [PH_VAR]: padded });
      expect(r.code).toBe(2);
      expectClean(s, r.output);
    });
  }

  it("when Platehouse's token is set with a leading space and only its body after ph_ is echoed", async () => {
    const s = setup(library());
    server.use(
      http.get(`${PLATEHOUSE}/api/v1/models`, () =>
        HttpResponse.json(
          { error: "forbidden", message: `unknown token ${FAKE_BEARER.slice(3)}` },
          { status: 403 },
        ),
      ),
    );
    const r = await s.run(["--apply"], { ...ENV, [PH_VAR]: ` ${FAKE_BEARER}` });
    expect(r.code).toBe(2);
    expectClean(s, r.output);
  });

  it("when Manyfold's client secret is set with a trailing newline and Manyfold echoes it bare", async () => {
    // Manyfold takes the padded secret as it was sent, then echoes it trimmed.
    const s = setup(library(), { manyfold: { clientKey: `${FAKE_KEY}\n` } });
    server.use(
      http.get(
        `${MANYFOLD}/models/m1`,
        () => new HttpResponse(`denied for client secret ${FAKE_KEY}`, { status: 403 }),
      ),
    );
    const r = await s.run(["--apply"], { ...ENV, [KEY_VAR]: `${FAKE_KEY}\n` });
    expect(r.code).toBe(1);
    expect(r.output).toContain(`denied for client secret ${REDACTED}`);
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
