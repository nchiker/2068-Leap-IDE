#!/usr/bin/env python3
"""Give every JavaScript module in ide.html and studio.html a content fingerprint.

usage: tools/stamp-modules.py          rewrite ide.html and studio.html
       tools/stamp-modules.py --check  exit 1 if either is out of date

Browsers cache scripts (GitHub Pages: 10 minutes; python's http.server:
heuristically), so after an update a page could load the new ide.html with
an old ide.js, or mix old and new modules. Here each module URL carries a
hash of its contents (`ide.js?v=3f9a…`): a changed file gets a new URL and
must be fetched, an unchanged one stays cached, and old and new code are
never mixed.

The two entry scripts get the stamp in their <script src>. Every module they
import (relative imports, followed recursively, including TSRun's) gets an
entry in the import map: "./src/x.js": "./src/x.js?v=<hash>". Import maps
remap URL-like specifiers by their resolved address, so the modules' own
`import ... from './x.js'` lines need no change. The CDN entries are left as
they are (they are pinned by version already).

Each page has its own entry scripts (PAGES below); the Leap Arcade Studio (studio.html) is a second shell on the
same modules. OPTIONAL entries are fingerprinted too when the file exists (modules the page loads with a dynamic
import(variable), such as the Studio's asset editors, which another engineer may add later).
"""
import hashlib
import json
import os
import re
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..'))
# page -> (entry scripts, optional entry scripts)
PAGES = {
    'ide.html': (['src/editor.js', 'ide.js'], []),
    'studio.html': (['src/editor.js', 'studio.js'], ['src/tools/sprite-editor.js']),
}
IMPORT_RE = re.compile(r'''(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}/[^'"]+)['"]''')


def fingerprint(path):
    with open(os.path.join(ROOT, path), 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()[:10]


def module_graph(entries):
    """Relative module paths (from ROOT) reachable from the entry scripts."""
    seen, todo = set(), list(entries)
    while todo:
        path = todo.pop()
        if path in seen:
            continue
        seen.add(path)
        with open(os.path.join(ROOT, path), encoding='utf-8') as f:
            source = f.read()
        for spec in IMPORT_RE.findall(source):
            target = os.path.normpath(os.path.join(os.path.dirname(path), spec)).replace(os.sep, '/')
            if not os.path.isfile(os.path.join(ROOT, target)):
                sys.exit(f'{path}: import {spec!r} -> {target} not found')
            todo.append(target)
    return sorted(seen)


def stamped_html(html, page):
    entries, optional = PAGES[page]
    entries = list(entries)
    optional = [o for o in optional if os.path.isfile(os.path.join(ROOT, o))]
    modules = module_graph(entries + optional)
    stamp = {m: f'./{m}?v={fingerprint(m)}' for m in modules}

    for entry in entries:
        pattern = re.compile(r'(<script type="module" src=")' + re.escape(entry) + r'(\?v=[0-9a-f]+)?(")')
        html, n = pattern.subn(lambda m: m.group(1) + stamp[entry][2:] + m.group(3), html)
        if n != 1:
            sys.exit(f'{page}: expected one <script type="module" src="{entry}">, found {n}')

    m = re.search(r'(<script type="importmap">\s*)(\{.*?\})(\s*</script>)', html, re.S)
    if not m:
        sys.exit(f'{page}: no import map')
    imports = json.loads(m.group(2))['imports']
    imports = {k: v for k, v in imports.items() if not k.startswith('./')}     # keep the CDN entries
    for path in modules:
        if path not in entries:
            imports['./' + path] = stamp[path]
    body = json.dumps({'imports': imports}, indent=2)
    return html[:m.start(2)] + body + html[m.end(2):]


def main():
    stale = []
    for page in PAGES:
        path = os.path.join(ROOT, page)
        if not os.path.isfile(path):
            continue
        with open(path, encoding='utf-8') as f:
            html = f.read()
        new = stamped_html(html, page)
        if '--check' in sys.argv:
            if new != html:
                stale.append(page)
            continue
        if new != html:
            with open(path, 'w', encoding='utf-8') as f:
                f.write(new)
            print(f'{page}: module stamps updated')
        else:
            print(f'{page}: module stamps already current')
    if stale:
        sys.exit(f'{", ".join(stale)}: module stamps are out of date: run tools/stamp-modules.py')


main()
