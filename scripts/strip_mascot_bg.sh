#!/usr/bin/env bash
#
# strip_mascot_bg.sh — cobalt-background mascot art -> transparent-background PNGs.
#
# Two engines, same in/out contract:
#   rembg (default)   isnet-anime + alpha matting. isnet-anime is the model trained
#                     on anime line art; alpha matting re-solves the edge band that
#                     rembg otherwise leaves as a blue haze around white linework.
#   --chroma COLOR    ImageMagick flood fill seeded from a 1px border of COLOR, so
#                     only background CONNECTED TO THE EDGE is cleared. A global
#                     -transparent would punch holes in blue inside the character.
#
# Requires: python3 (rembg mode — run via `uvx` when present, else a local venv at
# scripts/.venv-mascot/; never the global python), and ImageMagick 7 `magick` or 6
# `convert` (--chroma mode only).
# FIRST RUN of rembg downloads ~170MB of model weights to ~/.u2net.
#
# Usage:
#   ./scripts/strip_mascot_bg.sh                     # all PNGs in the default raw dir
#   ./scripts/strip_mascot_bg.sh a.png some/dir      # explicit files and/or dirs
#   ./scripts/strip_mascot_bg.sh --chroma '#0002DA'  # duotone flood-fill fallback
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEFAULT_IN="${REPO_ROOT}/apps/mobile/assets/mascot/raw"
OUT_DIR="${REPO_ROOT}/apps/mobile/assets/mascot"
VENV_DIR="${SCRIPT_DIR}/.venv-mascot"

# --- tuning (env-overridable) ----------------------------------------------
REMBG_SPEC="${REMBG_SPEC:-rembg[cpu,cli]}"  # the `cli` extra is required: rembg[cpu] alone has no `i` command
REMBG_MODEL="${REMBG_MODEL:-isnet-anime}"
# Trimap for HARD-edged art: wide definite-fg/definite-bg zones and a thin erode,
# so matting only reworks the true 1-2px antialiased rim instead of smearing it.
ALPHA_FG="${ALPHA_FG:-240}"
ALPHA_BG="${ALPHA_BG:-20}"
ALPHA_ERODE="${ALPHA_ERODE:-5}"
CHROMA_FUZZ="${CHROMA_FUZZ:-10%}"

usage() {
  cat <<'EOF'
strip_mascot_bg.sh — make mascot PNGs transparent, ready for React Native.

  ./scripts/strip_mascot_bg.sh [--chroma COLOR] [input...]

  input        PNG file or directory of PNGs (non-recursive).
               Default: apps/mobile/assets/mascot/raw/
  --chroma C   Use ImageMagick edge-connected flood fill of color C
               (e.g. '#0002DA', the brand blue the raw art is painted on — the
               file's own pixels sit a shade off it, which CHROMA_FUZZ covers)
               instead of rembg. Best for strict duotone art.
  -h, --help   This message.

Output: apps/mobile/assets/mascot/<same-basename>.png (RGBA). Inputs are never
overwritten. Env overrides: REMBG_MODEL, ALPHA_FG, ALPHA_BG, ALPHA_ERODE,
CHROMA_FUZZ, REMBG_SPEC.
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

# --- args ------------------------------------------------------------------
CHROMA=""
INPUTS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) usage; exit 0 ;;
    --chroma)
      [ $# -ge 2 ] || die "--chroma needs a color, e.g. --chroma '#0002DA'"
      CHROMA="$2"; shift 2 ;;
    --chroma=*) CHROMA="${1#*=}"; shift ;;
    -*) die "unknown option: $1 (try --help)" ;;
    *) INPUTS+=("$1"); shift ;;
  esac
done
[ ${#INPUTS[@]} -gt 0 ] || INPUTS=("${DEFAULT_IN}")

# --- collect PNGs ----------------------------------------------------------
shopt -s nullglob
FILES=()
for src in "${INPUTS[@]}"; do
  if [ -d "${src}" ]; then
    for f in "${src}"/*.png "${src}"/*.PNG; do FILES+=("${f}"); done
  elif [ -f "${src}" ]; then
    FILES+=("${src}")
  else
    die "no such file or directory: ${src}"
  fi
done
shopt -u nullglob
[ ${#FILES[@]} -gt 0 ] || die "no PNGs found in: ${INPUTS[*]}"

# --- engine setup ----------------------------------------------------------
ENGINE_CMD=()
if [ -n "${CHROMA}" ]; then
  if command -v magick >/dev/null 2>&1; then
    ENGINE_CMD=(magick)
  elif command -v convert >/dev/null 2>&1; then
    ENGINE_CMD=(convert)
  else
    die "--chroma needs ImageMagick. Install it with:  brew install imagemagick"
  fi
  echo "==> engine: ImageMagick (${ENGINE_CMD[0]}), chroma ${CHROMA}, fuzz ${CHROMA_FUZZ}"
else
  command -v python3 >/dev/null 2>&1 || die "python3 not found — install it (brew install python) or use --chroma"
  if command -v uvx >/dev/null 2>&1; then
    ENGINE_CMD=(uvx --from "${REMBG_SPEC}" rembg)
  else
    if [ ! -x "${VENV_DIR}/bin/rembg" ]; then
      echo "==> creating venv ${VENV_DIR} and installing ${REMBG_SPEC} (one-time, several minutes)"
      python3 -m venv "${VENV_DIR}"
      "${VENV_DIR}/bin/python" -m pip install --quiet --upgrade pip
      "${VENV_DIR}/bin/python" -m pip install --quiet "${REMBG_SPEC}"
    fi
    ENGINE_CMD=("${VENV_DIR}/bin/rembg")
  fi
  echo "==> engine: rembg ${REMBG_MODEL}, alpha matting fg=${ALPHA_FG} bg=${ALPHA_BG} erode=${ALPHA_ERODE}"
  if [ ! -f "${HOME}/.u2net/${REMBG_MODEL}.onnx" ]; then
    echo "==> heads-up: first run downloads the ${REMBG_MODEL} weights (~170MB) to ~/.u2net — this takes a few minutes"
  fi
fi

# --- run -------------------------------------------------------------------
mkdir -p "${OUT_DIR}"
DONE_N=0
for in_file in "${FILES[@]}"; do
  out_file="${OUT_DIR}/$(basename "${in_file}")"
  if [ "$(cd "$(dirname "${in_file}")" && pwd)/$(basename "${in_file}")" = "${out_file}" ]; then
    echo "!!  skip $(basename "${in_file}") — input is the output path (would overwrite the source)" >&2
    continue
  fi
  echo "--> $(basename "${in_file}")"
  if [ -n "${CHROMA}" ]; then
    # The 1px border is the single flood seed that touches all four edges; -shave
    # removes it again. PNG32 forces a real RGBA channel in the output.
    "${ENGINE_CMD[@]}" "${in_file}" -alpha set \
      -bordercolor "${CHROMA}" -border 1 \
      -fuzz "${CHROMA_FUZZ}" -fill none -draw 'alpha 0,0 floodfill' \
      -shave 1x1 "PNG32:${out_file}"
  else
    "${ENGINE_CMD[@]}" i -m "${REMBG_MODEL}" \
      -a -af "${ALPHA_FG}" -ab "${ALPHA_BG}" -ae "${ALPHA_ERODE}" \
      "${in_file}" "${out_file}"
  fi
  DONE_N=$((DONE_N + 1))
done

echo "==> DONE. ${DONE_N} file(s) -> ${OUT_DIR}"
