#!/usr/bin/env bash
# tools/reap-chrome.sh -- find (and with --kill, stop) headless Chromes that a browser test left behind.
#
#   tools/reap-chrome.sh              list them (a dry run; nothing is killed)
#   tools/reap-chrome.sh --kill       kill them
#   tools/reap-chrome.sh --min-age N  only those older than N seconds (default 2700 = 45 minutes: longer than the 40-minute watchdog of tests/chrome-guard.mjs, so a healthy test is never that old)
#
# Only browsers started by the repository's tests are touched: parent processes (no --type=) with a --remote-debugging-port AND a test profile
# directory (leap-prof-, tile-prof-, map-prof-, sprite-prof-, sound-prof- under the temp directory). It never uses `pkill -f`, so it cannot hit the
# browser of a test that is running now (that one is younger than the minimum age). Killing a parent takes its renderer and GPU children with it.
# Why: a test killed with SIGKILL cannot clean up after itself, and a dozen leaked browsers made the load average 63 (2026-11-16).
set -u
min_age=2700; kill=0
while [ $# -gt 0 ]; do
  case "$1" in
    --kill) kill=1 ;;
    --min-age) shift; min_age="${1:-2700}" ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
  esac
  shift
done
found=0
while read -r pid age args; do
  case "$args" in *--type=*) continue ;; esac
  case "$args" in *--remote-debugging-port=*) ;; *) continue ;; esac
  case "$args" in *-prof-*) ;; *) continue ;; esac
  [ "$age" -ge "$min_age" ] || continue
  found=$((found + 1))
  if [ "$kill" = 1 ]; then
    kill "$pid" 2>/dev/null; sleep 2
    if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null; echo "killed $pid with SIGKILL (age ${age}s)"; else echo "killed $pid (age ${age}s)"; fi
  else echo "would kill $pid (age ${age}s)"; fi
done < <(ps -eo pid=,etimes=,args= | grep chrome-headless-shell | grep -v grep)
[ "$found" = 0 ] && echo "no leaked test browsers (older than ${min_age}s)"
[ "$kill" = 1 ] || { [ "$found" = 0 ] || echo "run again with --kill to stop them"; }
exit 0
