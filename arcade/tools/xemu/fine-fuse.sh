#!/bin/sh
# fine-fuse.sh -- run the SCRIPT-DRIVEN cartridge of a fine-colour sample game (arcade/build/<game>-script.dck, made by fine-patch.mjs: the keyboard reads come from a per-tick table,
# because a headless Fuse cannot be fed keys per tick) in Fuse 1.9.1 with no window and no sound, record a movie and convert EVERY refresh to a PPM (320 x 240 RGB: the screen with
# its border; a .scr would hold only the 6,912 bytes of the standard screen, not mode 2's colour plane).  Adapted from orbit-fuse.sh and arcade/spike/fine/fuse.sh.
#   sh arcade/tools/xemu/fine-fuse.sh shooter|lumen [OUTDIR] [SECONDS]
# Defaults: OUTDIR arcade/build/xemu/fuse-<game>-fine (must be new or empty of frames), SECONDS 34 for shooter (347 ticks = about 1,250 refreshes = 21 s at 60 Hz) and 56 for lumen
# (687 ticks = about 2,400 refreshes = 40 s), a margin for Fuse's start; the movie runs on past the script's last tick, which fine-compare.mjs leaves out; Fuse's refresh rate is its own, so fine-compare.mjs matches the frames to the ticks by picture, not by time.
# About 230 KB a frame: 400 to 600 MB for a run (arcade/build is git-ignored; delete the directory when done).
set -e
game=${1:?usage: fine-fuse.sh shooter|lumen [OUTDIR] [SECONDS]}
here=$(cd "$(dirname "$0")/../../.." && pwd)
case "$game" in shooter) secs=${3:-34};; lumen) secs=${3:-56};; *) echo "unknown game $game" >&2; exit 2;; esac
cart=$here/arcade/build/$game-script.dck
out=${2:-$here/arcade/build/xemu/fuse-$game-fine}
mkdir -p "$out"
if ls "$out"/frame-*.ppm "$out/movie.fmf" >/dev/null 2>&1; then echo "$out already holds a movie: use a new OUTDIR" >&2; exit 1; fi
env -u DISPLAY -u WAYLAND_DISPLAY SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy \
  timeout -s INT "$secs" fuse --machine ts2068 \
  --rom-ts2068-0 "$here/tsrun/roms/ts2068-0.rom" --rom-ts2068-1 "$here/tsrun/roms/ts2068-1.rom" \
  --no-sound --no-confirm-actions --no-autosave-settings \
  --movie-start "$out/movie.fmf" "$cart" > "$out/fuse.log" 2>&1 || true
fmfconv -P -y "$out/movie.fmf" "$out/frame.ppm" > "$out/fmfconv.log" 2>&1 || true
ls "$out"/frame-*.ppm | wc -l
