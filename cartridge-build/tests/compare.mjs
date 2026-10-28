#!/usr/bin/env node
// compare.mjs — the cartridge runs a program exactly as the Leap ROM's RUN does.
//
// For each program: compile it on the release ROMs (tools/leap2cart.mjs), then
//   A  the release ROMs, program injected into the editor's line store and RUN (as the IDE does);
//   B  the stock TS2068 ROMs with the program's cartridge in the dock;
// run each FRAMES frames past the start of its run and compare the display file, attributes and
// border. Programs that do not compile on the release ROMs (package statements, deliberate compile
// errors) are listed as skipped.
//
//   node tests/compare.mjs [--frames N] [--png-dir DIR] FILE...

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { compile, sourceLines } from "../tools/leap2cart.mjs";
import { buildProgramImage, buildCartridge, romIdentity } from "../tools/cartpack.js";

const here = dirname(fileURLToPath(import.meta.url));
const LEAP = process.env.LEAP || join(here, "..", "leap");
const TSRUN = process.env.TSRUN || join(here, "..", "..", "tsrun");
const M = await import(pathToFileURL(join(TSRUN, "machine.js")).href);
const Z = await import(pathToFileURL(join(TSRUN, "z80.js")).href);

const args = process.argv.slice(2);
let FRAMES = 1500, pngDir = null;
// Differences that are the cartridge's by design, or of this harness, not of the run.
const EXPECTED = {
  "fn.peek.rom.bas": "PEEK(0) reads the LROS header ($00), not `di` ($F3)",
  "kw.peek.1.bas": "PEEK(0) reads the LROS header ($00), not `di` ($F3)",
  "mem.free.1.bas": "FREE() is larger: the cartridge holds no source text",
  "mem.free.2.bas": "FREE() is larger: the cartridge holds no source text",
  "hw.stick_idle.bas": "STICK drives A8-A15 from a stale B; the reference run's B strobes a stick " +
    "(the corpus expects 0, which the cartridge prints)",
};
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--frames") FRAMES = parseInt(args[++i], 10);
  else if (args[i] === "--png-dir") pngDir = args[++i];
  else files.push(args[i]);
}

const rd = (p) => readFileSync(join(LEAP, p));
const home = rd("v2_home.bin"), exrom = rd("v2_exrom.bin");
const cartHome = rd("build/cart/leap_v2_cart_home.bin"), cartExrom = rd("build/cart/leap_v2_cart_exrom.bin");
const sym = {};
for (const p of ["build/test_basic.sym", "build/exrom.sym", "build/cart/leap_v2_cart_home.sym", "build/cart/leap_v2_cart_exrom.sym"]) {
  const cart = p.includes("/cart/");
  for (const line of rd(p).toString().split("\n")) {
    const m = /^(\S+): EQU 0x([0-9A-F]+)/.exec(line);
    if (m && (!cart || !(m[1] in sym))) sym[m[1]] = parseInt(m[2], 16);
  }
}
const stock0 = readFileSync(join(TSRUN, "roms/ts2068-0.rom")), stock1 = readFileSync(join(TSRUN, "roms/ts2068-1.rom"));
const identity = romIdentity(home, exrom);

function machine(h, x) {
  const m = M.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
  M.setHomeRom(m, h);
  M.setExRom(m, x);
  M.resetMachine(m);
  return m;
}

// Run frames instruction by instruction until pc is in [lo, hi); true if reached.
function runUntil(m, lo, hi, maxFrames) {
  for (let f = 0; f < maxFrames; f++) {
    const end = m.frameStart + M.tStatesPerFrame;
    while (m.tstates < end) {
      if (m.cpu.pc >= lo && m.cpu.pc < hi) return true;
      if (m.cpu.halted) { if (end - m.tstates < 4) break; Z.runZ80(m.cpu, m.bus, end - m.tstates, m); continue; }
      Z.runZ80(m.cpu, m.bus, 1, m);
    }
    M.runFrame(m);
  }
  return false;
}

const screen = (m) => m.ram.slice(0x4000, 0x5B00);
const w16 = (m, a, v) => { m.bus.write(a, v & 0xFF); m.bus.write(a + 1, v >> 8); };

