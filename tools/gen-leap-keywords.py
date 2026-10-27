#!/usr/bin/env python3
"""Generate src/leap-keywords.js from the Leap V2 manual's keyword chapter.

usage: tools/gen-leap-keywords.py <2068-Leap checkout> <git ref> > src/leap-keywords.js

Reads docs/manual/03_keywords.md at <ref> (e.g. v2.0.2-emu.1), so the editor's
keyword classes, signatures, help text and examples match that release's
manual exactly. Each entry there is:

    ## NAME  [package: pkg]
    <blank>
    `signature` ... -- **kind** ...
    <blank>
    description paragraph
    ...
    ```basic ...
    example
    ```
"""
import json
import re
import subprocess
import sys

KINDS = {"function", "statement", "operator", "command", "part of"}
MAX_DESC = 420          # characters of description kept for tooltips
MAX_EXAMPLE_LINES = 6


def plain(md):
    """Markdown inline -> plain text (backticks, emphasis, links)."""
    md = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", md)
    return md.replace("**", "").replace("`", "").replace("*", "")


def shorten(text):
    if len(text) <= MAX_DESC:
        return text
    cut = text[:MAX_DESC]
    end = cut.rfind(". ")
    return cut[:end + 1] if end > 80 else cut.rstrip() + "…"


def split_forms(name, sig_md):
    """Alternative forms of a signature. A new form starts at each code chunk
    that begins with the keyword itself (`INPUT x` `INPUT "p"; x`); text in
    between (`FOR ...` ... `NEXT`) stays with the form it follows."""
    first = name.split()[0]
    parts = re.split(r"(`[^`]+`)", sig_md)
    starts = [p for p in parts if p.startswith("`") and p[1:].startswith(first)]
    if not starts:
        return [plain(p).strip() for p in parts if p.startswith("`")]
    forms, cur = [], ""
    for p in parts:
        if p.startswith("`") and p[1:].startswith(first) and cur.strip():
            forms.append(cur)
            cur = ""
        cur += p
    forms.append(cur)
    return [re.sub(r"\s+", " ", plain(f)).strip(" ,") for f in forms if plain(f).strip(" ,")]


def parse(md):
    entries = {}
    for block in re.split(r"^## ", md, flags=re.M)[1:]:
        lines = block.split("\n")
        head = re.match(r"(.+?)(?:\s+\[package: (\w+)\])?\s*$", lines[0])
        name, pkg = head.group(1).strip(), head.group(2)
        body = [l for l in lines[1:]]
        sig_line = next((l for l in body if " -- **" in l), None)
        if sig_line is None:
            continue                                  # "How to read an entry"
        kind = re.search(r" -- \*\*([a-z ]+)\*\*", sig_line).group(1).strip()
        assert kind in KINDS, (name, kind)
        raw = plain(sig_line.split(" -- ")[0]).strip()
        # Operators read "a AND b": the whole line is the one form.
        forms = [raw] if kind == "operator" else split_forms(name, sig_line.split(" -- ")[0])
        i = body.index(sig_line)
        para = []
        rest = [l.strip() for l in body[i + 1:]]
        for j, l in enumerate(rest):
            if l == "" and para:
                # A paragraph that leads into a list ("The separator between
                # items is") keeps the list; the list ends at a non-bullet.
                nxt = next((x for x in rest[j + 1:] if x), "")
                if para[-1][-1] in ".!?)" and not para[-1].startswith("* "):
                    break
                if para[-1].startswith("* ") and not nxt.startswith("* "):
                    break
                continue
            if l:
                para.append("•" + l[1:] if l.startswith("* ") else l)
        example = None
        m = re.search(r"```basic[^\n]*\n(.*?)```", block, re.S)
        if m:
            ex = m.group(1).rstrip("\n").split("\n")
            example = "\n".join(ex[:MAX_EXAMPLE_LINES]) + ("\n…" if len(ex) > MAX_EXAMPLE_LINES else "")
        entries[name] = {
            "kind": kind,
            "package": pkg,
            "syntax": raw,
            "forms": forms,
            "desc": shorten(plain(" ".join(para))),
            "example": example,
        }
    return entries


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    repo, ref = sys.argv[1], sys.argv[2]
    md = subprocess.run(["git", "-C", repo, "show", ref + ":docs/manual/03_keywords.md"],
                        check=True, capture_output=True, text=True).stdout
    entries = parse(md)
    print("/**")
    print(" * src/leap-keywords.js — GENERATED, do not edit.")
    print(" *")
    print(" * tools/gen-leap-keywords.py from 2068-Leap docs/manual/03_keywords.md at %s." % ref)
    print(" * One entry per manual keyword heading: kind (function / statement /")
    print(" * operator / command / part of), package (null for core), syntax, the")
    print(" * individual forms, the description's first paragraph and the first example.")
    print(" */")
    print()
    print('"use strict";')
    print()
    print("export const LEAP_MANUAL_REF = %s;" % json.dumps(ref))
    print()
    print("export const LEAP_KEYWORD_ENTRIES = %s;" % json.dumps(entries, indent=2, ensure_ascii=False))


main()
