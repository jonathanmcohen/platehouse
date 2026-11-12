// A whole import into the Platehouse stub (build plan Task 23; AC-001,
// AC-002, AC-004): what lands in Platehouse, re-runs, the trash, sizes, the
// report and the exit codes.
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
  ENV,
  MANYFOLD,
  manyfoldCalls,
  PLATEHOUSE,
  seen,
  server,
  setup,
  useServer,
} from "./support/harness.js";
import { library, sha256 } from "./support/library.js";

useServer();

const PH_VAR = ["PLATEHOUSE", "TOKEN"].join("_");

const byRef = (s: ReturnType<typeof setup>, id: string) => {
  const found = s.platehouse.byRef(`manyfold:${id}`);
  expect(found).toHaveLength(1);
  const model = found[0];
  if (model === undefined) throw new Error("unreachable");
  return model;
};

const fileNames = (s: ReturnType<typeof setup>, id: string) =>
  s.platehouse
    .filesOf(byRef(s, id).id)
    .map((f) => f.originalName)
    .sort();

const platehouseCalls = () =>
  seen
    .filter((r) => r.url.startsWith(PLATEHOUSE))
    .map((r) => `${r.method} ${new URL(r.url).pathname}`);

/** Code points that would move a terminal's cursor, ring it or reorder text. */
function controlCharacters(text: string): number[] {
  return [...text]
    .map((c) => c.codePointAt(0) ?? 0)
    .filter(
      (cp) =>
        (cp < 0x20 && cp !== 0x0a) ||
        (cp >= 0x7f && cp <= 0x9f) ||
        (cp >= 0x202a && cp <= 0x202e) ||
        (cp >= 0x2066 && cp <= 0x2069),
    );
}

describe("an --apply run", () => {
  it("makes one Platehouse model per Manyfold model, with its details, tags and collections", async () => {
    const s = setup(library());
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(0);
    expect(s.platehouse.models.size).toBe(3);
    const m1 = byRef(s, "m1");
    expect(m1).toMatchObject({
      name: "Benchy Stand",
      caption: "A stand for a benchy",
      description: "Print it **flat**.",
      creator: "Maker One",
      license: "CC-BY-4.0",
      externalRef: "manyfold:m1",
    });
    expect([...m1.tags].sort()).toEqual(["boat", "calibration"]);
    expect([...m1.collections].sort()).toEqual(["Calibration", "Gifts"]);
    const m2 = byRef(s, "m2");
    expect(m2).toMatchObject({ creator: null, caption: null, description: null, license: null });
    expect(m2.tags).toEqual([]);
    expect(m2.collections).toEqual(["Calibration"]);
    expect(byRef(s, "m3")).toMatchObject({ creator: "Second Maker", tags: ["filament"] });
  });

  it("uploads every file Platehouse takes, byte for byte", async () => {
    const s = setup(library());
    await s.run(["--apply"]);
    for (const model of library().models) {
      const stored = s.platehouse.filesOf(byRef(s, model.id).id);
      const wanted = model.files.filter((f) => !f.filename.endsWith(".png"));
      expect(stored.map((f) => f.originalName).sort()).toEqual(
        wanted.map((f) => f.filename).sort(),
      );
      for (const f of wanted) {
        const got = stored.find((x) => x.originalName === f.filename);
        expect(got?.size).toBe(f.bytes.length);
        expect(got?.sha256).toBe(sha256(f.bytes));
      }
    }
  });

  it("skips a file type Platehouse does not take, with the reason, and still imports its model", async () => {
    const s = setup(library());
    const r = await s.run(["--apply"]);
    const m2 = r.report?.models.find((m) => m.manyfoldId === "m2");
    expect(m2?.outcome).toBe("imported");
    const photo = m2?.files.find((f) => f.name === "photo.png");
    expect(photo?.status).toBe("skipped");
    expect(photo?.reason).toMatch(/png/);
    expect(s.manyfold.objectRequests.some((x) => x.url.includes("/f4?"))).toBe(false);
    expect(fileNames(s, "m2")).toEqual(["clip.3mf"]);
  });

  it("makes a model that has no files at all", async () => {
    const lib = library();
    lib.models.push({ id: "m4", name: "Empty Model", files: [] });
    const s = setup(lib);
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(0);
    expect(byRef(s, "m4").name).toBe("Empty Model");
  });
});

