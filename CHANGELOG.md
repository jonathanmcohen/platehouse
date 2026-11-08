# Changelog

All notable changes to Platehouse are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - unreleased

### Added

- Slicing gate harness in tools/slicing-gate: picks the Task 1 sample from the .3mf metadata, flattens OrcaSlicer's BBL profiles, and slices every plate in a throwaway network-less container on Hades, with a report and Jon's pass rule ([#1](https://github.com/jonathanmcohen/platehouse/pull/1)).
- CI job for the slicing gate: on pull requests and pushes that touch tools/slicing-gate, it runs the gate tests on Node 26, builds the gate image so every build step and check runs on GitHub instead of first on Hades, and smoke-checks the built image with no network; nothing is pushed and no secret is used ([#7](https://github.com/jonathanmcohen/platehouse/pull/7)).

### Fixed

- Slicing gate harness, after the first Hades run: Orca 2.5.0 ships its presets only as binary .opc caches, so the image now takes the BBL profile JSON from Orca's source at the commit tag v2.5.0 points to, fetched by that commit and checked by git, and fails the build unless its version matches the .opc Orca ships; every image build check names what failed, and the checks match the real layout of the pinned artifacts; the scripts run when started through a symlinked path (#4); the README copies the tool with scp -rp, runs run.sh through bash, and copies the sample in one tar stream that keeps subfolder paths ([#5](https://github.com/jonathanmcohen/platehouse/pull/5)).
- Slicing gate image, after the second Hades run: Node would not start in the image because libatomic1 was missing, so both stages now install it and check Node's libraries before first running it; the gate user could not start Orca, because the extracted AppImage files kept modes only root could use (found by the new CI job), so both AppImage trees are now readable and executable for every user and the image checks that as the gate user; the README uses the ssh alias Hades exactly (OpenSSH matches it case-sensitively) and starts the long run detached, with its log and exit code in the scratch dir; the unused ORCA_SRC_TAG build arg is gone (#6) ([#7](https://github.com/jonathanmcohen/platehouse/pull/7)).
- Slicing gate, after the third Hades run: slicing a file on a printer other than its own failed with Orca code -3, because Orca 2.5.0 then loads the new printer's default process from resources/profiles/BBL/process_full/, which the AppImage does not ship, so the image now writes those presets, flattened from the pinned profile source, at build time without adding a BBL.json beside BBL.opc, and the build fails, naming the printer, if any printer would be left without its preset; every landrun call now ends landrun's flags with --, so OpenSCAD's -o is no longer read as a landrun flag; CI now slices a crafted two-plate cube saved for one printer on the other printers, with a control run that must reproduce the run 3 failure, and runs the landrun checks; a smoke check with long output no longer fails with SIGPIPE (#9); CI runs on pushes only to main and release branches, and editing check-libs.sh no longer re-downloads every artifact (#8); by Jon's decision on 2026-11-08, Orca codes -101 (G-code path conflicts) and -62 (filament temperatures too far apart) are legitimate refusals, reported with their reason, and no longer fail the gate or wait for a decision ([#11](https://github.com/jonathanmcohen/platehouse/pull/11)).
