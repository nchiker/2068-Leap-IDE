#!/usr/bin/env python3
"""Generate src/lang/c/leapc-errors.js from Leap-C's own error table.

usage: tools/gen-leapc-errors.py <2068-Leap-C checkout> <git ref> > src/lang/c/leapc-errors.js

Reads include/leapc_errors.inc at <ref>: the ROM's single source of its
compile (E_*) and run-time (RTE_*) error numbers and the messages the shell
shows ("ERROR n: MESSAGE", "RUNTIME ERROR n: MESSAGE"). Each line is
    E_NAME   EQU n   ; "MESSAGE": cause, possibly continued
    ;   on following comment lines
"""

import json
import re
import subprocess
import sys

LINE = re.compile(r'^(E|RTE)_\w+\s+EQU\s+(\d+)\s*;\s*"([^"]+)":?\s*(.*)$')
MORE = re.compile(r'^\s+;\s{2,}(.*)$')


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    checkout, ref = sys.argv[1], sys.argv[2]
    text = subprocess.run(['git', '-C', checkout, 'show', f'{ref}:include/leapc_errors.inc'],
                          check=True, capture_output=True, text=True).stdout
    tables = {'E': {}, 'RTE': {}}
    last = None
    for line in text.split('\n'):
        m = LINE.match(line)
        if m:
            kind, code, message, cause = m.group(1), int(m.group(2)), m.group(3), m.group(4).strip()
            last = {'message': message, 'cause': cause}
            tables[kind][code] = last
            continue
        c = MORE.match(line)
        if c and last is not None:
            last['cause'] = (last['cause'] + ' ' + c.group(1).strip()).strip()
        else:
            last = None
    print('/**')
    print(' * src/lang/c/leapc-errors.js — GENERATED, do not edit.')
    print(' *')
    print(f' * tools/gen-leapc-errors.py from 2068-Leap-C include/leapc_errors.inc at {ref}:')
    print(' * error code -> {message, cause}; the message is what the ROM shows.')
    print(' */')
    print()
    print('"use strict";')
    print()
    for name, kind in (('LEAPC_COMPILE_ERRORS', 'E'), ('LEAPC_RUNTIME_ERRORS', 'RTE')):
        print(f'export const {name} = {{')
        for code in sorted(tables[kind]):
            print(f'  {code}: {json.dumps(tables[kind][code], ensure_ascii=False)},')
        print('};')
        print()


if __name__ == '__main__':
    main()
