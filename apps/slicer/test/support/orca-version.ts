// The Orca version the slicer image under test was built with, for the
// container tests to check against what it reports. slicer-image.yml builds
// whichever OrcaSlicer release it picked and exports that version as
// EXPECTED_ORCA_VERSION; elsewhere (ci.yml, a local run) the image is built
// at the Dockerfile's own pin, its ARG ORCA_VERSION= line.
import { readFileSync } from "node:fs";

/** The version apps/slicer/Dockerfile pins (ARG ORCA_VERSION=). */
export function dockerfileOrcaVersion(): string {
  const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
  const pin = /^ARG ORCA_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
  if (pin === undefined) throw new Error("apps/slicer/Dockerfile has no ARG ORCA_VERSION= line");
  return pin;
}

/** EXPECTED_ORCA_VERSION when set and not empty, else the Dockerfile's pin. */
export function expectedOrcaVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env.EXPECTED_ORCA_VERSION || dockerfileOrcaVersion();
}
