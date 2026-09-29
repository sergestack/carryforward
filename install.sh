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

# The extractor ships in this checkout. Verify it before creating any link.
VENDOR="${ROOT}/third_party/cli-continues"
required=(
  "${VENDOR}/LICENSE"
  "${VENDOR}/VENDOR.json"
  "${VENDOR}/package.json"
  "${VENDOR}/package-lock.json"
  "${VENDOR}/dist/parsers/codex.js"
  "${VENDOR}/dist/parsers/claude.js"
  "${VENDOR}/dist/config/index.js"
  "${VENDOR}/dist/utils/resume.js"
  "${VENDOR}/node_modules/chalk/package.json"
  "${VENDOR}/node_modules/yaml/package.json"
  "${VENDOR}/node_modules/zod/package.json"
  "${VENDOR}/node_modules/@clack/prompts/dist/index.mjs"
)
for file in "${required[@]}"; do
  if [[ ! -f "${file}" ]]; then
    echo "CarryForward could not install: the bundled cli-continues extractor is incomplete." >&2
    echo "Missing ${file#"${ROOT}/"}." >&2
    echo "cli-continues ships inside this checkout. Re-clone CarryForward. Nothing was linked." >&2
    exit 1
  fi
done

ROOT="${ROOT}" node --input-type=module <<'EOF'
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.env.ROOT;
const vendorDir = path.join(root, 'third_party', 'cli-continues');
const vendor = JSON.parse(fs.readFileSync(path.join(vendorDir, 'VENDOR.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(vendorDir, 'package.json'), 'utf8'));
const pin = 'e486cd22a592d89d890cff056624647fbe9cbe80';
if (vendor.package !== 'cli-continues' || vendor.version !== '4.1.1' || pkg.version !== '4.1.1' || vendor.commit !== pin) {
  console.error(`CarryForward could not install: bundled cli-continues is not pin 4.1.1 ${pin}.`);
  console.error(`Found package ${pkg.version || '(missing)'} and vendor commit ${vendor.commit || '(missing)'}.`);
  console.error('Nothing was linked.');
  process.exit(1);
}
const sums = vendor.sha256 || {};
for (const rel of Object.keys(sums)) {
  const file = path.join(vendorDir, rel);
  const got = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (got !== sums[rel]) {
    console.error(`CarryForward could not install: cli-continues checksum mismatch for ${rel}.`);
    console.error('The bundled extractor does not match VENDOR.json. Re-clone CarryForward. Nothing was linked.');
    process.exit(1);
  }
}
EOF

mkdir -p "${BIN_DIR}"

if [[ -e "${TARGET}" && ! -L "${TARGET}" ]]; then
  echo "Refusing to replace ${TARGET}: it is not a symlink." >&2
  exit 1
fi

ln -sfn "${ROOT}/bin/carryforward" "${TARGET}"
echo "Installed ${TARGET} -> ${ROOT}/bin/carryforward"
echo "Extractor: bundled cli-continues 4.1.1"

case ":${PATH}:" in
  *":${BIN_DIR}:"*)
    echo "Next: carryforward setup"
    ;;
  *)
    echo "${BIN_DIR} is not on PATH."
    echo "Next: ${TARGET} setup"
    ;;
esac
