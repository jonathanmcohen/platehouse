// Names from file titles: the models repository's rules for when a model may
// be renamed from its .3mf's title (models.name_source, migration 0005), and
// the one-off "Use file titles" backfill's preview and its skip rules.
// Against a migrated Postgres 17; every name here is made up.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { migrate } from "../../../src/db/migrate.js";
import type { NameSource } from "../../../src/db/types.js";
import { createRename } from "../../../src/library/rename.js";
import { createRepos, type Repos } from "../../../src/repos/index.js";
import {
  sqlState,
  startTestPostgres,
  type TestDatabase,
  type TestPostgres,
} from "../support/db.js";
import { sha256Of } from "../support/fixtures.js";

let pgc: TestPostgres;

beforeAll(async () => {
  pgc = await startTestPostgres();
});

afterAll(async () => {
  await pgc?.stop();
});

/** A fresh migrated database, so a test's counts are its own. */
async function freshRepos(): Promise<{ t: TestDatabase; repos: Repos }> {
  const t = await pgc.freshDatabase();
  await migrate(t.db);
  return { t, repos: createRepos(t.db) };
}

let fileCounter = 0;

/** A model with one source file of the given original name. */
async function modelWithFile(
  repos: Repos,
  input: {
    name: string;
    nameSource?: NameSource;
    caption?: string | null;
    externalRef?: string;
    file: string;
  },
) {
  const model = await repos.models.create({
    name: input.name,
    nameSource: input.nameSource ?? "file",
    caption: input.caption ?? null,
    externalRef: input.externalRef ?? null,
  });
  await addFile(repos, model.id, input.file);
  return model;
}

async function addFile(repos: Repos, modelId: string, originalName: string) {
  fileCounter += 1;
  const bytes = `title-names bytes ${fileCounter}`;
  const blob = await repos.blobs.insertPending({
    modelId,
    kind: "source",
    contentType: "model/3mf",
  });
  await repos.blobs.markStored(blob.id, { size: bytes.length, sha256: sha256Of(bytes) });
  await repos.files.create({
    modelId,
    blobId: blob.id,
    name: originalName,
    originalName,
    kind: "3mf",
    size: bytes.length,
    sha256: sha256Of(bytes),
  });
}

describe("models.name_source (0005)", () => {
  test("a model made without one is named by a person; ingest says file or title", async () => {
    const { repos } = await freshRepos();
    expect((await repos.models.create({ name: "Given by an API client" })).nameSource).toBe("user");
    expect(
      (await repos.models.create({ name: "From a file", nameSource: "file" })).nameSource,
    ).toBe("file");
    expect(
      (await repos.models.create({ name: "From a title", nameSource: "title" })).nameSource,
    ).toBe("title");
  });

  test("the schema refuses any other source and any design id that is not digits", async () => {
    const { t, repos } = await freshRepos();
    const model = await repos.models.create({ name: "Checked" });
    expect(
      await sqlState(
        t.db
          .updateTable("models")
          .set({ nameSource: "robot" as NameSource })
          .where("id", "=", model.id)
          .execute(),
      ),
    ).toBe("23514");
    for (const bad of ["https://evil.example/", "0123", "12a", "", "1234567890123456"]) {
      expect(
        await sqlState(
          t.db
            .updateTable("models")
            .set({ makerworldDesignId: bad })
            .where("id", "=", model.id)
            .execute(),
        ),
        bad,
      ).toBe("23514");
    }
  });

  test("a rename through the app makes the name the user's", async () => {
    const { t, repos } = await freshRepos();
    const model = await modelWithFile(repos, { name: "Desk clip", file: "Desk_clip.3mf" });
    expect(await createRename(t.db).renameModel(model.id, "My desk clip")).toBe(true);
    expect(await repos.models.get(model.id)).toMatchObject({
      name: "My desk clip",
      nameSource: "user",
    });
  });
});

