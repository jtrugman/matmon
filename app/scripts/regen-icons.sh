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
# Run from the app/ directory:
#   bash scripts/regen-icons.sh
# or via the npm script:
#   npm run icons:rebuild
#
# Inputs:
#   src-tauri/icons/source.png   (1024x1024 PNG, RGBA preferred)
#
# Outputs (overwritten):
#   src-tauri/icons/32x32.png
#   src-tauri/icons/128x128.png
#   src-tauri/icons/128x128@2x.png
#   src-tauri/icons/icon.png      (512x512 master)
#   src-tauri/icons/icon.icns     (built via iconutil)
#   src-tauri/icons/icon.ico      (multi-size Windows .ico via sips)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ICONS_DIR="$APP_DIR/src-tauri/icons"
SRC="$ICONS_DIR/source.png"
ICONSET="$ICONS_DIR/icon.iconset"

if [[ ! -f "$SRC" ]]; then
  echo "regen-icons: missing $SRC" >&2
  echo "Drop a 1024x1024 PNG at src-tauri/icons/source.png and rerun." >&2
  exit 1
fi

if ! command -v sips >/dev/null 2>&1; then
  echo "regen-icons: 'sips' not found. This script requires macOS." >&2
  exit 1
fi

if ! command -v iconutil >/dev/null 2>&1; then
  echo "regen-icons: 'iconutil' not found. This script requires macOS." >&2
  exit 1
fi

echo "regen-icons: source = $SRC"
SRC_DIMS=$(sips -g pixelWidth -g pixelHeight "$SRC" | awk '/pixel(Width|Height)/ {print $2}' | paste -sd "x" -)
echo "regen-icons: source dimensions = $SRC_DIMS"

# Tauri's per-platform PNGs (live next to icon.icns / icon.ico).
echo "regen-icons: building Tauri PNG set"
sips -z 32 32     "$SRC" --out "$ICONS_DIR/32x32.png"        >/dev/null
sips -z 128 128   "$SRC" --out "$ICONS_DIR/128x128.png"      >/dev/null
sips -z 256 256   "$SRC" --out "$ICONS_DIR/128x128@2x.png"   >/dev/null
sips -z 512 512   "$SRC" --out "$ICONS_DIR/icon.png"         >/dev/null

# Apple .icns via iconutil. Requires the exact 10-file iconset layout.
echo "regen-icons: building $ICONSET"
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
cp "$SRC" "$ICONSET/icon_512x512@2x.png"

echo "regen-icons: running iconutil"
iconutil -c icns "$ICONSET" -o "$ICONS_DIR/icon.icns"
rm -rf "$ICONSET"

# Windows .ico. sips will write a multi-size .ico when targeting microsoft-icon.
echo "regen-icons: building Windows icon.ico"
TMP_ICO_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_ICO_DIR"' EXIT
for size in 16 32 48 64 128 256; do
  sips -z "$size" "$size" "$SRC" --out "$TMP_ICO_DIR/icon_${size}.png" >/dev/null
done
# sips can emit .ico directly; fall back to the 256 PNG renamed if it can't.
if ! sips -s format microsoft-icon "$TMP_ICO_DIR/icon_256.png" --out "$ICONS_DIR/icon.ico" >/dev/null 2>&1; then
  echo "regen-icons: sips microsoft-icon path failed; keeping prior icon.ico in place" >&2
fi

echo "regen-icons: done"
echo "  $(file "$ICONS_DIR/icon.icns")"
echo "  $(file "$ICONS_DIR/icon.png")"
echo "  $(file "$ICONS_DIR/icon.ico")"