describe("a dry run", () => {
  it("is the default, plans every model and writes nothing to Platehouse", async () => {
    const s = setup(library());
    const r = await s.run([]);
    expect(r.code).toBe(0);
    expect(r.report?.mode).toBe("dry run");
    expect(s.platehouse.models.size).toBe(0);
    expect(s.platehouse.uploads.size).toBe(0);
    expect(platehouseCalls().length).toBeGreaterThan(0);
    expect(platehouseCalls().every((c) => c.startsWith("GET "))).toBe(true);
    expect(r.report?.models.map((m) => [m.manyfoldId, m.outcome, m.newModel])).toEqual([
      ["m1", "imported", true],
      ["m2", "imported", true],
      ["m3", "imported", true],
    ]);
    const rows = r.report?.models.flatMap((m) => m.files) ?? [];
    expect(rows.filter((f) => f.status === "would import")).toHaveLength(4);
  });

  it("downloads nothing", async () => {
    const s = setup(library());
    await s.run([]);
    expect(s.manyfold.objectRequests).toHaveLength(0);
  });
});

describe("Manyfold is only read", () => {
  it("gets nothing but GET requests and one token POST per run, over an import and a re-run", async () => {
    const s = setup(library());
    await s.run(["--apply"]);
    await s.run(["--apply"]);
    const calls = manyfoldCalls();
    expect(calls.length).toBeGreaterThan(2);
    const notGet = calls.filter((c) => !c.startsWith("GET "));
    expect(notGet).toEqual(["POST /oauth/token", "POST /oauth/token"]);
    expect(s.manyfold.writes).toEqual([]);
  });
});