function runReference(lines, frames = FRAMES) {
  const m = machine(home, exrom);
  const wait = sym["IO_READ_KEY.wait_hit"];
  if (!runUntil(m, wait, wait + 6, 400)) throw new Error("reference ROM did not reach the editor");
  const store = [];
  for (const l of lines) { store.push((l.length + 1) & 0xFF, (l.length + 1) >> 8, ...Buffer.from(l, "latin1"), 0x0D); }
  store.forEach((b, i) => m.bus.write(sym.PROG_AREA_START + i, b));
  w16(m, sym.PROG_END, sym.PROG_AREA_START + store.length);
  // CLEAR_ARRAYS -> RESET_EDIT -> RUN_STORED -> the command loop (the IDE's chain)
  const base = 0xFF00 - 4;
  w16(m, base, sym.V2_RESET_EDIT);
  w16(m, base + 2, sym.V2_RUN_STORED);
  w16(m, 0xFF00, sym["V2_COMMAND_LOOP.loop"]);
  m.cpu.sp = base;
  m.cpu.pc = sym.V2_CLEAR_ARRAYS;
  m.cpu.halted = false;
  if (!runUntil(m, sym.VM_RUN, sym.VM_RUN + 1, 400)) throw new Error("reference did not start VM_RUN");
  for (let f = 0; f < frames; f++) M.runFrame(m);
  return m;
}

function runCartridge(bytecode, symCounts) {
  const program = buildProgramImage({ bytecode, symCounts, identity });
  const { dck } = buildCartridge({ home: cartHome, exrom: cartExrom, program });
  const m = machine(stock0, stock1);
  const err = M.insertDock(m, dck);
  if (err) throw new Error(err);
  M.resetMachine(m);
  if (!runUntil(m, sym.VM_RUN, sym.VM_RUN + 1, 400)) throw new Error("cartridge did not start VM_RUN");
  for (let f = 0; f < FRAMES; f++) M.runFrame(m);
  return { m, dck };
}

// Screen text: glyphs learnt from the release ROM printing CHR$ 32..126 (rows 0-2).
const cell = (scr, row, col) => {
  const b = [];
  for (let y = 0; y < 8; y++) b.push(scr[((row & 0x18) << 8) | (y << 8) | ((row & 7) << 5) | col]);
  return b.join(",");
};
const GLYPHS = new Map();
{
  const lines = ["FOR i = 32 TO 126", "PRINT CHR$(i);", "NEXT i"];
  const c = compile(lines, home, exrom, sym);
  const scr = screen(runReference(lines, 50));
  for (let k = 0; k < 95; k++) GLYPHS.set(cell(scr, k >> 5, k & 31), String.fromCharCode(32 + k));
}
function text(scr) {
  const rows = [];
  for (let r = 0; r < 24; r++) {
    let t = "";
    for (let c = 0; c < 32; c++) t += GLYPHS.get(cell(scr, r, c)) ?? "?";
    rows.push(t.replace(/\s+$/, ""));
  }
  while (rows.length && rows[rows.length - 1] === "") rows.pop();
  return rows;
}

let pass = 0, fail = 0, skip = 0, expected = 0;
for (const f of files) {
  const name = basename(f);
  let lines;
  try { lines = sourceLines(readFileSync(f, "utf8")); } catch (e) { console.log(`SKIP ${name}: ${e.message}`); skip++; continue; }
  if (!lines.length) { skip++; continue; }
  const c = compile(lines, home, exrom, sym);
  if (c.code !== 0) { console.log(`SKIP ${name}: compile error ${c.code} (line ${c.line + 1})`); skip++; continue; }
  try {
    const a = runReference(lines);
    const { m: b } = runCartridge(c.bytecode, c.symCounts);
    const sa = screen(a), sb = screen(b);
    let diff = 0;
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) diff++;
    const same = diff === 0 && a.border === b.border;
    if (!same && EXPECTED[name]) {
      console.log(`EXPECTED ${name}: ${EXPECTED[name]}`);
      expected++;
      continue;
    }
    const ok = same;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${c.bytecode.length} B bytecode` +
      (ok ? "" : `, ${diff} screen bytes differ, border ${a.border} vs ${b.border}`));
    ok ? pass++ : fail++;
    if (!ok) {
      const ta = text(sa), tb = text(sb);
      for (let r = 0; r < Math.max(ta.length, tb.length); r++) {
        if (ta[r] !== tb[r]) console.log(`    row ${r}: ROM  ${JSON.stringify(ta[r] ?? "")}\n    row ${r}: CART ${JSON.stringify(tb[r] ?? "")}`);
      }
    }
    if (pngDir && !ok) {
      mkdirSync(pngDir, { recursive: true });
      writeFileSync(join(pngDir, name + ".ref.bin"), sa);
      writeFileSync(join(pngDir, name + ".cart.bin"), sb);
    }
  } catch (e) {
    console.log(`FAIL ${name}: ${e.message}`);
    fail++;
  }
}
console.log(`\n${pass} pass, ${expected} expected differences, ${fail} fail, ${skip} skipped`);
process.exit(fail ? 1 : 0);
