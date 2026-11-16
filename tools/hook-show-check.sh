#!/usr/bin/env bash
# Claude Code UserPromptSubmit hook: if the last token-free local check FAILED, tell the model in one line (stdout becomes context); silent otherwise.
root="$(cd "$(dirname "$0")/.." && pwd)"
line="$(cat "$root/arcade/build/last-check.txt" 2>/dev/null)"
case "$line" in
  *" FAIL "*) echo "Last local check (tools/check-local.sh, full output arcade/build/last-check.log): $line" ;;
esac
exit 0
