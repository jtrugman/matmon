#!/usr/bin/env bash
#
# flush-icon-cache.sh
#
# Forces macOS to forget any cached app icons AND dock tooltip names.
# Use this when the Dock or Finder is still showing a stale Matmon icon,
# or when the dock tooltip / Cmd+Tab switcher still shows the old app
# name (e.g. lowercase "matmon" instead of capitalized "Matmon") after
# you've rebuilt the bundle.
#
# macOS caches the CFBundleName / CFBundleDisplayName string alongside
# the icon in LaunchServices and IconServices, so a fresh bundle with a
# new productName will keep showing the previous name until those caches
# are wiped. This script wipes both the systemwide IconServices store
# and the per-user IconServices / Dock icon caches under
# /private/var/folders, then bounces Dock and Finder so they pick up
# both the fresh icns AND the fresh bundle name from Matmon.app.
#
# !! REQUIRES SUDO. !! This script removes system-level cache files under
# /Library/Caches and /private/var/folders and will prompt for your
# password. It is destructive only of caches (macOS will rebuild them on
# demand), but the Dock and Finder both get restarted, so save any work
# in Finder windows before running.
#
# DO NOT call this from regen-icons.sh or any other automated workflow.
# It needs an interactive operator to type the sudo password and to
# accept the Dock/Finder restart.
#
# Safe to run repeatedly. Requires sudo for the systemwide cache.
#
# Run from anywhere (the script is self-contained) or via:
#   npm run icons:flush
#

set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "flush-icon-cache: this script only does anything useful on macOS." >&2
  exit 1
fi

echo "flush-icon-cache: clearing /Library/Caches/com.apple.iconservices.store (requires sudo)"
sudo rm -rfv /Library/Caches/com.apple.iconservices.store || true

echo "flush-icon-cache: clearing per-user IconServices and Dock icon caches under /private/var/folders"
sudo find /private/var/folders/ \
  \( -name com.apple.dock.iconcache -or -name com.apple.iconservices \) \
  -exec rm -rfv {} \; 2>/dev/null || true

echo "flush-icon-cache: restarting Dock"
killall Dock || true

echo "flush-icon-cache: restarting Finder"
killall Finder || true

echo "flush-icon-cache: done. Reopen the app and the Dock should pick up the fresh icon."
