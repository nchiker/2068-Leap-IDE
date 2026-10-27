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
    commandLoop:      0xD215,   // V2_COMMAND_LOOP.loop
    compileErrorCode: 0xBA0A,   // COMPILE_ERROR_CODE
    vmErrorCode:      0xB683,   // VM_ERROR_CODE
    curEditIndex:     0x80F2,   // CUR_EDIT_INDEX
    kbdKeyHit:        0x816C,   // KBD_KEYHIT
    keyWaitEnd:       0x043B,   // end of the spin loop (exclusive)
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
