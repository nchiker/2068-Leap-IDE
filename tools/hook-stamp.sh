#!/usr/bin/env bash
# Claude Code PostToolUse hook (Edit | Write | MultiEdit): after a .js / .mjs file of this repository is edited, run tools/stamp-modules.py,
# which CLAUDE.md requires after any .js change (module fingerprints in ide.html / studio.html). Reads the hook's JSON on stdin; silent; never blocks.
set -u
f="$(jq -r '.tool_input.file_path // .tool_response.filePath // empty' 2>/dev/null)"
root="$(cd "$(dirname "$0")/.." && pwd)"
case "$f" in
  "$root"/*.js|"$root"/*.mjs) ;;
  *) exit 0 ;;
esac
case "$f" in "$root"/tsrun/*|"$root"/arcade/build/*|"$root"/.claude/*) exit 0 ;; esac
cd "$root" && python3 tools/stamp-modules.py > /dev/null 2>&1
exit 0
