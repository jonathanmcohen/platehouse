// planModel: what one Manyfold model needs in Platehouse (AC-001, AC-002).
import { describe, expect, it } from "vitest";
import { externalRefFor, importable, planModel, type SourceModel } from "../src/plan.js";
import type { PlatehouseFile, PlatehouseModel } from "../src/platehouse.js";

const source = (over: Partial<SourceModel> = {}): SourceModel => ({
  id: "abc123",
  name: "Benchy Stand",
  caption: "A stand",
  description: "Print it flat.",
  creator: "Maker One",
  license: "CC-BY-4.0",
  tags: ["boat", "Calibration"],
  collections: ["Gifts"],
  files: [
    { url: "u1", filename: "benchy.3mf", contentUrl: "c1", contentSize: 3000 },
    { url: "u2", filename: "stand.stl", contentUrl: "c2", contentSize: 1200 },
  ],
  ...over,
});

const stored = (name: string, size: number): PlatehouseFile => ({
  id: `id-${name}`,
  modelId: "pm1",
  name,
  originalName: name,
  size,
  sha256: "ab".repeat(32),
});

const existing = (over: Partial<PlatehouseModel> = {}): PlatehouseModel => ({
  id: "pm1",
  name: "Benchy Stand",
  externalRef: "manyfold:abc123",
  tags: ["boat", "calibration"],
  collections: ["Gifts"],
  files: [],
  ...over,
});

describe("externalRefFor", () => {
  it("is manyfold: and the model's public id", () => {
    expect(externalRefFor("abc123")).toBe("manyfold:abc123");
  });
});

describe("importable", () => {
  it.each([
    ["benchy.3mf", true],
    ["BENCHY.3MF", true],
    ["part.stl", true],
    ["part.step", true],
    ["part.stp", true],
    ["box.scad", true],
    ["folder/box.scad", true],
    ["photo.png", false],
    ["notes.pdf", false],
    [".3mf", false],
    ["noextension", false],
  ])("%s -> %s", (name, want) => {
    expect(importable(name)).toBe(want);
  });
});

describe("a model Platehouse does not have", () => {
  it("is created with its details, externalRef, tags and collections", () => {
    const plan = planModel(source(), undefined);
    expect(plan.create).toEqual({
      name: "Benchy Stand",
      caption: "A stand",
      description: "Print it flat.",
      creator: "Maker One",
      license: "CC-BY-4.0",
      externalRef: "manyfold:abc123",
      tags: ["boat", "Calibration"],
      collections: ["Gifts"],
    });
    expect(plan.tags).toEqual([]);
    expect(plan.collections).toEqual([]);
    expect(plan.files.map((f) => f.action)).toEqual(["import", "import"]);
  });

  it("leaves out details Manyfold does not have, rather than sending empty ones", () => {
    const plan = planModel(
      source({
        caption: null,
        description: "  ",
        creator: null,
        license: null,
        tags: [],
        collections: [],
      }),
      undefined,
    );
    expect(plan.create).toEqual({ name: "Benchy Stand", externalRef: "manyfold:abc123" });
  });

  it("sends each tag and collection once, whatever its case", () => {
    const plan = planModel(
      source({ tags: ["Boat", "boat", "BOAT", "dock"], collections: ["Gifts", "gifts"] }),
      undefined,
    );
    expect(plan.create?.tags).toEqual(["Boat", "dock"]);
    expect(plan.create?.collections).toEqual(["Gifts"]);
  });

  it("skips a file type Platehouse does not take, with the reason", () => {
    const plan = planModel(
      source({
        files: [{ url: "u", filename: "photo.png", contentUrl: "c", contentSize: 50 }],
      }),
      undefined,
    );
    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]?.action).toBe("skip");
    expect(plan.files[0]).toMatchObject({ reason: expect.stringMatching(/png/) });
  });

  it("fails a file Manyfold gives no contentSize for, since its size cannot be checked", () => {
    const plan = planModel(
      source({ files: [{ url: "u", filename: "a.3mf", contentUrl: "c", contentSize: null }] }),
      undefined,
    );
    expect(plan.files[0]?.action).toBe("fail");
    expect(plan.files[0]).toMatchObject({ reason: expect.stringMatching(/contentSize/) });
  });
});

