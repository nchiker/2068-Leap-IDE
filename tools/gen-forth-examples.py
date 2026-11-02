#!/usr/bin/env python3
"""Generate src/lang/forth/examples.js (the Examples menu) from a 2068-Forth release.

usage: tools/gen-forth-examples.py <2068-forth checkout> <git ref> > src/lang/forth/examples.js

The examples are the manual's Part 7 programs (docs/manual/07_examples.md,
the numbered "## N. Title" sections: the first ```forth block of each, and
the first sentence of the paragraph under the heading as the menu text),
plus demos/blackjack.fs and demos/gallery.fs, each with a last line that
starts the game. Each Part 7
program is a test in 2068-Forth's build: `\\ expect:` comments say what a
line prints and are kept (Forth ignores them) unless they make the line
longer than the prompt's 128 characters; all of them are also in `expect`.
`\\ keys:` lines give the keys a line waits for and are left out of the
text, but kept as `keys`: [line, keys], the line (0-based, in the text) being
the one they are typed for, the next one after the directive.
"""

import json
import re
import subprocess
import sys

KEYS = re.compile(r'^\s*\\\s*keys:\s?(.*)$')
EXPECT = re.compile(r'\s+\\\s*expect:\s?(.*)$')
LINE_LIMIT = 128           # the Forth prompt's line (EDIT_MAX_LEN)


def show(checkout, ref, path):
    return subprocess.run(['git', '-C', checkout, 'show', f'{ref}:{path}'],
                          check=True, capture_output=True, text=True).stdout


def first_sentence(par):
    par = re.sub(r'`([^`]*)`', r'\1', par)
    par = re.sub(r'\*\*?([^*]*)\*\*?', r'\1', par)
    m = re.match(r'(.+?[.!?])(\s|$)', par)
    return (m.group(1) if m else par)[:110]


def manual_examples(text):
    out = []
    for m in re.finditer(r'^## (\d+)\. (.+?)\n(.*?)(?=^## |\Z)', text, re.S | re.M):
        title, body = m.group(2).strip(), m.group(3)
        par = body.strip().split('\n\n')[0].replace('\n', ' ')
        code = re.search(r'```forth\n(.*?)```', body, re.S)
        if not code:
            continue
        lines, keys, expect = [], [], []
        for line in code.group(1).rstrip('\n').split('\n'):
            k = KEYS.match(line)
            if k:
                keys.append([len(lines), k.group(1).encode().decode('unicode_escape')])
            else:
                line = line.rstrip()
                e = EXPECT.search(line)
                if e:
                    expect.append([len(lines), e.group(1)])
                    # A line the comment makes too long for the prompt loses it.
                    if len(line) > LINE_LIMIT:
                        line = line[:e.start()].rstrip()
                lines.append(line)
        ident = re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-')
        ex = {'id': ident, 'title': title, 'about': first_sentence(par), 'text': '\n'.join(lines) + '\n',
              'expect': expect}
        if keys:
            ex['keys'] = keys
            ex['input'] = True
        out.append(ex)
    return out


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    checkout, ref = sys.argv[1], sys.argv[2]
    examples = manual_examples(show(checkout, ref, 'docs/manual/07_examples.md'))
    blackjack = show(checkout, ref, 'demos/blackjack.fs').rstrip('\n')
    examples.append({
        'id': 'blackjack', 'title': 'Blackjack',
        'about': 'You against the dealer, with card graphics and sound (the release demo). H hit, S stand.',
        'input': True,
        'text': blackjack + '\nBLACKJACK\n',
    })
    # The Shooting Gallery ends with MAIN, which starts it.
    gallery = show(checkout, ref, 'demos/gallery.fs').rstrip('\n')
    examples.append({
        'id': 'gallery', 'title': 'Shooting Gallery',
        'about': 'A real-time arcade game (the old demo ROM\'s source). Q/A, W/S, E/D move the targets, O/P the blaster, SPACE fires.',
        'input': True,
        'text': gallery + '\n',
    })
    print('/**')
    print(' * src/lang/forth/examples.js — GENERATED, do not edit.')
    print(' *')
    print(f' * tools/gen-forth-examples.py from 2068-Forth docs/manual/07_examples.md,')
    print(f' * demos/blackjack.fs and demos/gallery.fs at {ref}: {len(examples)} programs for the')
    print(' * Examples menu, {id, title, about, text, expect, input?, keys?}: expect [line, what')
    print(' * it prints (screen rows joined by |)], keys [line, what a test types while that')
    print(' * line waits]; lines are 0-based in the text.')
    print(' */')
    print()
    print('"use strict";')
    print()
    print('export const FORTH_EXAMPLES = [')
    for ex in examples:
        print(f'  {json.dumps(ex, ensure_ascii=False)},')
    print('];')


if __name__ == '__main__':
    main()
