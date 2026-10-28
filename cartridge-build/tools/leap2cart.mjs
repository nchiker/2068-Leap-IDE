#!/usr/bin/env node
// leap2cart.mjs — compile a Leap V2 program with the release ROM's own compiler and pack it into a
// runtime cartridge (.dck for emulators, flat 64 KB .bin for a physical cartridge).
//
//   node tools/leap2cart.mjs PROGRAM.bas -o OUT.dck [--bin OUT.bin] [--image OUT.prog]
//
// The compile is the Leap IDE checker's (src/leap-check.js): boot the release ROMs in a hidden TSRun
// machine to the editor's key wait, write the line store, call V2_CLEAR_ARRAYS -> V2_COMPILE_STORED,
// then read [VM_CODE_BASE, EMIT_PTR) and SYM_COUNTS. Addresses come from the build's .sym files.
// Inputs (override with env): LEAP=leap/ (v2_home.bin, v2_exrom.bin, build/*.sym, build/cart/*.bin),
// TSRUN=the IDE's tsrun/ submodule.

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { buildProgramImage, buildCartridge, romIdentity, cartIdentity } from "./cartpack.js";

const here = dirname(fileURLToPath(import.meta.url));
const LEAP = process.env.LEAP || join(here, "..", "leap");
const TSRUN = process.env.TSRUN || join(here, "..", "..", "tsrun");
const M = await import(pathToFileURL(join(TSRUN, "machine.js")).href);
const Z = await import(pathToFileURL(join(TSRUN, "z80.js")).href);

const MAX_LINE_CHARS = 255;

/** Lines the ROM would store: as the IDE's prepareSource (blank lines dropped, tabs = 2 spaces). */
export function sourceLines(text) {
  const lines = [];
  text.replace(/\r/g, "").split("\n").forEach((raw, i) => {
    const line = raw.replace(/\t/g, "  ").replace(/\s+$/, "");
    if (line.trim() === "") return;
    if (line.length > MAX_LINE_CHARS) throw new Error(`line ${i + 1}: longer than ${MAX_LINE_CHARS} characters`);
    if (/[^\x20-\x7E]/.test(line)) throw new Error(`line ${i + 1}: only printable ASCII can be stored`);
    lines.push(line);
  });
  return lines;
}

/** As the IDE's encodeLineStore: [len LE16 = text + CR][text][$0D] per line. */
function encodeLineStore(lines) {
  const out = [];
  for (const l of lines) {
    out.push((l.length + 1) & 0xFF, (l.length + 1) >> 8);
    for (let i = 0; i < l.length; i++) out.push(l.charCodeAt(i));
    out.push(0x0D);
  }
  return Uint8Array.from(out);
}

function readSyms(...paths) {
  const s = {};
  for (const p of paths) {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = /^(\S+): EQU 0x([0-9A-F]+)/.exec(line);
      if (m) s[m[1]] = parseInt(m[2], 16);
    }
  }
  return s;
}

/**
 * Compile a program on the release ROMs. Returns {code, line, bytecode, symCounts}; code 0 = compiled.
 */
