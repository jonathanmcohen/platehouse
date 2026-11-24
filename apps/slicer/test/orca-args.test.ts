// orcaArgs on its own: the first slice's arguments are fixed, and the
// re-arranged retry adds exactly --arrange 1 right before the input.
import { describe, expect, test } from "vitest";
import { type OrcaJob, orcaArgs } from "../src/orca.js";

const JOB: OrcaJob = {
  plate: 2,
  mstpp: 120,
  dataDir: "/j/orca/data",
  outDir: "/j/orca/out",
  machineFile: "/p/machine.json",
  filamentFiles: ["/p/a.json", ""],
  input: "/j/orca/input.3mf",
};

describe("orcaArgs", () => {
  test("without arrange the arguments are the first slice's, exactly", () => {
    expect(orcaArgs(JOB)).toEqual([
      "--datadir",
      "/j/orca/data",
      "--slice",
      "2",
      "--export-statistics",
      "--mstpp",
      "120",
      "--allow-newer-file",
      "--outputdir",
      "/j/orca/out",
      "--load-settings",
      "/p/machine.json",
      "--load-filaments",
      "/p/a.json;",
      "/j/orca/input.3mf",
    ]);
  });

  test("arrange false is the same as no arrange", () => {
    expect(orcaArgs({ ...JOB, arrange: false })).toEqual(orcaArgs(JOB));
  });

  test("arrange true adds --arrange 1 right before the input and nothing else", () => {
    const plain = orcaArgs(JOB);
    const arranged = orcaArgs({ ...JOB, arrange: true });
    expect(arranged).toEqual([...plain.slice(0, -1), "--arrange", "1", "/j/orca/input.3mf"]);
    expect(arranged).not.toContain("--orient");
    expect(arranged).not.toContain("--allow-rotations");
  });

  test("arrange true with no filament files still puts --arrange 1 before the input", () => {
    const args = orcaArgs({ ...JOB, filamentFiles: ["", ""], arrange: true });
    expect(args.slice(-3)).toEqual(["--arrange", "1", "/j/orca/input.3mf"]);
    expect(args).not.toContain("--load-filaments");
  });
});
