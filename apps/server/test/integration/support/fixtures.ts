// Rows the database tests build on: a model with one stored source blob, a
// .3mf file and its plates. Every value is synthetic.
import { createHash } from "node:crypto";
import type { Repos } from "../../../src/repos/index.js";

let counter = 0;

export function sha256Of(text: string): Buffer {
  return createHash("sha256").update(text).digest();
}

export async function seedFile(repos: Repos, opts: { modelId?: string } = {}) {
  counter += 1;
  const modelId =
    opts.modelId ?? (await repos.models.create({ name: `Fixture model ${counter}` })).id;
  const bytes = `fixture bytes ${counter}`;
  const blob = await repos.blobs.insertPending({
    modelId,
    kind: "source",
    contentType: "model/3mf",
  });
  await repos.blobs.markStored(blob.id, { size: bytes.length, sha256: sha256Of(bytes) });
  const file = await repos.files.create({
    modelId,
    blobId: blob.id,
    name: `Fixture ${counter}.3mf`,
    originalName: `Fixture ${counter}.3mf`,
    kind: "3mf",
    size: bytes.length,
    sha256: sha256Of(bytes),
  });
  return { modelId, blob, file };
}

export async function seedPlate(repos: Repos) {
  const { modelId, file } = await seedFile(repos);
  const plate = await repos.plates.create({ fileId: file.id, index: 1, objectCount: 2 });
  return { modelId, file, plate };
}
