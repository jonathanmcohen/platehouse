# Slicing gate (build plan Task 1)

This is a one-off test, not product code. Before any Platehouse feature is
built, it proves that the OrcaSlicer 2.5.0 command-line slicer can slice Jon's
real Bambu Studio files headless, in a locked-down container, and gives
numbers good enough to show. It also measures what the production slicer
container needs (CPU, memory, time per plate, scratch space) and checks the
OpenSCAD, landrun and STEP pieces the slicer image will carry.

It runs on Hades only, by platform-sre (T1b), after Jon approves it. Designer
files go from mini01 to Hades over scp and never to GitHub. When the report is
collected, the scratch dir and the image are deleted.

If the gate fails, the build plan stops and goes back to Jon with Kiri:Moto as
the fallback.

## Files

| File | Runs on | What it does |
|---|---|---|
| `select-sample.mjs` | mini01 | Reads each .3mf's metadata read-only and picks the sample. Prints names and reasons, never contents. |
| `flatten-profiles.mjs` | the image | Flattens Orca's BBL machine and filament profiles through `inherits` into full JSON for `--load-settings` and `--load-filaments`, and writes the recipe. |
| `gate.mjs` | the image | The driver: `plan`, `slice <id>`, `checks`, `report`. |
| `lib/` | both | Zip and 3MF metadata reader, printer ids, result classifier, GLB writer. |
| `Dockerfile` | Hades | The throwaway gate image. Every download is pinned and sha256-checked. |
| `check-libs.sh` | the image | Build-time check: fails the build when ldd fails on a binary or reports a missing shared library. |
| `run.sh` | Hades | Builds the image, runs every plate in its own container, then the checks and the report. `--clean` deletes everything. |
| `test/` | anywhere | `node --test 'tools/slicing-gate/test/**/*.test.mjs'` (Node 26, no install step). |

## The sample rule

`select-sample.mjs` reads `Metadata/slice_info.config` (per-plate
`printer_model_id`, `nozzle_diameters`, `prediction`, `weight`), the plate
list, and the printer keys in `Metadata/project_settings.config`. Files are
taken in name order:

