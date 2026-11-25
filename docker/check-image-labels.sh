#!/usr/bin/env bash
# Checks an image's standard OCI labels: the app image's for the release
# workflow (issue #317, .github/workflows/release.yml), and the slicer
# image's loaded build for .github/workflows/slicer-image.yml (the
# 0.1.1-rc.1 live check):
#
#   docker/check-image-labels.sh <where> <ref> <version> <revision> <source>
#
# where is one of:
#   local   an image in the runner's Docker (the tested build, before the
#           push): its config's labels, from docker image inspect
#   pushed  one per-arch image in the registry, by digest: its config's
#           labels, from docker buildx imagetools inspect
#   index   the multi-arch index in the registry, by tag: its annotations,
#           from the raw index
#
# version, revision and source must equal the given values; created, title,
# url, licenses and description, the rest docker/metadata-action computes,
# must be there and not empty. Each wrong or missing key is named in a
# ::error:: line and the script exits 1; it exits 2 on bad arguments, before
# running docker. apps/server/test/release-labels.test.ts runs it against a
# stub docker.
set -euo pipefail

usage() {
  echo "usage: $0 local|pushed|index <ref> <version> <revision> <source>" >&2
  exit 2
}

[ "$#" -eq 5 ] || usage
where="$1"
ref="$2"
want_version="$3"
want_revision="$4"
want_source="$5"
case "$where" in
  local | pushed | index) ;;
  *) usage ;;
esac

case "$where" in
  local)
    what="the labels of ${ref}"
    raw="$(docker image inspect --format '{{json .Config.Labels}}' "$ref")"
    filter='if type == "object" then . else {} end'
    ;;
  pushed)
    what="the labels of ${ref}"
    raw="$(docker buildx imagetools inspect "$ref" --format '{{json .Image}}')"
    # One image's config; a manifest list answers a map of platforms instead.
    filter='if type == "object" and (.config | type) == "object" then (.config.Labels // {}) else error("not a single image") end'
    ;;
  index)
    what="the annotations of ${ref}"
    raw="$(docker buildx imagetools inspect --raw "$ref")"
    filter='if type == "object" then (.annotations // {}) else {} end'
    ;;
esac

if ! labels="$(jq -ce "$filter" <<<"$raw")"; then
  echo "::error::${what} could not be read as one image's"
  exit 1
fi

value() {
  jq -r --arg k "$1" '.[$k] // "" | tostring' <<<"$labels"
}

failed=0
expect() {
  local key="org.opencontainers.image.$1" want="$2" got
  got="$(value "$key")"
  if [ "$got" != "$want" ]; then
    echo "::error::${what}: ${key} is '${got}', not '${want}'"
    failed=1
  else
    echo "${key}=${got}"
  fi
}
present() {
  local key="org.opencontainers.image.$1" got
  got="$(value "$key")"
  if [ -z "$got" ]; then
    echo "::error::${what}: ${key} is missing or empty"
    failed=1
  else
    echo "${key}=${got}"
  fi
}

expect version "$want_version"
expect revision "$want_revision"
expect source "$want_source"
for key in created title url licenses description; do
  present "$key"
done

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "${what} are right"
