# shellcheck shell=bash
# Build-time check helper, sourced by the Dockerfile's RUN steps. Copied
# unchanged from tools/slicing-gate/need.sh, which built the gate image on
# Hades and in CI.
#
# Usage: need <test arguments> [-- <reason>]
#   Runs test(1) with the arguments. When the test fails, it prints
#   "build check failed: test <arguments>" (and " - <reason>" if given) on
#   stderr and exits 1, so a failed build step names the check that failed
#   instead of exiting 1 with no text, as the Orca step did on Hades on
#   2026-11-08.
need() {
  local args=() why=""
  while (($# > 0)); do
    if [[ "$1" == "--" ]]; then
      shift
      why="$*"
      break
    fi
    args+=("$1")
    shift
  done
  if ! test "${args[@]}"; then
    printf 'build check failed: test %s%s\n' "${args[*]}" "${why:+ - ${why}}" >&2
    exit 1
  fi
}
