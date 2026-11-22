// STL previews in the built image (issue #316): POST /v1/stl/png renders a
// PNG of an STL with the image's OpenSCAD, through the same landrun sandbox,
// prlimit limits and time cap as a .scad render. The STLs are made here from
// synthetic coordinates; no designer file is read.
import { slicerContract } from "@platehouse/slicer-contract";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type RunningSlicer, startSlicer } from "./support/slicer.js";

let slicer: RunningSlicer;
beforeAll(async () => {
  slicer = await startSlicer();
});
afterAll(() => slicer?.stop());

type Triangle = [number[], number[], number[]];

/** The 12 triangles of an axis-aligned cube of side `size`, wound outwards. */
function cube(size: number): Triangle[] {
  const p = (x: number, y: number, z: number) => [x * size, y * size, z * size];
  const quads = [
    [p(0, 0, 0), p(0, 1, 0), p(1, 1, 0), p(1, 0, 0)],
    [p(0, 0, 1), p(1, 0, 1), p(1, 1, 1), p(0, 1, 1)],
    [p(0, 0, 0), p(1, 0, 0), p(1, 0, 1), p(0, 0, 1)],
    [p(0, 1, 0), p(0, 1, 1), p(1, 1, 1), p(1, 1, 0)],
    [p(0, 0, 0), p(0, 0, 1), p(0, 1, 1), p(0, 1, 0)],
    [p(1, 0, 0), p(1, 1, 0), p(1, 1, 1), p(1, 0, 1)],
  ];
  return quads.flatMap(([a, b, c, d]) => [[a, b, c] as Triangle, [a, c, d] as Triangle]);
}

function binaryStl(triangles: Triangle[]): Buffer {
  const b = Buffer.alloc(84 + 50 * triangles.length);
  b.write("platehouse container test", 0, "latin1");
  b.writeUInt32LE(triangles.length, 80);
  triangles.forEach((t, i) => {
    const at = 84 + i * 50 + 12;
    t.flat().forEach((v, k) => {
      b.writeFloatLE(v, at + k * 4);
    });
  });
  return b;
}

function asciiStl(triangles: Triangle[]): string {
  const facets = triangles.map(
    (t) =>
      `facet normal 0 0 0\n outer loop\n${t.map((v) => `  vertex ${v.join(" ")}\n`).join("")} endloop\nendfacet\n`,
  );
  return `solid test\n${facets.join("")}endsolid test\n`;
}

function preview(body: Buffer | string) {
  return fetch(`${slicer.base}/v1/stl/png`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body,
  });
}

async function statusOf(res: Response): Promise<string> {
  if (res.status === 200) return "200";
  return `${res.status} ${await res.clone().text()}`;
}

const PNG_MAGIC = "89504e470d0a1a0a";

describe("STL previews in the image", () => {
  test("a binary STL renders to a PNG", async () => {
    const res = await preview(binaryStl(cube(20)));
    expect(await statusOf(res)).toBe("200");
    expect(res.headers.get("content-type")).toBe("image/png");
    const png = Buffer.from(await res.arrayBuffer());
    expect(png.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC);
    // 800 x 800, as the .scad preview: the IHDR width and height.
    expect(png.readUInt32BE(16)).toBe(800);
    expect(png.readUInt32BE(20)).toBe(800);
  });

  test("an ASCII STL renders to a PNG", async () => {
    const res = await preview(asciiStl(cube(5)));
    expect(await statusOf(res)).toBe("200");
    const png = Buffer.from(await res.arrayBuffer());
    expect(png.subarray(0, 8).toString("hex")).toBe(PNG_MAGIC);
  });

  // The first preview in this container ran the self-test, exactly as the
  // first .scad render does in scad.test.ts.
  test("the sandbox self-test passed before the first preview", () => {
    const line = slicer
      .logs()
      .split("\n")
      .find((l) => l.includes("sandbox self-test:"));
    expect(line).toMatch(/sandbox self-test: ok: Landlock ABI \d+/);
  });

  test("a body that is not an STL is 422 render_failed with OpenSCAD's own words", async () => {
    const res = await preview("this is not an STL file\n");
    expect(res.status).toBe(422);
    const body = slicerContract.renderError.parse(await res.json());
    expect(body.error).toBe("render_failed");
    expect(body.message.length).toBeGreaterThan(0);
    // OpenSCAD answered, not the sandbox: renders are still on.
    expect(body.message).not.toMatch(/renders are off/);
  });

  test("the job folder is gone after each preview", () => {
    const r = slicer.exec(["sh", "-c", "ls /work | grep -E '^[0-9a-f]{8}-[0-9a-f]{4}-' || true"]);
    expect(r.stdout.trim()).toBe("");
  });
});
