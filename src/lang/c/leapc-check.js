/**
 * src/lang/c/leapc-check.js — the editor's error check for Leap-C: the ROM's
 * own compiler on a hidden machine, never displayed (the V2 checker's design,
 * src/lang/basic/leap-check.js).
 *
 * The machine boots the Leap-C ROMs once to the shell's key wait and keeps a
 * snapshot. check(store, lineCount) restores it, writes the line store
 * (PROG_END, ARRAYS_END, CUR_EDIT_INDEX as the shell keeps them) and calls
 * SH_COMPILE, the shell's own trampoline (EXROM out, CC_PROGRAM, EXROM in;
 * carry = error), with its return address pointing back into the key wait.
 * It reads CC_ERRNUM, CC_ERRLINE (1-based, over the stored lines) and the
 * column as SH_RUN works it out for SH_ERR_COL: TOK_PTR less the start of
 * the line's text, at most the line's length. Nothing is written outside the
 * program's own RAM and the stack.
 */

"use strict";

import { createMachine, setHomeRom, setExRom, resetMachine, runFrame, tStatesPerFrame } from '../../../tsrun/machine.js';
import { runZ80 } from '../../../tsrun/z80.js';
import { regionBlocks } from './cartridge.js';

const BOOT_FRAMES = 300;
const MAX_T = 60_000_000;           // give up on a compile after ~17 s of Z80 time (about 13 ms a line)
const CHUNK_T = 2000;               // T-states between looks for the key wait

/**
 * The 0-based column of a store offset within 1-based line `line` (SH_RUN's
 * SH_ERR_COL: past the line's end means its end), or -1.
 */
function errorColumn(store, line, offset) {
  let p = 0;
  for (let n = 1; p + 2 <= store.length; n++) {
    const len = (store[p] | (store[p + 1] << 8)) - 1;      // the record's length less its CR
    if (n === line) {
      const col = offset - (p + 2);
      return col < 0 ? -1 : Math.min(col, len);
    }
    p += 2 + len + 1;
  }
  return -1;
}

/**
 * @param {object} rom  entry from src/lang/c/leapc-roms.js
 * @param {{home: Uint8Array, exrom: Uint8Array}} images
 */
export function createChecker(rom, images) {
  const m = createMachine(new Uint8Array(8).fill(0x1F), new Uint8Array(2).fill(0xFF));
  setHomeRom(m, images.home);
  setExRom(m, images.exrom);
  resetMachine(m);

  const atWait = () => m.cpu.pc >= rom.keyWait && m.cpu.pc < rom.keyWaitEnd;
  const r16 = a => m.bus.read(a) | (m.bus.read(a + 1) << 8);
  const w16 = (a, v) => { m.bus.write(a, v & 0xFF); m.bus.write(a + 1, (v >> 8) & 0xFF); };

  let booted = false;
  for (let f = 0; f < BOOT_FRAMES && !booted; f++) {
    const end = m.frameStart + tStatesPerFrame;
    while (m.tstates < end && !m.cpu.halted) {
      if (atWait()) { booted = true; break; }
      runZ80(m.cpu, m.bus, 1, m);
    }
    if (!booted) runFrame(m);
  }
  if (!booted) throw new Error('Checker: the Leap-C ROM did not reach its editor');

  const snapshot = { ram: m.ram.slice(), cpu: { ...m.cpu }, portF4: m.portF4, portFF: m.portFF };

  return {
    /**
     * @param {Uint8Array} store  the encoded line store
     * @param {number} lineCount  its number of lines
     * @param {Uint8Array|null} lib  a library image to load first (LIB "name")
     * @returns {{code: number, line: number, col: number} | null}  code 0: compiles; null: did not finish
     */
    check(store, lineCount, lib = null) {
      m.ram.set(snapshot.ram);
      Object.assign(m.cpu, snapshot.cpu);
      m.portF4 = snapshot.portF4;
      m.portFF = snapshot.portFF;
      for (let i = 0; i < store.length; i++) m.bus.write(rom.progAreaStart + i, store[i]);
      w16(rom.progEnd, rom.progAreaStart + store.length);
      w16(rom.arraysEnd, rom.progAreaStart + store.length);
      w16(rom.curEditIndex, lineCount);
      if (lib) {
        for (let i = 0; i < lib.length; i++) m.bus.write(rom.libBase + i, lib[i]);
        m.bus.write(rom.libLoaded, rom.libBase >> 8);
      }
      w16(rom.stackTop - 2, rom.keyWait);
      m.cpu.sp = rom.stackTop - 2;
      m.cpu.pc = rom.shCompile;
      m.cpu.iff1 = m.cpu.iff2 = 0;        // no frame interrupts: nothing is drawn or scanned
      m.cpu.halted = false;
      for (let t = 0; t < MAX_T; t += CHUNK_T) {
        runZ80(m.cpu, m.bus, CHUNK_T, m);
        if (atWait() && m.cpu.sp === rom.stackTop) {
          const code = m.bus.read(rom.ccErrNum);
          if (!code) return { code, line: 0, col: -1 };
          const line = r16(rom.ccErrLine);
          return { code, line, col: errorColumn(store, line, r16(rom.tokPtr) - rom.progAreaStart) };
        }
      }
      return null;
    },

    /**
     * Compile as check() does and, if it compiles, read the program back for
     * the cartridge (c2cart.py compile_image): RUN_MAIN, RUN_VOID, IMG_LIM,
     * LIB_LOADED and the regions' blocks, from RAM itself ($C000-$DFFF is the
     * EXROM again once SH_COMPILE returns).
     * @returns {{code: number, line: number, col: number} | {code: 0, runMain: number, runVoid: number,
     *   imgLim: Uint8Array, libLoaded: number, blocks: [number, Uint8Array][]} | null}
     */
    compileImage(store, lineCount, lib = null) {
      const r = this.check(store, lineCount, lib);
      if (!r || r.code !== 0) return r;
      const ram16 = a => m.ram[a] | (m.ram[a + 1] << 8);
      const imgLim = m.ram.slice(rom.imgLim, rom.imgLim + 16);
      const libLoaded = m.ram[rom.libLoaded];
      return { code: 0, runMain: ram16(rom.runMain), runVoid: m.ram[rom.runVoid], imgLim, libLoaded,
        blocks: regionBlocks((a, n) => m.ram.slice(a, a + n), imgLim, libLoaded) };
    },
  };
}
