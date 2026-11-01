#!/usr/bin/env python3
"""Print a src/lang/forth/forth-roms.js entry for a 2068-Forth release.

usage: tools/forth-rom-entry.py <release dir> <version>

<release dir> is the unpacked release zip (2068-Forth-v2.0/): roms/ with
forth_boot_rom0.bin, graphics_exrom.bin and SHA256SUMS, symbols/ with
forth_boot.sym (or a build/ directory holding those files directly).

Every address the Forth profile uses comes from the .sym file; nothing is
copied by hand. The script checks the ROMs against SHA256SUMS and the bytes
of the key-wait spin loop (IO_READ_KEY.wait_hit: ld a,(KBD_KEYHIT); or a;
jr z,.wait_hit), whose end it reports as keyWaitEnd.
"""

import hashlib
import os
import re
import sys

# entry field -> .sym name
SYMBOLS = {
    'keyWait':        'IO_READ_KEY.wait_hit',
    'promptReturn':   'EDITOR_LOOP_LIVE.key_ret',
    'enterLine':      'EDITOR_LOOP_LIVE.enter',
    'editBuf':        'EDIT_BUF',
    'editLen':        'EDIT_LEN',
    'editCursor':     'EDIT_CURSOR',
    'editMaxLen':     'EDIT_MAX_LEN',
    'lastError':      'LAST_ERROR',
    'srcPtr':         'SRC_PTR',
    'srcEnd':         'SRC_END',
    'storeStart':     'STORE_START',
    'storeEnd':       'STORE_END',
    'storeLimit':     'STORE_LIMIT',
    'latest':         'LATEST',
    'here':           'HERE',
    'state':          'STATE',
    'colonXt':        'COLON_XT',
    'wordBuf':        'WORD_BUF',
    'interpToken':    'INTERPRET_NESTED.token',
    'kbdKeyHit':      'KBD_KEYHIT',
    'dstackTop':      'DSTACK_TOP',
    'dstackLimit':    'DSTACK_LIMIT',
    'fstackTop':      'FSTACK_TOP',
    'fstackLimit':    'FSTACK_LIMIT',
    'dictBase':       'FORTH_DICT_RAM',
    'dictCeiling':    'DICT_RAM_CEILING',
    'romIdentity':    'ROM_IDENTITY',
    'udgTable':       'UDG_TABLE',
    'udgCodeBase':    'UDG_CODE_BASE',
    'udgCount':       'UDG_COUNT',
    # Debugger (F4): the run-time routines a word's code starts with or calls
    'doLit':          'DOLIT',
    'doFLit':         'DOFLIT',
    'doDoes':         'DODOES',
    'qBranch':        'QBRANCH',
    'branch':         'BRANCH',
    'stkGuard':       'STK_GUARD',
}


def find(base, name):
    for sub in ('roms', 'symbols', ''):
        path = os.path.join(base, sub, name)
        if os.path.isfile(path):
            return path
    sys.exit(f'{name} not found under {base}')


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    base, version = sys.argv[1], sys.argv[2]
    home = open(find(base, 'forth_boot_rom0.bin'), 'rb').read()
    exrom = open(find(base, 'graphics_exrom.bin'), 'rb').read()
    sums = {}
    for line in open(find(base, 'SHA256SUMS')):
        parts = line.split()
        if len(parts) == 2:
            sums[parts[1].lstrip('*')] = parts[0]
    for name, data in (('forth_boot_rom0.bin', home), ('graphics_exrom.bin', exrom)):
        if sums.get(name) != hashlib.sha256(data).hexdigest():
            sys.exit(f'{name} does not match SHA256SUMS')

    sym = {}
    for line in open(find(base, 'forth_boot.sym')):
        m = re.match(r'^(\S+): EQU 0x([0-9A-Fa-f]+)', line)
        if m:
            sym[m.group(1)] = int(m.group(2), 16)
    entry = {}
    for field, name in SYMBOLS.items():
        if name not in sym:
            sys.exit(f'{name} is not in forth_boot.sym')
        entry[field] = sym[name]

    # The spin loop: 3A lo hi (ld a,(KBD_KEYHIT)), B7 (or a), 28 FA (jr z,-6).
    k, hit = entry['keyWait'], entry['kbdKeyHit']
    want = bytes([0x3A, hit & 0xFF, hit >> 8, 0xB7, 0x28, 0xFA])
    if home[k:k + 6] != want:
        sys.exit(f'IO_READ_KEY.wait_hit at ${k:04X} is not the expected spin loop')
    entry['keyWaitEnd'] = k + 6

    key = hashlib.sha256(home + exrom).hexdigest()
    print(f"  // 2068-Forth {version} (SHA-256 HOME {hashlib.sha256(home).hexdigest()[:8]}…, "
          f"EXROM {hashlib.sha256(exrom).hexdigest()[:8]}…)")
    print(f"  '{key}': {{")
    print(f"    version: '{version}',")
    for field, value in entry.items():
        label = SYMBOLS.get(field, 'end of the spin loop (exclusive)')
        print(f"    {(field + ':').ljust(17)} 0x{value:04X},   // {label}")
    print('  },')


if __name__ == '__main__':
    main()