describe("re-running", () => {
  it("plans zero new models after a full run", async () => {
    const s = setup(library());
    expect((await s.run(["--apply"])).code).toBe(0);
    const again = await s.run([]);
    expect(again.code).toBe(0);
    const models = again.report?.models ?? [];
    expect(models).toHaveLength(3);
    expect(models.filter((m) => m.newModel)).toHaveLength(0);
    const planned = models.flatMap((m) => m.files).filter((f) => f.status === "would import");
    expect(planned).toHaveLength(0);
    expect(models.every((m) => m.outcome === "skipped")).toBe(true);
    expect(models[0]?.reason).toMatch(/already in Platehouse/);
  });

  it("with --apply again creates no duplicate model or file", async () => {
    const s = setup(library());
    await s.run(["--apply"]);
    const again = await s.run(["--apply"]);
    expect(again.code).toBe(0);
    expect(s.platehouse.models.size).toBe(3);
    expect(s.platehouse.files.size).toBe(4);
    expect(platehouseCalls().filter((c) => c === "POST /api/v1/uploads")).toHaveLength(4);
  });

  it("after an interrupted run imports only what is missing and creates no duplicates", async () => {
    const s = setup(library());
    // The first run loses Platehouse after two files have gone up.
    let uploads = 0;
    server.use(
      http.post(`${PLATEHOUSE}/api/v1/uploads`, () => {
        uploads += 1;
        return uploads > 2 ? HttpResponse.error() : undefined;
      }),
    );
    const first = await s.run(["--apply"]);
    expect(first.code).toBe(1);
    expect(s.platehouse.files.size).toBe(2);

    server.resetHandlers(...s.manyfold.handlers, ...s.platehouse.handlers);
    seen.length = 0;
    const second = await s.run(["--apply"]);
    expect(second.code).toBe(0);
    expect(platehouseCalls().filter((c) => c === "POST /api/v1/uploads")).toHaveLength(2);
    expect(s.platehouse.models.size).toBe(3);
    expect(s.platehouse.files.size).toBe(4);
    expect(fileNames(s, "m1")).toEqual(["benchy.3mf", "stand.stl"]);
    expect(fileNames(s, "m2")).toEqual(["clip.3mf"]);
    expect(fileNames(s, "m3")).toEqual(["air-dry.3mf"]);
  });

  it("finishes a model whose answer to the create was lost, in the same run", async () => {
    const s = setup(library());
    // Platehouse makes the model, but the answer never arrives.
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
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(0);
    expect(s.platehouse.models.size).toBe(3);
    expect(fileNames(s, "m1")).toEqual(["benchy.3mf", "stand.stl"]);
  });

  it("skips a model Jon trashed in Platehouse, with the reason, and makes no new copy", async () => {
    const s = setup(library());
    await s.run(["--apply"]);
    s.platehouse.trash(byRef(s, "m1").id);
    seen.length = 0;
    const again = await s.run(["--apply"]);
    expect(again.code).toBe(0);
    const m1 = again.report?.models.find((m) => m.manyfoldId === "m1");
    expect(m1?.outcome).toBe("skipped");
    expect(m1?.reason).toMatch(/trash/);
    expect(s.platehouse.byRef("manyfold:m1")).toHaveLength(1);
    expect(s.platehouse.files.size).toBe(4);
    expect(platehouseCalls().filter((c) => c === "POST /api/v1/uploads")).toHaveLength(0);
    expect(again.stdout.join("\n")).toMatch(/Benchy Stand.*trash/);
  });

  it("adds a tag or collection Manyfold gained since, and uploads nothing again", async () => {
    const lib = library();
    const s = setup(lib);
    await s.run(["--apply"]);
    const m3 = lib.models[2];
    if (m3 === undefined) throw new Error("unreachable");
    m3.keywords = ["filament", "storage"];
    m3.collectionIds = ["col2"];
    seen.length = 0;
    const again = await s.run(["--apply"]);
    expect(again.code).toBe(0);
    const stored = byRef(s, "m3");
    expect([...stored.tags].sort()).toEqual(["filament", "storage"]);
    expect(stored.collections).toEqual(["Gifts"]);
    expect(platehouseCalls().filter((c) => c === "POST /api/v1/uploads")).toHaveLength(0);
  });
});

describe("sizes", () => {
  it("a download whose size is not contentSize is reported and not counted imported", async () => {
    const lib = library();
    const stand = lib.models[0]?.files[1];
    if (stand === undefined) throw new Error("unreachable");
    stand.contentSize = 1300;
    const s = setup(lib);
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    const m1 = r.report?.models.find((m) => m.manyfoldId === "m1");
    expect(m1?.outcome).toBe("failed");
    const row = m1?.files.find((f) => f.name === "stand.stl");
    expect(row).toMatchObject({ status: "failed", manyfoldSize: 1300, storedSize: null });
    expect(row?.reason).toMatch(/1200/);
    expect(fileNames(s, "m1")).toEqual(["benchy.3mf"]);
    expect(r.stdout.join("\n")).toMatch(/size mismatch/i);
  });

  it("a stored size that is not contentSize is reported and not counted imported", async () => {
    const s = setup(library(), {
      platehouse: {
        mangle: (name, bytes) =>
          name === "clip.3mf" ? bytes.subarray(0, bytes.length - 1) : bytes,
      },
    });
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(1);
    const m2 = r.report?.models.find((m) => m.manyfoldId === "m2");
    expect(m2?.outcome).toBe("failed");
    expect(m2?.files.find((f) => f.name === "clip.3mf")).toMatchObject({
      status: "failed",
      manyfoldSize: 800,
      storedSize: 799,
    });
  });
});

