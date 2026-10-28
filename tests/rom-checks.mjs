/**
 * tests/rom-checks.mjs — regression checks against the real Leap ROMs, in Node.
 *
 *   node tests/rom-checks.mjs                 the ROMs in tsrun/roms/
 *   LEAP_ROMS=<dir> node tests/rom-checks.mjs  leap-0.rom / leap-1.rom from <dir>
 *                                               (try a new release before moving the submodule)
 *
 * Needs Node 20+ (global crypto.subtle). No browser: TSRun's machine runs here
 * directly. Covers what "Adding a Leap ROM release" in CLAUDE.md asks to
 * re-verify: ROM table lookup, the run path (RAM injection), compile and
 * run-time errors, the editor's checker, packages, the debugger's line table /
 * variables / call stack, and TAP export against Leap's own SAVE. Exits 1 if
 * any check fails. (src/leap-lang.js needs CodeMirror, so the language mode
 * is checked in the browser: tests/browser-smoke.mjs.)
 *
 * Expected values were recorded against 2.0.2-emu.1. A check that fails on a
 * new release is a question, not automatically a bug: the ROM may have changed
 * on purpose (e.g. an error code); compare with the release's manual.
 */

"use strict";

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const romDir = process.env.LEAP_ROMS ?? join(ROOT, 'tsrun/roms');

const { createMachine, setHomeRom, setExRom, resetMachine, runFrame, tStatesPerFrame } = await import(join(ROOT, 'tsrun/machine.js'));
const { runZ80 } = await import(join(ROOT, 'tsrun/z80.js'));
const { identifyRoms } = await import(join(ROOT, 'src/leap-roms.js'));
const { encodeLineStore } = await import(join(ROOT, 'src/emulator.js'));
const { createChecker } = await import(join(ROOT, 'src/leap-check.js'));
const D = await import(join(ROOT, 'src/leap-debug.js'));
const { buildTAP } = await import(join(ROOT, 'src/export.js'));
const C = await import(join(ROOT, 'src/cartridge.js'));
const { insertDock } = await import(join(ROOT, 'tsrun/machine.js'));
const { tapeToText } = await import(join(ROOT, 'src/files.js'));
const { bresenham, pathsToCode } = await import(join(ROOT, 'src/tools/draw.js'));
const { udgPokes, pokesInSource } = await import(join(ROOT, 'src/tools/udg.js'));
const { EXAMPLES } = await import(join(ROOT, 'src/examples.js'));

// ── tiny harness ──
let failed = 0;
const json = v => JSON.stringify(v);
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed++;
}
const same = (name, got, want) => check(name, json(got) === json(want), `got ${json(got)}${json(got) === json(want) ? '' : `, want ${json(want)}`}`);

// ── ROMs ──
const home = new Uint8Array(readFileSync(join(romDir, 'leap-0.rom')));
const exrom = new Uint8Array(readFileSync(join(romDir, 'leap-1.rom')));
const { hash, rom } = await identifyRoms(home, exrom);
check('ROM pair is in src/leap-roms.js', !!rom, rom ? rom.version : `unknown hash ${hash}: add an entry (tools/leap-rom-entry.py)`);
if (!rom) process.exit(1);
console.log(`      Leap ${rom.version}, ROMs from ${romDir}\n`);

const pkg = name => new Uint8Array(readFileSync(join(ROOT, rom.packageDir, name + '.bin')));

