#!/bin/sh
# fuse.sh -- run a bank probe cartridge in Fuse 1.9.1 (no window, no sound), record a movie, convert it to one .scr per
# refresh, and classify every frame with fuse-check.mjs.
#   sh fuse.sh [CART.dck] [OUTDIR] [SECONDS]
# Defaults: build/probe.dck, build/fuse, 25 seconds.  (As arcade/tools/xemu/fuse-movie.sh.)
set -e
here=$(cd "$(dirname "$0")/../../.." && pwd)
bank=$here/arcade/spike/bank
cart=${1:-$bank/build/probe.dck}; out=${2:-$bank/build/fuse}; secs=${3:-25}
mkdir -p "$out"
rm -f "$out"/frame-*.scr "$out/movie.fmf"
env -u DISPLAY -u WAYLAND_DISPLAY SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy \
  timeout -s INT "$secs" fuse --machine ts2068 \
  --rom-ts2068-0 "$here/tsrun/roms/ts2068-0.rom" --rom-ts2068-1 "$here/tsrun/roms/ts2068-1.rom" \
  --no-sound --no-confirm-actions --no-autosave-settings \
  --movie-start "$out/movie.fmf" "$cart" > "$out/fuse.log" 2>&1 || true
fmfconv -S -y "$out/movie.fmf" "$out/frame.scr" > "$out/fmfconv.log" 2>&1 || true
ls "$out"/frame-*.scr | wc -l
node "$bank/fuse-check.mjs" "$out"
