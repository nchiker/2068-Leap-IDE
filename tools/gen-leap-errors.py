#!/usr/bin/env python3
"""Generate src/leap-errors.js from the Leap V2 manual's error code tables.

usage: tools/gen-leap-errors.py <2068-Leap checkout> <git ref> > src/leap-errors.js

Reads Appendix B of docs/manual/07_appendices.md at <ref> (e.g. v2.0.2-emu.1):
the "Compile errors" and "Run-time errors" tables, rows of
`| codes | message | cause |`, where codes are "3", "13, 14, 15" or
"12 to 14". A code listed more than once (core and package rows) keeps the
first message and joins the causes.
"""
import json
import re
import subprocess
import sys


def plain(md):
    md = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", md)           # [text](link) -> text
    return md.replace("**", "").replace("`", "").replace("*", "").strip()


def codes(cell):
    out = []
    for part in cell.split(","):
        m = re.match(r"\s*(\d+)\s+to\s+(\d+)\s*$", part)
        if m:
            out += range(int(m.group(1)), int(m.group(2)) + 1)
        elif part.strip().isdigit():
            out.append(int(part))
    return out


def table(section):
    entries = {}
    for line in section.split("\n"):
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) != 3 or not codes(cells[0]):
            continue
        message, cause = plain(cells[1]), plain(cells[2])
        for code in codes(cells[0]):
            if code in entries:
                entries[code]["cause"] += "; " + cause
            else:
                entries[code] = {"message": message, "cause": cause}
    return entries


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    repo, ref = sys.argv[1], sys.argv[2]
    md = subprocess.run(["git", "-C", repo, "show", ref + ":docs/manual/07_appendices.md"],
                        check=True, capture_output=True, text=True).stdout
    b = md.split("## Appendix B", 1)[1].split("\n## ", 1)[0]
    compile_part = b.split("### Compile errors", 1)[1].split("### ", 1)[0]
    run_part = b.split("### Run-time errors", 1)[1].split("### ", 1)[0]
    compile_errors, run_errors = table(compile_part), table(run_part)
    assert compile_errors and run_errors, "Appendix B tables not found"
    print("/**")
    print(" * src/leap-errors.js — GENERATED, do not edit.")
    print(" *")
    print(" * tools/gen-leap-errors.py from 2068-Leap docs/manual/07_appendices.md")
    print(" * (Appendix B) at %s: error code -> {message, cause}." % ref)
    print(" */")
    print()
    print('"use strict";')
    print()
    print("export const LEAP_COMPILE_ERRORS = %s;" % json.dumps(compile_errors, indent=2, ensure_ascii=False))
    print()
    print("export const LEAP_RUNTIME_ERRORS = %s;" % json.dumps(run_errors, indent=2, ensure_ascii=False))


main()
