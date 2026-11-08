// OpenSCAD in the built image (AC-052): renders STL and PNG headless, shows
// OpenSCAD's own message on an error, and cannot read a file outside its own
// job folder. /opt/platehouse/sandbox-probe.stl is a small STL the image
// ships for this test; the control renders the same import without landrun,
// so the refusal is the sandbox's and not a missing file.
import { slicerContract } from "@platehouse/slicer-contract";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type RunningSlicer, startSlicer } from "./support/slicer.js";

let slicer: RunningSlicer;
beforeAll(async () => {
  slicer = await startSlicer();
});
afterAll(() => slicer?.stop());

const PROBE = "/opt/platehouse/sandbox-probe.stl";

function post(path: string, body: string) {
  return fetch(`${slicer.base}${path}`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body,
  });
}

describe("OpenSCAD in the image", () => {
  test("a cube renders to STL", async () => {
    const res = await post("/v1/scad/stl", "cube([10, 10, 10]);\n");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("model/stl");
    expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(84);
  });

  test("a cube renders to PNG", async () => {
    const res = await post("/v1/scad/png", "cube([10, 10, 10]);\n");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  test("scad render error returns OpenSCAD's message", async () => {
    const res = await post("/v1/scad/stl", "cube([10, 10, 10]\n");
    expect(res.status).toBe(422);
    const body = slicerContract.renderError.parse(await res.json());
    expect(body.message).toMatch(/error/i);
  });

  test("scad import of a file outside its own directory fails (AC-052)", async () => {
    const res = await post("/v1/scad/stl", `import("${PROBE}");\n`);
    expect(res.status).toBe(422);
    slicerContract.renderError.parse(await res.json());
  });

  test("control: the same import without landrun renders, so landrun is what blocks it", () => {
    const r = slicer.exec([
      "sh",
      "-c",
      `d=$(mktemp -d /work/control-XXXXXX) && printf 'import("${PROBE}");\\n' > "$d/in.scad" && HOME="$d" /opt/openscad/AppRun --backend=manifold -o "$d/out.stl" "$d/in.scad" && test -s "$d/out.stl"`,
    ]);
    expect(r.code, r.stderr).toBe(0);
  });
});
