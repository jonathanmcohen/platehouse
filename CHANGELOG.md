# Changelog

All notable changes to Platehouse are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - unreleased

### Added

- Slicing gate harness in tools/slicing-gate: picks the Task 1 sample from the .3mf metadata, flattens OrcaSlicer's BBL profiles, and slices every plate in a throwaway network-less container on Hades, with a report and Jon's pass rule ([#1](https://github.com/jonathanmcohen/platehouse/pull/1)).

### Fixed

- Slicing gate harness, after the first Hades run: Orca 2.5.0 ships its presets only as binary .opc caches, so the image now takes the BBL profile JSON from Orca's source at the commit tag v2.5.0 points to, fetched by that commit and checked by git, and fails the build unless its version matches the .opc Orca ships; every image build check names what failed, and the checks match the real layout of the pinned artifacts; the scripts run when started through a symlinked path (#4); the README copies the tool with scp -rp, runs run.sh through bash, and copies the sample in one tar stream that keeps subfolder paths ([#5](https://github.com/jonathanmcohen/platehouse/pull/5)).
