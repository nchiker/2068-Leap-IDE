#!/usr/bin/env python3
"""Generate src/lang/forth/forth-words.js from the 2068-Forth manual's word chapters.

usage: tools/gen-forth-words.py <2068-forth checkout> <git ref> > src/lang/forth/forth-words.js

Reads docs/manual/03_language.md and 04_machine.md at <ref> (the release tag,
e.g. v2.0). Every word entry there has exactly this shape (2068-Forth
docs/requests answer Q5 "as built"):

    ## NAME
    <blank>
    `( stack -- effect )` -- **kind**, group
    <blank>
    the first paragraph of description
    ```forth
    the first example (lines with \\ expect: TEXT)
    ```

The stack effect itself contains " -- ", so the line is split on " -- **".
Headings without that line ("How to read an entry") are not words. Example
lines that are test directives (\\ keys:, \\ break:, \\ draws) are left out.
"""

import json
import re
import subprocess
import sys

PARTS = ['03_language.md', '04_machine.md']
MAX_DESC = 420
MAX_EXAMPLE_LINES = 6
DIRECTIVE = re.compile(r'^\s*\\\s*(keys|break|draws)\b')
EFFECT = re.compile(r'^`(?P<stack>.*)` -- \*\*(?P<kind>[^*]+)\*\*, (?P<group>.+?)\s*$')


def show(checkout, ref, path):
    return subprocess.run(['git', '-C', checkout, 'show', f'{ref}:{path}'],
                          check=True, capture_output=True, text=True).stdout


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
        while j < len(lines) and lines[j].strip() == '':
            j += 1
        e = EFFECT.match(lines[j]) if j < len(lines) else None
        if not e:
            i += 1
            continue
        k = j + 1
        while k < len(lines) and lines[k].strip() == '':
            k += 1
        desc = []
        while k < len(lines) and lines[k].strip() != '' and not lines[k].startswith('```'):
            desc.append(lines[k].strip())
            k += 1
        # Plain text: the manual's *emphasis* and `code` marks go.
        desc = re.sub(r'`([^`]*)`', r'\1', re.sub(r'\*\*?([^*]+)\*\*?', r'\1', ' '.join(desc)))
        if len(desc) > MAX_DESC:
            desc = desc[:MAX_DESC - 1].rsplit(' ', 1)[0] + '…'
        example = ''
        while k < len(lines) and not lines[k].startswith('## '):
            if lines[k].startswith('```forth'):
                ex = []
                k += 1
                while k < len(lines) and not lines[k].startswith('```'):
                    if not DIRECTIVE.match(lines[k]):
                        ex.append(lines[k].rstrip())
                    k += 1
                example = '\n'.join(ex[:MAX_EXAMPLE_LINES])
                break
            k += 1
        out[name] = {
            'stack': e.group('stack'),
            'kind': e.group('kind'),
            'group': e.group('group'),
            'desc': desc,
            'example': example,
            'part': part,
        }
        i = k
    return out


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    checkout, ref = sys.argv[1], sys.argv[2]
    words, groups = {}, []
    for part in PARTS:
        for name, e in entries(show(checkout, ref, f'docs/manual/{part}'), part).items():
            if name in words:
                sys.exit(f'{name} is in the manual twice')
            words[name] = e
            if e['group'] not in groups:
                groups.append(e['group'])
    print('/**')
    print(' * src/lang/forth/forth-words.js — GENERATED, do not edit.')
    print(' *')
    print(f' * tools/gen-forth-words.py from 2068-Forth docs/manual/{" and ".join(PARTS)}')
    print(f' * at {ref}: {len(words)} words -> {{stack, kind, group, desc, example, part}}.')
    print(' */')
    print()
    print('"use strict";')
    print()
    print(f'export const FORTH_MANUAL_REF = {json.dumps(ref)};')
    print()
    print('/** The groups, in the order the manual first uses them. */')
    print(f'export const FORTH_GROUPS = {json.dumps(groups)};')
    print()
    print('export const FORTH_WORD_ENTRIES = {')
    for name in sorted(words):
        print(f'  {json.dumps(name)}: {json.dumps(words[name], ensure_ascii=False)},')
    print('};')


if __name__ == '__main__':
    main()