describe("a model Platehouse already has", () => {
  it("is not created again", () => {
    expect(planModel(source(), existing()).create).toBeNull();
  });

  it("has a file with the same name and size counted present, and the rest planned", () => {
    const plan = planModel(source(), existing({ files: [stored("benchy.3mf", 3000)] }));
    expect(plan.files.map((f) => [f.file.filename, f.action])).toEqual([
      ["benchy.3mf", "present"],
      ["stand.stl", "import"],
    ]);
    expect(plan.files[0]).toMatchObject({ stored: { id: "id-benchy.3mf" } });
  });

  it("fails, rather than duplicates, a file whose name is there with another size", () => {
    const plan = planModel(source(), existing({ files: [stored("stand.stl", 999)] }));
    const stand = plan.files.find((f) => f.file.filename === "stand.stl");
    expect(stand?.action).toBe("fail");
    expect(stand).toMatchObject({ reason: expect.stringMatching(/999/) });
  });

  it("matches two files of one name one to one", () => {
    const plan = planModel(
      source({
        files: [
          { url: "u1", filename: "part.stl", contentUrl: "c1", contentSize: 10 },
          { url: "u2", filename: "part.stl", contentUrl: "c2", contentSize: 10 },
        ],
      }),
      existing({ files: [stored("part.stl", 10)] }),
    );
    expect(plan.files.map((f) => f.action)).toEqual(["present", "import"]);
  });

  it("gets only the tags and collections it lacks, compared without case", () => {
    const plan = planModel(
      source({ tags: ["Boat", "dock"], collections: ["gifts", "Calibration"] }),
      existing({ tags: ["boat"], collections: ["Gifts"] }),
    );
    expect(plan.tags).toEqual(["dock"]);
    expect(plan.collections).toEqual(["Calibration"]);
  });

  it("is left alone when nothing is missing", () => {
    const plan = planModel(
      source(),
      existing({ files: [stored("benchy.3mf", 3000), stored("stand.stl", 1200)] }),
    );
    expect(plan.create).toBeNull();
    expect(plan.tags).toEqual([]);
    expect(plan.collections).toEqual([]);
    expect(plan.files.every((f) => f.action === "present")).toBe(true);
  });
});

