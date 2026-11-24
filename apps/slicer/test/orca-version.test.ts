// The Orca version the container tests expect the image to report: the one
// slicer-image.yml built (EXPECTED_ORCA_VERSION), else the Dockerfile's pin,
// which is what ci.yml and a local run build.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { dockerfileOrcaVersion, expectedOrcaVersion } from "./support/orca-version.js";

describe("the expected Orca version", () => {
  test("the Dockerfile's pin is its ARG ORCA_VERSION= line", () => {
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    const line = dockerfile.split("\n").find((l) => l.startsWith("ARG ORCA_VERSION="));
    expect(dockerfileOrcaVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(line).toBe(`ARG ORCA_VERSION=${dockerfileOrcaVersion()}`);
  });

  test("is EXPECTED_ORCA_VERSION when it is set", () => {
    expect(expectedOrcaVersion({ EXPECTED_ORCA_VERSION: "9.8.7" })).toBe("9.8.7");
  });

  test("is the Dockerfile's pin when EXPECTED_ORCA_VERSION is unset or empty", () => {
    expect(expectedOrcaVersion({})).toBe(dockerfileOrcaVersion());
    expect(expectedOrcaVersion({ EXPECTED_ORCA_VERSION: "" })).toBe(dockerfileOrcaVersion());
  });
});
