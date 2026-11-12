#!/bin/sh
# shooter-fuse.sh -- run the SCRIPT-DRIVEN Starfall cartridge (arcade/build/shooter-script.dck, made by shooter-patch.mjs: the keyboard reads come from a per-tick table,
# because a headless Fuse cannot be fed keys per tick: the title, fire, the play scene, GAME OVER, fire again) in Fuse 1.9.1 with no window and no sound, record a movie and
# convert it to one .scr per refresh (6912 bytes, the displayed screen).  Adapted from runner-fuse.sh.  Order of the commands: see the header of shooter-tsrun.mjs.
#   sh arcade/tools/xemu/shooter-fuse.sh [CART.dck] [OUTDIR] [SECONDS]
# Defaults: arcade/build/shooter-script.dck, arcade/build/xemu/fuse-shooter-script, 60 seconds (the scenario's 513 ticks are about 1,700 refreshes of TSRun, 3 a tick plus the
# boot; the movie runs at 50 or 60 frames a second and the picture stays on after the last tick; Fuse's refresh rate is its own, so shooter-compare.mjs matches the frames to
# the ticks by screen, not by time).  OUTDIR must be new: an earlier movie is not overwritten.
set -e
here=$(cd "$(dirname "$0")/../../.." && pwd)
cart=${1:-$here/arcade/build/shooter-script.dck}; out=${2:-$here/arcade/build/xemu/fuse-shooter-script}; secs=${3:-60}
mkdir -p "$out"
if ls "$out"/frame-*.scr "$out/movie.fmf" >/dev/null 2>&1; then echo "$out already holds a movie: use a new OUTDIR" >&2; exit 1; fi
env -u DISPLAY -u WAYLAND_DISPLAY SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy \
  timeout -s INT "$secs" fuse --machine ts2068 \
  --rom-ts2068-0 "$here/tsrun/roms/ts2068-0.rom" --rom-ts2068-1 "$here/tsrun/roms/ts2068-1.rom" \
  --no-sound --no-confirm-actions --no-autosave-settings \
  --movie-start "$out/movie.fmf" "$cart" > "$out/fuse.log" 2>&1 || true
fmfconv -S -y "$out/movie.fmf" "$out/frame.scr" > "$out/fmfconv.log" 2>&1 || true
ls "$out"/frame-*.scr | wc -l
