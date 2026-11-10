#!/bin/sh
# platformer-fuse.sh -- run the SCRIPT-DRIVEN platformer cartridge (arcade/build/platformer-script.dck, made by platformer-patch.mjs: the keyboard
# reads come from a per-tick table, because a headless Fuse cannot be fed keys per tick) in Fuse 1.9.1 with no window and no sound, record a
# movie and convert it to one .scr per refresh (6912 bytes, the displayed screen).  Adapted from shooter-fuse.sh.
#   sh arcade/tools/xemu/platformer-fuse.sh [CART.dck] [OUTDIR] [SECONDS]
# Defaults: arcade/build/platformer-script.dck, arcade/build/xemu/fuse-platformer, 45 seconds (170 ticks take about 630 TSRun refreshes; Fuse's refresh
# rate is its own, so platformer-compare.mjs matches the frames to the ticks by screen, not by time).
set -e
here=$(cd "$(dirname "$0")/../../.." && pwd)
cart=${1:-$here/arcade/build/platformer-script.dck}; out=${2:-$here/arcade/build/xemu/fuse-platformer}; secs=${3:-45}
mkdir -p "$out"
rm -f "$out"/frame-*.scr "$out/movie.fmf"
env -u DISPLAY -u WAYLAND_DISPLAY SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy \
  timeout -s INT "$secs" fuse --machine ts2068 \
  --rom-ts2068-0 "$here/tsrun/roms/ts2068-0.rom" --rom-ts2068-1 "$here/tsrun/roms/ts2068-1.rom" \
  --no-sound --no-confirm-actions --no-autosave-settings \
  --movie-start "$out/movie.fmf" "$cart" > "$out/fuse.log" 2>&1 || true
fmfconv -S -y "$out/movie.fmf" "$out/frame.scr" > "$out/fmfconv.log" 2>&1 || true
ls "$out"/frame-*.scr | wc -l
