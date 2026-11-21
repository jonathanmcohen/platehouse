// A small synthetic Manyfold library: three models over two list pages, two
// creators, two collections, five files (one a type Platehouse does not
// take). The bytes are generated, not anyone's design.
import { createHash } from "node:crypto";
import { bytesOf, type StubData } from "./manyfold-stub.js";

export function library(): StubData {
  return {
    creators: [
      { id: "c1", name: "Maker One" },
      { id: "c2", name: "Second Maker" },
    ],
    collections: [
      { id: "col1", name: "Calibration" },
      { id: "col2", name: "Gifts" },
    ],
    models: [
      {
        id: "m1",
        name: "Benchy Stand",
        caption: "A stand for a benchy",
        description: "Print it **flat**.",
        creatorId: "c1",
        license: "CC-BY-4.0",
        keywords: ["boat", "calibration"],
        collectionIds: ["col1", "col2"],
        files: [
          { id: "f1", filename: "benchy.3mf", bytes: bytesOf("f1", 3000) },
          {
            id: "f2",
            filename: "stand.stl",
            encodingFormat: "model/stl",
            bytes: bytesOf("f2", 1200),
          },
        ],
      },
      {
        id: "m2",
        name: "Cable Clip",
        collectionIds: ["col1"],
        files: [
          { id: "f3", filename: "clip.3mf", bytes: bytesOf("f3", 800) },
          {
            id: "f4",
            filename: "photo.png",
            encodingFormat: "image/png",
            bytes: bytesOf("f4", 50),
          },
        ],
      },
      {
        id: "m3",
        name: "Air Dry Box",
        creatorId: "c2",
        keywords: ["filament"],
        files: [{ id: "f5", filename: "air-dry.3mf", bytes: bytesOf("f5", 5000) }],
      },
    ],
  };
}

/** sha256 hex of a fixture file's bytes, worked out here, not by the importer. */
export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