export function compile(lines, home, exrom, sym) {
  const need = (n) => { if (!(n in sym)) throw new Error("symbol missing: " + n); return sym[n]; };
  const keyWait = need("IO_READ_KEY.wait_hit");
  const STACK_TOP = 0xFF00;
  const m = M.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
  M.setHomeRom(m, home);
  M.setExRom(m, exrom);
  M.resetMachine(m);
  const atWait = () => m.cpu.pc >= keyWait && m.cpu.pc < keyWait + 6;
  const r8 = (a) => m.bus.read(a);
  const r16 = (a) => r8(a) | (r8(a + 1) << 8);
  const w16 = (a, v) => { m.bus.write(a, v & 0xFF); m.bus.write(a + 1, (v >> 8) & 0xFF); };

  let booted = false;
  for (let f = 0; f < 400 && !booted; f++) {
    const end = m.frameStart + M.tStatesPerFrame;
    while (m.tstates < end && !m.cpu.halted) {
      if (atWait()) { booted = true; break; }
      Z.runZ80(m.cpu, m.bus, 1, m);
    }
    if (!booted) M.runFrame(m);
  }
  if (!booted) throw new Error("the Leap ROM did not reach its editor");

  const store = encodeLineStore(lines);
  const progArea = need("PROG_AREA_START");
  for (let i = 0; i < store.length; i++) m.bus.write(progArea + i, store[i]);
  w16(need("PROG_END"), progArea + store.length);
  w16(STACK_TOP - 2, need("V2_COMPILE_STORED"));
  w16(STACK_TOP, keyWait);
  m.cpu.sp = STACK_TOP - 2;
  m.cpu.pc = need("V2_CLEAR_ARRAYS");
  m.cpu.halted = false;
  for (let t = 0; t < 40_000_000; t += 20000) {
    Z.runZ80(m.cpu, m.bus, 20000, m);
    if (atWait()) {
      const code = r8(need("COMPILE_ERROR_CODE"));
      const line = r16(need("LEX_LINE")) & 0x7FFF;
      if (code !== 0) return { code, line };
      const base = need("VM_CODE_BASE"), end = r16(need("EMIT_PTR"));
      const bytecode = new Uint8Array(end - base);
      for (let i = 0; i < bytecode.length; i++) bytecode[i] = r8(base + i);
      const counts = need("SYM_COUNTS");
      const symCounts = Uint8Array.from([0, 1, 2, 3, 4], (k) => r8(counts + k));
      return { code: 0, line: 0, bytecode, symCounts };
    }
  }
  throw new Error("the compiler did not finish");
}

async function main(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o") opt.dck = argv[++i];
    else if (a === "--bin") opt.bin = argv[++i];
    else if (a === "--image") opt.image = argv[++i];
    else if (!opt.src) opt.src = a;
    else throw new Error("unexpected argument " + a);
  }
  if (!opt.src || !(opt.dck || opt.bin || opt.image)) {
    console.error("usage: leap2cart.mjs PROGRAM.bas [-o OUT.dck] [--bin OUT.bin] [--image OUT.prog]");
    process.exit(2);
  }
  const home = readFileSync(join(LEAP, "v2_home.bin"));
  const exrom = readFileSync(join(LEAP, "v2_exrom.bin"));
  const cartHome = readFileSync(join(LEAP, "build/cart/leap_v2_cart_home.bin"));
  const cartExrom = readFileSync(join(LEAP, "build/cart/leap_v2_cart_exrom.bin"));
  const identity = romIdentity(home, exrom);
  if (identity !== cartIdentity(cartHome)) {
    throw new Error(`the cartridge build accepts identity $${cartIdentity(cartHome).toString(16)}, ` +
      `the compiling ROMs are $${identity.toString(16)}: rebuild with make cart`);
  }
  const sym = readSyms(join(LEAP, "build/test_basic.sym"), join(LEAP, "build/exrom.sym"));
  const lines = sourceLines(readFileSync(opt.src, "utf8"));
  if (lines.length === 0) throw new Error("the program is empty");
  const r = compile(lines, home, exrom, sym);
  if (r.code !== 0) {
    console.error(`${opt.src}: compile error ${r.code} at stored line ${r.line + 1}`);
    process.exit(1);
  }
  const program = buildProgramImage({ bytecode: r.bytecode, symCounts: r.symCounts, identity });
  const { dck, bin } = buildCartridge({ home: cartHome, exrom: cartExrom, program });
  if (opt.dck) writeFileSync(opt.dck, dck);
  if (opt.bin) writeFileSync(opt.bin, bin);
  if (opt.image) writeFileSync(opt.image, program);
  console.log(`${opt.src}: ${r.bytecode.length} bytes of bytecode, counts ${[...r.symCounts].join(",")}, ` +
    `identity $${identity.toString(16).toUpperCase()}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
