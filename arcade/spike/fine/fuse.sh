#!/bin/sh
# fuse.sh -- run an F1 cartridge in Fuse 1.9.1 (no window, no sound), record a movie and convert it to PPM screenshots (2 a second),
# for xemu.mjs compare (the last frame is the stopped picture).  As arcade/tools/xemu/fuse-movie.sh.
#   sh arcade/spike/fine/fuse.sh build/xB [SECONDS=22]
set -e
here=$(cd "$(dirname "$0")/../../.." && pwd)
dir=$(cd "$1" && pwd); secs=${2:-22}
out=$dir/fuse
mkdir -p "$out"
rm -f "$out"/frame-*.ppm "$out/movie.fmf"
env -u DISPLAY -u WAYLAND_DISPLAY SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy \
  timeout -s INT "$secs" fuse --machine ts2068 \
  --rom-ts2068-0 "$here/tsrun/roms/ts2068-0.rom" --rom-ts2068-1 "$here/tsrun/roms/ts2068-1.rom" \
  --no-sound --no-confirm-actions --no-autosave-settings \
  --movie-start "$out/movie.fmf" "$dir/fine.dck" > "$out/fuse.log" 2>&1 || true
fmfconv -P -f 2 -y "$out/movie.fmf" "$out/frame.ppm" > "$out/fmfconv.log" 2>&1 || true
ls "$out"/frame-*.ppm | wc -l