// ── a machine, driven one instruction at a time ──
function bootMachine() {
  const m = createMachine(new Uint8Array(8).fill(0x1F), new Uint8Array(2).fill(0xFF));
  setHomeRom(m, home); setExRom(m, exrom); resetMachine(m);
  return m;
}
const w16 = (m, a, v) => { m.bus.write(a, v & 0xFF); m.bus.write(a + 1, v >> 8); };
const atWait = m => m.cpu.pc >= rom.keyWait && m.cpu.pc < rom.keyWaitEnd;
/** Run until until() (checked before each instruction) is true; false after maxFrames frames. */
function run(m, until, maxFrames) {
  for (let f = 0; f < maxFrames; f++) {
    const end = m.frameStart + tStatesPerFrame;
    while (m.tstates < end && !m.cpu.halted) { if (until()) return true; runZ80(m.cpu, m.bus, 1, m); }
    runFrame(m);
  }
  return false;
}
/** The IDE's Run (src/emulator.js inject()): store, PROG_END, return chain, optional package. */
function inject(m, lines, image = null) {
  const store = encodeLineStore(lines);
  store.forEach((b, i) => m.bus.write(rom.progAreaStart + i, b));
  w16(m, rom.progEnd, rom.progAreaStart + store.length);
  const CB = 0xFF00 - 4;
  w16(m, CB, rom.resetEdit); w16(m, CB + 2, rom.runStored); w16(m, 0xFF00, rom.commandLoop);
  if (image) {
    image.forEach((b, i) => m.bus.write(rom.packageBase + i, b));
    w16(m, rom.packageLen, image.length);
    w16(m, CB - 4, rom.packageBase); w16(m, CB - 2, rom.clearArrays);
    m.cpu.sp = CB - 4; m.cpu.pc = rom.ext2ClearAll;
  } else {
    m.cpu.sp = CB; m.cpu.pc = rom.clearArrays;
  }
}
/** Boot, run a program to its end; {reached, ce, ve, sp}. */
function runProgram(lines, image = null) {
  const m = bootMachine();
  if (!run(m, () => atWait(m), 600)) return { reached: false, note: 'never reached the editor key wait' };
  inject(m, lines, image);
  run(m, () => false, 2);                              // leave the key wait first
  const reached = run(m, () => atWait(m), 900);
  return { reached, ce: m.bus.read(rom.compileErrorCode), ve: m.bus.read(rom.vmErrorCode), sp: m.cpu.sp };
}

// ── 1. Run path ──
console.log('Run (RAM injection)');
same('hello world runs to the end', runProgram(['CLS', 'PRINT "HELLO"']), { reached: true, ce: 0, ve: 0, sp: 0xFF00 });
same('compile error is reported (LET -> 2)', runProgram(['x = 1', 'LET y = 2']).ce, 2);
same('run-time error is reported (index -> 10)', runProgram(['DIM a(3)', 'a(5) = 1']).ve, 10);
same('package program runs (SHAPES: CIRCLE + FILL)',
  runProgram(['CLS', 'CIRCLE 128, 96, 40', 'FILL 128, 96', 'PRINT "OK"'], pkg('shapes')), { reached: true, ce: 0, ve: 0, sp: 0xFF00 });

// ── 2. Editor checker (the ROM's own compiler on a hidden machine) ──
console.log('\nChecker (src/leap-check.js)');
const checker = createChecker(rom, { home, exrom });
const cases = [
  // name, lines, expected {code, line}: line = failing store line, or the line count at end of source
  ['compiles', ['PRINT "HI"'], { code: 0, line: 1 }],
  ['3: expression could not start', ['x = 1', 'y = 2', 'PRINT x +', 'PRINT y'], { code: 3, line: 2 }],
  ['7: GOTO an undefined label', ['GOTO nowhere'], { code: 7, line: 1 }],
  ['2: LET is not V2', ['x = 1', 'LET y = 2'], { code: 2, line: 1 }],
  ['9: IF block without ENDIF', ['a = 1', 'IF a = 1 THEN', 'PRINT "x"'], { code: 9, line: 3 }],
  ['70: string literal over 31', ['a$ = "' + 'x'.repeat(40) + '"'], { code: 70, line: 0 }],
  ['61: name over 31', ['abcdefghijabcdefghijabcdefghijabcd = 1'], { code: 61, line: 0 }],
  ['2: CIRCLE without its package', ['CIRCLE 10, 10, 5'], { code: 2, line: 0 }],
  ['label loop compiles', ['n = 0', 'top:', 'n = n + 1', 'IF n < 3 THEN GOTO top'], { code: 0, line: 4 }],
  ['16: PROC without ENDP', ['PROC p(n):', 'PRINT n'], { code: 16, line: 2 }],
];
for (const [name, lines, want] of cases) same(name, checker.check(encodeLineStore(lines)), want);
const big = [];
for (let i = 0; i < 150; i++) big.push(`v${i} = ${i} * 2`, `IF v${i} > 100 THEN GOTO done`);
big.push('done:', 'PRINT 1');
same('302-line program compiles', checker.check(encodeLineStore(big)), { code: 0, line: 302 });

