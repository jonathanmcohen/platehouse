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
