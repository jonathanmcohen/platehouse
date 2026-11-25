# Releasing

This page is for maintainers. Platehouse is released by pushing a `v*` tag. A plain tag such as
`v0.1.1` is a release; a tag such as `v0.2.0-rc.1` is a release candidate. The release workflow
(`.github/workflows/release.yml`) builds and publishes the app image for the tag, and the
slicer-image workflow publishes the slicer image for it. Below is how the slicer image is
published, rolled back and followed by the `rc` tag.

## The release gate

A `v*` tag publishes only for a commit that has a successful ci run, from a push or a manual
dispatch, on main or a `release/**` branch. The gate is `.github/scripts/release-gate.mjs`, called
from `release.yml`. It waits for a running ci run and fails when none succeeded. The `latest` tag
goes only to the highest stable release: a backport tag below it, or a release candidate, never
moves `latest`.

## Slicer image

`.github/workflows/slicer-image.yml` publishes the slicer image,
`ghcr.io/jonathanmcohen/platehouse-slicer`. A deployment pins the version tag
(`platehouse-slicer:X.Y.Z`, the same as the app image), as `examples/docker-compose.yml` does.
`orca-X.Y.Z` follows the newest build of that OrcaSlicer version from main or a release, never a
release candidate, and `stable` the newest such build of any OrcaSlicer version. To go back
to a release from 0.1.1 on, set both images to the previous version tag. 0.1.0 has no slicer
version tag (those began after it), so to go back to it set the slicer to
`ghcr.io/jonathanmcohen/platehouse-slicer:orca-2.5.1-r3`, the build 0.1.0's example file resolved
to (`orca-2.5.1` itself still points at it, but is a moving tag), together with
`ghcr.io/jonathanmcohen/platehouse:0.1.0`. A test server can follow the `rc` tag instead (below).

Every day at 05:00 UTC the workflow reads OrcaSlicer's latest stable release. When
`orca-X.Y.Z` for that version is not in the registry yet, it builds `apps/slicer/Dockerfile`
for that version and smoke-slices generated plates in the built image. Only when every plate
slices does it push `orca-X.Y.Z` and a run tag, `orca-X.Y.Z-r<run number>`, and move `stable` to
the same digest. A re-run of a run (Re-run all jobs or Re-run failed jobs) keeps its run number, so its run tag is
`orca-X.Y.Z-r<run number>.<attempt>` and the first attempt's tag stays on the image it named. It also runs on every release tag, at the latest Orca release, so a change to the slicer
ships with the release, and it can be run by hand from the Actions tab (a version, or a forced
failure to test the failure path). A prerelease tag such as `v0.1.0-rc.1`, or a backport tag below the highest release (`v0.1.2` after `v0.2.0`), publishes the run tag and the release's version but
leaves `orca-X.Y.Z` and `stable` alone; only the highest plain `vX.Y.Z` tag moves both. Before anything is pushed,
a Trivy scan lists fixable HIGH and CRITICAL findings in the job log; it is a report and never
fails the run. A prerelease tag leaves `orca-X.Y.Z` and `stable` where they were, as does a backport tag, so the next daily run builds
that version when its `orca-X.Y.Z` tag does not exist yet, and moves both.

The image installs its Ubuntu packages from one fixed snapshot of the Ubuntu archive,
`APT_SNAPSHOT` in `apps/slicer/Dockerfile` (the slicing gate image, `tools/slicing-gate/Dockerfile`,
pins the same one), so every build installs the same packages. To pick up Ubuntu's security
fixes, `.github/workflows/apt-snapshot.yml` moves the snapshot forward once a month, at 06:00 UTC
on the 1st. It takes midnight UTC of the newest day snapshot.ubuntu.com has, checks that the
service has it before changing anything, and opens one pull request from the branch
`bot/apt-snapshot` saying the old and new dates. If last month's pull request is still open, it is
closed and replaced by the new one, so there is never more than one. GitHub holds the checks
of a pull request a workflow opened until someone approves them, so the workflow starts the ci
workflow on that branch itself: it builds both images, runs the container tests and the slicing
gate tests, and the slicer job ends with the same Trivy report as above, so the pull request shows
what is still open in the new image. Review and merge it like any other pull request. Merging does
not publish anything: the new packages reach the published image with the next build of it (a
release tag, a new OrcaSlicer version, or a run by hand), and a deployment pinned to a version tag
gets them with the next Platehouse release's version tag; pulling the same version tag again gets
nothing new. The Trivy scans stay reports and never
fail a build (the slicer has no internet access). The branch belongs to the workflow, which
replaces it each month, so fix a broken snapshot on another branch. The workflow can also be run by
hand from main (Actions, apt-snapshot, Run workflow). It needs the repository setting "Allow GitHub
Actions to create and approve pull requests" (Settings, Actions, General, Workflow permissions);
without it the run pushes the branch and then fails, saying so.

Only those three places, the two Dockerfiles and the pins table in `tools/slicing-gate/README.md`,
may name the current snapshot or a later one, each once, in its pin; `CHANGELOG.md` is left out.
The monthly run stops before it pushes when any other tracked file does, or one of those files
names it a second time (a comment, a sentence), as the rewrite would leave that copy behind. So
the ci workflow's Ubuntu snapshot pin check job runs the same check,
`node .github/scripts/apt-snapshot.mjs leftovers`, on every pull request: to write a snapshot date
anywhere else, use one before the current pin.

