#!/bin/sh
# fuse-movie.sh -- run a cartridge (.dck) in Fuse 1.9.1 with no window and no sound, record a movie, and convert it to
# one .scr (6912 bytes: the displayed screen) per refresh.  As cartridge-build/README.md describes.
#   sh arcade/tools/xemu/fuse-movie.sh CART.dck OUTDIR [SECONDS]
# The movie is about 50 refreshes a second; 20 seconds gives ~960 refreshes.  Compare the .scr files with
# arcade/tools/xemu/tsrun-screens.mjs --dir OUTDIR.
set -e
cart=$1; out=$2; secs=${3:-20}
here=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$out"
env -u DISPLAY -u WAYLAND_DISPLAY SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy \
  timeout -s INT "$secs" fuse --machine ts2068 \
  --rom-ts2068-0 "$here/tsrun/roms/ts2068-0.rom" --rom-ts2068-1 "$here/tsrun/roms/ts2068-1.rom" \
  --no-sound --no-confirm-actions --no-autosave-settings \
  --movie-start "$out/movie.fmf" "$cart" > "$out/fuse.log" 2>&1 || true
fmfconv -S -y "$out/movie.fmf" "$out/frame.scr" > "$out/fmfconv.log" 2>&1
ls "$out"/frame-*.scr | wc -l