describe("models.nameFromTitle", () => {
  test("renames a model still named after one of its files", async () => {
    const { repos } = await freshRepos();
    const cleaned = await modelWithFile(repos, { name: "Desk clip", file: "Desk_clip.3mf" });
    const raw = await modelWithFile(repos, { name: "Desk_hook", file: "Desk_hook.3mf" });
    expect(await repos.models.nameFromTitle(cleaned.id, "Desk Clip | Snap Fit")).toBe(true);
    expect(await repos.models.nameFromTitle(raw.id, "Desk Hook")).toBe(true);
    expect(await repos.models.get(cleaned.id)).toMatchObject({
      name: "Desk Clip | Snap Fit",
      nameSource: "title",
    });
    expect((await repos.models.get(raw.id))?.name).toBe("Desk Hook");
  });

  test("never overwrites a name the user set", async () => {
    const { t, repos } = await freshRepos();
    const model = await modelWithFile(repos, { name: "Desk clip", file: "Desk_clip.3mf" });
    await createRename(t.db).renameModel(model.id, "Desk clip");
    expect(await repos.models.nameFromTitle(model.id, "Desk Clip | Snap Fit")).toBe(false);
    expect((await repos.models.get(model.id))?.name).toBe("Desk clip");
  });

  test("leaves a name that is none of its files' names (set before name_source existed)", async () => {
    const { repos } = await freshRepos();
    const model = await modelWithFile(repos, { name: "Hand-picked name", file: "Desk_clip.3mf" });
    expect(await repos.models.nameFromTitle(model.id, "Desk Clip | Snap Fit")).toBe(false);
    expect((await repos.models.get(model.id))?.name).toBe("Hand-picked name");
  });

  test("leaves a model already named from a title", async () => {
    const { repos } = await freshRepos();
    const model = await modelWithFile(repos, {
      name: "First title",
      nameSource: "title",
      file: "First.3mf",
    });
    expect(await repos.models.nameFromTitle(model.id, "Second title")).toBe(false);
    expect((await repos.models.get(model.id))?.name).toBe("First title");
  });

  test("cuts a very long title at the API's 500-character limit", async () => {
    const { repos } = await freshRepos();
    const model = await modelWithFile(repos, { name: "Long", file: "Long.3mf" });
    expect(await repos.models.nameFromTitle(model.id, "L".repeat(900))).toBe(true);
    expect((await repos.models.get(model.id))?.name).toBe("L".repeat(500));
  });

  test("a blank title, a trashed or an unknown model changes nothing", async () => {
    const { repos } = await freshRepos();
    const model = await modelWithFile(repos, { name: "Blank", file: "Blank.3mf" });
    expect(await repos.models.nameFromTitle(model.id, "   ")).toBe(false);
    await repos.models.trash(model.id);
    expect(await repos.models.nameFromTitle(model.id, "A title")).toBe(false);
    expect((await repos.models.get(model.id, { includeTrashed: true }))?.name).toBe("Blank");
    expect(await repos.models.nameFromTitle("0198f0c4-0000-7000-8000-00000000abcd", "A")).toBe(
      false,
    );
    expect(await repos.models.nameFromTitle("not-a-uuid", "A")).toBe(false);
  });
});

