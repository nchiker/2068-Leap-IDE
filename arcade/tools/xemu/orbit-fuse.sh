#!/bin/sh
# orbit-fuse.sh -- run the SCRIPT-DRIVEN Orbit Gates cartridge (arcade/build/orbit-script.dck, made by orbit-patch.mjs: the keyboard
# reads come from a per-tick table, because a headless Fuse cannot be fed keys per tick) in Fuse 1.9.1 with no window and no sound, record a
# movie and convert it to one .scr per refresh (6912 bytes, the displayed screen).  Adapted from platformer-fuse.sh.
#   sh arcade/tools/xemu/orbit-fuse.sh [CART.dck] [OUTDIR] [SECONDS]
# Defaults: arcade/build/orbit-script.dck, arcade/build/xemu/fuse-orbit, 75 seconds (315 ticks take about 1,750 refreshes = about 30 s at 60 Hz, 5 refreshes a tick (FRAMERATE 12) plus the ticks that overrun and the scene switches; Fuse's refresh
# rate is its own, so orbit-compare.mjs matches the frames to the ticks by screen, not by time).
set -e
here=$(cd "$(dirname "$0")/../../.." && pwd)
cart=${1:-$here/arcade/build/orbit-script.dck}; out=${2:-$here/arcade/build/xemu/fuse-orbit}; secs=${3:-75}
mkdir -p "$out"
if ls "$out"/frame-*.scr "$out/movie.fmf" >/dev/null 2>&1; then echo "$out already holds a movie: use a new OUTDIR" >&2; exit 1; fi
env -u DISPLAY -u WAYLAND_DISPLAY SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy \
  timeout -s INT "$secs" fuse --machine ts2068 \
  --rom-ts2068-0 "$here/tsrun/roms/ts2068-0.rom" --rom-ts2068-1 "$here/tsrun/roms/ts2068-1.rom" \
  --no-sound --no-confirm-actions --no-autosave-settings \
  --movie-start "$out/movie.fmf" "$cart" > "$out/fuse.log" 2>&1 || true
fmfconv -S -y "$out/movie.fmf" "$out/frame.scr" > "$out/fmfconv.log" 2>&1 || true
ls "$out"/frame-*.scr | wc -l
