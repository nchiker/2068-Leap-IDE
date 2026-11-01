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
 * any check fails. Run uses the BASIC profile's own driver
 * (src/lang/basic/profile.js), and section 1b drives the profile's attach()
 * API as ide.js does. (src/lang/basic/leap-lang.js needs CodeMirror, so the
 * language mode is checked in the browser: tests/browser-smoke.mjs.)
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
const { romPairHash } = await import(join(ROOT, 'src/emulator.js'));
const { basicProfile, encodeLineStore, prepareSource } = await import(join(ROOT, 'src/lang/basic/profile.js'));
const { PROFILES, profileById, profileForFile, profileForTape } = await import(join(ROOT, 'src/lang/profiles.js'));
const { createChecker } = await import(join(ROOT, 'src/lang/basic/leap-check.js'));
const D = await import(join(ROOT, 'src/lang/basic/leap-debug.js'));
const { buildTAP } = await import(join(ROOT, 'src/lang/basic/export.js'));
const C = await import(join(ROOT, 'src/lang/basic/cartridge.js'));
const { insertDock } = await import(join(ROOT, 'tsrun/machine.js'));
const { tapeToText, encodeShare, decodeShare } = await import(join(ROOT, 'src/files.js'));
const { bresenham, pathsToCode } = await import(join(ROOT, 'src/tools/draw.js'));
const { udgPokes, pokesInSource } = await import(join(ROOT, 'src/tools/udg.js'));
const { EXAMPLES } = await import(join(ROOT, 'src/lang/basic/examples.js'));

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
const hash = await romPairHash(home, exrom);
const rom = basicProfile.knownRoms[hash] ?? null;
check('ROM pair is in src/lang/basic/leap-roms.js', !!rom, rom ? rom.version : `unknown hash ${hash}: add an entry (tools/leap-rom-entry.py)`);
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
/** The IDE's Run: the BASIC profile's driver (store, PROG_END, return chain, optional package). */
function inject(m, lines, image = null) {
  basicProfile.driver.inject(m, rom, { store: encodeLineStore(lines), pkg: image });
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

{
  // Each Run starts with Leap's default colours, whatever the last run left set.
  const m = bootMachine();
  run(m, () => atWait(m), 600);
  inject(m, ['PAPER 0', 'INK 7', 'BORDER 2', 'OVER 1', 'CLS']);
  run(m, () => false, 2);
  run(m, () => atWait(m), 900);
  const after1 = m.bus.read(0x5800);
  inject(m, ['CLS', 'PRINT 1']);
  run(m, () => false, 2);
  run(m, () => atWait(m), 900);
  same('a run does not inherit the last run\'s colours (PAPER 0, INK 7 -> PAPER 7, INK 0)',
    { first: after1, second: m.bus.read(0x5800) }, { first: 0x07, second: 0x38 });
}

// ── 1b. The BASIC profile as ide.js uses it (src/lang/basic/profile.js) ──
console.log('\nLanguage profile (src/lang/profiles.js, src/lang/basic/profile.js)');
{
  same('profiles: BASIC is the default and owns .leap / .bas',
    [PROFILES[0].id, profileById('nope').id, profileForFile('x.LEAP')?.id, profileForFile('x.bas')?.id, profileForFile('x.txt')],
    ['basic', 'basic', 'basic', 'basic', null]);
  same('prepareSource drops blank lines and maps the rest', prepareSource('A = 1\n\n  \nPRINT A').editorLine, [0, 3]);
  const lang = await basicProfile.attach({
    rom, romImages: { home, exrom },
    fetchAsset: async path => new Uint8Array(readFileSync(join(ROOT, path))),
  });
  same('lint: a clean program has no diagnostics', lang.lint('CLS\nPRINT 1'), []);
  same('lint: LET is compile error 2 on its editor line',
    lang.lint('x = 1\n\nLET y = 2').map(d => [d.line0, d.message.slice(0, 15)]), [[2, 'SYNTAX ERROR 2:']]);
  same('lint: two packages are refused on the second one\'s line',
    lang.lint('CIRCLE 1, 2, 3\nCPLOT 1, 2').map(d => d.line0), [1]);
  const start = lang.startRun('CIRCLE 128, 96, 20');
  same('startRun: a package program carries the SHAPES image',
    [start.job.pkg?.length > 0, start.editorLine, start.message], [true, [0], 'Starting… (with the shapes package)']);
  same('describeResult: compile error on the editor line',
    lang.describeResult({ compileError: 2, vmError: 0, line: 1 }, [0, 2], () => -1).text, 'Compile error 2 on line 3');
  same('describeResult: BREAK at a line',
    lang.describeResult({ compileError: 0, vmError: 66, line: 0 }, [0], () => 4).text, 'Stopped (BREAK) at line 4');
  const tape = lang.exportTape('PRINT 1', 'hello');
  same('exportTape and profileForTape: the tape is BASIC\'s', [tape.fileName, profileForTape(tape.tap)?.id], ['hello.tap', 'basic']);
}

// ── 2. Editor checker (the ROM's own compiler on a hidden machine) ──
console.log('\nChecker (src/lang/basic/leap-check.js)');
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

// ── 3b. Examples menu (src/lang/basic/examples.js): each compiles and runs without an error ──
console.log('\nExamples');
for (const ex of EXAMPLES) {
  const lines = ex.text.split('\n').filter(l => l.trim() !== '');   // as prepareSource: blank lines are not stored
  const image = ex.package ? pkg(ex.package) : null;
  const r = runProgram(lines, image);
  // An INPUT example stops at its first INPUT (a key wait deeper in the stack).
  const ok = r.reached && r.ce === 0 && r.ve === 0 && (ex.input ? r.sp !== 0xFF00 : r.sp === 0xFF00);
  check(`example "${ex.title}" runs${ex.input ? ' to its INPUT' : ''}`, ok, json(r));
}

// ── 4. Debugger (src/lang/basic/leap-debug.js) ──
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
{
  const big = EXAMPLES.map(e => e.text).join('');                   // every example: about 3 KB of program
  const hash = await encodeShare(big, 'all examples.leap');
  const back = await decodeShare('#' + hash);
  check('a share link carries the program and its name', back.text === big && back.name === 'all examples.leap',
    `${back.text.length} characters, ${back.name}`);
  check('a share link is short', hash.length < big.length, `${big.length} characters of program -> ${hash.length} in the link`);
  same('a fragment with no program is ignored', await decodeShare('#section'), null);
  same('a damaged share link is refused', await decodeShare('#v1=AAAA').catch(e => /damaged/.test(e.message)), true);
}
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
  console.log('\nCartridge (src/lang/basic/cartridge.js)');
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

// ── 8. Leap-Forth (src/lang/forth/): the live prompt, Run line by line ──
console.log('\nLeap-Forth (src/lang/forth/profile.js)');
{
  const { forthProfile: F } = await import(join(ROOT, 'src/lang/forth/profile.js'));
  const { FORTH_EXAMPLES } = await import(join(ROOT, 'src/lang/forth/examples.js'));
  const { FORTH_WORD_ENTRIES } = await import(join(ROOT, 'src/lang/forth/forth-words.js'));
  const { lineTokens, scanDefinitions } = await import(join(ROOT, 'src/lang/forth/forth-scan.js'));
  const { checkForth } = await import(join(ROOT, 'src/lang/forth/forth-check.js'));
  const fdir = process.env.FORTH_ROMS ?? join(ROOT, 'tsrun/roms');
  const fhome = new Uint8Array(readFileSync(join(fdir, 'leapforth-0.rom')));
  const fexrom = new Uint8Array(readFileSync(join(fdir, 'leapforth-1.rom')));
  const from = F.knownRoms[await romPairHash(fhome, fexrom)] ?? null;
  check('Forth ROM pair is in src/lang/forth/forth-roms.js', !!from, from ? from.version : 'unknown: tools/forth-rom-entry.py');
  const fl = await F.attach({ rom: from });
  const m = createMachine(new Uint8Array(8).fill(0x1F), new Uint8Array(2).fill(0xFF));
  const boot = () => { setHomeRom(m, fhome); setExRom(m, fexrom); resetMachine(m); };
  const fwait = () => m.cpu.pc >= from.keyWait && m.cpu.pc < from.keyWaitEnd;
  const frun = (until, frames) => {
    for (let f = 0; f < frames; f++) {
      const end = m.frameStart + tStatesPerFrame;
      while (m.tstates < end && !m.cpu.halted) { if (until()) return true; runZ80(m.cpu, m.bus, 1, m); }
      runFrame(m);
    }
    return false;
  };
  /** Run as the IDE does (emulator.js with the Forth driver): the lines one by one, to the prompt or a wait. */
  function send(text, frames = 3000) {
    const start = fl.startRun(text);
    F.driver.inject(m, from, start.job);
    for (;;) {
      frun(() => false, 1);
      if (!frun(fwait, frames)) return { state: 'busy' };
      const state = F.driver.runState(m, from);
      if (state === 'ended' && F.driver.next(m, from, start.job)) continue;
      return { state, ...F.driver.result(m, from, start.job), status: fl.describeResult(F.driver.result(m, from, start.job), start.editorLine) };
    }
  }
  const ix = () => (m.cpu.xh << 8) | m.cpu.xl;
  const tos = () => { const v = m.bus.read(ix()) | (m.bus.read(ix() + 1) << 8); return v & 0x8000 ? v - 0x10000 : v; };
  const depth = () => (from.dstackTop - ix()) / 2;

  boot();
  check('Forth boots to the OK prompt', frun(fwait, 600) && F.driver.runState(m, from) === 'ended');
  same('definitions and a use, line by line, end in OK', (r => [r.state, r.lastError, r.status.text, depth(), tos()])(
    send(': SQ ( n -- n*n ) DUP * ;\n\n7 SQ')), ['ended', 0, 'OK', 1, 49]);
  same('a second Run sees the first one\'s words (the session is live)', (r => [r.lastError, tos()])(send('DROP 12 SQ')), [0, 144]);
  same('check: a word of the live session is known, an unknown one is marked',
    (fl.keyWait(m), fl.lint('DROP 5 SQ .\n5 NOPE')).map(d => [d.line0, d.cols, d.message.slice(0, 20)]),
    [[1, { from: 2, to: 6 }, 'UNDEFINED WORD: NOPE']]);
  same('an unknown word stops the sending, on its line and column', (r => [r.lastError, r.index, r.status.text, r.status.mark?.cols])(
    send('DROP 1\nFOO 2\n3')), [-13, 1, 'FOO ? (THROW -13: not a word Forth knows here) on line 2', { from: 0, to: 3 }]);
  {
    // The prompt stores each line before it runs it: the last one stored is the failing one.
    const end = m.bus.read(from.storeEnd) | (m.bus.read(from.storeEnd + 1) << 8);
    let text = '';
    for (let a = from.storeStart; a < end; a++) text += String.fromCharCode(m.bus.read(a));
    same('the lines after the error were not sent', text.split('\r').filter(Boolean).pop(), 'FOO 2');
  }
  same('Import session: the line store as text, what was sent in order',
    (r => r.text.split('\n').slice(0, 3))(fl.importSession(m)), [': SQ ( n -- n*n ) DUP * ;', '7 SQ', 'DROP 12 SQ']);
  same('a THROW from inside a word: DIVISION BY ZERO (-42) on the line that called it',
    (r => [r.lastError, r.status.text])(send(': BAD 1.0 0.0 F/ ;\nBAD')), [-42, 'DIVISION BY ZERO (THROW -42) on line 2']);
  same('KEY waits at a key wait that is not the prompt', (r => [r.state, F.driver.canInject(m, from)])(send('KEY')), ['waiting', false]);
  {
    // BREAK (CAPS SHIFT + SPACE) ends the KEY wait with THROW -28, back at the prompt.
    m.keyMatrix[0] &= ~1; m.keyMatrix[7] &= ~1;
    frun(() => false, 5);
    m.keyMatrix.fill(0x1F);
    m.bus.write(from.kbdKeyHit, 0);
    const at = frun(() => fwait() && F.driver.runState(m, from) === 'ended', 200);
    same('BREAK ends KEY: THROW -28, at the prompt', [at, F.driver.result(m, from, null).lastError], [true, -28]);
  }
  {
    send(': SPIN BEGIN 0 UNTIL ;');
    const start = fl.startRun('SPIN');
    F.driver.inject(m, from, start.job);
    const busy = !frun(fwait, 20);
    m.keyMatrix[0] &= ~1; m.keyMatrix[7] &= ~1;
    const back = frun(fwait, 100);
    m.keyMatrix.fill(0x1F);
    m.bus.write(from.kbdKeyHit, 0);
    same('BREAK stops an endless loop', [busy, back, F.driver.runState(m, from), F.driver.result(m, from, start.job).lastError],
      [true, true, 'ended', -28]);
  }
  same('lines over 128 characters are refused', fl.lint('1 . \\ ' + 'x'.repeat(130)).length, 1);

  // The examples (the manual's Part 7, tested by 2068-Forth's build): each from a fresh
  // Forth runs to OK. Those that wait for keys are left out here.
  const bad = [];
  for (const ex of FORTH_EXAMPLES.filter(e => !e.input)) {
    boot(); frun(fwait, 600);
    const r = send(ex.text, 6000);
    if (r.state !== 'ended' || r.lastError !== 0) bad.push(`${ex.id}: ${r.state} ${r.status?.text ?? ''}`);
  }
  boot(); frun(fwait, 600); fl.keyWait(m);
  same('Import session after a Reset: nothing to import', /empty/.test(fl.importSession(m).error), true);
  same('check: after a Reset the session\'s words are gone', fl.lint('5 SQ .').map(d => d.message.slice(0, 18)), ['UNDEFINED WORD: SQ']);
  same('check: every Examples-menu program is clean', FORTH_EXAMPLES.filter(e => checkForth(e.text).length > 0).map(e => e.id), []);
  same('check: use before definition, unbalanced IF, compile-only at the prompt, ; without :',
    checkForth('5 BAR\n: BAR . ;\n: X 1 IF 2 ;\nIF\n;').map(d => `${d.line0}:${d.cols.from} ${d.message.split(' ').slice(0, 3).join(' ')}`),
    ['0:2 UNDEFINED WORD: BAR', '2:6 IF without THEN', '3:0 IF ? :', '4:0 ; without a']);
  same('check: unclosed string (error) and ( comment (warning) on their line; MISSING NAME; OUT OF RANGE',
    checkForth('S" hi\n( note\nVARIABLE\n99999 .').map(d => `${d.line0} ${d.severity} ${d.message.split(' ').slice(0, 2).join(' ')}`),
    ['0 error The string', '1 warning This (', '2 error MISSING NAME:', '3 error OUT OF']);
  same('check: a defining word made with CREATE defines the name after it; \' X CATCH NAME',
    checkForth(': CONST CREATE , DOES> @ ;\n5 CONST FIVE FIVE .\n\' SAVE-TEXT CATCH DEMO .'), []);
  same(`the Examples menu's programs run to OK (${FORTH_EXAMPLES.filter(e => !e.input).length} without key input)`, bad, []);

  same('word data: 184 words from the manual, each with a stack effect and group',
    Object.values(FORTH_WORD_ENTRIES).filter(e => e.stack && e.group).length, 184);
  same('tokens: a comment, a string, a definition, a number',
    lineTokens(': HI ." HELLO" 42 . ; \\ greet').map(t => t.type), ['word', 'defName', 'word', 'string', 'number', 'word', 'word', 'comment']);
  same('definitions: :, VARIABLE, CONSTANT; the newest last',
    scanDefinitions(': A ;\nVARIABLE B  10 CONSTANT C\n: A 1 ;').map(d => `${d.kind} ${d.name} ${d.line}`),
    [': A 1', 'VARIABLE B 2', 'CONSTANT C 2', ': A 3']);
}

// ── 9. Leap-C (src/lang/c/): Run by the shell path, the checker, results ──
console.log('\nLeap-C (src/lang/c/profile.js)');
{
  const { leapcProfile: P } = await import(join(ROOT, 'src/lang/c/profile.js'));
  const { LEAPC_KEYWORD_ENTRIES } = await import(join(ROOT, 'src/lang/c/leapc-keywords.js'));
  const { scanC } = await import(join(ROOT, 'src/lang/c/leapc-scan.js'));
  const cdir = process.env.LEAPC_ROMS ?? join(ROOT, 'tsrun/roms');
  const chome = new Uint8Array(readFileSync(join(cdir, 'leapc-0.rom')));
  const cexrom = new Uint8Array(readFileSync(join(cdir, 'leapc-1.rom')));
  const crom = P.knownRoms[await romPairHash(chome, cexrom)] ?? null;
  check('Leap-C ROM pair is in src/lang/c/leapc-roms.js', !!crom, crom ? crom.version : 'unknown: tools/leapc-rom-entry.py');
  const cl = await P.attach({ rom: crom, romImages: { home: chome, exrom: cexrom } });
  const main = body => `int main(void)\n{\n${body}\n}`;

  same('checker: a clean program', cl.lint(main('    printf("HI");\n    return 0;')), []);
  same('checker: a syntax error on its line, at its token',
    cl.lint('int main(void)\n{\n\n    int x = 3 +;\n    return x;\n}').map(d => [d.line0, d.cols, d.message.slice(0, 21)]),
    [[3, { from: 15, to: 16 }, 'ERROR 20: SYNTAX ERRO']]);
  same('checker: an undefined function on its line', cl.lint(main('    foo(1);\n    return 0;')).map(d => [d.line0, d.message.slice(0, 31)]),
    [[2, 'ERROR 70: UNDEFINED FUNCTION (c']]);
  same('checker: a line over 127 characters', cl.lint(main('    // ' + 'x'.repeat(130))).length, 1);

  const m = createMachine(new Uint8Array(8).fill(0x1F), new Uint8Array(2).fill(0xFF));
  setHomeRom(m, chome); setExRom(m, cexrom); resetMachine(m);
  const cwait = () => m.cpu.pc >= crom.keyWait && m.cpu.pc < crom.keyWaitEnd;
  const crun = (until, frames) => {
    for (let f = 0; f < frames; f++) {
      const end = m.frameStart + tStatesPerFrame;
      while (m.tstates < end && !m.cpu.halted) { if (until()) return true; runZ80(m.cpu, m.bus, 1, m); }
      runFrame(m);
    }
    return false;
  };
  /** Run as the IDE does (the C driver at a shell key wait), to the report or a key wait. */
  function cRun(text) {
    const start = cl.startRun(text);
    P.driver.inject(m, crom, start.job);
    crun(() => false, 2);
    if (!crun(cwait, 900)) return { state: 'busy' };
    const r = P.driver.result(m, crom);
    return { state: P.driver.runState(m, crom), report: (m.bus.read(m.cpu.sp) | (m.bus.read(m.cpu.sp + 1) << 8)) === crom.reportReturn,
      text: cl.describeResult(r, start.editorLine, null, start.job).text };
  }
  check('Leap-C boots to its editor, a shell key wait', crun(cwait, 600) && P.driver.canInject(m, crom));
  same('hello world runs and ends at the report', cRun(main('    cls();\n    printf("HELLO");\n    return 9;')),
    { state: 'ended', report: true, text: 'Finished' });
  same('a compile error is reported on its editor line', cRun('int main(void)\n{\n\n    int x = 3 +;\n}').text, 'Compile error 20 on line 4');
  same('a run-time error names the failing function\'s line (stack overflow, 1)',
    cRun('int f(int n)\n{\n    return f(n + 1);\n}\nint main(void)\n{\n    return f(0);\n}').text, 'Runtime error 1 in the function on line 1');
  const waiting = cRun(main('    int c;\n    c = getkey();\n    return c;'));
  same('getkey() waits: a key wait the IDE must not start a run from', [waiting.state, P.driver.canInject(m, crom)], ['waiting', false]);
  {
    // BREAK for driver.breakHold frames, then let go (the report waits for all keys released).
    m.keyMatrix[0] &= ~1; m.keyMatrix[7] &= ~1;
    crun(() => false, P.driver.breakHold);
    m.keyMatrix.fill(0x1F);
    m.bus.write(crom.kbdKeyHit, 0);
    const back = crun(() => cwait() && P.driver.runState(m, crom) === 'ended', 300);
    same('BREAK ends getkey(): run-time error 5, Stopped (BREAK)',
      [back, cl.describeResult(P.driver.result(m, crom), [0, 1, 2, 3, 4], null, null).text], [true, 'Stopped (BREAK) in the function on line 1']);
  }
  same('a run started from the last report runs', cRun(main('    return 0;')).text, 'Finished');

  same('manual data: keywords, library functions, the shapes library',
    ['while', 'printf', 'circle'].map(w => LEAPC_KEYWORD_ENTRIES[w]?.kind), ['keyword', 'function', 'library function']);
  same('file-scope names: functions, globals, macros, types',
    (s => [s.functions.map(f => f.name), s.globals.map(g => g.name), s.macros.map(d => d.name), s.types.map(t => t.name)])(
      scanC('#define N 3\nint total, *p;\nstruct pt { int x; };\nint add(int a)\n{\n  /* { */ return a; // }\n}\nint main(void) { return add(N); }')),
    [['add', 'main'], ['total', 'p'], ['N'], ['pt']]);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