// ── 3. Packages ──
console.log('\nPackages');
const shapesProg = ['CLS', 'CIRCLE 128, 96, 40', 'FILL 128, 96', 'PRINT "SHAPES OK"'];
same('package statements need the package', checker.check(encodeLineStore(shapesProg)).code, 2);
same('with SHAPES installed they compile', checker.check(encodeLineStore(shapesProg), pkg('shapes')).code, 0);
same('a plain program after a package check', checker.check(encodeLineStore(['PRINT 1'])).code, 0);
for (const name of ['cbeep', 'graphics', 'mode', 'printer', 'shapes', 'sprite']) {
  const image = pkg(name);
  check(`package image ${name}.bin fits the window`, image.length > 0 && image.length <= 0x400, `${image.length} bytes`);
}

// ── 3b. Examples menu (src/examples.js): each compiles and runs without an error ──
console.log('\nExamples');
for (const ex of EXAMPLES) {
  const lines = ex.text.split('\n').filter(l => l.trim() !== '');   // as prepareSource: blank lines are not stored
  const image = ex.package ? pkg(ex.package) : null;
  const r = runProgram(lines, image);
  // An INPUT example stops at its first INPUT (a key wait deeper in the stack).
  const ok = r.reached && r.ce === 0 && r.ve === 0 && (ex.input ? r.sp !== 0xFF00 : r.sp === 0xFF00);
  check(`example "${ex.title}" runs${ex.input ? ' to its INPUT' : ''}`, ok, json(r));
}

// ── 4. Debugger (src/leap-debug.js) ──
console.log('\nDebugger');
{
  const m = bootMachine();
  run(m, () => atWait(m), 600);
  inject(m, [
    'total = 0 : ratio = 1.5', 'name$ = "Leap"', 'DIM sq(5)', 'DIM w$(3, 8)', 'w$(1) = "two"',
    'FOR i = 1 TO 3', '  CALL show(i)', 'NEXT i', 'END',
    'PROC show(n):', '  total = total + n * ratio', '  sq(n) = n * n', 'ENDP',
  ]);
  const T = D.createLineTable(rom);
  run(m, () => { T.observe(m); return D.vmInstruction(m, rom) >= 0; }, 300);
  same('line table: statement starts', T.size, 14);
  same('first instruction is on line 0', T.lineOf(D.vmInstruction(m, rom)), 0);
  const procBp = new Set(T.breakAddrs(m, 9));
  run(m, () => { const ip = D.vmInstruction(m, rom); return ip >= 0 && procBp.has(ip); }, 300);
  same('breakpoint on the PROC line stops in the PROC', T.lineOf(D.vmInstruction(m, rom)), 9);
  same('call stack there', D.readCallStack(m, rom, a => T.lineOf(a)).map(f => `${f.kind} ${f.name} ${f.line}`),
    ['call show 6', 'for FOR i -1']);
  const bp = new Set(T.breakAddrs(m, 11)); let hits = 0;
  run(m, () => { const ip = D.vmInstruction(m, rom); return ip >= 0 && bp.has(ip) && ++hits === 2; }, 300);
  same('second hit of a breakpoint on line 11', T.lineOf(D.vmInstruction(m, rom)), 11);
  same('variables there', D.readVariables(m, rom).map(v => `${v.name}=${v.value}`),
    ['total=4.5', 'ratio=1.5', 'name$="Leap"', 'sq()=0, 1, 0, 0, 0', 'w$()="", "two", ""', 'i=2', 'n=2']);
  run(m, () => atWait(m), 300);
  same('program then ends cleanly', [m.bus.read(rom.compileErrorCode), m.bus.read(rom.vmErrorCode), m.cpu.sp], [0, 0, 0xFF00]);
  same('final variables', D.readVariables(m, rom).map(v => `${v.name}=${v.value}`),
    ['total=9', 'ratio=1.5', 'name$="Leap"', 'sq()=0, 1, 4, 9, 0', 'w$()="", "two", ""', 'i=4', 'n=0']);
}

