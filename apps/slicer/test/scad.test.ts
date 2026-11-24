// stlProblem: the check /v1/stl/png makes before OpenSCAD runs. An ASCII STL
// starts with "solid" and a name, and a name may run straight on from the
// word, as CAD exporters write it (solid_Body1).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { NOT_AN_STL, STL_INPUT, stlProblem } from "../src/scad.js";

const dirs: string[] = [];

function jobWith(body: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "stl-problem-"));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, STL_INPUT), body);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const FACET =
  "facet normal 0 0 1\n outer loop\n  vertex 0 0 0\n  vertex 1 0 0\n  vertex 0 1 0\n endloop\nendfacet\n";

describe("stlProblem", () => {
  test("accepts an ASCII STL whose name runs on from the word solid", () => {
    expect(stlProblem(jobWith(`solid_Body1\n${FACET}endsolid_Body1\n`))).toBeNull();
  });

  test("accepts an ASCII STL with a spaced name", () => {
    expect(stlProblem(jobWith(`solid cube\n${FACET}endsolid cube\n`))).toBeNull();
  });

  test("accepts an ASCII STL with no name", () => {
    expect(stlProblem(jobWith(`solid\n${FACET}endsolid\n`))).toBeNull();
  });

  test("refuses an ASCII STL with no facet", () => {
    expect(stlProblem(jobWith("solid_Body1\nendsolid_Body1\n"))).toBe(NOT_AN_STL);
  });

  test("refuses text that does not start with solid", () => {
    expect(stlProblem(jobWith(`cube\n${FACET}`))).toBe(NOT_AN_STL);
  });
});
