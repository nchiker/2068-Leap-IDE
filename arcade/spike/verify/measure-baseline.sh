#!/bin/bash
# Stage 0 baseline (docs/ARCADE_STUDIO_COMPLETION_CONTRACT.md section 2.1): times every suite outside run-all, one at a time, then
# run-all --full --jobs 4. Started detached on 2026-11-13; results in arcade/spike/verify/baseline-*.txt (commit them next session).
cd "$(dirname "$0")/../../.." || exit 1
OUT=arcade/spike/verify
echo "started $(date -Is) at $(git rev-parse --short HEAD)" > $OUT/baseline-other.txt
for s in tests/studio-smoke.mjs tests/sprite-editor-smoke.mjs tests/tile-editor-smoke.mjs tests/map-editor-smoke.mjs tests/sound-editor-smoke.mjs \
         tests/arcade-project.mjs tests/arcade-assetcheck.mjs tests/sprite-model.mjs tests/tile-model.mjs tests/map-model.mjs tests/sound-model.mjs \
         tests/music-model.mjs tests/music-stream.mjs tests/rom-checks.mjs tests/browser-smoke.mjs; do
  [ -f "$s" ] || { echo "MISSING $s" >> $OUT/baseline-other.txt; continue; }
  t0=$(date +%s.%N); node "$s" > $OUT/log-$(basename $s .mjs).txt 2>&1; rc=$?; t1=$(date +%s.%N)
  printf "%-36s exit %d  %6.1f s  %s\n" "$s" $rc "$(echo "$t1 - $t0" | bc)" "$(tail -1 $OUT/log-$(basename $s .mjs).txt | cut -c1-80)" >> $OUT/baseline-other.txt
done
echo "finished $(date -Is)" >> $OUT/baseline-other.txt
{ echo "started $(date -Is)"; /usr/bin/time -f "wall %e s, user %U s, sys %S s, max RSS %M KB" node arcade/tests/run-all.mjs --full --jobs 4; echo "finished $(date -Is)"; } > $OUT/baseline-runall-full.txt 2>&1
