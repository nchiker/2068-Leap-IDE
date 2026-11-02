/**
 * src/lang/c/leapc-roms.js — the Leap-C ROM builds the IDE knows how to drive.
 *
 * Keyed by the SHA-256 of HOME (16K) followed by EXROM (8K); a ROM pair not
 * listed here is refused rather than driven with the wrong addresses. Every
 * address comes from the build's leapc_home.sym / leapc_exrom.sym.
 *
 * To add a release: take its emulator pack (leapc-<version>-emulators.zip:
 * roms/, symbols/, SHA256SUMS; put the two images, the two .sym files and
 * their SHA256SUMS lines in one directory), or build its tag in a detached
 * worktree of 2068-Leap-C (make build), then
 *   tools/leapc-rom-entry.py <dir> <version>
 * and paste the printed entry below. 1.0.0 came from its emulator pack.
 */

"use strict";

export const KNOWN_ROMS = {
  // Leap-C 1.0.0 (SHA-256 HOME d2b18eaa…, EXROM 02790ebe…)
  'c0f7f76fbc3b89626a09db9a6ec8cc268525103a5fbb70c6ad527d805df39b7b': {
    version: '1.0.0',
    keyWait:          0x02C0,   // IO_READ_KEY.wait_hit
    kbdKeyHit:        0x5C6C,   // KBD_KEYHIT
    gfxSetBorder:     0x03E1,   // GFX_SET_BORDER
    progAreaStart:    0x7800,   // PROG_AREA_START
    progAreaMax:      0xC000,   // PROG_AREA_MAX
    progEnd:          0x5B02,   // PROG_END
    arraysEnd:        0x5D2D,   // ARRAYS_END
    curEditIndex:     0x5BF2,   // CUR_EDIT_INDEX
    running:          0x5EB6,   // RUNNING
    ccErrNum:         0x5EB1,   // CC_ERRNUM
    ccErrLine:        0x5EB2,   // CC_ERRLINE
    shErrCol:         0x5F42,   // SH_ERR_COL
    rtErrNum:         0x5EB7,   // RT_ERRNUM
    rtErrLine:        0x5EBA,   // RT_ERRLINE
    rtRunDone:        0x367C,   // RT_RUN.done
    libLoaded:        0x5F54,   // LIB_LOADED
    tokLine:          0x5D61,   // TOK_LINE
    tokPtr:           0x5D5F,   // TOK_PTR
    cgPc:             0x5E84,   // CG_PC
    statement:        0x302C,   // STATEMENT
    shCompile:        0x2EDF,   // SH_COMPILE
    udgTable:         0xF180,   // UDG_TABLE
    udgCodeBase:      0x0090,   // UDG_CODE_BASE
    udgCount:         0x0015,   // UDG_COUNT
    stackTop:         0xFF00,   // LEAPC_STACK_TOP
    tapeFormatWord:   0x8C00,   // LEAPC_TAPE_VERSION
    libBase:          0xF400,   // LX_BASE
    shLoop:           0xC02F,   // SH_LOOP
    shRun:            0xC10F,   // SH_RUN
    reportReturn:     0xC1AC,   // SH_WAIT_KEY.key_ret
    reportBuf:        0x5F21,   // SH_REPORT_BUF
    dclAutoinit:      0x30BF,   // DCL_AUTOINIT
    stmtDoCond:       0x3187,   // STMT_DO.cond
    cgUnitFound:      0x2929,   // CG_UNIT.found
    runFnlines:       0x5EAB,   // RUN_FNLINES
    symGlo:           0x5E38,   // SYM_GLO
    rtRun:            0x363B,   // RT_RUN
    rtErrPc:          0x5EB8,   // RT_ERRPC
    runMain:          0x5E9C,   // RUN_MAIN
    runVoid:          0x5E9E,   // RUN_VOID
    imgLim:           0x5E72,   // IMG_LIM
    keyWaitEnd:       0x02C6,   // end of the spin loop (exclusive)
    romIdentity:      0xE90E,   // CRC-16/CCITT-FALSE of HOME then EXROM (the cartridge's identity)
    cartridgeDir:     'cartridge/c/1.1.0/',
  },



  // Leap-C 1.0.0-beta.2 (SHA-256 HOME 043becf4…, EXROM 97fe9523…)
  '9cc679793a1f855f7ddcc2d99113e2730bd45c37e7204ea91df0d8f8e4b5af04': {
    version: '1.0.0-beta.2',
    keyWait:          0x02C0,   // IO_READ_KEY.wait_hit
    kbdKeyHit:        0x5C6C,   // KBD_KEYHIT
    gfxSetBorder:     0x03E1,   // GFX_SET_BORDER
    progAreaStart:    0x7800,   // PROG_AREA_START
    progAreaMax:      0xC000,   // PROG_AREA_MAX
    progEnd:          0x5B02,   // PROG_END
    arraysEnd:        0x5D2D,   // ARRAYS_END
    curEditIndex:     0x5BF2,   // CUR_EDIT_INDEX
    running:          0x5EB6,   // RUNNING
    ccErrNum:         0x5EB1,   // CC_ERRNUM
    ccErrLine:        0x5EB2,   // CC_ERRLINE
    shErrCol:         0x5F42,   // SH_ERR_COL
    rtErrNum:         0x5EB7,   // RT_ERRNUM
    rtErrLine:        0x5EBA,   // RT_ERRLINE
    rtRunDone:        0x368A,   // RT_RUN.done
    libLoaded:        0x5F54,   // LIB_LOADED
    tokLine:          0x5D61,   // TOK_LINE
    tokPtr:           0x5D5F,   // TOK_PTR
    cgPc:             0x5E84,   // CG_PC
    statement:        0x303A,   // STATEMENT
    shCompile:        0x2EED,   // SH_COMPILE
    udgTable:         0xF180,   // UDG_TABLE
    udgCodeBase:      0x0090,   // UDG_CODE_BASE
    udgCount:         0x0015,   // UDG_COUNT
    stackTop:         0xFF00,   // LEAPC_STACK_TOP
    tapeFormatWord:   0x8C00,   // LEAPC_TAPE_VERSION
    libBase:          0xF400,   // LX_BASE
    shLoop:           0xC021,   // SH_LOOP
    shRun:            0xC101,   // SH_RUN
    reportReturn:     0xC1EB,   // SH_WAIT_KEY.read + 3 (no SH_WAIT_KEY.key_ret label in this build)
    keyWaitEnd:       0x02C6,   // end of the spin loop (exclusive)
  },
};
