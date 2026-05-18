#!/usr/bin/env bash
#
# regen-icons.sh
#
# Regenerates every icon Tauri references in src-tauri/tauri.conf.json
# (bundle.icon) from a single source PNG at src-tauri/icons/source.png.
#
# Uses macOS built-ins (sips + iconutil) so the produced .icns is a real
# Apple-format icns the Dock and LaunchServices will trust. Pillow's icns
# writer has historically produced files macOS silently rejects, which is
# how we ended up with the placeholder doc icon in the Dock.
#
# IMPORTANT: source.png MUST already be inset to Apple's macOS template
# safe area (visual mark within ~824x824 centered in 1024x1024, leaving
# roughly 100px of transparent margin on each side). If you have a full
# bleed master, drop it at src-tauri/icons/source-fullbleed.png and this
# script will inset it into source.png automatically before generating
# the rest. The inset step uses Pillow's LANCZOS resampling.
#
# Why the inset matters: macOS draws every app icon inside a uniform
# bounding box. Apps that fill the whole canvas appear visibly LARGER
# than neighbours in the Dock because the system has no padding to
# absorb. Apple's template gives the system that breathing room. See:
# https://developer.apple.com/design/resources/ ("macOS App Icon").
#
# Run from the app/ directory:
#   bash scripts/regen-icons.sh
# or via the npm script:
#   npm run icons:rebuild
#
# Inputs:
#   src-tauri/icons/source.png            (1024x1024 PNG, already inset)
#   src-tauri/icons/source-fullbleed.png  (optional, will be inset for you)
#
# Outputs (overwritten):
#   src-tauri/icons/32x32.png
#   src-tauri/icons/128x128.png
#   src-tauri/icons/128x128@2x.png
#   src-tauri/icons/icon.png      (512x512 master for Linux)
#   src-tauri/icons/icon.icns     (built via iconutil, 10 embedded variants)
#   src-tauri/icons/icon.ico      (multi-size Windows .ico via Pillow)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ICONS_DIR="$APP_DIR/src-tauri/icons"
SRC="$ICONS_DIR/source.png"
FULLBLEED="$ICONS_DIR/source-fullbleed.png"
ICONSET="$ICONS_DIR/icon.iconset"

# Apple macOS Big Sur+ icon template: visual mark fits in 824x824 centred
# inside the 1024x1024 canvas, which leaves a 100px transparent margin
# on every side. The Dock relies on that margin for visual sizing.
CANVAS_PX=1024
MARK_PX=824

if ! command -v sips >/dev/null 2>&1; then
  echo "regen-icons: 'sips' not found. This script requires macOS." >&2
  exit 1
fi

if ! command -v iconutil >/dev/null 2>&1; then
  echo "regen-icons: 'iconutil' not found. This script requires macOS." >&2
  exit 1
fi

# Step 0: optional auto-inset. If a fullbleed master is present we re-derive
# source.png from it every run so the inset is deterministic.
if [[ -f "$FULLBLEED" ]]; then
  echo "regen-icons: auto-insetting $FULLBLEED -> $SRC"
  if ! command -v python3 >/dev/null 2>&1; then
    echo "regen-icons: python3 required to inset the full-bleed master" >&2
    exit 1
  fi
  python3 - "$FULLBLEED" "$SRC" "$CANVAS_PX" "$MARK_PX" <<'PY'
import sys
try:
    from PIL import Image
except ImportError:
    sys.stderr.write("regen-icons: Pillow is required to inset source-fullbleed.png\n")
    sys.exit(2)
src_path, dst_path, canvas, mark = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
img = Image.open(src_path).convert("RGBA")
if img.size != (canvas, canvas):
    img = img.resize((canvas, canvas), Image.LANCZOS)
inset = img.resize((mark, mark), Image.LANCZOS)
canvas_img = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
offset = (canvas - mark) // 2
canvas_img.paste(inset, (offset, offset), inset)
canvas_img.save(dst_path, "PNG", optimize=True)
PY
fi

if [[ ! -f "$SRC" ]]; then
  echo "regen-icons: missing $SRC" >&2
  echo "Drop a 1024x1024 PNG at src-tauri/icons/source.png and rerun." >&2
  echo "(Alternatively, drop a full-bleed master at source-fullbleed.png and" >&2
  echo " the script will inset it for you.)" >&2
  exit 1
fi