A run started from a release tag (its push, a re-run of it, or a run by hand from that tag) also
tags the image with the release's version, `X.Y.Z` or `X.Y.Z-rc.N`, the same name the app image
uses, so the slicer built for a release can be found afterwards. Daily runs and runs from main tag
no version.

When a run fails, the workflow opens an issue titled "Slicer image failed for OrcaSlicer X.Y.Z".
A failure before tagging creates or moves no tag, and `stable` stays where it was. A failure
while tagging (a readback that does not match, or a passing GHCR error) can leave `orca-X.Y.Z`,
and `stable` if it had got that far, at the new digest; the issue then
lists the tags it had already pointed at the new digest. Once `orca-X.Y.Z` exists the daily run
will not retry that version, and a run that moves it may have left it, so the issue says to run
the workflow by hand. A prerelease tag's run never creates or moves `orca-X.Y.Z`, so the daily run
still builds that version if it is missing; the issue suggests Re-run failed jobs, as a run by hand would move `stable`. It
re-runs the build job with the first attempt's version and pins, so it builds the failed version
again and leaves `stable` alone. The issue warns against Re-run all jobs, which runs the
detect job again and so reads OrcaSlicer's latest release again: if Orca has shipped a newer
version since, that re-run builds the newer one and leaves the failed version as the first
attempt left it.

### Rolling the slicer back

Point `stable` back at the last version that worked. Log in to GHCR first with a token that
has `write:packages` (`docker login ghcr.io`), then:

```sh
docker buildx imagetools create --prefer-index=false \
  -t ghcr.io/jonathanmcohen/platehouse-slicer:stable \
  ghcr.io/jonathanmcohen/platehouse-slicer:orca-<previous>
```

`--prefer-index=false` makes `stable` an exact copy of that image. Without it, buildx wraps the
image in a new index with a digest of its own. Check that the two digests now match:

```sh
docker buildx imagetools inspect ghcr.io/jonathanmcohen/platehouse-slicer:stable --format '{{.Manifest.Digest}}'
docker buildx imagetools inspect ghcr.io/jonathanmcohen/platehouse-slicer:orca-<previous> --format '{{.Manifest.Digest}}'
```

A deployment that follows `stable` (for example with Watchtower) then pulls the image it now names. Every build also keeps its own
`orca-X.Y.Z-r<run number>` tag, or `orca-X.Y.Z-r<run number>.<attempt>` for a re-run, so if a
slicer change broke the image at the same Orca version, point `stable` at the previous `-r` tag of
that version instead.

The daily run leaves a rollback alone: it builds only when an Orca release has no `orca-X.Y.Z`
tag yet. A plain release tag or a run by hand always builds, and moves `stable` again when its
smoke slice passes.

### The rc tag

Both images carry an `rc` tag for a test server: set the app to
`ghcr.io/jonathanmcohen/platehouse:rc` and the slicer to
`ghcr.io/jonathanmcohen/platehouse-slicer:rc`, and pull to get the newest release candidate. It
moves, so it is not a pin. `rc` points at the newest version, by version number, that has both
images published: the highest `vX.Y.Z-rc.N` or plain `vX.Y.Z` tag for which both
`platehouse:X.Y.Z[-rc.N]` and `platehouse-slicer:X.Y.Z[-rc.N]` exist. Once a run has finished,
both `rc` tags name builds of the same tag, with the one exception below.

Only `.github/workflows/rc-tag.yml` moves `rc`. It runs after every run of the release or
slicer-image workflow, one run at a time, and works the answer out again each time from the
repository's tags and the registry, so the order in which runs finish, re-runs of old tags and
runs by hand cannot leave `rc` on the wrong tag or the two images on different tags. When the
answer has not changed it writes nothing. It reads all four tags (both version tags and both
`rc` tags) before it writes anything, and if it fails after moving one `rc` tag it points that tag
back at the build it had, so a failed run leaves `rc` where it was until the next run of either
workflow, or until rc-tag is run by hand (Actions, rc-tag, Run workflow). The exception: if that
put-back fails too, or the `rc` tag it moved did not exist before (a tag cannot be put back to not
existing), the two `rc` tags can name different tags until the next successful run. The run then
fails with an error saying the `rc` tags may name builds of different tags; run rc-tag by hand once
GHCR answers again.

- A release tag cut for an older version after a newer candidate (a backport, such as `v0.1.1`
  after `v0.2.0-rc.1`) does not move `rc`, by design: `rc` stays on the newer candidate.
- Throwaway tags such as `v0.0.0-test` and other prerelease kinds (`-beta.1`, `-rc` with no
  number) never qualify.
- A new candidate reaches `rc` only once both of its images are published, so a test server never
  pulls a new app with an old slicer.

To see where `rc` points, compare digests (the releases page lists neither candidates nor `rc`):

```sh
docker buildx imagetools inspect ghcr.io/jonathanmcohen/platehouse:rc --format '{{.Manifest.Digest}}'
docker buildx imagetools inspect ghcr.io/jonathanmcohen/platehouse:0.2.0-rc.1 --format '{{.Manifest.Digest}}'
```

or read the summary of the latest rc-tag run, which lists every candidate tag, whether each image
is published for it, and where it pointed `rc`.
