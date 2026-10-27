#!/usr/bin/env python3
"""Print a src/leap-roms.js entry for a 2068-Leap build.

usage: tools/leap-rom-entry.py <2068-Leap checkout> <version label>

Run `make build` in the checkout first (at the release tag). The entry is keyed
by the SHA-256 of HOME + EXROM, so the IDE refuses ROMs whose addresses it does
not know. Paste the output into KNOWN_ROMS in src/leap-roms.js, and copy the
release's packages/v2_package_<name>.bin files to packages/<version>/<name>.bin
(check them against the release's SHA256SUMS).
"""
import hashlib
import os
import sys

# IDE name -> symbol in the build's .sym files
SYMBOLS = {
    "progAreaStart":    "PROG_AREA_START",
    "progEnd":          "PROG_END",
    "sourceEnd":        "V2_SOURCE_END",
    "keyWait":          "IO_READ_KEY.wait_hit",
    "clearArrays":      "V2_CLEAR_ARRAYS",
    "resetEdit":        "V2_RESET_EDIT",
    "runStored":        "V2_RUN_STORED",
    "compileStored":    "V2_COMPILE_STORED",
    "tapeFormatWord":   "V2_FORMAT_WORD",      # header "autostart" field of a SAVE tape
    # Packages (LOAD "NAME" EXT): clear the registry, image at the window, call it
    "ext2ClearAll":     "EXT2_CLEAR_ALL",
    "packageBase":      "EXTENSION_MODULE_BASE",
    "packageLen":       "V2_PACKAGE_LEN",
    # User-defined characters: codes UDG_CODE_BASE.. (21 of them), 8 bytes each
    "udgTable":         "UDG_TABLE",
    "udgCodeBase":      "UDG_CODE_BASE",
    "udgCount":         "UDG_COUNT",
    "commandLoop":      "V2_COMMAND_LOOP.loop",
    "compileErrorCode": "COMPILE_ERROR_CODE",
    "vmErrorCode":      "VM_ERROR_CODE",
    "curEditIndex":     "CUR_EDIT_INDEX",
    "kbdKeyHit":        "KBD_KEYHIT",
    # Debugger (Phase 3): compiler and VM hooks, run-time tables
    "compileStmt":      "COMPILE_STATEMENT_LIST.loop",
    "lexLine":          "LEX_LINE",
    "emitPtr":          "EMIT_PTR",
    "tokType":          "TOK_TYPE",
    "runIsStored":      "V2_RUN_IS_STORED",
    "vmLoop":           "VM_RUN.loop",
    "vmIp":             "VM_IP",
    "vmHalted":         "VM_HALTED",
    "vmCodeBase":       "VM_CODE_BASE",
    "symBase":          "SYM_BASE_V",
    "symEnd":           "SYM_END_V",
    "rtSymtab":         "RT_SYMTAB_PTR",
    "rtFloattab":       "RT_FLOATTAB_PTR",
    "rtStrtab":         "RT_STRTAB_PTR",
    "rtArrPtr":         "RT_ARRPTR_PTR",
    "rtStrArrPtr":      "RT_STRARRPTR_PTR",
    "vmCsp":            "VM_CSP",
    "varsStart":        "VARS_START",
}


def read_syms(path):
    out = {}
    for line in open(path):
        p = line.split()
        if len(p) >= 3 and p[1] == "EQU":
            out[p[0].rstrip(":")] = int(p[2], 16)
    return out


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    build = os.path.join(sys.argv[1], "build")
    home = open(os.path.join(build, "test_basic.bin"), "rb").read()
    ex = open(os.path.join(build, "exrom.bin"), "rb").read()
    syms = read_syms(os.path.join(build, "test_basic.sym"))
    syms.update(read_syms(os.path.join(build, "exrom.sym")))

    # The key wait is a 3-instruction spin: ld a,(KBD_KEYHIT) / or a / jr z,.wait_hit.
    # Check the bytes so a ROM that reshapes it is caught here, not in the browser.
    kw = syms["IO_READ_KEY.wait_hit"]
    if home[kw] != 0x3A or home[kw + 3] != 0xB7 or home[kw + 4:kw + 6] != b"\x28\xFA":
        sys.exit("IO_READ_KEY.wait_hit is no longer the expected spin loop; update src/emulator.js")

    print("  // %s" % sys.argv[2])
    print("  '%s': {" % hashlib.sha256(home + ex).hexdigest())
    print("    version: '%s'," % sys.argv[2])
    for name, sym in SYMBOLS.items():
        print("    %-17s 0x%04X,   // %s" % (name + ":", syms[sym], sym))
    print("    keyWaitEnd:       0x%04X,   // end of the spin loop (exclusive)" % (kw + 6))
    # The release's packages/v2_package_<name>.bin, copied unchanged.
    print("    packageDir:       'packages/%s/'," % sys.argv[2])
    print("  },")


main()
