// buildSliceable (build plan Task 11): a generated multi-plate,
// multi-filament Bambu project of simple cubes that OrcaSlicer can slice. It
// is the fixture for the slicer's container tests and the AC-037 smoke slice;
// no designer file is involved. Orca itself is only in the slicer image, so
// these tests check the file's shape against what Orca 2.5.0's 3MF loader
// reads (src/libslic3r/Format/bbs_3mf.cpp at 40ecc66); the container tests
// prove Orca slices it.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { readProject } from "../src/index.js";
import {
  buildSliceable,
  plateOrigin,
  SLICEABLE_PRINTER,
  sliceableEntries,
} from "./support/sliceable.js";

function save(buf: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "sliceable-"));
  const file = join(dir, "sliceable.3mf");
  writeFileSync(file, buf);
  return file;
}

describe("buildSliceable", () => {
  test("two plates and two filaments read back as a Bambu project", async () => {
    const project = await readProject(save(buildSliceable({ plates: 2, filaments: 2 })));
    expect(project).not.toBeNull();
    expect(project?.plates.map((p) => p.index)).toEqual([1, 2]);
    expect(project?.plates.map((p) => p.objectCount)).toEqual([2, 2]);
    expect(project?.plates.every((p) => !p.sliced)).toBe(true);
    expect(project?.projectFilaments.map((f) => [f.slot, f.type])).toEqual([
      [1, "PLA"],
      [2, "PLA"],
    ]);
    expect(project?.projectFilaments.map((f) => f.colour)).toEqual(["#FFFFFF", "#1F1F1F"]);
    expect(project?.processName).toBe("0.20mm Standard @BBL X1C");
  });

  test("plate and filament counts follow the options", async () => {
    const project = await readProject(save(buildSliceable({ plates: 3, filaments: 1 })));
    expect(project?.plates.map((p) => p.objectCount)).toEqual([1, 1, 1]);
    expect(project?.projectFilaments).toHaveLength(1);
  });

  test("the project is saved for the P1S 0.4 nozzle, so slicing it there switches nothing", () => {
    const entries = sliceableEntries({ plates: 2, filaments: 2 });
    const settings = JSON.parse(entries.get("Metadata/project_settings.config") ?? "{}");
    expect(SLICEABLE_PRINTER).toBe("Bambu Lab P1S 0.4 nozzle");
    expect(settings.printer_settings_id).toBe(SLICEABLE_PRINTER);
    expect(settings.printer_model).toBe("Bambu Lab P1S");
    expect(settings.filament_settings_id).toHaveLength(2);
    expect(settings.filament_type).toEqual(["PLA", "PLA"]);
    // Orca's 3MF loader marks a file as a Bambu project only from this tag.
    const model = entries.get("3D/3dmodel.model") ?? "";
    expect(model).toMatch(/<metadata name="Application">BambuStudio-[\d.]+<\/metadata>/);
  });

  test("every cube sits inside its own plate's bed, where Orca's plate grid puts it", () => {
    const entries = sliceableEntries({ plates: 3, filaments: 2 });
    const model = entries.get("3D/3dmodel.model") ?? "";
    const settings = entries.get("Metadata/model_settings.config") ?? "";
    const items = [...model.matchAll(/<item objectid="(\d+)" transform="([^"]+)"/g)].map((m) => ({
      id: Number(m[1]),
      x: Number(m[2]?.split(" ")[9]),
      y: Number(m[2]?.split(" ")[10]),
    }));
    expect(items).toHaveLength(6);
    const plates = [...settings.matchAll(/<plate>([\s\S]*?)<\/plate>/g)].map((m) => m[1] ?? "");
    expect(plates).toHaveLength(3);
    plates.forEach((block, i) => {
      const origin = plateOrigin(i, 3);
      const ids = [...block.matchAll(/key="object_id" value="(\d+)"/g)].map((m) => Number(m[1]));
      expect(ids).toHaveLength(2);
      for (const id of ids) {
        const item = items.find((it) => it.id === id);
        expect(item, `object ${id}`).toBeDefined();
        expect(item?.x).toBeGreaterThanOrEqual(origin.x + 20);
        expect(item?.x).toBeLessThanOrEqual(origin.x + 256 - 40);
        expect(item?.y).toBeGreaterThanOrEqual(origin.y + 20);
        expect(item?.y).toBeLessThanOrEqual(origin.y + 256 - 40);
      }
    });
  });

  test("Orca's plate grid: columns are the rounded-up square root, stride is 1.2 beds", () => {
    // PartPlate.hpp compute_colum_count and PartPlate.cpp compute_shape_position.
    expect(plateOrigin(0, 1)).toEqual({ x: 0, y: 0 });
    expect(plateOrigin(1, 2)).toEqual({ x: 256 * 1.2, y: 0 });
    expect(plateOrigin(2, 3)).toEqual({ x: 0, y: -256 * 1.2 });
    expect(plateOrigin(3, 4)).toEqual({ x: 256 * 1.2, y: -256 * 1.2 });
    expect(plateOrigin(4, 5)).toEqual({ x: 256 * 2.4, y: 0 });
  });

  test("each cube uses the filament it is assigned, one per filament on every plate", () => {
    const entries = sliceableEntries({ plates: 2, filaments: 2 });
    const settings = entries.get("Metadata/model_settings.config") ?? "";
    const extruders = [...settings.matchAll(/key="extruder" value="(\d+)"/g)].map((m) => m[1]);
    expect(extruders).toEqual(["1", "2", "1", "2"]);
  });

  test("options outside 1 to 128 plates or 1 to 16 filaments are refused", () => {
    expect(() => buildSliceable({ plates: 0, filaments: 1 })).toThrow(/plates/);
    expect(() => buildSliceable({ plates: 129, filaments: 1 })).toThrow(/plates/);
    expect(() => buildSliceable({ plates: 1, filaments: 0 })).toThrow(/filaments/);
    expect(() => buildSliceable({ plates: 1, filaments: 17 })).toThrow(/filaments/);
  });
});
