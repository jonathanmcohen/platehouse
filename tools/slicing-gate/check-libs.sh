#!/usr/bin/env bash
# Build-time shared-library check, run by the Dockerfile so a library missing
# from the image fails the build, not every plate on Hades.
#
# Usage: check-libs.sh <elf binary> [<library path>]
#   <library path> is set as LD_LIBRARY_PATH for ldd, the way the program's
#   own launcher sets it at run time.
# Exit status: 0 every library resolves; 1 a library is missing, the binary
# does not exist, or ldd itself failed (a script or other non-ELF file would
# otherwise pass without checking anything); 2 bad usage.
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  printf 'usage: check-libs.sh <elf binary> [<library path>]\n' >&2
  exit 2
fi
bin="$1"
if [[ ! -f "${bin}" ]]; then
  printf 'check-libs: %s does not exist\n' "${bin}" >&2
  exit 1
fi
if [[ -n "${2:-}" ]]; then export LD_LIBRARY_PATH="$2"; fi

set +e
out="$(ldd "${bin}" 2>&1)"
rc=$?
set -e
if [[ "${rc}" -ne 0 ]]; then
  printf 'check-libs: ldd %s exited %s:\n%s\n' "${bin}" "${rc}" "${out}" >&2
  exit 1
fi
missing="$(printf '%s\n' "${out}" | grep 'not found' || true)"
if [[ -n "${missing}" ]]; then
  printf 'check-libs: missing shared libraries for %s:\n%s\n' "${bin}" "${missing}" >&2
  exit 1
fi
printf 'check-libs: every shared library of %s resolves\n' "${bin}"