describe("the Use file titles backfill", () => {
  async function library() {
    const env = await freshRepos();
    const { repos } = env;
    const m = {
      // Renamed: still named after its file, and its file had a title.
      raw: await modelWithFile(repos, {
        name: "Spool_holder_wall",
        caption: "Wall Spool Holder | Screwless",
        file: "Spool_holder_wall.3mf",
      }),
      cleaned: await modelWithFile(repos, {
        name: "Cable clip PETG",
        caption: "Cable Clip for Desks",
        file: "Cable_clip_PETG.3mf",
      }),
      // Skipped: the user renamed it.
      user: await modelWithFile(repos, {
        name: "My bin",
        nameSource: "user",
        caption: "Gridfinity Bin 2x3",
        file: "bin.3mf",
      }),
      // Skipped: already named from its title.
      titled: await modelWithFile(repos, {
        name: "Hook Rail",
        nameSource: "title",
        caption: "Hook Rail",
        file: "hook.3mf",
      }),
      // Skipped: no title.
      untitled: await modelWithFile(repos, { name: "Plain part", file: "Plain_part.stl" }),
      // Skipped: the title is the name it already has.
      same: await modelWithFile(repos, { name: "Knob", caption: "Knob", file: "Knob.3mf" }),
      // Skipped: its name is none of its files' names, so a person chose it.
      chosen: await modelWithFile(repos, {
        name: "Drawer divider (kitchen)",
        caption: "Drawer Divider Set",
        file: "drawer_divider.3mf",
      }),
      // Skipped: imported from Manyfold before 0005, so name_source is
      // 'file' and its caption is Manyfold's own, copied as written, not
      // its .3mf's title, though its name matches its file's cleaned name.
      imported: await modelWithFile(repos, {
        name: "Desk cable clip",
        caption: "A clip that holds two cables under any desk edge up to 30 mm thick.",
        externalRef: "manyfold:abc123",
        file: "Desk_cable_clip.3mf",
      }),
      // Not counted at all: in the trash.
      trashed: await modelWithFile(repos, {
        name: "Old_thing",
        caption: "Old Thing",
        file: "Old_thing.3mf",
      }),
    };
    await repos.models.trash(m.trashed.id);
    return { ...env, m };
  }

  test("the preview lists what would change and counts every skip by reason, changing nothing", async () => {
    const { repos, m } = await library();
    const plan = await repos.models.titleNamePlan();
    expect(plan.renames).toEqual([
      { id: m.cleaned.id, from: "Cable clip PETG", to: "Cable Clip for Desks" },
      { id: m.raw.id, from: "Spool_holder_wall", to: "Wall Spool Holder | Screwless" },
    ]);
    expect(plan.skipped).toEqual({
      renamedByUser: 1,
      namedFromTitle: 1,
      noTitle: 1,
      sameName: 1,
      nameNotFromFile: 1,
      imported: 1,
    });
    expect(plan.planId).toMatch(/^[0-9a-f]{64}$/);
    expect((await repos.models.titleNamePlan()).planId).toBe(plan.planId);
    expect((await repos.models.get(m.raw.id))?.name).toBe("Spool_holder_wall");
    expect((await repos.models.get(m.imported.id))?.name).toBe("Desk cable clip");
  });

  test("applying renames exactly the previewed models and marks them named from their title", async () => {
    const { repos, m } = await library();
    const { planId } = await repos.models.titleNamePlan();
    expect(await repos.models.applyTitleNames(planId)).toEqual({ renamed: 2 });
    expect(await repos.models.get(m.raw.id)).toMatchObject({
      name: "Wall Spool Holder | Screwless",
      nameSource: "title",
    });
    expect((await repos.models.get(m.cleaned.id))?.name).toBe("Cable Clip for Desks");
    expect((await repos.models.get(m.user.id))?.name).toBe("My bin");
    expect((await repos.models.get(m.chosen.id))?.name).toBe("Drawer divider (kitchen)");
    expect((await repos.models.get(m.imported.id))?.name).toBe("Desk cable clip");
    expect((await repos.models.get(m.untitled.id))?.name).toBe("Plain part");
    expect((await repos.models.get(m.trashed.id, { includeTrashed: true }))?.name).toBe(
      "Old_thing",
    );
    // A second run finds nothing left to do.
    const again = await repos.models.titleNamePlan();
    expect(again.renames).toEqual([]);
    expect(await repos.models.applyTitleNames(again.planId)).toEqual({ renamed: 0 });
  });

  test("a rename made after the preview wins, and the stale preview renames nothing", async () => {
    const { t, repos, m } = await library();
    const plan = await repos.models.titleNamePlan();
    expect(plan.renames).toHaveLength(2);
    await createRename(t.db).renameModel(m.raw.id, "Jon's spool holder");
    expect(await repos.models.applyTitleNames(plan.planId)).toBeNull();
    expect((await repos.models.get(m.raw.id))?.name).toBe("Jon's spool holder");
    expect((await repos.models.get(m.cleaned.id))?.name).toBe("Cable clip PETG");
  });

  test("a model that comes to qualify after the preview is never renamed by it", async () => {
    const { repos, m } = await library();
    const plan = await repos.models.titleNamePlan();
    expect(plan.renames).toHaveLength(2);
    // A file whose name is the hand-picked name's stem joins the model, so
    // the model now looks named after a file, though the preview left it.
    await addFile(repos, m.chosen.id, "Drawer divider (kitchen).3mf");
    expect((await repos.models.titleNamePlan()).renames).toHaveLength(3);
    expect(await repos.models.applyTitleNames(plan.planId)).toBeNull();
    expect((await repos.models.get(m.chosen.id))?.name).toBe("Drawer divider (kitchen)");
    expect((await repos.models.get(m.raw.id))?.name).toBe("Spool_holder_wall");
  });

  test("a plan id that is not the current plan's renames nothing", async () => {
    const { repos, m } = await library();
    expect(await repos.models.applyTitleNames("0".repeat(64))).toBeNull();
    expect(await repos.models.applyTitleNames("")).toBeNull();
    expect((await repos.models.get(m.raw.id))?.name).toBe("Spool_holder_wall");
  });

  test("a title over the limit is previewed and applied cut to 500 characters", async () => {
    const { repos } = await freshRepos();
    const model = await modelWithFile(repos, {
      name: "Long_one",
      caption: `${"Very long title ".repeat(60)}end`,
      file: "Long_one.3mf",
    });
    const plan = await repos.models.titleNamePlan();
    const [rename] = plan.renames;
    expect(rename?.to.length).toBeLessThanOrEqual(500);
    expect(await repos.models.applyTitleNames(plan.planId)).toEqual({ renamed: 1 });
    expect((await repos.models.get(model.id))?.name).toBe(rename?.to);
  });

  test("search answers a renamed model under its new name at once", async () => {
    const { repos, m } = await library();
    await repos.models.applyTitleNames((await repos.models.titleNamePlan()).planId);
    const found = await repos.models.search({ q: "Spool Holder" });
    expect(found.map((x) => [x.id, x.name])).toEqual([[m.raw.id, "Wall Spool Holder | Screwless"]]);
  });
});