// The limits POST /api/v1/models and the tag and collection PUTs enforce
// (apps/server/src/api/v1.ts NEW_MODEL and LABEL). One value over a limit
// would get the whole create refused with 400 on every run, so the planner
// leaves that value out with a reason and keeps the rest of the model.
describe("Platehouse's limits", () => {
  it("leaves out a caption, description, creator or licence over its limit, and keeps the rest", () => {
    const plan = planModel(
      source({
        caption: "c".repeat(2001),
        description: "d".repeat(200_001),
        creator: "m".repeat(301),
        license: "l".repeat(201),
      }),
      undefined,
    );
    expect(plan.refused).toBeNull();
    expect(plan.create).toEqual({
      name: "Benchy Stand",
      externalRef: "manyfold:abc123",
      tags: ["boat", "Calibration"],
      collections: ["Gifts"],
    });
    expect(plan.leftOut).toEqual([
      expect.stringMatching(/^caption left out: 2001 characters, Platehouse takes at most 2000$/),
      expect.stringMatching(/^description left out: 200001 characters, .* at most 200000$/),
      expect.stringMatching(/^creator left out: 301 characters, .* at most 300$/),
      expect.stringMatching(/^licence left out: 201 characters, .* at most 200$/),
    ]);
  });

  it("keeps values exactly at each limit", () => {
    const plan = planModel(
      source({
        name: "n".repeat(500),
        caption: "c".repeat(2000),
        creator: "m".repeat(300),
        license: "l".repeat(200),
        tags: ["t".repeat(100)],
      }),
      undefined,
    );
    expect(plan.refused).toBeNull();
    expect(plan.leftOut).toEqual([]);
    expect(plan.create).toMatchObject({ caption: "c".repeat(2000), tags: ["t".repeat(100)] });
  });

  it("counts characters in the create body as the server's validator does, by code point", () => {
    const tag = "\u{1F6A2}".repeat(100); // 100 code points, 200 UTF-16 units
    const plan = planModel(source({ tags: [tag] }), undefined);
    expect(plan.create?.tags).toEqual([tag]);
    expect(plan.leftOut).toEqual([]);
  });

  it("leaves out a tag or collection over 100 characters, with the reason", () => {
    const plan = planModel(
      source({ tags: ["boat", "t".repeat(101)], collections: ["g".repeat(150), "Gifts"] }),
      undefined,
    );
    expect(plan.create?.tags).toEqual(["boat"]);
    expect(plan.create?.collections).toEqual(["Gifts"]);
    expect(plan.leftOut).toEqual([
      expect.stringMatching(/^tag t{40}\.\.\. left out: 101 characters, .* at most 100$/),
      expect.stringMatching(/^collection g{40}\.\.\. left out: 150 characters, .* at most 100$/),
    ]);
  });

  it("sends 100 tags and 100 collections in the create, and adds the rest with PUTs", () => {
    // NEW_MODEL's maxItems caps only the create body; the tag and collection
    // PUTs have no per-model cap, so nothing past the first 100 is left out.
    const many = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`);
    const plan = planModel(
      source({ tags: many("t", 103), collections: many("c", 101) }),
      undefined,
    );
    expect(plan.create?.tags).toEqual(many("t", 100));
    expect(plan.create?.collections).toEqual(many("c", 100));
    expect(plan.tags).toEqual(["t100", "t101", "t102"]);
    expect(plan.collections).toEqual(["c100"]);
    expect(plan.leftOut).toEqual([]);
  });

  it("leaves out a label too long for a URL path, past the first 100 on a new model", () => {
    const many = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`);
    const wide = "\u{1F6A2}".repeat(51); // 51 code points, 102 UTF-16 units
    const plan = planModel(source({ tags: [...many("t", 100), wide, "t100"] }), undefined);
    expect(plan.create?.tags).toEqual(many("t", 100));
    expect(plan.tags).toEqual(["t100"]);
    expect(plan.leftOut).toEqual([
      expect.stringMatching(
        /^tag \u{1F6A2}{40}\.\.\. left out: 102 UTF-16 units in a URL path, .* at most 100$/u,
      ),
    ]);
  });

  it("leaves out a tag or collection an existing model lacks that is over 100 UTF-16 units", () => {
    // The tag and collection PUTs carry the label in the URL path, and
    // Platehouse's router (find-my-way maxParamLength 100) counts the decoded
    // parameter in UTF-16 units, answering 414 past 100.
    const wide = "\u{1F6A2}".repeat(51); // 51 code points, 102 UTF-16 units
    const fits = "\u{1F6A2}".repeat(50); // 100 UTF-16 units
    const plan = planModel(
      source({ tags: ["boat", wide, fits], collections: [`g${wide}`] }),
      existing(),
    );
    expect(plan.tags).toEqual([fits]);
    expect(plan.collections).toEqual([]);
    expect(plan.leftOut).toEqual([
      expect.stringMatching(/^tag .* left out: 102 UTF-16 units in a URL path, .* at most 100$/),
      expect.stringMatching(/^collection g.* left out: 103 UTF-16 units in a URL path/),
    ]);
  });

  it("refuses to make a model whose name is over 500 characters, saying why", () => {
    const plan = planModel(source({ name: "n".repeat(501) }), undefined);
    expect(plan.refused).toMatch(/^the name is 501 characters; Platehouse takes at most 500$/);
  });

  it("refuses to make a model whose externalRef would be over 300 characters", () => {
    const plan = planModel(source({ id: "i".repeat(292) }), undefined);
    expect(plan.refused).toMatch(/externalRef .* 301 characters; Platehouse takes at most 300$/);
  });

  it("does not refuse a model already in Platehouse for a long name, since none is sent", () => {
    const plan = planModel(source({ name: "n".repeat(501) }), existing());
    expect(plan.refused).toBeNull();
  });

  it("leaves out a tag or collection over 100 characters that an existing model lacks", () => {
    const plan = planModel(
      source({ tags: ["boat", "dock", "t".repeat(101)], collections: ["g".repeat(101)] }),
      existing(),
    );
    expect(plan.tags).toEqual(["dock"]);
    expect(plan.collections).toEqual([]);
    expect(plan.leftOut).toHaveLength(2);
    expect(plan.leftOut[0]).toMatch(/^tag t{40}\.\.\. left out: 101 characters/);
    expect(plan.leftOut[1]).toMatch(/^collection g{40}\.\.\. left out: 101 characters/);
  });
});

