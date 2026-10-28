/**
 * src/leap-roms.js — the Leap V2 ROM builds the IDE knows how to drive.
 *
 * RAM injection jumps into ROM routines and pokes system variables, and those
 * addresses move between Leap releases. Each entry is keyed by the SHA-256 of
 * HOME (16K) followed by EXROM (8K); a ROM pair not listed here is refused
 * rather than driven with the wrong addresses.
 *
 * To add a release: build its tag in a 2068-Leap checkout (`make build`), then
 *   tools/leap-rom-entry.py <checkout> <version>
 * and paste the printed entry below.
 */

"use strict";

export const KNOWN_ROMS = {
  // 2.0.2-emu.1 (built from 77f1baa; byte-identical to the release zip and TSRun's roms/leap-*.rom)
  'c0ae3c6108668db9fc58ccd8d0ef634d7d5e600d5d0f60a1d27a8c6d1a2a4b2c': {
    version: '2.0.2-emu.1',
    progAreaStart:    0x825A,   // PROG_AREA_START
    progEnd:          0x8002,   // PROG_END
    sourceEnd:        0xA655,   // V2_SOURCE_END
    keyWait:          0x0435,   // IO_READ_KEY.wait_hit
    clearArrays:      0xD6C2,   // V2_CLEAR_ARRAYS
    resetEdit:        0xD326,   // V2_RESET_EDIT
    runStored:        0xD49F,   // V2_RUN_STORED
    compileStored:    0xD54F,   // V2_COMPILE_STORED
    tapeFormatWord:   0x8101,   // V2_FORMAT_WORD
    ext2ClearAll:     0x0F29,   // EXT2_CLEAR_ALL
    packageBase:      0xF400,   // EXTENSION_MODULE_BASE
    packageLen:       0xBE82,   // V2_PACKAGE_LEN
    udgTable:         0xF180,   // UDG_TABLE
    udgCodeBase:      0x0090,   // UDG_CODE_BASE
    udgCount:         0x0015,   // UDG_COUNT
    commandLoop:      0xD215,   // V2_COMMAND_LOOP.loop
    compileErrorCode: 0xBA0A,   // COMPILE_ERROR_CODE
    vmErrorCode:      0xB683,   // VM_ERROR_CODE
    curEditIndex:     0x80F2,   // CUR_EDIT_INDEX
    kbdKeyHit:        0x816C,   // KBD_KEYHIT
    compileStmt:      0x3942,   // COMPILE_STATEMENT_LIST.loop
    lexLine:          0xB95C,   // LEX_LINE
    emitPtr:          0xBA02,   // EMIT_PTR
    tokType:          0xBA04,   // TOK_TYPE
    runIsStored:      0xBE84,   // V2_RUN_IS_STORED
    vmLoop:           0x1161,   // VM_RUN.loop
    vmNext:           0x1161,   // VM_RUN.next (= VM_RUN.loop before 2.1)
    vmIp:             0xB600,   // VM_IP
    vmHalted:         0xB684,   // VM_HALTED
    vmCodeBase:       0xA655,   // VM_CODE_BASE
    symBase:          0xB805,   // SYM_BASE_V
    symEnd:           0xB807,   // SYM_END_V
    rtSymtab:         0xB80D,   // RT_SYMTAB_PTR
    rtFloattab:       0xB80F,   // RT_FLOATTAB_PTR
    rtStrtab:         0xB811,   // RT_STRTAB_PTR
    rtArrPtr:         0xB813,   // RT_ARRPTR_PTR
    rtStrArrPtr:      0xB815,   // RT_STRARRPTR_PTR
    vmCsp:            0xB819,   // VM_CSP
    varsStart:        0x822F,   // VARS_START
    keyWaitEnd:       0x043B,   // end of the spin loop (exclusive)
    packageDir:       'packages/2.0.2-emu.1/',
  },
  // 2.1.0-emu.1 (built from c005159; byte-identical to the release zip and TSRun's roms/leap-*.rom at 016787f)
  '5a42872e6b6ec9a510f2cde3255617211d33eab7cb68b936c45d01d6db41bf95': {
    version: '2.1.0-emu.1',
    progAreaStart:    0x825A,   // PROG_AREA_START
    progEnd:          0x8002,   // PROG_END
    sourceEnd:        0xA655,   // V2_SOURCE_END
    keyWait:          0x0443,   // IO_READ_KEY.wait_hit
    clearArrays:      0xD5DF,   // V2_CLEAR_ARRAYS
    resetEdit:        0xD237,   // V2_RESET_EDIT
    runStored:        0xD3AA,   // V2_RUN_STORED
    compileStored:    0xD45A,   // V2_COMPILE_STORED
    tapeFormatWord:   0x8101,   // V2_FORMAT_WORD
    ext2ClearAll:     0x0F38,   // EXT2_CLEAR_ALL
    packageBase:      0xF400,   // EXTENSION_MODULE_BASE
    packageLen:       0xBE82,   // V2_PACKAGE_LEN
    udgTable:         0xF180,   // UDG_TABLE
    udgCodeBase:      0x0090,   // UDG_CODE_BASE
    udgCount:         0x0015,   // UDG_COUNT
    commandLoop:      0xD12B,   // V2_COMMAND_LOOP.loop
    compileErrorCode: 0xBA0A,   // COMPILE_ERROR_CODE
    vmErrorCode:      0xB683,   // VM_ERROR_CODE
    curEditIndex:     0x80F2,   // CUR_EDIT_INDEX
    kbdKeyHit:        0x816C,   // KBD_KEYHIT
    compileStmt:      0x387E,   // COMPILE_STATEMENT_LIST.loop
    lexLine:          0xB95C,   // LEX_LINE
    emitPtr:          0xBA02,   // EMIT_PTR
    tokType:          0xBA04,   // TOK_TYPE
    runIsStored:      0xBE84,   // V2_RUN_IS_STORED
    vmLoop:           0x11A1,   // VM_RUN.loop
    vmNext:           0x11A6,   // VM_RUN.next
    vmIp:             0xB600,   // VM_IP
    vmHalted:         0xB684,   // VM_HALTED
    vmCodeBase:       0xA655,   // VM_CODE_BASE
    symCounts:        0xB800,   // SYM_COUNTS
    symBase:          0xB805,   // SYM_BASE_V
    symEnd:           0xB807,   // SYM_END_V
    rtSymtab:         0xB80D,   // RT_SYMTAB_PTR
    rtFloattab:       0xB80F,   // RT_FLOATTAB_PTR
    rtStrtab:         0xB811,   // RT_STRTAB_PTR
    rtArrPtr:         0xB813,   // RT_ARRPTR_PTR
    rtStrArrPtr:      0xB815,   // RT_STRARRPTR_PTR
    vmCsp:            0xB819,   // VM_CSP
    varsStart:        0x822F,   // VARS_START
    keyWaitEnd:       0x0449,   // end of the spin loop (exclusive)
    packageDir:       'packages/2.1.0-emu.1/',
    cartridgeDir:     'cartridge/2.1.0-emu.1/',
  },
};

/**
 * @param {Uint8Array} home
 * @param {Uint8Array} exrom
 * @returns {Promise<{hash: string, rom: object | null}>}
 */
export async function identifyRoms(home, exrom) {
  const both = new Uint8Array(home.length + exrom.length);
  both.set(home);
  both.set(exrom, home.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', both));
  const hash = Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
  return { hash, rom: KNOWN_ROMS[hash] ?? null };
}
