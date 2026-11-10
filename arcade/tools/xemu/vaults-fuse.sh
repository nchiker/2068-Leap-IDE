#!/bin/sh
# vaults-fuse.sh -- run the SCRIPT-DRIVEN Vaults cartridge (arcade/build/vaults-script.dck, made by vaults-patch.mjs: the keyboard
# reads come from a per-tick table, because a headless Fuse cannot be fed keys per tick) in Fuse 1.9.1 with no window and no sound, record a
# movie and convert it to one .scr per refresh (6912 bytes, the displayed screen).  Adapted from platformer-fuse.sh.
#   sh arcade/tools/xemu/vaults-fuse.sh [CART.dck] [OUTDIR] [SECONDS]
# Defaults: arcade/build/vaults-script.dck, arcade/build/xemu/fuse-vaults, 40 seconds (250 ticks take 1,134 refreshes = about 19 s at 60 Hz, 4 refreshes a tick plus the ticks that overrun; Fuse's refresh
# rate is its own, so vaults-compare.mjs matches the frames to the ticks by screen, not by time).
set -e
here=$(cd "$(dirname "$0")/../../.." && pwd)
cart=${1:-$here/arcade/build/vaults-script.dck}; out=${2:-$here/arcade/build/xemu/fuse-vaults}; secs=${3:-40}
mkdir -p "$out"
if ls "$out"/frame-*.scr "$out/movie.fmf" >/dev/null 2>&1; then echo "$out already holds a movie: use a new OUTDIR" >&2; exit 1; fi
env -u DISPLAY -u WAYLAND_DISPLAY SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy \
  timeout -s INT "$secs" fuse --machine ts2068 \
  --rom-ts2068-0 "$here/tsrun/roms/ts2068-0.rom" --rom-ts2068-1 "$here/tsrun/roms/ts2068-1.rom" \
  --no-sound --no-confirm-actions --no-autosave-settings \
  --movie-start "$out/movie.fmf" "$cart" > "$out/fuse.log" 2>&1 || true
fmfconv -S -y "$out/movie.fmf" "$out/frame.scr" > "$out/fmfconv.log" 2>&1 || true
ls "$out"/frame-*.scr | wc -l