// Platehouse trims every tag and collection name before it stores or matches
// it, and matches without case (apps/server/src/repos/tags.ts tagName,
// collections.ts collectionName), so the plan compares and sends them the
// same way.
describe("tags and collections as Platehouse stores them", () => {
  it("sends a new model's padded labels trimmed, each once", () => {
    const plan = planModel(
      source({ tags: ["  boat ", "Boat", "\tCalibration\n", "   "], collections: [" Gifts "] }),
      undefined,
    );
    expect(plan.create?.tags).toEqual(["boat", "Calibration"]);
    expect(plan.create?.collections).toEqual(["Gifts"]);
  });

  it("finds nothing missing when an existing model holds the trimmed labels", () => {
    const plan = planModel(
      // "Gifts" ends in a no-break space, which String.trim strips as the
      // server's does.
      source({ tags: ["boat ", " Calibration"], collections: ["Gifts\u00a0"] }),
      existing(),
    );
    expect(plan.tags).toEqual([]);
    expect(plan.collections).toEqual([]);
    expect(plan.leftOut).toEqual([]);
  });

  it("sends a label an existing model lacks trimmed", () => {
    const plan = planModel(source({ tags: [" dock "], collections: [" Shelf "] }), existing());
    expect(plan.tags).toEqual(["dock"]);
    expect(plan.collections).toEqual(["Shelf"]);
  });

  it("measures a padded label after trimming it", () => {
    const label = `  ${"a".repeat(100)}  `;
    const plan = planModel(source({ tags: [label], collections: [] }), existing({ tags: [] }));
    expect(plan.tags).toEqual(["a".repeat(100)]);
    expect(plan.leftOut).toEqual([]);
  });
});

// A label sent by PUT rides in the URL path. "." and ".." are dot segments:
// the URL parser resolves them, %2e forms included, so the PUT would reach
// another route. They are left out with the reason rather than sent.
describe("labels that would be URL dot segments", () => {
  it("leaves out a . or .. tag or collection an existing model lacks, with the reason", () => {
    const plan = planModel(
      source({ tags: ["boat", ".", " .. ", "dock"], collections: [".."] }),
      existing(),
    );
    expect(plan.tags).toEqual(["dock"]);
    expect(plan.collections).toEqual([]);
    expect(plan.leftOut).toEqual([
      'tag . left out: a URL path cannot carry "." or ".." as a name',
      'tag .. left out: a URL path cannot carry "." or ".." as a name',
      'collection .. left out: a URL path cannot carry "." or ".." as a name',
    ]);
  });

  it("leaves out a . or .. label past a new model's first 100", () => {
    const tags = [...Array.from({ length: 100 }, (_, i) => `t${i}`), "..", "t100"];
    const plan = planModel(source({ tags }), undefined);
    expect(plan.create?.tags).toHaveLength(100);
    expect(plan.tags).toEqual(["t100"]);
    expect(plan.leftOut).toEqual([
      'tag .. left out: a URL path cannot carry "." or ".." as a name',
    ]);
  });

  it("sends a . or .. label in a new model's create body, which carries no path", () => {
    const plan = planModel(source({ tags: [".", "boat"], collections: [".."] }), undefined);
    expect(plan.create?.tags).toEqual([".", "boat"]);
    expect(plan.create?.collections).toEqual([".."]);
    expect(plan.leftOut).toEqual([]);
  });

  it("keeps a label with dots in it that is not only dots, or is three dots", () => {
    const plan = planModel(
      source({ tags: ["v1.2", "...", ".hidden"], collections: [] }),
      existing({ tags: [] }),
    );
    expect(plan.tags).toEqual(["v1.2", "...", ".hidden"]);
  });
});