describe("the report", () => {
  it("has one size row per file: Manyfold contentSize, stored size and SHA-256 prefix", async () => {
    const s = setup(library());
    const r = await s.run(["--apply"]);
    const models = r.report?.models ?? [];
    expect(models.map((m) => m.files.length)).toEqual([2, 2, 1]);
    const benchy = library().models[0]?.files[0];
    if (benchy === undefined) throw new Error("unreachable");
    expect(models[0]?.files[0]).toMatchObject({
      name: "benchy.3mf",
      manyfoldSize: 3000,
      storedSize: 3000,
      sha256: sha256(benchy.bytes),
      status: "imported",
    });
    const line = r.stdout.find((l) => l.includes("benchy.3mf"));
    expect(line).toContain("3000");
    expect(line).toContain(sha256(benchy.bytes).slice(0, 12));
  });

  it("ends with models found, imported, skipped and failed", async () => {
    const s = setup(library());
    const first = await s.run(["--apply"]);
    expect(first.stdout.join("\n")).toMatch(/found 3, imported 3, skipped 0, failed 0/);
    const again = await s.run(["--apply"]);
    expect(again.stdout.join("\n")).toMatch(/found 3, imported 0, skipped 3, failed 0/);
  });
});

describe("--model", () => {
  it("imports that one model only", async () => {
    const s = setup(library());
    const r = await s.run(["--apply", "--model", "m2"]);
    expect(r.code).toBe(0);
    expect(r.report?.found).toBe(1);
    expect([...s.platehouse.models.values()].map((m) => m.externalRef)).toEqual(["manyfold:m2"]);
    expect(manyfoldCalls()).not.toContain("GET /models");
  });

  it("reports an id Manyfold does not know as a failed model", async () => {
    const s = setup(library());
    const r = await s.run(["--apply", "--model", "nope"]);
    expect(r.code).toBe(1);
    expect(r.report?.models[0]?.outcome).toBe("failed");
  });
});

describe("exit code 2: the run could not start", () => {
  it("when a credential is missing, naming it and sending nothing", async () => {
    const s = setup(library());
    const env: Record<string, string | undefined> = { ...ENV };
    delete env.MANYFOLD_CLIENT_ID;
    const r = await s.run(["--apply"], env);
    expect(r.code).toBe(2);
    expect(r.stderr.join("\n")).toContain("MANYFOLD_CLIENT_ID");
    expect(seen).toHaveLength(0);
  });

  it("on an unknown flag", async () => {
    const s = setup(library());
    const r = await s.run(["--force"]);
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it("on a --model value that is not a Manyfold id", async () => {
    const s = setup(library());
    const r = await s.run(["--model", "../creators"]);
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it("when Manyfold refuses the token", async () => {
    const s = setup(library());
    const r = await s.run(["--apply"], { ...ENV, MANYFOLD_CLIENT_ID: "someone-else" });
    expect(r.code).toBe(2);
    expect(r.stderr.join("\n")).toMatch(/token/);
    expect(s.platehouse.models.size).toBe(0);
  });

  it("when Platehouse refuses its token, before anything is read from Manyfold", async () => {
    const s = setup(library());
    const r = await s.run(["--apply"], { ...ENV, [PH_VAR]: "not-the-real-one" });
    expect(r.code).toBe(2);
    expect(r.stderr.join("\n")).toMatch(/Platehouse/);
    expect(s.platehouse.models.size).toBe(0);
    expect(manyfoldCalls().filter((c) => c.startsWith("GET "))).toHaveLength(0);
  });

  it("when Manyfold's model list cannot be read", async () => {
    const s = setup(library());
    server.use(http.get(`${MANYFOLD}/models`, () => new HttpResponse(null, { status: 500 })));
    const r = await s.run(["--apply"]);
    expect(r.code).toBe(2);
    expect(s.platehouse.models.size).toBe(0);
  });
});

describe("text from Manyfold", () => {
  it("is printed without control or bidi characters", async () => {
    const lib = library();
    const m1 = lib.models[0];
    if (m1 === undefined) throw new Error("unreachable");
    m1.name = "Evil\u001b[2J\u0007 Name‮";
    const s = setup(lib);
    const r = await s.run([]);
    expect(r.code).toBe(0);
    expect(r.output).toContain("Evil[2J Name");
    expect(controlCharacters(r.output)).toEqual([]);
  });
});
