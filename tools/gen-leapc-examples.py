#!/usr/bin/env python3
"""Generate src/lang/c/examples.js (the Examples menu) from a 2068-Leap-C release.

usage: tools/gen-leapc-examples.py <2068-Leap-C checkout> <git ref> > src/lang/c/examples.js

The examples are the manual's Part 7 programs (docs/manual/07_examples.md,
the numbered "## N. Title" sections: the first ```c block of each, and the
first sentence of the paragraph under the heading as the menu text). Each is
a test in Leap-C's build; its directive comments are taken out of the text
and kept as data:
  // expect: exit N        -> exit
  // screen: ROW TEXT      -> screen [[row, text], ...]
  // pixel: X Y V          -> pixels [[x, y, v], ...]
  // keys: "50" ENTER ...  -> keys (as written) and input: true
  // library: NAME         -> library
A program that needs a tape (the manual says so of its last one) gets
tape: true.
"""

import json
import re
import subprocess
import sys

DIRECTIVE = re.compile(r'^\s*//\s*(expect|screen|pixel|keys|library):\s?(.*)$')


def show(checkout, ref, path):
    return subprocess.run(['git', '-C', checkout, 'show', f'{ref}:{path}'],
                          check=True, capture_output=True, text=True).stdout


def first_sentence(par):
    par = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', par)
    par = re.sub(r'`([^`]*)`', r'\1', par)
    par = re.sub(r'\*\*?([^*]*)\*\*?', r'\1', par)
    m = re.match(r'(.+?[.!?])(\s|$)', par)
    return (m.group(1) if m else par)[:110]


def examples(text):
    out = []
    for m in re.finditer(r'^## (\d+)\. (.+?)\n(.*?)(?=^## |\Z)', text, re.S | re.M):
        title, body = m.group(2).strip(), m.group(3)
        par = body.strip().split('\n\n')[0].replace('\n', ' ')
        code = re.search(r'```c\n(.*?)```', body, re.S)
        if not code:
            continue
        lines = []
        ex = {'id': re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-'), 'title': title,
              'about': first_sentence(par)}
        screen, pixels = [], []
        for line in code.group(1).rstrip('\n').split('\n'):
            d = DIRECTIVE.match(line)
            if not d:
                lines.append(line.rstrip())
                continue
            kind, value = d.group(1), d.group(2).strip()
            if kind == 'expect':
                e = re.fullmatch(r'exit (-?\d+)', value)
                if not e:
                    sys.exit(f'{title}: unknown expect: {value}')
                ex['exit'] = int(e.group(1))
            elif kind == 'screen':
                row, _, rest = value.partition(' ')
                screen.append([int(row), rest])
            elif kind == 'pixel':
                pixels.append([int(v) for v in value.split()])
            elif kind == 'keys':
                ex['keys'] = value
                ex['input'] = True
            elif kind == 'library':
                ex['library'] = value
        while lines and lines[0] == '':
            lines.pop(0)
        ex['text'] = '\n'.join(lines) + '\n'
        if screen:
            ex['screen'] = screen
        if pixels:
            ex['pixels'] = pixels
        if re.search(r'\btape_(save|load)\s*\(', ex['text']):
            ex['tape'] = True
        out.append(ex)
    return out


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    checkout, ref = sys.argv[1], sys.argv[2]
    found = examples(show(checkout, ref, 'docs/manual/07_examples.md'))
    if not found:
        sys.exit('no examples found')
    print('/**')
    print(' * src/lang/c/examples.js — GENERATED, do not edit.')
    print(' *')
    print(f' * tools/gen-leapc-examples.py from 2068-Leap-C docs/manual/07_examples.md at {ref}:')
    print(f' * {len(found)} programs for the Examples menu, {{id, title, about, text, exit?, screen?,')
    print(' * pixels?, keys?, input?, library?, tape?}: the manual\'s test directives (exit status,')
    print(' * screen rows, pixels, keys typed, library) taken out of the text.')
    print(' */')
    print()
    print('"use strict";')
    print()
    print('export const LEAPC_EXAMPLES = [')
    for ex in found:
        print(f'  {json.dumps(ex)},')
    print('];')


if __name__ == '__main__':
    main()
