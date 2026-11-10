#!/bin/sh
# shooter-fuse.sh -- run shooter.dck (no input) in Fuse 1.9.1 with no window and no sound, record a movie and convert it to one
# .scr per refresh (6912 bytes, the displayed screen).  Adapted from breakout-fuse.sh.
#   sh arcade/tools/xemu/shooter-fuse.sh [CART.dck] [OUTDIR] [SECONDS]
# Defaults: arcade/build/shooter.dck, arcade/build/xemu/fuse-shooter, 30 seconds (about 1400 refreshes at 50 Hz, enough for
# tick 200 at 3 refreshes a tick; Fuse's refresh rate is its own, so the frames are matched by screen, not by time).
set -e
here=$(cd "$(dirname "$0")/../../.." && pwd)
cart=${1:-$here/arcade/build/shooter.dck}; out=${2:-$here/arcade/build/xemu/fuse-shooter}; secs=${3:-30}
mkdir -p "$out"
rm -f "$out"/frame-*.scr "$out/movie.fmf"
env -u DISPLAY -u WAYLAND_DISPLAY SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy \
  timeout -s INT "$secs" fuse --machine ts2068 \
  --rom-ts2068-0 "$here/tsrun/roms/ts2068-0.rom" --rom-ts2068-1 "$here/tsrun/roms/ts2068-1.rom" \
  --no-sound --no-confirm-actions --no-autosave-settings \
  --movie-start "$out/movie.fmf" "$cart" > "$out/fuse.log" 2>&1 || true
fmfconv -S -y "$out/movie.fmf" "$out/frame.scr" > "$out/fmfconv.log" 2>&1 || true
ls "$out"/frame-*.scr | wc -l