// ── 5. TAP export vs Leap's own SAVE ──
console.log('\nTAP export');
const tapeLines = ['REM tape test', 'x = 1.5 : name$ = "Leap"', 'FOR i = 1 TO 3', '  PRINT i * x', 'NEXT i'];
const tapeStore = encodeLineStore(tapeLines);
const tap = buildTAP(tapeStore, 'MyProg', rom.tapeFormatWord);
same('a .tap opens back as the same source', tapeToText(tap).text, tapeLines.join('\n') + '\n');
// Leap's SAVE internals are not in the ROM table (only this test needs them):
// take them from the release's .sym files (2068-Leap build) for a new release.
const SAVE_SYMBOLS = {
  '2.0.2-emu.1': { V2_SAVE: 0xD7E5, STORAGE_SEND_BLOCK: 0xC310, NAME_PTR: 0xBE7C, NAME_LEN: 0xBE7E, REQ: 0xBE81 },
  '2.1.0-emu.1': { V2_SAVE: 0xD702, STORAGE_SEND_BLOCK: 0xC3F1, NAME_PTR: 0xBE7C, NAME_LEN: 0xBE7E, REQ: 0xBE81 },
};
const S = SAVE_SYMBOLS[rom.version];
if (!S) {
  console.log(`SKIP  byte-identical to Leap's SAVE — add SAVE_SYMBOLS['${rom.version}'] from the release's .sym files`);
} else {
  const m = bootMachine();
  run(m, () => atWait(m), 600);
  tapeStore.forEach((b, i) => m.bus.write(rom.progAreaStart + i, b));
  w16(m, rom.progEnd, rom.progAreaStart + tapeStore.length);
  [...'MyProg'].forEach((c, i) => m.bus.write(0xFE80 + i, c.charCodeAt(0)));
  w16(m, S.NAME_PTR, 0xFE80); m.bus.write(S.NAME_LEN, 6); m.bus.write(S.REQ, 0);
  w16(m, 0xFEFC, S.V2_SAVE); w16(m, 0xFEFE, rom.keyWait); m.cpu.sp = 0xFEFC; m.cpu.pc = rom.clearArrays;
  const r8 = a => m.bus.read(a);
  const blocks = [];
  run(m, () => {
    if (m.cpu.pc === S.STORAGE_SEND_BLOCK) {        // capture the block, skip the pulses
      const ix = (m.cpu.xh << 8) | m.cpu.xl, de = (m.cpu.d << 8) | m.cpu.e;
      blocks.push({ flag: m.cpu.a, bytes: Array.from({ length: de }, (_, i) => r8(ix + i)) });
      m.cpu.pc = r8(m.cpu.sp) | r8(m.cpu.sp + 1) << 8; m.cpu.sp += 2;
      m.cpu.f |= 1;                                 // carry: sent whole (2.1 stops SAVE otherwise)
      return false;
    }
    return atWait(m) && blocks.length >= 2;
  }, 3000);
  const romTap = [];
  for (const b of blocks) {
    let x = b.flag; for (const v of b.bytes) x ^= v;
    romTap.push((b.bytes.length + 2) & 255, (b.bytes.length + 2) >> 8, b.flag, ...b.bytes, x);
  }
  same("buildTAP is byte-identical to Leap's SAVE", { blocks: blocks.length, identical: json(romTap) === json([...tap]) }, { blocks: 2, identical: true });
}

// ── 6. Pure helpers ──
console.log('\nTools');
same('pathsToCode', pathsToCode([[[10, 20]], [[0, 0], [5, 0], [5, 5]]]), 'PLOT 10, 20\nLINE 0, 0 TO 5, 0\nLINE 5, 0 TO 5, 5');
same('bresenham includes both ends', [...bresenham(0, 0, 3, 1)].length, 4);
{
  const bytes = new Uint8Array(rom.udgCount * 8);
  bytes.set([0x3C, 0x42, 0x81, 0xA5, 0x81, 0x99, 0x42, 0x3C], 8 * 2);
  const text = udgPokes(bytes, [2], rom.udgTable, rom.udgCodeBase);
  const back = pokesInSource(text, rom.udgTable, bytes.length);
  same('UDG POKEs read back', [...back.values()], [0x3C, 0x42, 0x81, 0xA5, 0x81, 0x99, 0x42, 0x3C]);
  same('UDG POKE lines compile', checker.check(encodeLineStore(text.split('\n'))).code, 0);
}

