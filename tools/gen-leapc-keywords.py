#!/usr/bin/env python3
"""Generate src/lang/c/leapc-keywords.js from the Leap-C manual.

usage: tools/gen-leapc-keywords.py <2068-Leap-C checkout> <git ref> > src/lang/c/leapc-keywords.js

Reads docs/manual/03_keywords.md (keywords, operators, preprocessor),
04_library.md (the ROM's library functions) and 06_libraries.md (functions
of the loadable libraries) at <ref>. An entry is

    ## name
    [library: shapes]                       (06 only)
    <blank>
    `syntax` -- **kind**                     (one or more such lines)
    <blank>
    the first paragraph of description
    ```c
    the first example
    ```

Headings without a `-- **kind**` line ("How to read an entry") are not
entries. Example lines that are test directives (// expect:, // screen:,
// keys:) are left out.
"""

import json
import re
import subprocess
import sys

PARTS = ['03_keywords.md', '04_library.md', '06_libraries.md']
MAX_DESC = 420
MAX_EXAMPLE_LINES = 8
SYNTAX = re.compile(r'^(?P<syntax>.+?) -- \*\*(?P<kind>[^*]+)\*\*\s*$')
DIRECTIVE = re.compile(r'^\s*//\s*(expect|screen|keys|break|input)\b')


def plain(text):
    text = re.sub(r'`([^`]*)`', r'\1', text)
    return re.sub(r'\*\*?([^*]+)\*\*?', r'\1', text).strip()


def entries(text, part):
    lines = text.split('\n')
    out = {}
    i = 0
    while i < len(lines):
        m = re.match(r'^## (.+?)\s*$', lines[i])
        if not m:
            i += 1
            continue
        name = m.group(1).strip('`')
        j = i + 1
        library = None
        lib = re.match(r'^\[library: (\w+)\]', lines[j]) if j < len(lines) else None
        if lib:
            library = lib.group(1)
            j += 1
        while j < len(lines) and lines[j].strip() == '':
            j += 1
        forms, kind = [], None
        while j < len(lines) and SYNTAX.match(lines[j]):
            s = SYNTAX.match(lines[j])
            forms.append(plain(s.group('syntax')))
            kind = s.group('kind')
            j += 1
        if not forms:
            i += 1
            continue
        while j < len(lines) and lines[j].strip() == '':
            j += 1
        desc = []
        while j < len(lines) and lines[j].strip() != '' and not lines[j].startswith('```'):
            desc.append(lines[j].strip())
            j += 1
        desc = plain(' '.join(desc))
        if len(desc) > MAX_DESC:
            desc = desc[:MAX_DESC - 1].rsplit(' ', 1)[0] + '…'
        example = ''
        while j < len(lines) and not lines[j].startswith('## '):
            if lines[j].startswith('```c'):
                ex = []
                j += 1
                while j < len(lines) and not lines[j].startswith('```'):
                    if not DIRECTIVE.match(lines[j]):
                        ex.append(lines[j].rstrip())
                    j += 1
                example = '\n'.join(ex[:MAX_EXAMPLE_LINES])
                break
            j += 1
        out[name] = {'kind': kind, 'library': library, 'forms': forms, 'desc': desc, 'example': example, 'part': part}
        i = j
    return out


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    checkout, ref = sys.argv[1], sys.argv[2]
    commit = subprocess.run(['git', '-C', checkout, 'rev-parse', '--short', ref],
                            check=True, capture_output=True, text=True).stdout.strip()
    words = {}
    for part in PARTS:
        text = subprocess.run(['git', '-C', checkout, 'show', f'{ref}:docs/manual/{part}'],
                              check=True, capture_output=True, text=True).stdout
        for name, e in entries(text, part).items():
            if name in words:
                sys.exit(f'{name} is in the manual twice')
            words[name] = e
    print('/**')
    print(' * src/lang/c/leapc-keywords.js — GENERATED, do not edit.')
    print(' *')
    print(f' * tools/gen-leapc-keywords.py from 2068-Leap-C docs/manual/ ({", ".join(PARTS)})')
    print(f' * at {ref} ({commit}): {len(words)} entries -> {{kind, library, forms, desc, example, part}}.')
    print(' */')
    print()
    print('"use strict";')
    print()
    print(f'export const LEAPC_MANUAL_REF = {json.dumps(commit)};')
    print()
    print('export const LEAPC_KEYWORD_ENTRIES = {')
    for name in sorted(words):
        print(f'  {json.dumps(name)}: {json.dumps(words[name], ensure_ascii=False)},')
    print('};')


if __name__ == '__main__':
    main()
