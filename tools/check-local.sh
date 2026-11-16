#!/usr/bin/env bash
# tools/check-local.sh [<ref>] -- the token-free local check: what changed since <ref> (default HEAD: the uncommitted work), run without a model.
#
# Writes ONE summary line to arcade/build/last-check.txt (and the full output to arcade/build/last-check.log):
#     2026-11-16T12:00:00 PASS 14/14 steps (changed since HEAD) in 212 s
#     2026-11-16T12:00:00 FAIL 13/14 steps (changed since HEAD): FAILED: tests/studio-smoke.mjs
# A session, or the UserPromptSubmit hook, reads that line instead of running or polling the tests itself.
#
# Runs `python3 tools/stamp-modules.py --check`, then `node tools/verify.mjs --changed <ref> --quick` (only the steps that read a changed file; quick mode).
# Never starts twice at once (a lock), skips when nothing changed since the last run (a fingerprint of the working tree), runs at low priority,
# and reaps leaked test browsers first (tools/reap-chrome.sh). Not a replacement for `verify --all` before a pull request.
set -u
cd "$(dirname "$0")/.." || exit 0
ref="${1:-HEAD}"
dir=arcade/build; mkdir -p "$dir"
status="$dir/last-check.txt"; log="$dir/last-check.log"; lock="$dir/check-local.lock"; seen="$dir/last-check.fingerprint"
if ps -eo args | grep -q "[n]ode tools/verify.mjs"; then exit 0; fi                                  # a verify run (this script's or a hand-started --all) is going: never compete with it
if [ -e "$lock" ] && kill -0 "$(cat "$lock" 2>/dev/null)" 2>/dev/null; then exit 0; fi       # one at a time
echo $$ > "$lock"; trap 'rm -f "$lock"' EXIT
fp="$( { git status --porcelain -uall -- . ':!arcade/spike/verify' ; git diff "$ref" -- . ':!arcade/spike/verify' ; } 2>/dev/null | sha256sum | cut -d' ' -f1)"
if [ -z "$(git status --porcelain -uall -- . ':!arcade/spike/verify' 2>/dev/null)" ]; then
  echo "$(date +%FT%T) PASS nothing changed since $ref" > "$status"; echo "$fp" > "$seen"; exit 0
fi
if [ "$(cat "$seen" 2>/dev/null)" = "$fp" ]; then exit 0; fi                                      # the same changes were checked already
tools/reap-chrome.sh --kill > /dev/null 2>&1
start=$(date +%s)
{
  echo "== stamp-modules --check"; python3 tools/stamp-modules.py --check
  stamp_rc=$?
  echo "== verify --changed $ref --quick"; nice -n 10 node tools/verify.mjs --changed "$ref" --quick
  verify_rc=$?
  echo "== rc stamp=$stamp_rc verify=$verify_rc"
} > "$log" 2>&1
secs=$(( $(date +%s) - start ))
stamp_rc=$(sed -n 's/^== rc stamp=\([0-9]*\) verify=.*/\1/p' "$log" | tail -1); verify_rc=$(sed -n 's/^== rc stamp=[0-9]* verify=\([0-9]*\)/\1/p' "$log" | tail -1)
steps="$(grep -E '^[0-9]+/[0-9]+ steps passed' "$log" | tail -1 | sed 's/;.*//')"; [ -n "$steps" ] || steps="$(grep -E '^verify .*nothing to run' "$log" | tail -1)"
if [ "${stamp_rc:-1}" = 0 ] && [ "${verify_rc:-1}" = 0 ]; then
  echo "$(date +%FT%T) PASS ${steps:-no steps} (changed since $ref) in ${secs} s" > "$status"
else
  failed="$(grep -E '^FAILED:|^BUILD FAILED' "$log" | tail -1 | cut -c1-200)"; [ "${stamp_rc:-1}" = 0 ] || failed="stamp-modules is stale (run python3 tools/stamp-modules.py); $failed"
  echo "$(date +%FT%T) FAIL ${steps:-no summary} (changed since $ref): ${failed:-see $log}" > "$status"
fi
echo "$fp" > "$seen"
exit 0