// ── 7. Cartridge (DCK) export: the program on a stock TS2068 ──
if (rom.cartridgeDir) {
  console.log('\nCartridge (src/cartridge.js)');
  const cartHome = new Uint8Array(readFileSync(join(ROOT, rom.cartridgeDir, 'leap_v2_cart_home.bin')));
  const cartExrom = new Uint8Array(readFileSync(join(ROOT, rom.cartridgeDir, 'leap_v2_cart_exrom.bin')));
  const stock0 = new Uint8Array(readFileSync(join(ROOT, 'tsrun/roms/ts2068-0.rom')));
  const stock1 = new Uint8Array(readFileSync(join(ROOT, 'tsrun/roms/ts2068-1.rom')));
  const identity = C.romIdentity(home, exrom);
  same('the cartridge build accepts these ROMs\' bytecode', C.cartIdentity(cartHome), identity);

  const MARK = 32000;                                  // free RAM ($7D00)
  const prog = ['x = 6 * 7', `POKE ${MARK}, x`, 'PRINT "CART"; x'];
  const compiled = checker.compile(encodeLineStore(prog), C.SYM_COUNTS_SIZE);
  check('the checker returns bytecode and SYM_COUNTS', compiled.code === 0 && compiled.bytecode.length > 0 &&
    compiled.symCounts.length === C.SYM_COUNTS_SIZE, `${compiled.bytecode?.length} bytes, counts ${json([...(compiled.symCounts ?? [])])}`);
  same('a compile error comes back without bytecode', checker.compile(encodeLineStore(['LET y = 2']), C.SYM_COUNTS_SIZE), { code: 2, line: 0 });

  /** Stock ROMs, the cartridge in the dock; run to Leap's key wait (the program's end). */
  const runCartridge = (id, comp = compiled, pkgImage = null) => {
    const program = C.buildProgramImage({ bytecode: comp.bytecode, symCounts: comp.symCounts, identity: id,
      pkg: pkgImage, format: C.cartFormat(cartHome) });
    const { dck, bin } = C.buildCartridge({ home: cartHome, exrom: cartExrom, program });
    const m = createMachine(new Uint8Array(8).fill(0x1F), new Uint8Array(2).fill(0xFF));
    setHomeRom(m, stock0); setExRom(m, stock1);
    const err = insertDock(m, dck);
    resetMachine(m);
    const reached = !err && run(m, () => atWait(m), 600);
    let ink = 0;                                       // set pixels on the screen
    for (let a = 0x4000; a < 0x5800; a++) for (let v = m.bus.read(a); v; v &= v - 1) ink++;
    return { dck, bin, err, reached, mark: m.bus.read(MARK), ve: m.bus.read(rom.vmErrorCode), f4: m.portF4, ink };
  };
  const ok = runCartridge(identity);
  same('DCK layout: DOCK bank, chunks 0, 1, 3, 6 as ROM', { head: [...ok.dck.subarray(0, 9)], size: ok.dck.length },
    { head: [0, 2, 2, 0, 2, 0, 0, 2, 0], size: 9 + 4 * C.CHUNK });
  same('flat BIN: 64 KB, the program image at $6000', { size: ok.bin.length, magic: String.fromCharCode(...ok.bin.subarray(0x6000, 0x6008)) },
    { size: 65536, magic: 'LEAPPROG' });
  same('stock TS2068 runs the cartridge to the end', { err: ok.err, reached: ok.reached, mark: ok.mark, ve: ok.ve, f4: ok.f4 },
    { err: null, reached: true, mark: 42, ve: 0, f4: 0x43 });
  same('the cartridge build takes packages (image format 2)', C.cartFormat(cartHome), 2);
  const shapesCart = ['CLS', 'CIRCLE 128, 96, 40', 'FILL 128, 96', `POKE ${MARK}, 7`];
  const shapesComp = checker.compile(encodeLineStore(shapesCart), C.SYM_COUNTS_SIZE, pkg('shapes'));
  const shapesRun = shapesComp.code === 0 ? runCartridge(identity, shapesComp, pkg('shapes')) : null;
  // A filled radius-40 disc is about pi * 40^2 = 5027 pixels.
  check('a SHAPES program (CIRCLE + FILL) runs from the cartridge', shapesRun?.reached && shapesRun.mark === 7 &&
    shapesRun.ve === 0 && shapesRun.ink > 4500 && shapesRun.ink < 5600,
    json({ code: shapesComp.code, ...(shapesRun && { reached: shapesRun.reached, mark: shapesRun.mark, ve: shapesRun.ve, ink: shapesRun.ink }) }));
  const wrong = runCartridge(identity ^ 1);
  same('bytecode from other ROMs is refused (NO PROGRAM)', { reached: wrong.reached, mark: wrong.mark }, { reached: true, mark: 0 });
  same('OUT to the paging ports is found', C.pagingWrites('OUT 254, 1\nx = 1: OUT 244, 3\nPRINT "OUT 255, 0"\nOUT 511, 0'),
    [{ line: 2, port: 244 }, { line: 4, port: 511 }]);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
