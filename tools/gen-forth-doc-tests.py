#!/usr/bin/env python3
"""Generate tests/forth-manual-examples.json (the Forth manual's examples as tests) from a 2068-Forth release.

usage: tools/gen-forth-doc-tests.py <2068-forth checkout> <git ref> > tests/forth-manual-examples.json

A port of 2068-Forth's tools/docexamples.py: every fenced ```forth block in
docs/manual/*.md is one test case, named as docexamples.py names its
tests/doc/manual_<part>_<NN>.fs, with the manual file and the line the block's
code starts on. The text is the block as written, directives included
(`\\ expect:`, `\\ expect-end:`, `\\ draws`, `\\ keys:`, `\\ break:`): the test
(tests/rom-checks.mjs, section 8) reads them as tools/forthtest.py does.
Part 7's programs are cases here too; the Examples menu (tools/gen-forth-examples.py)
carries the same programs.
"""

import json
import re
import subprocess
import sys


def git(checkout, *args):
    return subprocess.run(['git', '-C', checkout, *args], check=True, capture_output=True, text=True).stdout


def examples(checkout, ref):
    """[{name, doc, line, text}] of every ```forth block, in docexamples.py's order (manual files sorted)."""
    out = []
    files = sorted(p for p in git(checkout, 'ls-tree', '--name-only', ref, 'docs/manual/').split()
                   if p.endswith('.md'))
    for doc in files:
        base = doc.rsplit('/', 1)[-1][:-3]
        stem = 'manual_' + re.sub(r'[^a-z0-9]+', '_', base.lower())
        lines = git(checkout, 'show', f'{ref}:{doc}').split('\n')
        k, i = 0, 0
        while i < len(lines):
            if lines[i].strip() != '```forth':
                i += 1
                continue
            start = i + 1
            j = start
            while j < len(lines) and lines[j].strip() != '```':
                j += 1
            k += 1
            out.append({'name': '%s_%02d' % (stem, k), 'doc': doc, 'line': start + 1,
                        'text': '\n'.join(lines[start:j]) + '\n'})
            i = j + 1
    return out


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    checkout, ref = sys.argv[1], sys.argv[2]
    commit = git(checkout, 'rev-parse', f'{ref}^{{commit}}').strip()
    data = {'generated': 'tools/gen-forth-doc-tests.py: GENERATED, do not edit',
            'ref': ref, 'commit': commit, 'examples': examples(checkout, ref)}
    json.dump(data, sys.stdout, indent=1, ensure_ascii=False)
    print()


if __name__ == '__main__':
    main()
