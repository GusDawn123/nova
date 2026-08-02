#!/usr/bin/env bash
#
# make_blink_patch.sh — cut her closed eyes out of the mascot art as a small
# overlay patch, so a blink is a cross-fade of the EYE REGION ONLY.
#
# Why a patch and not a whole-frame swap: eyes-open.png and eyes-closed.png are
# two separate AI generations. Outside the eyes every hair strand and headphone
# stitch sits a few pixels off between them, so cross-fading the whole frame
# shimmers across the entire head.
#
# The BOX is the whole game, and the rule for choosing it is: its four edges must
# land where the two images already AGREE. Agreeing pixels cross-fade into
# themselves, so the border stays invisible at EVERY stage of the fade, not just
# at the ends. That rules out the bangs (they disagree strand for strand) and
# rules in the solid blue hair beside her face, the flat skin under her eyes, and
# the high band where the bangs go solid. SEAM below reports that agreement.
#
# Requires: uv (https://docs.astral.sh/uv/) — pillow is pulled per-run, no venv.
#
# Usage:
#   ./scripts/make_blink_patch.sh                       # regenerate the asset
#   PREVIEW_DIR=/tmp/look ./scripts/make_blink_patch.sh # previews somewhere else
#   BOX_TOP=460 ./scripts/make_blink_patch.sh           # re-cut the box
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ASSET_DIR="${REPO_ROOT}/apps/mobile/assets/mascot"
OPEN_PNG="${ASSET_DIR}/eyes-open.png"
CLOSED_PNG="${ASSET_DIR}/eyes-closed.png"

# --- the box ----------------------------------------------------------------
# PINNED BOX (420, 486, 812, 684) in the 1254x1254 source art = a 392x198 patch
# whose ORIGIN — the offset the overlay must be drawn at — is (420, 486).
# Chosen by the seam metric plus a look at every edge:
#   left 420 / right 812  solid blue hair; both read 0 differing px.
#   top  486   the highest-agreement row above the brows — every row between it
#              and the lashes cuts bangs that disagree strand by strand.
#   bottom 684 the widest strip of flat skin below the lashes, above the nose.
#
# CONSUMER CONTRACT, as fractions of the base frame so it survives any re-export
# of the art at another resolution — this is what MascotStage lays out with:
#   left 33.493%   top 38.756%   width 31.260%   height 15.789%
PIN_LEFT=420
PIN_TOP=486
PIN_RIGHT=812
PIN_BOTTOM=684

# Overridable ONLY to hunt for a better box, and an override never touches the
# committed asset (see OUT_PNG below) — eye-patch.png can only ever be produced
# by the box pinned above, so re-pinning means editing these four numbers.
BOX_LEFT="${BOX_LEFT:-${PIN_LEFT}}"
BOX_TOP="${BOX_TOP:-${PIN_TOP}}"
BOX_RIGHT="${BOX_RIGHT:-${PIN_RIGHT}}"
BOX_BOTTOM="${BOX_BOTTOM:-${PIN_BOTTOM}}"

PREVIEW_DIR="${PREVIEW_DIR:-${TMPDIR:-/tmp}}"

usage() {
  cat <<'EOF'
make_blink_patch.sh — cut the closed-eye overlay patch for the mascot blink.

  ./scripts/make_blink_patch.sh [-h]

Reads  apps/mobile/assets/mascot/eyes-{open,closed}.png (the TRANSPARENT ones).
Writes apps/mobile/assets/mascot/eye-patch.png, plus two throwaway previews in
$PREVIEW_DIR (blink-preview.png, blink-preview-zoom.png) — NEVER commit those.
Prints SEAM per edge: how many pixels along that border differ between the two
sources, and by how much. Near-zero is an invisible edge; hundreds of high-delta
pixels means the box is cutting through art.

Overriding any BOX_* value is an EXPERIMENT: the patch goes to $PREVIEW_DIR and
the committed asset is left alone. Re-pin by editing PIN_* in this file.

Env overrides: BOX_LEFT, BOX_TOP, BOX_RIGHT, BOX_BOTTOM, PREVIEW_DIR.
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

case "${1:-}" in
  -h | --help) usage; exit 0 ;;
  "") ;;
  *) die "unknown option: $1 (try --help)" ;;
esac

command -v uv >/dev/null 2>&1 || die "uv not found — install it: brew install uv"
[ -f "${OPEN_PNG}" ] || die "missing ${OPEN_PNG} (run strip_mascot_bg.sh first)"
[ -f "${CLOSED_PNG}" ] || die "missing ${CLOSED_PNG} (run strip_mascot_bg.sh first)"

