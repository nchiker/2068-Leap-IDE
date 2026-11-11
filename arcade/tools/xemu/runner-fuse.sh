#!/bin/sh
# runner-fuse.sh -- run the SCRIPT-DRIVEN Leap Runner cartridge (arcade/build/runner-script.dck, made by runner-patch.mjs: the keyboard
# reads come from a per-tick table, because a headless Fuse cannot be fed keys per tick) in Fuse 1.9.1 with no window and no sound, record a
# movie and convert it to one .scr per refresh (6912 bytes, the displayed screen).  Adapted from platformer-fuse.sh.
#   sh arcade/tools/xemu/runner-fuse.sh [CART.dck] [OUTDIR] [SECONDS]
# Defaults: arcade/build/runner-script.dck, arcade/build/xemu/fuse-runner, 100 seconds (a tick takes about 4 refreshes plus the ticks that overrun, the level changes among them; the movie
# runs at 60 frames a second, so 1,000 ticks take about 70 s; Fuse's refresh rate is its own, so runner-compare.mjs matches the frames to the ticks by screen, not by time).
set -e
here=$(cd "$(dirname "$0")/../../.." && pwd)
cart=${1:-$here/arcade/build/runner-script.dck}; out=${2:-$here/arcade/build/xemu/fuse-runner}; secs=${3:-100}
mkdir -p "$out"
if ls "$out"/frame-*.scr "$out/movie.fmf" >/dev/null 2>&1; then echo "$out already holds a movie: use a new OUTDIR" >&2; exit 1; fi
env -u DISPLAY -u WAYLAND_DISPLAY SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy \
  timeout -s INT "$secs" fuse --machine ts2068 \
  --rom-ts2068-0 "$here/tsrun/roms/ts2068-0.rom" --rom-ts2068-1 "$here/tsrun/roms/ts2068-1.rom" \
  --no-sound --no-confirm-actions --no-autosave-settings \
  --movie-start "$out/movie.fmf" "$cart" > "$out/fuse.log" 2>&1 || true
fmfconv -S -y "$out/movie.fmf" "$out/frame.scr" > "$out/fmfconv.log" 2>&1 || true
ls "$out"/frame-*.scr | wc -l
