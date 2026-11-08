#!/usr/bin/env bash
# Platehouse slicing gate (build plan Task 1), run on Hades by platform-sre
# after Jon approves. Builds the throwaway image, runs every plate slice in a
# fresh network-less, read-only container, then the OpenSCAD, landrun and STEP
# checks, then writes the report.
#
# Usage:
#   tools/slicing-gate/run.sh          build the image if missing, run the gate
#   tools/slicing-gate/run.sh --build  rebuild the image first
#   tools/slicing-gate/run.sh --clean  delete the scratch dir and the image, and verify
#
# Inputs, under GATE_DIR (default /tmp/platehouse-gate):
#   in/selection.json   from select-sample.mjs --json on mini01
#   in/sample/          the selected .3mf files, copied from mini01 over scp
# Outputs, under GATE_DIR/out: result.json (machine-readable), summary.txt.
# Exit status: 0 PASS, 1 FAIL, 3 NEEDS-DECISION, 2 the gate could not run.
{
set -euo pipefail

# Exit 1 means the gate FAILED, so only the report's verdict may return it.
# Under set -e any command that fails outside a die guard would end the script
# with its own status, usually 1. This trap turns every exit except a
# deliberate one (exit_as set just before it) into 2, the gate could not run.
exit_as=""
exit_rc=0
trap 'exit_rc=$?
if [[ "${exit_rc}" -ne 2 && "${exit_rc}" != "${exit_as}" ]]; then
  printf "run.sh: a step failed (exit %s); the gate could not run\n" "${exit_rc}" >&2
  exit 2
fi' EXIT

GATE_DIR="${GATE_DIR:-/tmp/platehouse-gate}"
IMAGE="platehouse-gate:t1"
KILL_SECONDS=900            # the external kill inside each container
HOST_BACKSTOP_SECONDS=960   # the host-side kill, in case the container hangs
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
IN="${GATE_DIR}/in"
OUT="${GATE_DIR}/out"

die() { printf 'run.sh: %s\n' "$*" >&2; exit 2; }

# The scratch dir is deleted with rm -rf, so it must be the throwaway path.
# A case pattern's * also matches "/..", so a .. segment is refused first.
case "/${GATE_DIR}/" in
  */../*) die "GATE_DIR must not contain a .. segment, got ${GATE_DIR}" ;;
  *) ;;
esac
case "${GATE_DIR}" in
  /tmp/platehouse-gate | /tmp/platehouse-gate/*) ;;
  *) die "GATE_DIR must be /tmp/platehouse-gate or below it, got ${GATE_DIR}" ;;
esac

command -v docker > /dev/null || die "docker is not installed"
command -v timeout > /dev/null || die "GNU timeout is not installed"
# Before --clean too: with no daemon, --clean cannot remove or check the image.
docker info > /dev/null 2>&1 || die "cannot reach the docker daemon"

if [[ "${1:-}" = "--clean" ]]; then
  rm -rf -- "${GATE_DIR}"
  if docker image inspect "${IMAGE}" > /dev/null 2>&1; then
    docker image rm "${IMAGE}" > /dev/null
  fi
  if [[ -e "${GATE_DIR}" ]]; then die "${GATE_DIR} still exists"; fi
  # Captured first, so a failing docker images is exit 2, never "gone", and
  # grep reads a variable, so no pipe can turn a match into a miss.
  images="$(docker images --format '{{.Repository}}:{{.Tag}}')" \
    || die "docker images failed, so whether the image is gone is unknown"
  if grep -q '^platehouse-gate' <<< "${images}"; then
    die "a platehouse-gate image still exists"
  fi
  printf 'Deleted %s and the %s image; neither remains.\n' "${GATE_DIR}" "${IMAGE}"
  exit_as=0
  exit 0
fi

[[ -f "${IN}/selection.json" ]] || die "missing ${IN}/selection.json (from select-sample.mjs --json)"
[[ -d "${IN}/sample" ]] || die "missing ${IN}/sample (the selected .3mf files)"
if [[ -e "${OUT}" ]]; then
  out_entries="$(ls -A "${OUT}")"
  if [[ -n "${out_entries}" ]]; then
    die "${OUT} is not empty; move it away or delete it before a new run"
  fi
fi
mkdir -p "${OUT}/jobs"

if [[ "${1:-}" = "--build" ]] || ! docker image inspect "${IMAGE}" > /dev/null 2>&1; then
  # A setup failure exits 2, never 1, so it cannot read as a gate FAIL.
  docker build --platform linux/amd64 -t "${IMAGE}" "${HERE}" || die "image build failed"
fi

# Task 1's container: no network, 4 CPUs, 8 GB (swap included, so the limit
# is real), read-only root, 4 GB tmpfs scratch, the sample read-only. Added
# beyond Task 1: the caller's uid so /out stays writable and owned by the
# caller, and T26's runtime hardening (no capabilities, no new privileges)
# so the landrun check runs as it will in production.
uid="$(id -u)"
gid="$(id -g)"
tmpfs_opts="rw,size=4g,mode=1777"
run_args=(
  --rm
  --network none
  --cpus 4
  --memory 8g
  --memory-swap 8g
  --read-only
  --tmpfs "/work:${tmpfs_opts}"
  --cap-drop ALL
  --security-opt no-new-privileges:true
  --user "${uid}:${gid}"
  --volume "${IN}:/in:ro"
  --volume "${OUT}:/out:rw"
)

gate() {
  docker run "${run_args[@]}" "${IMAGE}" node /opt/gate/gate.mjs "$@" < /dev/null
}

gate plan || die "plan step failed"
# bash 3.2 does not stop on a failed redirect into the loop below, so a plan
# step that wrote no jobs.txt would go on to a report with no plates.
[[ -f "${OUT}/jobs.txt" ]] || die "the plan step wrote no ${OUT}/jobs.txt; the gate could not run"

total="$(grep -c '^j' "${OUT}/jobs.txt" || true)"
n=0
while IFS= read -r id; do
  [[ "${id}" =~ ^j[0-9]{4,}$ ]] || continue
  n=$((n + 1))
  name="platehouse-gate-${id}"
  printf '[%s/%s] %s\n' "${n}" "${total}" "${id}"
  set +e
  timeout --kill-after=30 "${HOST_BACKSTOP_SECONDS}" \
    docker run --name "${name}" "${run_args[@]}" "${IMAGE}" \
    node /opt/gate/gate.mjs slice "${id}" < /dev/null
  rc=$?
  set -e
  if [[ "${rc}" -eq 124 || "${rc}" -eq 137 ]]; then
    docker kill "${name}" > /dev/null 2>&1 || true
    docker rm -f "${name}" > /dev/null 2>&1 || true
  fi
  printf '%s\t%s\n' "${id}" "${rc}" >> "${OUT}/host-exit.tsv"
  # None of these is a slicer result, and the report would count the plate as
  # an Orca crash and FAIL the gate. 125 is docker run failing to create or
  # start the container. gate.mjs slice exits 0 whatever Orca did and 2 only
  # when its own command fails; 126 and 127 mean the command could not run.
  case "${rc}" in
    125) die "docker could not start the container for ${id} (exit 125); the gate could not run" ;;
    2 | 126 | 127) die "slice for ${id} could not run (exit ${rc}); the gate could not run" ;;
    *) ;;
  esac
done < "${OUT}/jobs.txt"

set +e
gate checks
checks_rc=$?
set -e
if [[ "${checks_rc}" -ne 0 ]]; then
  # With no checks.json the report reads COULD-NOT-RUN (exit 2), unless a
  # plate failed, which stays FAIL (exit 1).
  printf 'run.sh: the checks step exited %s; with no checks.json the report says COULD-NOT-RUN unless a plate failed\n' "${checks_rc}" >&2
fi

set +e
gate report
verdict=$?
set -e
# gate.mjs exits 0 to 3 itself; any other code is docker's (125 could not
# start, 137 killed), so the report never ran and the gate could not run.
case "${verdict}" in
  0 | 1 | 2 | 3) ;;
  *) die "report step failed (exit ${verdict})" ;;
esac

printf '\nResults: %s/result.json and %s/summary.txt\n' "${OUT}" "${OUT}"
printf 'Per-plate kill inside each container: %s s; --mstpp 600.\n' "${KILL_SECONDS}"
printf 'After the report is collected: %s --clean\n' "$0"
exit_as="${verdict}"
exit "${verdict}"
}