# Reject a bad box HERE, where the message can name the variable — Pillow would
# only report it as a ValueError traceback, or worse, silently crop nothing.
check_coord() {
  case "$2" in
    "" | *[!0-9]*) die "$1 must be a whole number of pixels, got: '$2'" ;;
    0?*) die "$1 must not have a leading zero (the shell reads it as octal), got: '$2'" ;;
  esac
}
check_coord BOX_LEFT "${BOX_LEFT}"
check_coord BOX_TOP "${BOX_TOP}"
check_coord BOX_RIGHT "${BOX_RIGHT}"
check_coord BOX_BOTTOM "${BOX_BOTTOM}"
[ "${BOX_LEFT}" -lt "${BOX_RIGHT}" ] ||
  die "BOX_LEFT (${BOX_LEFT}) must be left of BOX_RIGHT (${BOX_RIGHT})"
[ "${BOX_TOP}" -lt "${BOX_BOTTOM}" ] ||
  die "BOX_TOP (${BOX_TOP}) must be above BOX_BOTTOM (${BOX_BOTTOM})"

mkdir -p "${PREVIEW_DIR}"

# An experimental box writes its patch beside the previews, never over the asset.
if [ "${BOX_LEFT},${BOX_TOP},${BOX_RIGHT},${BOX_BOTTOM}" \
  = "${PIN_LEFT},${PIN_TOP},${PIN_RIGHT},${PIN_BOTTOM}" ]; then
  OUT_PNG="${ASSET_DIR}/eye-patch.png"
  echo "==> box (${BOX_LEFT}, ${BOX_TOP}, ${BOX_RIGHT}, ${BOX_BOTTOM}) — the pinned box"
else
  OUT_PNG="${PREVIEW_DIR}/eye-patch-experiment.png"
  echo "==> box (${BOX_LEFT}, ${BOX_TOP}, ${BOX_RIGHT}, ${BOX_BOTTOM}) — EXPERIMENT"
  echo "    the pinned box is (${PIN_LEFT}, ${PIN_TOP}, ${PIN_RIGHT}, ${PIN_BOTTOM}), so the committed asset is untouched"
  echo "    this patch goes to ${OUT_PNG} instead"
fi

BOX_LEFT="${BOX_LEFT}" BOX_TOP="${BOX_TOP}" BOX_RIGHT="${BOX_RIGHT}" \
  BOX_BOTTOM="${BOX_BOTTOM}" OPEN_PNG="${OPEN_PNG}" CLOSED_PNG="${CLOSED_PNG}" \
  OUT_PNG="${OUT_PNG}" PREVIEW_DIR="${PREVIEW_DIR}" \
  uv run --quiet --with pillow python - <<'PY'
import os
from PIL import Image, ImageChops

env = os.environ
L, T, R, B = (int(env[k]) for k in ("BOX_LEFT", "BOX_TOP", "BOX_RIGHT", "BOX_BOTTOM"))
base = Image.open(env["OPEN_PNG"]).convert("RGBA")
closed = Image.open(env["CLOSED_PNG"]).convert("RGBA")
if base.size != closed.size:
    raise SystemExit(f"ERROR: source sizes differ: {base.size} vs {closed.size}")
W, H = base.size
if not (0 <= L < R <= W and 0 <= T < B <= H):
    raise SystemExit(f"ERROR: box ({L}, {T}, {R}, {B}) falls outside the {W}x{H} source art")


def onto_white(im):
    # The seam that matters most runs across her face, and a transparent PNG
    # hides it against whatever the viewer happens to render behind.
    bg = Image.new("RGB", im.size, (255, 255, 255))
    bg.paste(im, (0, 0), im)
    return bg


def out(name):
    return os.path.join(env["PREVIEW_DIR"], name)


patch = closed.crop((L, T, R, B))
patch.save(env["OUT_PNG"])

preview = base.copy()
preview.alpha_composite(patch, (L, T))
white = onto_white(preview)
white.save(out("blink-preview.png"))
m = 70
zoom = white.crop((L - m, T - m, R + m, B + m))
zoom.resize((zoom.width * 2, zoom.height * 2), Image.LANCZOS).save(out("blink-preview-zoom.png"))

delta = ImageChops.difference(onto_white(base), onto_white(closed)).convert("L").load()
print(f"==> patch {R - L}x{B - T} at origin ({L}, {T})")
print(
    f"    LAYOUT left {100 * L / W:.3f}%  top {100 * T / H:.3f}%  "
    f"width {100 * (R - L) / W:.3f}%  height {100 * (B - T) / H:.3f}%  of the base frame"
)
for name, pts in (
    ("top", [(x, T) for x in range(L, R)]),
    ("bottom", [(x, B) for x in range(L, R)]),
    ("left", [(L, y) for y in range(T, B)]),
    ("right", [(R, y) for y in range(T, B)]),
):
    v = [delta[x, y] for x, y in pts]
    print(f"    SEAM {name:<6} {sum(1 for i in v if i > 40):>4}/{len(v)} px differ, max delta {max(v)}")
PY

echo "==> DONE. ${OUT_PNG}"
echo "==> preview: ${PREVIEW_DIR}/blink-preview.png (+ -zoom.png)"