echo "regen-icons: source = $SRC"
SRC_DIMS=$(sips -g pixelWidth -g pixelHeight "$SRC" | awk '/pixel(Width|Height)/ {print $2}' | paste -sd "x" -)
echo "regen-icons: source dimensions = $SRC_DIMS"

# Every output below is resampled from the 1024x1024 master in a single hop
# (not via intermediates). This keeps small-size variants sharp because each
# downsample is high-quality LANCZOS rather than a chain of nearest-neighbours.

echo "regen-icons: building Tauri per-platform PNGs"
sips -z 32 32     "$SRC" --out "$ICONS_DIR/32x32.png"        >/dev/null
sips -z 128 128   "$SRC" --out "$ICONS_DIR/128x128.png"      >/dev/null
sips -z 256 256   "$SRC" --out "$ICONS_DIR/128x128@2x.png"   >/dev/null
sips -z 512 512   "$SRC" --out "$ICONS_DIR/icon.png"         >/dev/null

# Apple .icns via iconutil. Requires the exact 10-file iconset layout.
# Each variant is freshly resampled from the master; we never copy a smaller
# file forward as a larger one's @2x.
echo "regen-icons: building $ICONSET (all 10 variants from 1024px master)"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
sips -z 16 16     "$SRC" --out "$ICONSET/icon_16x16.png"        >/dev/null
sips -z 32 32     "$SRC" --out "$ICONSET/icon_16x16@2x.png"     >/dev/null
sips -z 32 32     "$SRC" --out "$ICONSET/icon_32x32.png"        >/dev/null
sips -z 64 64     "$SRC" --out "$ICONSET/icon_32x32@2x.png"     >/dev/null
sips -z 128 128   "$SRC" --out "$ICONSET/icon_128x128.png"      >/dev/null
sips -z 256 256   "$SRC" --out "$ICONSET/icon_128x128@2x.png"   >/dev/null
sips -z 256 256   "$SRC" --out "$ICONSET/icon_256x256.png"      >/dev/null
sips -z 512 512   "$SRC" --out "$ICONSET/icon_256x256@2x.png"   >/dev/null
sips -z 512 512   "$SRC" --out "$ICONSET/icon_512x512.png"      >/dev/null
cp "$SRC"                       "$ICONSET/icon_512x512@2x.png"

echo "regen-icons: running iconutil"
iconutil -c icns "$ICONSET" -o "$ICONS_DIR/icon.icns"
rm -rf "$ICONSET"

# Windows .ico via Pillow (preferred) or sips fallback. Pillow writes a real
# multi-resolution .ico; sips microsoft-icon path has been known to segfault.
echo "regen-icons: building Windows icon.ico"
TMP_ICO_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_ICO_DIR"' EXIT
for size in 16 32 48 64 128 256; do
  sips -z "$size" "$size" "$SRC" --out "$TMP_ICO_DIR/icon_${size}.png" >/dev/null
done

ICO_WRITTEN=0
if command -v python3 >/dev/null 2>&1; then
  if python3 - "$SRC" "$ICONS_DIR/icon.ico" <<'PY'
import sys
try:
    from PIL import Image
except ImportError:
    sys.exit(2)
src, dst = sys.argv[1], sys.argv[2]
img = Image.open(src).convert("RGBA")
sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
img.save(dst, format="ICO", sizes=sizes)
PY
  then
    ICO_WRITTEN=1
    echo "regen-icons: wrote icon.ico via Pillow"
  else
    echo "regen-icons: Pillow path unavailable, trying sips" >&2
  fi
fi

if [[ $ICO_WRITTEN -eq 0 ]]; then
  if sips -s format microsoft-icon "$TMP_ICO_DIR/icon_256.png" --out "$ICONS_DIR/icon.ico" >/dev/null 2>&1; then
    ICO_WRITTEN=1
    echo "regen-icons: wrote icon.ico via sips"
  else
    echo "regen-icons: sips microsoft-icon path failed; keeping prior icon.ico in place" >&2
  fi
fi

# Final summary so the operator can eyeball every generated file in one place.
echo ""
echo "regen-icons: done. Output summary:"
printf '  %-32s %s\n' "FILE" "DETAILS"
for f in 32x32.png 128x128.png 128x128@2x.png icon.png icon.icns icon.ico; do
  full="$ICONS_DIR/$f"
  if [[ -f "$full" ]]; then
    sz=$(stat -f '%z' "$full")
    info=$(file -b "$full")
    printf '  %-32s %8d bytes  %s\n' "$f" "$sz" "$info"
  else
    printf '  %-32s MISSING\n' "$f"
  fi
done
