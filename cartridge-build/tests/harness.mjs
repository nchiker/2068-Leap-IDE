// tests/harness.mjs — shared pieces of the cartridge tests: TSRun machines (release Leap ROMs, or the
// stock ROMs with a dock), symbols, compiling, keys and screen text.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { compile, sourceLines } from "../tools/leap2cart.mjs";
import { buildProgramImage, buildCartridge, romIdentity } from "../tools/cartpack.js";

const here = dirname(fileURLToPath(import.meta.url));
export const LEAP = process.env.LEAP || join(here, "..", "leap");
const TSRUN = process.env.TSRUN || join(here, "..", "..", "tsrun");
export const M = await import(pathToFileURL(join(TSRUN, "machine.js")).href);
export const Z = await import(pathToFileURL(join(TSRUN, "z80.js")).href);

const rd = (p) => readFileSync(join(LEAP, p));
export const home = rd("v2_home.bin"), exrom = rd("v2_exrom.bin");
export const cartHome = rd("build/cart/leap_v2_cart_home.bin"), cartExrom = rd("build/cart/leap_v2_cart_exrom.bin");
export const identity = romIdentity(home, exrom);
const stock0 = readFileSync(join(TSRUN, "roms/ts2068-0.rom")), stock1 = readFileSync(join(TSRUN, "roms/ts2068-1.rom"));

/** Release symbols, plus the cartridge-only ones (CART_*). */
export const sym = {};
for (const p of ["build/test_basic.sym", "build/exrom.sym", "build/cart/leap_v2_cart_home.sym", "build/cart/leap_v2_cart_exrom.sym"]) {
  const cart = p.includes("/cart/");
  for (const line of rd(p).toString().split("\n")) {
    const m = /^(\S+): EQU 0x([0-9A-F]+)/.exec(line);
    if (m && (!cart || !(m[1] in sym))) sym[m[1]] = parseInt(m[2], 16);
  }
}

export function compileText(text) {
  const lines = sourceLines(text);
  const r = compile(lines, home, exrom, sym);
  if (r.code !== 0) throw new Error(`compile error ${r.code} at line ${r.line + 1}`);
  return { lines, ...r };
}

export function cartridgeFor(text, { identity: id = identity } = {}) {
  const c = compileText(text);
  const program = buildProgramImage({ bytecode: c.bytecode, symCounts: c.symCounts, identity: id });
  return buildCartridge({ home: cartHome, exrom: cartExrom, program }).dck;
}

/** A TS2068 with the stock ROMs; with a DCK in the dock. Port $F4/$FF writes are logged in m.outs. */
export function stockMachine(dck) {
  const m = M.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
  M.setHomeRom(m, stock0);
  M.setExRom(m, stock1);
  if (dck) { const e = M.insertDock(m, dck); if (e) throw new Error(e); }
  M.resetMachine(m);
  m.outs = [];
  const io = m.bus.ioWrite;
  m.bus.ioWrite = (port, v) => {
    if ((port & 0xFF) === 0xF4 || (port & 0xFF) === 0xFF) m.outs.push([port & 0xFF, v, m.cpu.pc]);
    io(port, v);
  };
  return m;
}

export function releaseMachine() {
  const m = M.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
  M.setHomeRom(m, home);
  M.setExRom(m, exrom);
  M.resetMachine(m);
  return m;
}

/**
 * Run instruction by instruction until pred(m) or maxFrames frames; onStep(m) runs before each
 * instruction. Returns true if pred was met.
 */
export function runUntil(m, pred, maxFrames, onStep = null) {
  for (let f = 0; f < maxFrames; f++) {
    const end = m.frameStart + M.tStatesPerFrame;
    while (m.tstates < end) {
      if (onStep) onStep(m);
      if (pred(m)) return true;
      if (m.cpu.halted) { if (end - m.tstates < 4) break; Z.runZ80(m.cpu, m.bus, end - m.tstates, m); continue; }
      Z.runZ80(m.cpu, m.bus, 1, m);
    }
    M.runFrame(m);
  }
  return false;
}
export const atPc = (addr) => (m) => m.cpu.pc === addr;
export const atKeyWait = (m) => m.cpu.pc >= sym["IO_READ_KEY.wait_hit"] && m.cpu.pc < sym["IO_READ_KEY.wait_hit"] + 6;
export function frames(m, n) { for (let i = 0; i < n; i++) M.runFrame(m); }

// Keyboard: [half-row, bit]; CAPS SHIFT = [0,0], SYMBOL SHIFT = [7,1].
const ROWS = ["\x01zxcv", "asdfg", "qwert", "12345", "09876", "poiuy", "\nlkjh", " \x02mnb"];
function keyPos(ch) {
  for (let r = 0; r < 8; r++) { const b = ROWS[r].indexOf(ch); if (b >= 0) return [r, b]; }
  throw new Error("no key " + JSON.stringify(ch));
}
export function setKeys(m, chars, down) {
  for (const ch of chars) {
    const [r, b] = keyPos(ch);
    m.keyMatrix[r] = down ? m.keyMatrix[r] & ~(1 << b) : m.keyMatrix[r] | (1 << b);
  }
}
/** Press (a chord of) keys for `hold` frames, then release for `gap` frames. */
export function tap(m, chars, hold = 4, gap = 4) {
  setKeys(m, chars, true); frames(m, hold);
  setKeys(m, chars, false); frames(m, gap);
}
export function type(m, text) { for (const ch of text) tap(m, ch); }

// Screen text, glyphs learnt from the release ROM printing CHR$ 32..126.
const cell = (m, row, col) => {
  const b = [];
  for (let y = 0; y < 8; y++) b.push(m.ram[0x4000 + (((row & 0x18) << 8) | (y << 8) | ((row & 7) << 5) | col)]);
  return b.join(",");
};
let GLYPHS = null;
function glyphs() {
  if (GLYPHS) return GLYPHS;
  GLYPHS = new Map();
  const m = stockMachine(cartridgeFor("FOR i = 32 TO 126\nPRINT CHR$(i);\nNEXT i\n"));
  if (!runUntil(m, atKeyWait, 600)) throw new Error("glyph program did not finish");
  for (let k = 0; k < 95; k++) GLYPHS.set(cell(m, k >> 5, k & 31), String.fromCharCode(32 + k));
  return GLYPHS;
}
export function screenText(m) {
  const g = glyphs(), rows = [];
  for (let r = 0; r < 24; r++) {
    let t = "";
    for (let c = 0; c < 32; c++) t += g.get(cell(m, r, c)) ?? "?";
    rows.push(t.replace(/\s+$/, ""));
  }
  return rows;
}
