# Releasing

This page is for maintainers. Pushing a `v*` tag releases Platehouse: `v0.1.1` is a release,
`v0.2.0-rc.1` a release candidate. For each tag, `release.yml` publishes the app image
(`ghcr.io/jonathanmcohen/platehouse`), `slicer-image.yml` publishes the slicer image
(`ghcr.io/jonathanmcohen/platehouse-slicer`), and `rc-tag.yml` then moves the `rc` tags. Once
both images of a release are out, `release-notes.yml` opens a draft GitHub Release. `docs-pages.yml`
runs on each tag push too, and publishes the docs site only from the highest release tag. All five
are in `.github/workflows/`.

## Cutting a release

1. Merge into main or a `release/**` branch and wait for that push's ci run to pass. The release
   gate refuses any other commit.
2. Tag the commit and push the tag:

   ```sh
   git tag -a vX.Y.Z <commit> -m "Platehouse X.Y.Z"
   git push origin vX.Y.Z
   ```

3. Wait for the release, slicer-image and rc-tag runs to succeed. The docs-pages run on the tag
   publishes the docs site when the tag is the highest release, without waiting for the images
   (see [The docs site](#the-docs-site)). For a release (not a candidate), once both images are
   out, release-notes opens a draft Release, "Platehouse X.Y.Z", with the images, their digests and
   the changelog links filled in. If no draft appears, run release-notes by hand from main with the
   tag (Actions, release-notes, Run workflow).
4. Publish any security advisories the release fixes, with `X.Y.Z` as the patched version, once
   both images are out.
5. Open the draft. Write Summary, What's new and Known issues, check Before you upgrade, fill in
   Security from the advisories you just published, and remove every TODO comment. Then publish
   it:

   ```sh
   latest="$(gh api --paginate repos/jonathanmcohen/platehouse/git/matching-refs/tags/v --jq '.[].ref' | sed -n 's#^refs/tags/##p' | node .github/scripts/release-gate.mjs latest vX.Y.Z)"
   gh release edit vX.Y.Z --draft=false --latest="$latest"
   ```

   `latest` is true only for the highest release. A backport gets a page too, published with
   `--latest=false`. Because the page is published after the advisories, a public page never
   names an unpublished advisory.

6. Check that the issues the release fixes are closed.

## The release gate

A `v*` tag publishes images only for a commit with a successful ci run (a push or a manual
dispatch) on main or a `release/**` branch. `.github/scripts/release-gate.mjs`, called from
`release.yml`, waits for a ci run that is still going and fails when none succeeded. `latest` only
moves to the highest stable release, never to a release candidate or a backport. The docs site
does not wait for this gate: docs-pages publishes from the tag on its push, so it can be live
before the gate refuses the images (see [The docs site](#the-docs-site) for the way back).

## The docs site

`docs-pages.yml` publishes the docs site to GitHub Pages when the highest release is tagged, so
the site describes the latest release and not unreleased work. A push of an rc tag, a throwaway
tag or a backport publishes nothing; its run ends green with a notice. Pull requests and merges
publish nothing either. A run by hand publishes from the highest release tag, or from main while
main's `package.json` version is the highest release. From any other ref it fails.

One-time setup, before the first release tag that should publish:

1. Open Settings, then Environments, then **github-pages**.
2. Under **Deployment branches and tags**, choose **Add deployment branch or tag rule**.
3. Set **Ref type** to **Tag** and **Name pattern** to `v*.*.*`, then **Add rule**.
4. Keep the existing `main` branch rule, because runs by hand from main still deploy.

The same rule from the command line:

```sh
gh api -X POST repos/jonathanmcohen/platehouse/environments/github-pages/deployment-branch-policies -f name='v*.*.*' -f type=tag
```

Pages' Source stays **GitHub Actions**; nothing else in the Pages settings changes. The pattern
also matches rc and throwaway tags. The workflow's decision step skips those, and refuses a tag
whose commit is on neither main nor a `release/**` branch, but it is not a security control: a
tag runs the workflow file at its own commit, so a tag on a commit with a changed workflow can
leave the step out. The server-side controls are this environment rule and a tag ruleset on
`refs/tags/v*` (Settings, Rules) that lets only admins create, move or delete those tags.
Without the environment rule, a tag's deploy job fails with an environment protection error and
the site stays as it was: add the rule, then run docs-pages by hand from the tag.

A tag push runs docs-pages beside the image builds, so the docs can go live some minutes before
both images are out, and stay live if the release gate then refuses the images. To take them back
in that case, delete the tag, then run docs-pages by hand from the previous release tag
(Actions, docs-pages, Run workflow, choosing that tag):

```sh
git push origin --delete refs/tags/vX.Y.Z
git tag -d vX.Y.Z
```

### Publishing a docs fix

Merge the fix to main, then run the workflow by hand from main
(Actions, docs-pages, Run workflow, branch `main`). It runs from main, not from the tag, because
the fix is not in the tag and a release tag never moves. This works only while main's version is
the highest release: once main says a version that has no tag yet, the run refuses, and the fix
goes out with that release.

## Slicer image

### Tags

| Tag                        | Names                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `X.Y.Z`, `X.Y.Z-rc.N`      | The slicer built for that release tag. Pin this, as `examples/docker-compose.yml` does.         |
| `orca-X.Y.Z`               | The newest build of that OrcaSlicer version from main or a release (never a release candidate). |
| `stable`                   | The newest such build of any OrcaSlicer version.                                                |
| `orca-X.Y.Z-r<run number>` | One build; never moves. A re-run adds its attempt: `orca-X.Y.Z-r<run number>.<attempt>`.        |
| `rc`                       | The newest release candidate. See [The rc tag](#the-rc-tag).                                    |

Only runs started from a release tag (its push, a re-run, or a run by hand from the tag) add the
version tag. A re-run keeps its run number, and the first attempt's run tag stays on its image.

To go back a release, set both images to the earlier version tag. 0.1.0 predates slicer version
tags: use `ghcr.io/jonathanmcohen/platehouse:0.1.0` with
`ghcr.io/jonathanmcohen/platehouse-slicer:orca-2.5.1-r3`, the build its example file resolved to
(`orca-2.5.1` names it too, but moves).

### When it builds

- Daily at 05:00 UTC, for OrcaSlicer's latest stable release, only if that version has no
  `orca-X.Y.Z` tag yet.
- On every release tag, at the latest Orca release, so slicer changes ship with the release.
- By hand from Actions, for a chosen version or with a forced failure to test the failure path.

Each run builds `apps/slicer/Dockerfile` and smoke-slices generated plates. Only if every plate
slices does it push `orca-X.Y.Z` and the run tag and move `stable` to the same digest. A Trivy
scan lists fixable HIGH and CRITICAL findings in the log first; it never fails the run.

A prerelease tag (`v0.1.0-rc.1`) or a backport below the highest release (`v0.1.2` after
`v0.2.0`) publishes only the run tag and the version tag. A prerelease tag leaves `orca-X.Y.Z` and `stable` where they were, as does a backport, so the next daily run builds
that version if its `orca-X.Y.Z` is missing. Only the highest plain `vX.Y.Z` moves both.

### When a run fails

The workflow opens an issue, "Slicer image failed for OrcaSlicer X.Y.Z".

- **Before tagging:** no tag is created or moved.
- **While tagging** (a readback mismatch or a GHCR error): `orca-X.Y.Z`, and maybe `stable`, can
  already be at the new digest. The issue lists the tags it had already pointed at the new digest
  and says to run the workflow by hand, since the daily run skips a version whose `orca-X.Y.Z`
  exists.
- **A prerelease tag's run** never touches `orca-X.Y.Z`, so the issue suggests Re-run failed jobs:
  it rebuilds the same version and pins and leaves `stable` alone, where a run by hand would move
  it. The issue warns against Re-run all jobs, which reads OrcaSlicer's latest release again and may build a newer version instead.

### Ubuntu packages

The slicer image and the slicing gate image (`tools/slicing-gate/Dockerfile`) install Ubuntu
packages from one fixed archive snapshot, `APT_SNAPSHOT`, so builds are reproducible.
`apt-snapshot.yml` moves it forward at 06:00 UTC on the 1st of each month:

- It picks midnight UTC of the newest day snapshot.ubuntu.com has, checks the service has it, and
  opens one pull request from `bot/apt-snapshot` with the old and new dates, replacing last
  month's if it is still open. Fix a broken snapshot on another branch: the workflow owns that one.
- It starts ci on the branch itself, because GitHub holds checks on pull requests a workflow opens.
  That run builds both images, runs the container and slicing gate tests, and shows the Trivy
  report for the new image.
- Merging publishes nothing. The packages ship with the slicer's next build, and a deployment
  pinned to a version tag gets them with the next Platehouse release.
- It needs "Allow GitHub Actions to create and approve pull requests" (Settings, Actions, General).
  Without it, the run pushes the branch and then fails. It can also be run by hand from main.

Only the two Dockerfiles and the pins table in `tools/slicing-gate/README.md` may name the current
snapshot date or a later one, once each (`CHANGELOG.md` is exempt). Any other copy would be left
behind by the monthly rewrite, so the run refuses to push, and ci's Ubuntu snapshot pin check
(`node .github/scripts/apt-snapshot.mjs leftovers`) fails the pull request. To mention a snapshot
date elsewhere, use an older one.

### Rolling the slicer back

Point `stable` back at the last version that worked. Log in with a token that has
`write:packages` (`docker login ghcr.io`), then:

```sh
docker buildx imagetools create --prefer-index=false \
  -t ghcr.io/jonathanmcohen/platehouse-slicer:stable \
  ghcr.io/jonathanmcohen/platehouse-slicer:orca-<previous>
```

`--prefer-index=false` makes `stable` an exact copy; without it, buildx wraps the image in a new
index with its own digest. Check the two digests match:

```sh
docker buildx imagetools inspect ghcr.io/jonathanmcohen/platehouse-slicer:stable --format '{{.Manifest.Digest}}'
docker buildx imagetools inspect ghcr.io/jonathanmcohen/platehouse-slicer:orca-<previous> --format '{{.Manifest.Digest}}'
```

If a slicer change broke the image at the same Orca version, use that version's previous run tag
instead: every build keeps its own `orca-X.Y.Z-r<run number>` tag, or `orca-X.Y.Z-r<run number>.<attempt>` for a re-run.

The daily run leaves a rollback alone. A release tag or a run by hand builds again and moves
`stable` when its smoke slice passes.

### The rc tag

A test server can set both images to `:rc` and pull to get the newest release candidate. It
moves, so it is not a pin.

`rc` names the highest `vX.Y.Z-rc.N` or `vX.Y.Z` tag that has both `platehouse:X.Y.Z[-rc.N]` and
`platehouse-slicer:X.Y.Z[-rc.N]` published, so a test server never gets a new app with an old
slicer. A backport after a newer candidate (`v0.1.1` after `v0.2.0-rc.1`) does not move it.
Throwaway tags (`v0.0.0-test`) and other prerelease kinds (`-beta.1`, `-rc` with no number) never
qualify.

Only `rc-tag.yml` moves `rc`. It runs after every release or slicer-image run, one at a time, and
works the answer out again from the tags and the registry, so run order, re-runs and runs by hand
can't leave it wrong. It reads all four tags before writing and puts a moved `rc` tag back if a
later step fails. Only if that put-back fails too, or the moved tag didn't exist before, can the
two `rc` tags differ; the run then fails saying so. Run rc-tag by hand once GHCR answers again.

To see where `rc` points, read the latest rc-tag run's summary, or compare digests (the releases
page doesn't list candidates):

```sh
docker buildx imagetools inspect ghcr.io/jonathanmcohen/platehouse:rc --format '{{.Manifest.Digest}}'
docker buildx imagetools inspect ghcr.io/jonathanmcohen/platehouse:0.2.0-rc.1 --format '{{.Manifest.Digest}}'
```

## Node release keys

The weekly base-images run checks Node's `SHASUMS256.txt.asc` with `gpgv` against
nodejs/release-keys' `gpg-only-active-keys/pubring.kbx`, at the commit `NODE_RELEASE_KEYS_COMMIT`
in `.github/scripts/base-images.mjs`, whose sha256 is `NODE_RELEASE_KEYRING_SHA256`. The list must
carry exactly one good signature, by a key whose fingerprint is in `NODE_RELEASE_KEY_FINGERPRINTS`
in the same file. It takes a new Node release's sha256 only from a list that passes, so a list
changed on the server or on the way never reaches the pins.

When the run fails because the list is signed by a key not in the ring, the error names the key
the signature claims, from its issuer field: it may be a subkey, and nothing has verified it.
A good signature from an expired or revoked key is refused too, by gpgv's status lines.
Never take a commit, a sha256 or a fingerprint from a pull request, an issue or a run's log.
GitHub serves a commit from any fork of nodejs/release-keys under the upstream URL, so a commit in
that URL proves nothing by itself, and the binary keyring can't be read in a diff. Rotate the ring
in this order:

1. Pick a commit on the `main` branch of nodejs/release-keys, usually its head:
   `gh api repos/nodejs/release-keys/commits/main --jq .sha`.
2. Check that the commit is on `main`: `gh api repos/nodejs/release-keys/compare/<sha>...main --jq .status` must print `ahead` or `identical`.
   Stop on `diverged` or `behind`: the commit is not on `main`.
3. Download the ring from that commit and list its fingerprints:

   ```sh
   curl -fsSL -o pubring.kbx "https://raw.githubusercontent.com/nodejs/release-keys/<sha>/gpg-only-active-keys/pubring.kbx"
   shasum -a 256 pubring.kbx
   gpg --homedir "$(mktemp -d)" --no-default-keyring --keyring ./pubring.kbx --list-keys --with-colons |
     awk -F: '$1 == "pub" { p = 1; next } $1 == "fpr" && p { print $10; p = 0 }'
   ```

4. Check each fingerprint against the Release keys list in the nodejs/node README
   ([nodejs/node](https://github.com/nodejs/node#release-keys)), a separate source from
   nodejs/release-keys. Stop if any fingerprint is not there.
5. In one reviewed pull request, change `NODE_RELEASE_KEYS_COMMIT`, `NODE_RELEASE_KEYRING_SHA256` and `NODE_RELEASE_KEY_FINGERPRINTS` together:
   the commit, the sha256 that `shasum` printed and the fingerprints that `gpg` listed.