- 5 files already sliced for the P1S;
- 5 unsliced files (no plate carries Bambu's numbers), not counting
  `Air Dry - AMS.3mf`, which is its own item below;
- one file each sliced for the X1C, A1, A1 mini, P1P, P2S and X2D. When no file
  is sliced for one of these, it takes an unsliced file whose
  `project_settings.config` names that printer, says so in the reason, and
  lists the gap under "Not found";
- `Air Dry - AMS.3mf`, the 90 MB file;
- the comparison set: every already-sliced file, on its own printer, plate by
  plate.

The sample files are sliced on the three selected printers: P1S 0.4, X1 Carbon
0.4 and A1 0.4. The comparison files are sliced on their own printer and
compared with Bambu's own numbers. A job that falls in both sets runs once.

## How to run it

1. On mini01, read only over the folder; the selection is written to /tmp, never into the folder:

   ```sh
   node tools/slicing-gate/select-sample.mjs "$HOME/Downloads/3D Prints" \
     --json /tmp/platehouse-selection.json --names /tmp/platehouse-names.txt
   ```

2. Copy the selection, the sample and this folder to Hades over scp. The names
   in `/tmp/platehouse-names.txt` are top-level file names (checked on
   2026-11-07; none holds a `/`).

   ```sh
   ssh hades 'mkdir -p /tmp/platehouse-gate/in/sample'
   scp /tmp/platehouse-selection.json hades:/tmp/platehouse-gate/in/selection.json
   cd "$HOME/Downloads/3D Prints"
   while IFS= read -r f; do scp -p -- "./$f" hades:/tmp/platehouse-gate/in/sample/; done < /tmp/platehouse-names.txt
   scp -r /path/to/platehouse/tools/slicing-gate hades:/tmp/platehouse-gate/tool
   ```

3. On Hades:

   ```sh
   /tmp/platehouse-gate/tool/run.sh
   ```

   It builds `platehouse-gate:t1` if it is missing (`--build` forces a
   rebuild), then writes `/tmp/platehouse-gate/out/result.json` and
   `/tmp/platehouse-gate/out/summary.txt`. Exit status: 0 PASS, 1 FAIL,
   3 NEEDS-DECISION, 2 the gate could not run.

4. Copy `result.json` and `summary.txt` back. The main session files the
   report in Drive under 15 - Plans/Platehouse.

5. Delete the scratch dir and the image, and check both are gone:

   ```sh
   /tmp/platehouse-gate/tool/run.sh --clean
   ls /tmp/platehouse-gate                 # expect: No such file or directory
   docker images | grep platehouse-gate    # expect: nothing
   ```

   Also delete `/tmp/platehouse-selection.json` and
   `/tmp/platehouse-names.txt` on mini01.

## The container

Each step runs in a fresh container, exactly as Task 1 states:
`--network none --cpus 4 --memory 8g --read-only --tmpfs /work:size=4g`, the
sample mounted read-only at `/in`. Each plate is one Orca call,
`--slice N --export-statistics --outputdir ...`, under `/usr/bin/time -v`, with
`--mstpp 600` and an external kill at 900 s (`timeout -s KILL 900`). The host
also kills a container that is still running after 960 s.

Added beyond Task 1, each for a reason:

- `--memory-swap 8g`, so the 8 GB limit is not doubled by swap;
- `--user` set to the caller, so `/out` (small result files only) stays
  writable and owned by the caller;
- `--cap-drop ALL` and `--security-opt no-new-privileges:true`, T26's slicer
  runtime, so the landrun check runs the way it will in production. Docker's
  default seccomp profile is left on.

Orca is called with `--allow-newer-file` so a file saved by a newer Bambu
Studio is not refused on version alone; the recipe in the report says so.

## The pass rule

Jon, 2026-11-07: every plate gets a time and a weight above zero, or is refused
for a reason AC-034 treats as legitimate (process not compatible, machine not
supported, bed too small, nozzle or extruder mismatch), which is reported. A
crash, a timeout or an unexplained slicer error on any plate fails the gate.

The legitimate refusals, by Orca 2.5.0 return code: -15 and -16 (machine not
supported), -17 (process not compatible), -20, -52 and -102 (bed too small),
-66 and -68 (nozzle or extruder mismatch).

NEEDS-DECISION: the plan's slicer contract maps -61 to -69 to "nozzle
mismatch", but Orca's own messages say only -66 and -68 are about extruders.
-61 to -65, -67 and -69 (bed type, temperature, collisions, vase mode, TPU
count, mixed filament), and -50 (empty plate), are reported as needs-decision
rather than passed or failed, so Jon decides them.

## What the report holds

`result.json` is the machine-readable report; `summary.txt` is the plain one.

- (a) per file x printer x plate: return code, error string, time, weight,
  grams per filament, wall time, peak RSS, and the verdict.
- (b) the gap against Bambu's own numbers on the already-sliced files: per
  plate percent difference, median and worst, for time and weight. No
  threshold.
- (c) the profile recipe: how presets are flattened, the inherits chain of
  each printer, which generic filament profile maps to each filament type,
  and whether the file's own process survives the printer switch (Orca's
  layer height, wall loops and infill density against the file's).
- (d) proposed AC-035 limits from the measured worst case, by a stated rule.
- (e) which slice_info.config and project_settings.config keys name the
  printer and nozzle, and the BBL model_id map read from the image.
- (f) OpenSCAD: does it render STL and PNG headless with no Xvfb, and does
  `--info` mention EGL and Manifold.
- (g) landrun under Docker's default seccomp: a same-dir `import()` works and
  an `import("/opt/gate/samples/outside.stl")` is blocked, with a control run
  of the same import outside landrun to show landrun is what blocks it. It
  also runs the plan's T11 form (`--ro` on the OpenSCAD tree) as evidence;
  landrun's README says executed paths need `--rox`.
- (h) occt-import-js 0.0.23 converts the NIST CTC-01 STEP file to GLB: time
  and size.

Per-plate Orca log tails are written to `out/jobs/<id>.log` only; they can
name objects in a file, so they are not copied into the report.

## Read-only preflight (same job, no approval needed)

On Hades and Mario, read-only, reported with the gate:

- `docker network inspect internal` (is `.Internal` true?)
- whether Traefik's 443 is reachable from the internet (port-forward and router rule)
- the LAN and tailnet CIDRs for an ipAllowList
- how `*.local.jonco.dev` resolves
- the wildcard certificate in use
- which networks pgbackweb joins
- whether the restart-loop script covers every container
- `${APPDATA}` on Hades
- Pocket ID's OIDC client setup on Mario

## Pins

| What | Version | Checked against |
|---|---|---|
| Base image | ubuntu:24.04 | index digest `sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852` |
| apt packages | Ubuntu snapshot 20261107T000000Z | signed snapshot index (apt) |
| OrcaSlicer | v2.5.0 Ubuntu 24.04 AppImage | sha256 `d13eb0a9cd618ed080ab6b82c64c0a60c4501aac91e88d5ac2c3b526fb141a7c` |
| OpenSCAD | 2026.11-RC0 x86_64 AppImage | sha256 `78c2050aedcf52cca0186151cdcda1118a771491e3bec934b3172d0b03a9de96` |
| landrun | v0.1.17 linux amd64 | sha256 `6ada66a06669e8994e174a7271af2db636308e55a0d6ec896cc7d326b46727f6` |
| Node.js | 26.13.0 linux x64 | sha256 `d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997` |
| occt-import-js | 0.0.23 | sha256 `eaab9ca7bf02799360d8fc70468dc8bf78eb2073c3fafb1ff982006e558fc1f3` |
| NIST STEP files | archive of 2024-06-19 | zip sha256 `8fa78429...1911`, extracted file sha256 `e081d518...5855` (full values in the Dockerfile) |
