/**
 * src/leap-check.js — check a program with the Leap ROM's own compiler.
 *
 * A second, invisible TS2068 (TSRun's machine.js, never displayed) boots the
 * same ROMs once to the editor's key wait and is snapshotted there. Each
 * check restores the snapshot, writes the line store, and calls what RUN
 * calls before it runs anything:
 *
 *   V2_CLEAR_ARRAYS -> V2_COMPILE_STORED -> back into the key-wait loop
 *
 * then reads COMPILE_ERROR_CODE and LEX_LINE (the failing store line, as
 * V2_JUMP_TO_ERROR_LINE uses it). The editor's errors are therefore exactly
 * the ROM's, for whichever Leap release is loaded. Frame interrupts are never
 * delivered (compiling needs none) and nothing is drawn.
 */

"use strict";

import { createMachine, setHomeRom, setExRom, resetMachine, runFrame, tStatesPerFrame } from '../tsrun/machine.js';
import { runZ80 } from '../tsrun/z80.js';

const STACK_TOP  = 0xFF00;          // the ROM's machine stack, as in src/emulator.js
const BOOT_FRAMES = 300;            // to the editor: 66 frames on 2.0.2-emu.1
const CHUNK_T = 20000;              // T-states run between "finished yet?" checks
const MAX_T = 40_000_000;           // give up on a compile after ~11 s of Z80 time

/**
 * @param {object} rom                      entry from src/leap-roms.js
 * @param {{home: Uint8Array, exrom: Uint8Array}} images
 */
export function createChecker(rom, images) {
  const m = createMachine(new Uint8Array(8).fill(0x1F), new Uint8Array(2).fill(0xFF));
  setHomeRom(m, images.home);
  setExRom(m, images.exrom);
  resetMachine(m);

  const atWait = () => m.cpu.pc >= rom.keyWait && m.cpu.pc < rom.keyWaitEnd;
  const r8 = a => m.bus.read(a);
  const w16 = (a, v) => { m.bus.write(a, v & 0xFF); m.bus.write(a + 1, (v >> 8) & 0xFF); };

  // Boot to the key wait, one instruction at a time within each frame.
  let booted = false;
  for (let f = 0; f < BOOT_FRAMES && !booted; f++) {
    const end = m.frameStart + tStatesPerFrame;
    while (m.tstates < end && !m.cpu.halted) {
      if (atWait()) { booted = true; break; }
      runZ80(m.cpu, m.bus, 1, m);
    }
    if (!booted) runFrame(m);
  }
  if (!booted) throw new Error('Checker: the ROM did not reach its editor');

  const snapshot = {
    ram: m.ram.slice(),
    cpu: { ...m.cpu },
    portF4: m.portF4,
    portFF: m.portFF,
  };

  return {
    /**
     * Compile a line store (see encodeLineStore) without running it.
     * @returns {{code: number, line: number} | null}  code 0 = compiles;
     *   line = failing store line (the line count for end-of-source errors);
     *   null if the compiler did not finish.
     */
    check(store) {
      m.ram.set(snapshot.ram);
      Object.assign(m.cpu, snapshot.cpu);
      m.portF4 = snapshot.portF4;
      m.portFF = snapshot.portFF;

      for (let i = 0; i < store.length; i++) m.bus.write(rom.progAreaStart + i, store[i]);
      w16(rom.progEnd, rom.progAreaStart + store.length);
      // CLEAR_ARRAYS returns into COMPILE_STORED, which returns into the key wait.
      w16(STACK_TOP - 2, rom.compileStored);
      w16(STACK_TOP, rom.keyWait);
      m.cpu.sp = STACK_TOP - 2;
      m.cpu.pc = rom.clearArrays;
      m.cpu.halted = false;

      for (let t = 0; t < MAX_T; t += CHUNK_T) {
        runZ80(m.cpu, m.bus, CHUNK_T, m);
        if (atWait()) {
          return {
            code: r8(rom.compileErrorCode),
            line: (r8(rom.lexLine) | (r8(rom.lexLine + 1) << 8)) & 0x7FFF,
          };
        }
      }
      return null;
    },
  };
}
