#!/usr/bin/env python3
"""Give every JavaScript module in ide.html a content fingerprint.

usage: tools/stamp-modules.py          rewrite ide.html
       tools/stamp-modules.py --check  exit 1 if ide.html is out of date

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
"""
import hashlib
import json
import os
import re
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..'))
HTML = os.path.join(ROOT, 'ide.html')
ENTRIES = ['src/editor.js', 'ide.js']
IMPORT_RE = re.compile(r'''(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}/[^'"]+)['"]''')


def fingerprint(path):
    with open(os.path.join(ROOT, path), 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()[:10]


def module_graph():
    """Relative module paths (from ROOT) reachable from the entry scripts."""
    seen, todo = set(), list(ENTRIES)
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


def stamped_html(html):
    modules = module_graph()
    stamp = {m: f'./{m}?v={fingerprint(m)}' for m in modules}

    for entry in ENTRIES:
        pattern = re.compile(r'(<script type="module" src=")' + re.escape(entry) + r'(\?v=[0-9a-f]+)?(")')
        html, n = pattern.subn(lambda m: m.group(1) + stamp[entry][2:] + m.group(3), html)
        if n != 1:
            sys.exit(f'ide.html: expected one <script type="module" src="{entry}">, found {n}')

    m = re.search(r'(<script type="importmap">\s*)(\{.*?\})(\s*</script>)', html, re.S)
    if not m:
        sys.exit('ide.html: no import map')
    imports = json.loads(m.group(2))['imports']
    imports = {k: v for k, v in imports.items() if not k.startswith('./')}     # keep the CDN entries
    for path in modules:
        if path not in ENTRIES:
            imports['./' + path] = stamp[path]
    body = json.dumps({'imports': imports}, indent=2)
    return html[:m.start(2)] + body + html[m.end(2):]


def main():
    with open(HTML, encoding='utf-8') as f:
        html = f.read()
    new = stamped_html(html)
    if '--check' in sys.argv:
        if new != html:
            sys.exit('ide.html module stamps are out of date: run tools/stamp-modules.py')
        return
    if new != html:
        with open(HTML, 'w', encoding='utf-8') as f:
            f.write(new)
        print('ide.html: module stamps updated')
    else:
        print('ide.html: module stamps already current')


main()
