#!/bin/sh
# breakout-fuse.sh -- run breakout.dck (no input) in Fuse 1.9.1 with no window and no sound, record a movie and convert it
# to one .scr per refresh (6912 bytes each, the displayed screen).  Adapted from fuse-movie.sh.
#   sh arcade/tools/xemu/breakout-fuse.sh [CART.dck] [OUTDIR] [SECONDS]
# Defaults: arcade/build/breakout.dck, arcade/build/xemu/fuse-breakout, 15 seconds (about 750 refreshes; tick 60 is at
# about refresh 240 after the entry, which is refresh ~104).  Compare with breakout-compare.mjs.  OUTDIR is emptied of an earlier movie, so give a new one
# to keep the old.  The cartridge is the runtime v2 build (arcade/tools/arcadec.mjs arcade/examples/breakout.arc --assets arcade/examples/breakout.assets.json
# --runtime v2); order of the commands: see the header of breakout-tsrun.mjs.
set -e
here=$(cd "$(dirname "$0")/../../.." && pwd)
cart=${1:-$here/arcade/build/breakout.dck}; out=${2:-$here/arcade/build/xemu/fuse-breakout}; secs=${3:-15}
mkdir -p "$out"
rm -f "$out"/frame-*.scr "$out/movie.fmf"
env -u DISPLAY -u WAYLAND_DISPLAY SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy \
  timeout -s INT "$secs" fuse --machine ts2068 \
  --rom-ts2068-0 "$here/tsrun/roms/ts2068-0.rom" --rom-ts2068-1 "$here/tsrun/roms/ts2068-1.rom" \
  --no-sound --no-confirm-actions --no-autosave-settings \
  --movie-start "$out/movie.fmf" "$cart" > "$out/fuse.log" 2>&1 || true
fmfconv -S -y "$out/movie.fmf" "$out/frame.scr" > "$out/fmfconv.log" 2>&1
ls "$out"/frame-*.scr | wc -l
