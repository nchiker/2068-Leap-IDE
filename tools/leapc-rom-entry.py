#!/usr/bin/env python3
"""Print a src/lang/c/leapc-roms.js entry for a 2068-Leap-C build.

usage: tools/leapc-rom-entry.py <build dir> <version>

<build dir> holds leapc_home.bin, leapc_exrom.bin, leapc_home.sym,
leapc_exrom.sym and SHA256SUMS: build/ of the release tag built in a
detached worktree (git -C ~/2068-Leap-C worktree add --detach <dir> <tag>;
make build), or the release's emulator pack.

Every address the C profile uses comes from the two .sym files; nothing is
copied by hand. Checks: the images against SHA256SUMS, the key-wait spin loop
(IO_READ_KEY.wait_hit: ld a,(KBD_KEYHIT); or a; jr z,.wait_hit), and, for a
build from before the label existed (v1.0.0-beta.2), SH_WAIT_KEY.key_ret is
derived as SH_WAIT_KEY.read + 3 after checking the CALL there
(docs/requests/LEAP_C_ANSWERS.md Q2.3: the label costs 0 bytes).
"""

import hashlib
import os
import re
import sys

# entry field -> (.sym name, which .sym)
SYMBOLS = {
    'keyWait':        ('IO_READ_KEY.wait_hit', 'home'),
    'kbdKeyHit':      ('KBD_KEYHIT', 'home'),
    'gfxSetBorder':   ('GFX_SET_BORDER', 'home'),
    'progAreaStart':  ('PROG_AREA_START', 'home'),
    'progAreaMax':    ('PROG_AREA_MAX', 'home'),
    'progEnd':        ('PROG_END', 'home'),
    'arraysEnd':      ('ARRAYS_END', 'home'),
    'curEditIndex':   ('CUR_EDIT_INDEX', 'home'),
    'running':        ('RUNNING', 'home'),
    'ccErrNum':       ('CC_ERRNUM', 'home'),
    'ccErrLine':      ('CC_ERRLINE', 'home'),
    'shErrCol':       ('SH_ERR_COL', 'home'),
    'rtErrNum':       ('RT_ERRNUM', 'home'),
    'rtErrLine':      ('RT_ERRLINE', 'home'),
    'rtRunDone':      ('RT_RUN.done', 'home'),
    'libLoaded':      ('LIB_LOADED', 'home'),
    'tokLine':        ('TOK_LINE', 'home'),
    'tokPtr':         ('TOK_PTR', 'home'),
    'cgPc':           ('CG_PC', 'home'),
    'statement':      ('STATEMENT', 'home'),
    'shCompile':      ('SH_COMPILE', 'home'),
    'udgTable':       ('UDG_TABLE', 'home'),
    'udgCodeBase':    ('UDG_CODE_BASE', 'home'),
    'udgCount':       ('UDG_COUNT', 'home'),
    'stackTop':       ('LEAPC_STACK_TOP', 'exrom'),
    'tapeFormatWord': ('LEAPC_TAPE_VERSION', 'exrom'),
    'libBase':        ('LX_BASE', 'exrom'),
    'shLoop':         ('SH_LOOP', 'exrom'),
    'shRun':          ('SH_RUN', 'exrom'),
    'reportReturn':   ('SH_WAIT_KEY.key_ret', 'exrom'),
}


def load_sym(path):
    sym = {}
    for line in open(path):
        m = re.match(r'^(\S+): EQU 0x([0-9A-Fa-f]+)', line)
        if m:
            sym[m.group(1)] = int(m.group(2), 16)
    return sym


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    base, version = sys.argv[1], sys.argv[2]
    home = open(os.path.join(base, 'leapc_home.bin'), 'rb').read()
    exrom = open(os.path.join(base, 'leapc_exrom.bin'), 'rb').read()
    sums = {}
    for line in open(os.path.join(base, 'SHA256SUMS')):
        parts = line.split()
        if len(parts) == 2:
            sums[parts[1].lstrip('*')] = parts[0]
    for name, data in (('leapc_home.bin', home), ('leapc_exrom.bin', exrom)):
        if sums.get(name) != hashlib.sha256(data).hexdigest():
            sys.exit(f'{name} does not match SHA256SUMS')
    syms = {'home': load_sym(os.path.join(base, 'leapc_home.sym')),
            'exrom': load_sym(os.path.join(base, 'leapc_exrom.sym'))}

    notes = {}
    entry = {}
    for field, (name, which) in SYMBOLS.items():
        sym = syms[which]
        if name in sym:
            entry[field] = sym[name]
        elif name == 'SH_WAIT_KEY.key_ret' and 'SH_WAIT_KEY.read' in sym:
            read = sym['SH_WAIT_KEY.read']
            if exrom[read - 0xC000] != 0xCD:
                sys.exit('SH_WAIT_KEY.read is not a CALL: cannot derive SH_WAIT_KEY.key_ret')
            entry[field] = read + 3
            notes[field] = 'SH_WAIT_KEY.read + 3 (no SH_WAIT_KEY.key_ret label in this build)'
        else:
            sys.exit(f'{name} is not in leapc_{which}.sym')

    k, hit = entry['keyWait'], entry['kbdKeyHit']
    want = bytes([0x3A, hit & 0xFF, hit >> 8, 0xB7, 0x28, 0xFA])
    if home[k:k + 6] != want:
        sys.exit(f'IO_READ_KEY.wait_hit at ${k:04X} is not the expected spin loop')
    entry['keyWaitEnd'] = k + 6

    key = hashlib.sha256(home + exrom).hexdigest()
    print(f"  // Leap-C {version} (SHA-256 HOME {hashlib.sha256(home).hexdigest()[:8]}…, "
          f"EXROM {hashlib.sha256(exrom).hexdigest()[:8]}…)")
    print(f"  '{key}': {{")
    print(f"    version: '{version}',")
    for field, value in entry.items():
        label = notes.get(field) or (SYMBOLS[field][0] if field in SYMBOLS else 'end of the spin loop (exclusive)')
        print(f"    {(field + ':').ljust(17)} 0x{value:04X},   // {label}")
    print('  },')


if __name__ == '__main__':
    main()
