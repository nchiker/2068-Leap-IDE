#!/usr/bin/env python3
"""Write the V2 program corpora of the Leap source tree as .bas files for tests/compare.mjs.

  build/corpus/lang/<case>.bas    docs/V2_LANGUAGE_CASES.csv (lines joined by " | " there)
  build/corpus/manual/<ex>.bas    the manual's ```basic ex=... blocks (docs/manual/*.md)
  build/corpus/package/<ex>.bas   those of them that need a package (pkg=); compare.mjs finds which
Usage: extract_corpus.py [LEAP_DIR]   (default: leap/)
"""
import csv
import pathlib
import re
import sys

leap = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "leap")
out = pathlib.Path("build/corpus")
safe = lambda s: re.sub(r"[^A-Za-z0-9_.-]", "_", s)

(out / "lang").mkdir(parents=True, exist_ok=True)
n = 0
for row in csv.DictReader(open(leap / "docs/V2_LANGUAGE_CASES.csv")):
    (out / "lang" / (safe(row["case_id"]) + ".bas")).write_text("\n".join(row["program"].split(" | ")) + "\n")
    n += 1

(out / "manual").mkdir(parents=True, exist_ok=True)
(out / "package").mkdir(parents=True, exist_ok=True)
m = p = 0
for md in sorted((leap / "docs/manual").glob("*.md")):
    for info, body in re.findall(r"^```basic ([^\n]*)\n(.*?)^```", md.read_text(), re.S | re.M):
        attrs = dict(a.split("=", 1) for a in info.split() if "=" in a)
        if "ex" not in attrs:
            continue
        pkg = "pkg" in attrs
        (out / ("package" if pkg else "manual") / (safe(attrs["ex"]) + ".bas")).write_text(body)
        p += pkg
        m += not pkg
print(f"{n} language cases, {m} manual examples, {p} package examples -> {out}/")
