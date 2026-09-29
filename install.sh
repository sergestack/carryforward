#!/usr/bin/env bash
# Install carryforward for the current user. Does not touch agent configuration.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BIN_DIR="${HOME}/.local/bin"
TARGET="${BIN_DIR}/carryforward"

os_name="$(uname -s)"
case "${os_name}" in
  Darwin|Linux) ;;
  *)
    echo "CarryForward install supports macOS and Linux. Found ${os_name}." >&2
    exit 1
    ;;
esac

if ! command -v node >/dev/null 2>&1; then
  echo "CarryForward needs Node.js 22.5.0 or newer. Node was not found." >&2
  exit 1
fi

raw="$(node --version 2>/dev/null || true)"
ver="${raw#v}"
IFS=. read -r major minor patch <<<"${ver}"
if [[ -z "${major}" || -z "${minor}" ]]; then
  echo "CarryForward needs Node.js 22.5.0 or newer. Node was not found." >&2
  exit 1
fi
if (( major < 22 || (major == 22 && minor < 5) )); then
  echo "CarryForward needs Node.js 22.5.0 or newer. Found ${ver}." >&2
  exit 1
fi

mkdir -p "${BIN_DIR}"

if [[ -e "${TARGET}" && ! -L "${TARGET}" ]]; then
  echo "Refusing to replace ${TARGET}: it is not a symlink." >&2
  exit 1
fi

ln -sfn "${ROOT}/bin/carryforward" "${TARGET}"
echo "Installed ${TARGET} -> ${ROOT}/bin/carryforward"

case ":${PATH}:" in
  *":${BIN_DIR}:"*)
    echo "Next: carryforward setup"
    ;;
  *)
    echo "${BIN_DIR} is not on PATH."
    echo "Next: ${TARGET} setup"
    ;;
esac
