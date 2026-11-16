#!/usr/bin/env bash
# Claude Code Stop hook: start tools/check-local.sh detached in the background (it has its own lock and skips when nothing changed). Silent; never blocks.
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root" || exit 0
nohup setsid tools/check-local.sh > /dev/null 2>&1 < /dev/null &
exit 0
