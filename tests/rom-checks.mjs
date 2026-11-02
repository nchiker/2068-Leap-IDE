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

import { readFileSync, existsSync } from 'node:fs';
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
const { createPcKeyboard } = await import(join(ROOT, 'src/pc-keyboard.js'));

// ── typing into a waiting program, as the ROM projects' test tools feed keys ──
// Leap-C's tools/exectest.py and 2068-Forth's tools/forthtest.py give a program one key
// each time it waits for one (through the ISR's latch). Here each key is typed on the
// matrix instead, through the IDE's own PC-keyboard translation (src/pc-keyboard.js):
// held until the ROM takes it (the program leaves the key wait), then released for a
// few frames, so the next key is a new press. The keys therefore mean the same.
// A key counts as taken when the ROM's interrupt latches it (KBD_KEYHIT), as the
// tools' latch writes do; leaving the key wait's spin loop is no sign of it, since
// every frame interrupt leaves it too.
/** A key code -> the KeyboardEvent a PC would send for it. */
// (Forth's include/keys.inc: 1-4 the cursor keys, 8 DELETE, 13 ENTER, $10 BREAK = Escape on a PC.)
const NAMED_CODES = { 13: 'Enter', 8: 'Backspace', 1: 'ArrowLeft', 2: 'ArrowDown', 3: 'ArrowUp', 4: 'ArrowRight', 16: 'Escape' };
function keyEvent(code) {
  const key = NAMED_CODES[code] ?? String.fromCharCode(code);
  return { key, code: `K${code}`, repeat: false, ctrlKey: false, altKey: false, metaKey: false, preventDefault() {} };
}
/** Leap-C's `// keys:` text (exectest.py parse_keys): "text", ENTER, DELETE, NONE, or a number. */
function parseCKeys(text) {
  const out = [];
  for (const tok of text.match(/"[^"]*"|\S+/g) ?? []) {
    if (tok.startsWith('"')) out.push(...[...tok.slice(1, -1)].map(c => c.charCodeAt(0)));
    else if (tok === 'ENTER') out.push(13);
    else if (tok === 'DELETE') out.push(8);
    else if (tok === 'NONE') out.push(null);          // an inkey() that finds no key: nothing typed
    else out.push(Number(tok));
  }
  return out;
}
/**
 * Type one key: press it until the ROM latches it (KBD_KEYHIT, at most 10 frames), release
 * it and run 3 frames. run(until, frames) is the section's frame runner, m.bus the machine's.
 * Returns false when the ROM did not take the key.
 */
function typeKey(kb, code, run, bus, kbdKeyHit) {
  const e = keyEvent(code);
  kb.keyDown(e);
  const took = run(() => bus.read(kbdKeyHit) !== 0, 10);
  kb.keyUp(e);
  run(() => false, 3);
  return took;
}

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
  '2.1.1-emu.1': { V2_SAVE: 0xD702, STORAGE_SEND_BLOCK: 0xC3F1, NAME_PTR: 0xBE7C, NAME_LEN: 0xBE7E, REQ: 0xBE81 },
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

/** A signed 16-bit cell. */
const signed = (m, a) => { const v = m.bus.read(a) | (m.bus.read(a + 1) << 8); return v & 0x8000 ? v - 0x10000 : v; };

/** Tape routines of each Forth release (symbols/forth_boot.sym), for the tape checks. */
const FORTH_TAPE_SYMBOLS = {
  '2.0': { STORAGE_SEND_BLOCK: 0x09CE, STORAGE_RECEIVE_BLOCK: 0x0A5D },
};
/** What F6's output checks read (symbols/forth_boot.sym): the print row and the glyph routine. */
const FORTH_SCREEN_SYMBOLS = {
  '2.0': { PRINT_ROW: 0x81CF, GFX_PUTCHAR: 0x0705 },
};

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
  const fl = await F.attach({ rom: from, romImages: { home: fhome, exrom: fexrom }, fetchAsset: async p => new Uint8Array(readFileSync(join(ROOT, p))) });
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

  // F6: what each line prints, as 2068-Forth's tools/forthtest.py reads it. Each case starts
  // from a just-booted Forth (a snapshot) and its lines go one at a time through the IDE's
  // Send path (fharness's host_line is that path); `\ keys:` keys are typed on the matrix
  // whenever the line waits for one, `\ break: after N` holds BREAK after N instructions.
  // The output is the screen rows from the print row before the line to the one after it
  // (scrolling and CLS allowed for), trailing blanks dropped, joined with |, the final OK
  // dropped; it must equal the line's `\ expect:` text (nothing for a line without one),
  // end with `\ expect-end:`, or is not read (`\ draws`).
  const SS = FORTH_SCREEN_SYMBOLS[from.version];
  if (!SS) {
    console.log(`SKIP  Forth output checks — add FORTH_SCREEN_SYMBOLS['${from.version}'] from the release's forth_boot.sym`);
  } else {
    boot(); frun(fwait, 600);
    const snap = { ram: m.ram.slice(), cpu: { ...m.cpu }, portF4: m.portF4, portFF: m.portFF };
    const fresh = () => {
      m.ram.set(snap.ram); Object.assign(m.cpu, snap.cpu); m.portF4 = snap.portF4; m.portFF = snap.portFF;
      m.keyMatrix.fill(0x1F);
    };
    const cell = (row, col) => Array.from({ length: 8 }, (_, k) => {
      const y = row * 8 + k;
      return m.bus.read(0x4000 | ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2) | col);
    });
    // The glyphs, drawn by the ROM's own GFX_PUTCHAR (A = code, B = row, C = col), as fharness does:
    // codes 32 to 143 (128 to 143 the block graphics, read as U+2580 on).
    const glyphs = new Map();
    {
      const STOP = 0xFF02;
      m.bus.write(STOP, 0x18); m.bus.write(STOP + 1, 0xFE);          // jr $
      for (let code = 32; code < 144; code++) {
        const i = code - 32;
        Object.assign(m.cpu, { a: code, b: Math.floor(i / 32), c: i % 32, sp: 0xFF00, pc: SS.GFX_PUTCHAR, iff1: 0, iff2: 0, halted: false });
        m.bus.write(0xFF00, STOP & 0xFF); m.bus.write(0xFF01, STOP >> 8);
        for (let n = 0; n < 200000 && m.cpu.pc !== STOP; n++) runZ80(m.cpu, m.bus, 1, m);
        const k = cell(Math.floor(i / 32), i % 32).join();
        if (!glyphs.has(k)) glyphs.set(k, code < 128 ? String.fromCharCode(code) : String.fromCharCode(0x2580 + code - 128));
      }
      glyphs.set('0,0,0,0,0,0,0,0', ' ');
      fresh();
    }
    /** A screen row as text (fharness screen_rows): unknown cells ░, a UDG U+E000 + i, inverse • + char. */
    const screenRow = row => {
      let s = '';
      for (let col = 0; col < 32; col++) {
        const c = cell(row, col);
        let ch = glyphs.get(c.join());
        if (ch === undefined) {
          for (let u = 20; u >= 0; u--) {
            const b = Array.from({ length: 8 }, (_, j) => m.bus.read(from.udgTable + u * 8 + j));
            if (b.some(Boolean) && b.join() === c.join()) ch = String.fromCharCode(0xE000 + u);
          }
        }
        if (ch === undefined) { const inv = glyphs.get(c.map(b => 255 - b).join()); ch = inv === undefined ? '░' : '•' + inv; }
        s += ch;
      }
      return s.trimEnd();
    };
    const rows = () => Array.from({ length: 24 }, (_, r) => screenRow(r));
    const kb = createPcKeyboard(m.keyMatrix, F.keyboard.symbols);
    const unescape = t => t.replace(/\\(x[0-9a-fA-F]{2}|.)/g, (_, e) =>
      e[0] === 'x' ? String.fromCharCode(parseInt(e.slice(1), 16)) : ({ r: '\r', n: '\n', b: '\b', t: '\t', '\\': '\\' }[e] ?? '\\' + e));
    const DRAWS = { draws: true };
    /** forthtest.py's parse(): the typed lines with their expectation, keys and break. */
    const parseCase = text => {
      const out = [];
      let keys = '', brk = null;
      text.split('\n').forEach((raw, i) => {
        const s = raw.trim();
        if (!s) return;
        if (s.startsWith('\\')) {
          if (s.startsWith('\\ keys: ')) keys = unescape(s.slice(8));
          else if (s.startsWith('\\ break: ')) { const w = s.split(/\s+/).slice(2); brk = w[0] === 'after' ? Number(w[1]) : `at ${w[1]}`; }
          return;
        }
        let exp = null;
        const cut = (tag) => { const at = raw.indexOf(tag); const e = raw.slice(at + tag.length); raw = raw.slice(0, at); return e.startsWith(' ') ? e.slice(1).trimEnd() : e.trimEnd(); };
        if (raw.includes('\\ expect-end:')) exp = { end: cut('\\ expect-end:') };
        else if (raw.includes('\\ expect:')) exp = cut('\\ expect:');
        else if (raw.trimEnd().endsWith('\\ draws')) { raw = raw.trimEnd().slice(0, -'\\ draws'.length); exp = DRAWS; }
        out.push({ line: i + 1, text: raw.trimEnd(), exp, keys, brk });
        keys = ''; brk = null;
      });
      return out;
    };
    const pressBreak = down => { if (down) { m.keyMatrix[0] &= ~1; m.keyMatrix[7] &= ~1; } else m.keyMatrix.fill(0x1F); };
    /** forthtest.py's typed(): send one line, feed its keys, read what it printed. */
    const typed = ({ text, keys, brk }) => {
      if (typeof brk === 'string') throw new Error(`break: ${brk} is not supported here`);
      const before = rows();
      const r0 = m.bus.read(SS.PRINT_ROW);
      const start = fl.startRun(text);
      if (!start.job) throw new Error(`not sent: ${start.error ?? JSON.stringify(start.problems)}`);
      F.driver.inject(m, from, start.job);
      if (brk !== null) {
        let n = 0;
        if (!frun(() => ++n > brk || (n > 1 && fwait() && F.driver.runState(m, from) === 'ended'), 20000)) throw new Error('break: the run never got there');
        pressBreak(true);
        const back = frun(() => fwait() && F.driver.runState(m, from) === 'ended', 2000);
        pressBreak(false);
        m.bus.write(from.kbdKeyHit, 0);
        if (!back) throw new Error('BREAK held: the console never waited for a key again');
      } else {
        frun(() => false, 1);
        if (!frun(fwait, 20000)) throw new Error('the line did not end');
      }
      const queue = [...keys].map(c => c.charCodeAt(0));
      while (queue.length && F.driver.runState(m, from) === 'waiting') {
        if (!typeKey(kb, queue.shift(), frun, m.bus, from.kbdKeyHit)) throw new Error('a key was not taken');
        if (!frun(fwait, 20000)) throw new Error('the line did not end');
      }
      if (F.driver.runState(m, from) === 'waiting') throw new Error(`the line waits for a key (${queue.length ? '?' : 'no keys left'})`);
      if (queue.length) throw new Error(`${queue.length} key(s) not read`);
      const after = rows();
      const r1 = m.bus.read(SS.PRINT_ROW);
      const cleared = r1 < r0 || (before.slice(0, r0).some(Boolean) && !after.slice(0, r0).some(Boolean));
      let k = 0;
      while (k < r0 && !cleared && after.slice(0, r0 - k).join('\n') !== before.slice(k, r0).join('\n')) k++;
      const got = after.slice(cleared ? 0 : r0 - k, r1 + 1);
      while (got.length && !got[got.length - 1]) got.pop();
      while (cleared && got.length && !got[0]) got.shift();
      let out = got.join('|');
      if (out.endsWith('OK')) out = out.slice(0, -2).replace(/[ |]+$/, '');
      return out;
    };
    /** forthtest.py's run_case(): from a fresh Forth; null, or where and how it first differs. */
    const runCase = (name, lines) => {
      fresh();
      for (const l of lines) {
        let got;
        try { got = typed(l); } catch (e) { return `${name}:${l.line} ${JSON.stringify(l.text)}: ${e.message}`; }
        const want = l.exp ?? '';
        if (want === DRAWS) continue;
        if (typeof want === 'object' ? !got.endsWith(want.end) : got !== want)
          return `${name}:${l.line} ${JSON.stringify(l.text)} printed ${JSON.stringify(got)}, expected ${typeof want === 'object' ? `it to end with ${JSON.stringify(want.end)}` : JSON.stringify(want)}`;
      }
      return null;
    };

    const corpus = JSON.parse(readFileSync(join(ROOT, 'tests/forth-manual-examples.json'), 'utf8'));
    const t0 = Date.now();
    // Known differences between TSRun and ZEsarUX (2068-Forth's test emulator), not IDE faults:
    // STICK reads the AY's port A without making it an input, and Forth leaves the mixer
    // (register 7) at $F8, port A an output. TSRun then returns the output latch, as an
    // AY-3-8912 does (0, so device 2 reads 1); ZEsarUX returns the joystick lines (none: 0).
    const KNOWN = { 'docs/manual/04_machine.md:1214:2 "2 STICK ." printed "1", expected "0"': 'TSRun: AY port A is an output' };
    const docAll = corpus.examples.map(e => runCase(`${e.doc}:${e.line}`, parseCase(e.text))).filter(Boolean);
    const docBad = docAll.filter(d => !KNOWN[d]);
    if (process.env.VERBOSE) console.log(`      (${corpus.examples.length} manual examples in ${Date.now() - t0} ms)`);
    same(`F6: the manual's ${corpus.examples.length} examples print what their \\ expect: lines say (${corpus.ref}, as tools/forthtest.py runs tests/doc; ${Object.keys(KNOWN).length} known emulator difference)`, docBad, []);
    same('F6: the known emulator difference is still there (2 STICK . reads 1 in TSRun)', docAll.filter(d => KNOWN[d]), Object.keys(KNOWN));

    // The Examples menu's own data (src/lang/forth/examples.js): the Part 7 programs with their
    // expect and keys ([line, ...], 0-based), run the same way. The demos have no expectations.
    const exCase = ex => parseCase(ex.text).map(l => {
      const e = (ex.expect ?? []).find(([i]) => i === l.line - 1);
      const k = (ex.keys ?? []).find(([i]) => i === l.line - 1);
      return { ...l, exp: e ? e[1] : l.exp, keys: k ? k[1] : '' };
    });
    const part7 = FORTH_EXAMPLES.filter(e => e.expect);
    same(`F6: the Examples menu's ${part7.length} manual programs print what they should, those that read keys typed on the matrix (${part7.filter(e => e.keys).length})`,
      part7.map(ex => runCase(ex.id, exCase(ex))).filter(Boolean), []);
    {
      // demos/gallery.fs: "not rebuilt for the finished ROM" says its header; it loads on this
      // one (every line OK and silent), and MAIN shows the title screen and waits for a key.
      const g = FORTH_EXAMPLES.find(e => e.id === 'gallery');
      const lines = parseCase(g.text);
      const load = runCase('gallery', lines.slice(0, -1));
      const start = fl.startRun(lines.at(-1).text);
      F.driver.inject(m, from, start.job);
      frun(() => false, 100);
      same('F6: the Shooting Gallery demo loads, and MAIN shows its title screen', [load, lines.at(-1).text, screenRow(3).trim()], [null, 'MAIN', 'SHOOTING GALLERY']);
      pressBreak(true); frun(() => fwait() && F.driver.runState(m, from) === 'ended', 200); pressBreak(false); m.bus.write(from.kbdKeyHit, 0);
    }
  }

  // F5: TEXT tapes. The block sender / receiver are replaced by stand-ins
  // (STORAGE_SEND_BLOCK / STORAGE_RECEIVE_BLOCK of the release's forth_boot.sym):
  // capture what SAVE-TEXT sends, feed LOAD-TEXT the IDE's tape.
  const FS = FORTH_TAPE_SYMBOLS[from.version];
  if (!FS) {
    console.log(`SKIP  Forth tapes — add FORTH_TAPE_SYMBOLS['${from.version}'] from the release's forth_boot.sym`);
  } else {
    const ret = carry => {
      m.cpu.f = carry ? (m.cpu.f | 1) : (m.cpu.f & ~1);
      m.cpu.pc = m.bus.read(m.cpu.sp) | (m.bus.read(m.cpu.sp + 1) << 8);
      m.cpu.sp = (m.cpu.sp + 2) & 0xFFFF;
    };
    const tapeRun = (text, onBlock, frames = 3000) => {
      const start = fl.startRun(text);
      F.driver.inject(m, from, start.job);
      for (let f = 0; f < frames; f++) {
        const end = m.frameStart + tStatesPerFrame;
        while (m.tstates < end && !m.cpu.halted) {
          if (m.cpu.pc === FS.STORAGE_SEND_BLOCK || m.cpu.pc === FS.STORAGE_RECEIVE_BLOCK) onBlock(m.cpu.pc === FS.STORAGE_SEND_BLOCK);
          else runZ80(m.cpu, m.bus, 1, m);
        }
        runFrame(m);
        if (f > 2 && fwait() && F.driver.runState(m, from) === 'ended') break;
      }
      return F.driver.result(m, from, start.job);
    };
    const prog = ': T5 ( -- n ) 5 ;\n\n  VARIABLE V  7 V !\n: SHOW T5 V @ + . ;   \\ prints 12';
    boot(); frun(fwait, 600);
    send(prog);
    const sent = [];
    tapeRun('SAVE-TEXT demo', () => {
      const ixv = (m.cpu.xh << 8) | m.cpu.xl, de = (m.cpu.d << 8) | m.cpu.e;
      const bytes = [];
      for (let i = 0; i < de; i++) bytes.push(m.bus.read(ixv + i));
      sent.push({ flag: m.cpu.a, bytes });
      ret(true);                                    // carry set: sent whole
    });
    const romTap = [];
    for (const b of sent) {
      let x = b.flag; for (const v of b.bytes) x ^= v;
      const n = b.bytes.length + 2;
      romTap.push(n & 0xFF, n >> 8, b.flag, ...b.bytes, x);
    }
    const out = fl.exportTape(prog, 'demo');
    same('TAP export is byte-identical to the ROM\'s SAVE-TEXT', [sent.length, out.fileName, Buffer.from(out.tap).equals(Buffer.from(romTap))],
      [2, 'DEMO.tap', true]);
    same('Open: the TEXT tape reads back as the program\'s lines', [F.ownsTape(out.tap), F.tapeToText(out.tap).name, F.tapeToText(out.tap).text],
      [true, 'DEMO', ': T5 ( -- n ) 5 ;\n  VARIABLE V  7 V !\n: SHOW T5 V @ + . ;   \\ prints 12\n']);
    // LOAD-TEXT of the IDE's tape on a fresh Forth defines the words.
    boot(); frun(fwait, 600);
    const blocks = [];
    for (let p = 0; p < out.tap.length;) { const n = out.tap[p] | (out.tap[p + 1] << 8); blocks.push(out.tap.subarray(p + 2, p + 2 + n)); p += 2 + n; }
    const loaded = tapeRun('LOAD-TEXT DEMO', () => {
      const b = blocks.shift();
      if (!b || b[0] !== m.cpu.a) { ret(true); return; }
      let ixv = (m.cpu.xh << 8) | m.cpu.xl;
      const de = (m.cpu.d << 8) | m.cpu.e;
      for (let i = 0; i < de; i++) m.bus.write(ixv++, b[1 + i]);
      m.cpu.xh = (ixv >> 8) & 0xFF; m.cpu.xl = ixv & 0xFF; m.cpu.d = 0; m.cpu.e = 0;
      ret(false);                                   // carry clear: loaded
    });
    same('LOAD-TEXT reads the IDE\'s tape and defines its words', [loaded.lastError, (r => [r.lastError, tos()])(send('SHOW 0 T5 V @ +'))],
      [0, [0, 12]]);
    const basicTap = buildTAP(encodeLineStore(['PRINT 1']), 'demo', 0x8101);
    same('a Leap V2 tape is not a Forth tape, and the reverse', [F.ownsTape(basicTap), basicProfile.ownsTape(out.tap)], [false, false]);
  }

  // F4: the debugger. The adapter driven as src/debugger.js drives it: observe and position
  // before every instruction, breakpoints placed again when the line table grows.
  {
    const A = F.createDebugAdapter(from);
    /** Send text with breakpoints on job lines; stop(i) at each stop returns 'continue' | 'step' | 'quit'. */
    const debugRun = (text, breakLines, onStop) => {
      const start = fl.startRun(text);
      A.reset(start.job);
      F.driver.inject(m, from, start.job);
      let version = -1, at = new Set(), stepping = false, stops = 0, skip = false;
      for (let f = 0; f < 3000; f++) {
        const end = m.frameStart + tStatesPerFrame;
        while (m.tstates < end && !m.cpu.halted) {
          if (f > 0 && fwait() && F.driver.runState(m, from) === 'ended') {
            if (!F.driver.next(m, from, start.job)) return { stops, result: F.driver.result(m, from, start.job) };
          }
          A.observe(m);
          const pos = A.position(m);
          if (!skip && pos >= 0) {
            if (A.version() !== version) { version = A.version(); at = new Set(breakLines.flatMap(l => A.breakPositions(m, l))); }
            if ((stepping && A.isStart(pos)) || at.has(pos)) {
              stops++;
              const how = onStop({ line: A.lineOf(pos), stack: A.callStack(m, l => l + 1), vars: A.variables(m) });
              if (how === 'quit') return { stops };
              stepping = how === 'step';
              skip = true;                     // leave the stop: run this instruction
            }
          } else skip = false;
          runZ80(m.cpu, m.bus, 1, m);
          skip = false;
        }
        runFrame(m);
      }
      return { stops, result: null };
    };
    boot(); frun(fwait, 600);
    const prog = ': SQ ( n -- n*n )\n  DUP * ;\n: TWICE ( n -- )\n  SQ SQ . ;\n\n3 TWICE';
    const seen = [];
    const r = debugRun(prog, [1], s => {
      seen.push([s.line, s.vars[0].value, s.stack.map(f => `${f.label}@${f.line}`).join(' < ')]);
      return 'continue';
    });
    same('F4: a breakpoint in a word stops each time it runs, with the stack and the callers',
      [r.stops, r.result?.lastError, seen],
      [2, 0, [[1, '3  $0003', 'SQ@2 < TWICE@4 < the line sent@5'], [1, '9  $0009', 'SQ@2 < TWICE@4 < the line sent@5']]]);
    const steps = [];
    boot(); frun(fwait, 600);
    debugRun(prog, [4], s => { steps.push(`${s.line}:${s.vars.filter(v => v.type === 'data').map(v => v.name === 'stack' ? '-' : v.value.split(' ')[0]).join(',')}`); return steps.length < 6 ? 'step' : 'quit'; });
    same('F4: a breakpoint on a line run at the prompt stops when it is sent; Step goes word by word',
      steps, ['4:-', '3:3', '1:3', '1:3,3', '1:9', '3:9']);   // TWICE's body, SQ's DUP, *, ;, back in TWICE
    boot(); frun(fwait, 600);
    send('VARIABLE V  7 V !\n-5 CONSTANT K\nFVARIABLE FV  2.5E0 FV F!\n10 ARRAY A\n: W ;\n1 2');
    same('F4: the stacks and the words with their values',
      F.createDebugAdapter(from).variables(m).map(v => `${v.name} ${v.type} ${v.value.replace(/code \$\w+/, 'code')}`),
      ['top data 2  $0002', '2 data 1  $0001', 'V variable 7', 'K constant -5', 'FV fvariable 2.5', 'A data 20 bytes at $' + (A.variables(m).find(v => v.name === 'A')?.value.slice(-4) ?? ''), 'W : code']);
  }

  // F8: the cartridge. The editor's text built on a fresh hidden machine, the start word chosen,
  // then the DCK run on a stock TS2068 (stock ROMs, the cartridge in the dock).
  {
    const { readWords } = await import(join(ROOT, 'src/lang/forth/forth-debug.js'));
    const { programImage, crc16, isForthCartridge } = await import(join(ROOT, 'src/lang/forth/cartridge.js'));
    const cartProg = 'VARIABLE HIT\n: GREET ( -- ) CLS ." CART" ;\n: MAIN ( -- ) 42 HIT ! GREET ;\n255 0 UDG C!  129 0 UDG 7 + C!';
    const asked = [];
    const out = await fl.buildCartridge(cartProg, { confirm: () => true, prompt: (q, def) => { asked.push([q, def]); return 'main'; } });
    same('F8: the start word is asked for, from the program\'s : words (the newest the default)', [asked[0]?.[1], /GREET MAIN/.test(asked[0]?.[0] ?? ''), out.summary],
      ['MAIN', true, `${out.dck ? (out.dck[9 + 2 * 0x2000 + 4] | (out.dck[9 + 2 * 0x2000 + 5] << 8)) : 0} bytes of dictionary, start word MAIN`]);
    same('F8: the DCK: bank 0, chunks 0-2 and 5 as ROM, "F1" at DOCK $4000; the flat image 64 KB',
      [[...out.dck.subarray(0, 9)], out.dck.length, isForthCartridge(out.dck), out.bin.length, out.bin[0x4000], out.bin[0x4001], out.bin[0x6000]],
      [[0, 2, 2, 2, 0, 0, 2, 0, 0], 9 + 4 * 0x2000, true, 0x10000, 0x46, 0x31, 0xFF]);
    {
      const img = out.bin.subarray(0x4000);
      const n = img[4] | (img[5] << 8);
      same('F8: the image\'s CRC-16/CCITT-FALSE ("123456789" gives $29B1)', [crc16(new TextEncoder().encode('123456789')), crc16(img.subarray(0, 208 + n)) === (img[208 + n] | (img[209 + n] << 8))], [0x29B1, true]);
    }
    const stock0 = new Uint8Array(readFileSync(join(ROOT, 'tsrun/roms/ts2068-0.rom')));
    const stock1 = new Uint8Array(readFileSync(join(ROOT, 'tsrun/roms/ts2068-1.rom')));
    const sm = createMachine(new Uint8Array(8).fill(0x1F), new Uint8Array(2).fill(0xFF));
    setHomeRom(sm, stock0); setExRom(sm, stock1);
    const dockErr = insertDock(sm, out.dck);
    resetMachine(sm);
    let promptAt = false;
    for (let f = 0; f < 400 && !promptAt; f++) {
      const end = sm.frameStart + tStatesPerFrame;
      while (sm.tstates < end && !sm.cpu.halted) {
        if (f > 110 && sm.cpu.pc >= from.keyWait && sm.cpu.pc < from.keyWaitEnd && (sm.bus.read(sm.cpu.sp) | (sm.bus.read(sm.cpu.sp + 1) << 8)) === from.promptReturn) { promptAt = true; break; }
        runZ80(sm.cpu, sm.bus, 1, sm);
      }
      if (!promptAt) runFrame(sm);
    }
    const hit = readWords(sm, from).find(w => w.name === 'HIT');
    same('F8: on a stock TS2068 the cartridge loads, runs MAIN (HIT = 42) and leaves the OK prompt; the UDGs are there',
      [dockErr, promptAt, hit?.value, sm.bus.read(from.udgTable), sm.bus.read(from.udgTable + 7), signed(sm, from.lastError)], [null, true, '42', 255, 129, 0]);
    same('F8: an error while building names its line', await fl.buildCartridge(': A ;\nNOPE', { confirm: () => true, prompt: () => 'A' }),
      { error: 'NOPE ? (THROW -13: not a word Forth knows here) on line 2: fix it first', line0: 1 });
    same('F8: a start word that is not the program\'s is refused', (await fl.buildCartridge(': A ;', { confirm: () => true, prompt: () => 'DUP' })).error, 'DUP is not one of the program\'s words');
    same('F8: a cartridge needs a : word; another identity is refused',
      [(await fl.buildCartridge('1 2 +', { confirm: () => true })).error,
        (() => { try { programImage({ dictionary: new Uint8Array(8), latest: 0x9100, identity: 1, cartIdentity: 2, start: 'X' }); return 'built'; } catch (e) { return e.message.slice(0, 33); } })()],
      ['The program defines no : words to start the cartridge with', 'The program was made on other ROM']);
  }

  same('word data: 184 words from the manual, each with a stack effect and group',
    Object.values(FORTH_WORD_ENTRIES).filter(e => e.stack && e.group).length, 184);
  same('tokens: a comment, a string, a definition, a number',
    lineTokens(': HI ." HELLO" 42 . ; \\ greet').map(t => t.type), ['word', 'defName', 'word', 'string', 'number', 'word', 'word', 'comment']);
  same('definitions: :, VARIABLE, CONSTANT; the newest last',
    scanDefinitions(': A ;\nVARIABLE B  10 CONSTANT C\n: A 1 ;').map(d => `${d.kind} ${d.name} ${d.line}`),
    [': A 1', 'VARIABLE B 2', 'CONSTANT C 2', ': A 3']);
}

/** The shell's tape commands and block routines of each Leap-C release (symbols/leapc_exrom.sym). */
const LEAPC_TAPE_SYMBOLS = {
  '1.0.0': { SH_SAVE: 0xC8DE, SH_LOAD: 0xC80E, STORAGE_SEND_BLOCK: 0xCA62, STORAGE_RECEIVE_BLOCK: 0xCA74 },
};

// ── 9. Leap-C (src/lang/c/): Run by the shell path, the checker, results ──
console.log('\nLeap-C (src/lang/c/profile.js)');
{
  const { leapcProfile: P } = await import(join(ROOT, 'src/lang/c/profile.js'));
  const { LEAPC_KEYWORD_ENTRIES } = await import(join(ROOT, 'src/lang/c/leapc-keywords.js'));
  const { scanC } = await import(join(ROOT, 'src/lang/c/leapc-scan.js'));
  const { LEAPC_EXAMPLES } = await import(join(ROOT, 'src/lang/c/examples.js'));
  const cdir = process.env.LEAPC_ROMS ?? join(ROOT, 'tsrun/roms');
  const chome = new Uint8Array(readFileSync(join(cdir, 'leapc-0.rom')));
  const cexrom = new Uint8Array(readFileSync(join(cdir, 'leapc-1.rom')));
  const crom = P.knownRoms[await romPairHash(chome, cexrom)] ?? null;
  check('Leap-C ROM pair is in src/lang/c/leapc-roms.js', !!crom, crom ? crom.version : 'unknown: tools/leapc-rom-entry.py');
  const cl = await P.attach({ rom: crom, romImages: { home: chome, exrom: cexrom }, fetchAsset: async p => new Uint8Array(readFileSync(join(ROOT, p))) });
  const main = body => `int main(void)\n{\n${body}\n}`;
  /** The status of a finished run: with the exit status where the ROM entry has SH_REPORT_BUF. */
  const fin = n => (crom.reportBuf ? `Finished: exit ${n}` : 'Finished');

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
    { state: 'ended', report: true, text: fin(9) });
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
  same('a run started from the last report runs', cRun(main('    return 0;')).text, fin(0));

  // C6: libraries. A program that calls circle() / isqrt() gets LIB "shapes" installed for its check and run.
  if (!existsSync(join(ROOT, 'libs/c', crom.version, 'shapes.bin'))) {
    console.log(`SKIP  Leap-C libraries — no libs/c/${crom.version}/ (copy the release's library images there)`);
  } else {
    const pixel = (x, y) => (m.bus.read(0x4000 | ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2) | (x >> 3)) >> (7 - (x & 7))) & 1;
    const shapes = main('    cls();\n    circle(128, 96, 20);\n    return isqrt(150);');
    same('library: a shapes program checks clean (the library is loaded for the check)', cl.lint(shapes), []);
    same('library: without it the compiler does not know circle()', cl.lint(main('    cls();\n    circleX(1, 2, 3);\n    return 0;')).length, 1);
    same('library: a shapes program runs: circle() draws',
      [cRun(shapes).text, pixel(148, 96), pixel(108, 96), pixel(128, 76), pixel(128, 96), m.bus.read(crom.libLoaded)],
      [fin(12), 1, 1, 1, 0, crom.libBase >> 8]);
    same('library: the next run without it unloads it (LIB_LOADED 0)', [cRun(main('    return 0;')).text, m.bus.read(crom.libLoaded)], [fin(0), 0]);
    same('library: a program defining its own circle() does not load it',
      [cl.startRun('int circle(int a, int b, int c)\n{\n    return a;\n}\nint main(void)\n{\n    return circle(1, 2, 3);\n}').job.lib, cl.lint('int circle(int a, int b, int c)\n{\n    return a;\n}\nint main(void)\n{\n    return circle(1, 2, 3);\n}')],
      [null, []]);
    same('library: ⬇ TAP names LIB "shapes" first', cl.exportTape(shapes, 'circ').message, 'Saved circ.tap: on the TS2068, LIB "shapes", then LOAD "circ" then RUN');
  }

  // C4: the debugger, driven as src/debugger.js drives it.
  if (!crom.rtRun) {
    console.log(`SKIP  Leap-C debugger — the ${crom.version} entry has no C4 fields (tools/leapc-rom-entry.py)`);
  } else {
    const A = P.createDebugAdapter(crom);
    const debugRun = (text, breakLines0, onStop) => {
      const start = cl.startRun(text);
      A.reset(start.job);
      P.driver.inject(m, crom, start.job);
      let at = null, stepping = false, stops = 0;
      for (let f = 0; f < 1500; f++) {
        const end = m.frameStart + tStatesPerFrame;
        while (m.tstates < end && !m.cpu.halted) {
          if (f > 2 && cwait()) return { stops, start };
          A.observe(m);
          const pos = A.position(m);
          if (pos >= 0) {
            at ??= new Set(breakLines0.flatMap(l => A.breakPositions(m, l)));
            if ((stepping && A.isStart(pos)) || at.has(pos)) {
              stops++;
              const how = onStop({ line0: A.lineOf(pos), stack: A.callStack(m, l => start.editorLine[l] + 1), vars: A.variables(m) });
              if (how === 'quit') return { stops, start };
              stepping = how === 'step';
            }
          }
          runZ80(m.cpu, m.bus, 1, m);
        }
        runFrame(m);
      }
      return { stops, start };
    };
    const prog = ['int total;', 'int sq(int n)', '{', '    return n * n;', '}', 'int main(void)', '{', '    int i;',
      '    for (i = 1; i <= 3; i++)', '        total = total + sq(i);', '    return total;', '}'].join('\n');
    const seen = [];
    const r = debugRun(prog, [3], s => { seen.push([s.line0 + 1, s.vars.map(v => `${v.name} ${v.type} ${v.value}`).join(), s.stack.map(f => `${f.label}@${f.line}`).join(' < ')]); return 'continue'; });
    same('C4: a breakpoint in a function stops at each call, with the globals and the call stack',
      [r.stops, seen, cl.describeResult(P.driver.result(m, crom), r.start.editorLine, null, r.start.job).text],
      [3, [[4, 'total int 0', 'sq()@4 < main()@10'], [4, 'total int 1', 'sq()@4 < main()@10'], [4, 'total int 5', 'sq()@4 < main()@10']], fin(14)]);
    const steps = [];
    debugRun(prog, [8], s => { steps.push(s.line0 + 1); return steps.length < 8 ? 'step' : 'quit'; });
    {
      // The run was left at a pause: BREAK ends it, back to the report.
      m.keyMatrix[0] &= ~1; m.keyMatrix[7] &= ~1;
      crun(() => false, P.driver.breakHold);
      m.keyMatrix.fill(0x1F);
      m.bus.write(crom.kbdKeyHit, 0);
      crun(() => cwait() && P.driver.runState(m, crom) === 'ended', 300);
    }
    same('C4: Step goes statement by statement, into the called function', steps, [9, 10, 2, 4, 10, 2, 4, 10]);   // the for's test and step are not statement starts
    const g = ['struct pt { int x; int y; };', 'char name[8] = "LEAP";', 'float half = 0.5;', 'unsigned big = 50000;',
      'int arr[3] = { 7, -8, 9 };', 'struct pt p;', 'int *ptr;', 'int main(void)', '{', '    ptr = &arr[1];', '    return *ptr;', '}'].join('\n');
    const gv = [];
    debugRun(g, [10], s => { gv.push(...s.vars.map(v => `${v.name}: ${v.type} = ${v.value.replace(/\$[0-9A-F]{4}/, '$addr')}`)); return 'continue'; });
    same('C4: globals of each type with their values', gv,
      ['name: char[8] = "LEAP"', 'half: float = 0.5', 'big: unsigned = 50000', 'arr: int[3] = {7, -8, 9}', 'p: struct (4 bytes) = at $addr', 'ptr: int * = $addr']);
    const deep = 'int main(void)\n{\n    float f = 1.0;\n    float z = 0.0;\n    f = f / z;\n    return 0;\n}';
    const dr = debugRun(deep, [], () => 'continue');
    same('C4: a run-time error names its statement\'s line (RT_ERRPC in the line table)',
      cl.describeResult(P.driver.result(m, crom), dr.start.editorLine, () => { const l = A.stopLine(m); return l < 0 ? -1 : dr.start.editorLine[l] + 1; }, dr.start.job).text,
      'Runtime error 6 on line 5');
    const kr = debugRun('int main(void)\n{\n    int c = 0;\n    c = getkey();\n    return c;\n}', [], () => 'continue');
    m.keyMatrix[0] &= ~1; m.keyMatrix[7] &= ~1;
    crun(() => false, P.driver.breakHold);
    m.keyMatrix.fill(0x1F);
    m.bus.write(crom.kbdKeyHit, 0);
    crun(() => cwait() && P.driver.runState(m, crom) === 'ended', 300);
    same('C4: BREAK in getkey() names the line it stopped on',
      cl.describeResult(P.driver.result(m, crom), kr.start.editorLine, () => { const l = A.stopLine(m); return l < 0 ? -1 : kr.start.editorLine[l] + 1; }, kr.start.job).text,
      'Stopped (BREAK) on line 4');
  }

  // C7: the Examples menu (the manual's Part 7, each a test in Leap-C's build): every program
  // without keys or a tape runs to Finished with the manual's exit status (HL at RT_RUN.done),
  // screen rows and pixels. The screen is read back as text with glyphs learnt from the ROM itself.
  {
    // The screen as it was when the program ended (RT_RUN.done), before the report on row 23.
    let shot = null;
    const scr = a => (shot ? shot[a - 0x4000] : m.bus.read(a));
    const cellBytes = (row, col) => Array.from({ length: 8 }, (_, k) => {
      const y = row * 8 + k;
      return scr(0x4000 | ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2) | col);
    }).join(',');
    const glyphs = new Map();
    const chars = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i));
    const printed = chars.map(c => c === '\\' || c === '"' ? '\\' + c : c === '%' ? '%%' : c).join('');
    cRun(main(`    cls();\n    printf("${printed}");\n    return 0;`));
    chars.forEach((c, i) => { const k = cellBytes(Math.floor(i / 32), i % 32); if (!glyphs.has(k)) glyphs.set(k, c); });   // blank glyphs read as space
    const screenRow = row => Array.from({ length: 32 }, (_, col) => glyphs.get(cellBytes(row, col)) ?? '?').join('').trimEnd();
    const pixel = (x, y) => (scr(0x4000 | ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2) | (x >> 3)) >> (7 - (x & 7))) & 1;
    /**
     * Run to the report, keeping HL at RT_RUN.done (the exit status) and the screen there.
     * keys (the manual's `// keys:` text): typed one at a time whenever the program waits
     * for a key (getkey(), gets()), as Leap-C's exectest.py feeds them.
     */
    const kb = createPcKeyboard(m.keyMatrix, P.keyboard.symbols);
    const runExit = (text, keys = null) => {
      const start = cl.startRun(text);
      P.driver.inject(m, crom, start.job);
      let exit = null;
      const done = () => {
        if (m.cpu.pc === crom.rtRunDone) {
          exit = (m.cpu.h << 8) | m.cpu.l;
          shot = Uint8Array.from({ length: 6144 }, (_, i) => m.bus.read(0x4000 + i));
        }
      };
      crun(() => false, 2);
      shot = null;
      let back = crun(() => (done(), cwait()), 1500);
      const queue = (keys ? parseCKeys(keys) : []).filter(k => k !== null);
      let keyNote = null;
      while (back && P.driver.runState(m, crom) === 'waiting') {
        if (!queue.length) { keyNote = 'waiting for a key with none left'; break; }
        if (!typeKey(kb, queue.shift(), (u, n) => crun(() => (done(), u()), n), m.bus, crom.kbdKeyHit)) { keyNote = 'a key was not taken'; break; }
        back = crun(() => (done(), cwait()), 1500);
      }
      if (!keyNote && queue.length) keyNote = `${queue.length} key(s) not read`;
      if (P.driver.runState(m, crom) !== 'ended') {
        // Left waiting or busy: BREAK, so the next run starts from the report.
        m.keyMatrix[0] &= ~1; m.keyMatrix[7] &= ~1;
        crun(() => false, P.driver.breakHold);
        m.keyMatrix.fill(0x1F);
        m.bus.write(crom.kbdKeyHit, 0);
        crun(() => cwait() && P.driver.runState(m, crom) === 'ended', 300);
      }
      return { back, exit, keyNote, text: cl.describeResult(P.driver.result(m, crom), start.editorLine, null, start.job).text };
    };
    const bad = [];
    const hasLibs = existsSync(join(ROOT, 'libs/c', crom.version));
    const runnable = LEAPC_EXAMPLES.filter(e => !e.input && !e.tape && (hasLibs || !e.library));
    const keyed = LEAPC_EXAMPLES.filter(e => e.input && e.keys && !e.tape && (hasLibs || !e.library));
    const badKeyed = [];
    for (const ex of [...runnable, ...keyed]) {
      const r = runExit(ex.text, ex.keys ?? null);
      if (r.keyNote) { (ex.keys ? badKeyed : bad).push(`${ex.id}: ${r.keyNote}`); continue; }
      const got = { status: r.text, exit: r.exit & 0xFFFF,
        screen: (ex.screen ?? []).map(([row]) => [row, screenRow(row)]),
        pixels: (ex.pixels ?? []).map(([x, y]) => [x, y, pixel(x, y)]) };
      const want = { status: fin(ex.exit), exit: ex.exit & 0xFFFF,
        screen: (ex.screen ?? []).map(([row, t]) => [row, t.trimEnd()]), pixels: ex.pixels ?? [] };
      if (JSON.stringify(got) !== JSON.stringify(want)) (ex.keys ? badKeyed : bad).push(`${ex.id}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    }
    same(`the Examples menu's programs give the manual's exit status, screen and pixels (${runnable.length} without keys or a tape)`, bad, []);
    same(`the Examples menu's programs that read keys, typed on the keyboard matrix, give the manual's results (${keyed.length}: ${keyed.map(e => e.id).join(', ')})`, badKeyed, []);
    same('every example checks clean', LEAPC_EXAMPLES.filter(e => (hasLibs || !e.library) && cl.lint(e.text).length > 0).map(e => e.id), []);
  }

  // C5: tapes. SH_SAVE / SH_LOAD (the shell's SAVE "name" / LOAD "name") called at the
  // report's key wait with the block routines replaced by stand-ins, as for V2 and Forth.
  const CT = LEAPC_TAPE_SYMBOLS[crom.version];
  if (!CT) {
    console.log(`SKIP  Leap-C tapes — add LEAPC_TAPE_SYMBOLS['${crom.version}'] from the release's symbols/*.sym`);
  } else {
    const ret = carry => {
      m.cpu.f = carry ? (m.cpu.f | 1) : (m.cpu.f & ~1);
      m.cpu.pc = m.bus.read(m.cpu.sp) | (m.bus.read(m.cpu.sp + 1) << 8);
      m.cpu.sp = (m.cpu.sp + 2) & 0xFFFF;
    };
    /** Call a shell command routine with HL -> 'name"' (after the opening quote), as typed. */
    const command = (routine, name, onBlock) => {
      const NAME_AT = 0x6000;                         // image region 4: free outside a run
      [...name + '"'].forEach((c, i) => m.bus.write(NAME_AT + i, c.charCodeAt(0)));
      m.bus.write(NAME_AT + name.length + 1, 0);
      m.cpu.sp = crom.stackTop - 2;
      m.bus.write(m.cpu.sp, crom.shLoop & 0xFF); m.bus.write(m.cpu.sp + 1, crom.shLoop >> 8);
      m.cpu.h = NAME_AT >> 8; m.cpu.l = NAME_AT & 0xFF;
      m.cpu.pc = routine;
      for (let f = 0; f < 600; f++) {
        const end = m.frameStart + tStatesPerFrame;
        while (m.tstates < end && !m.cpu.halted) {
          if (f > 2 && cwait()) return true;
          if (m.cpu.pc === CT.STORAGE_SEND_BLOCK || m.cpu.pc === CT.STORAGE_RECEIVE_BLOCK) onBlock(m.cpu.pc === CT.STORAGE_SEND_BLOCK);
          else runZ80(m.cpu, m.bus, 1, m);
        }
        runFrame(m);
      }
      return false;
    };
    const prog = '/* tape */\nint main(void)\n{\n\n    printf("TAPE");\n    return 5;\n}';
    same('a program for the tape runs', cRun(prog).text, fin(5));
    const sent = [];
    const saved = command(CT.SH_SAVE, 'demo', () => {
      const ixv = (m.cpu.xh << 8) | m.cpu.xl, de = (m.cpu.d << 8) | m.cpu.e;
      const bytes = [];
      for (let i = 0; i < de; i++) bytes.push(m.bus.read(ixv + i));
      sent.push({ flag: m.cpu.a, bytes });
      ret(true);                                      // carry set: sent whole
    });
    const romTap = [];
    for (const b of sent) {
      let x = b.flag; for (const v of b.bytes) x ^= v;
      const n = b.bytes.length + 2;
      romTap.push(n & 0xFF, n >> 8, b.flag, ...b.bytes, x);
    }
    const out = cl.exportTape(prog, 'demo');
    same('TAP export is byte-identical to the ROM\'s SAVE "demo"', [saved, sent.length, out.fileName, Buffer.from(out.tap).equals(Buffer.from(romTap))],
      [true, 2, 'demo.tap', true]);
    same('Open: the tape reads back as the program (blank lines are not stored)',
      [P.ownsTape(out.tap), P.tapeToText(out.tap).name, P.tapeToText(out.tap).text], [true, 'demo', prog.replace('\n\n', '\n') + '\n']);
    same('Leap-C and Leap V2 tapes are told apart',
      [P.ownsTape(buildTAP(encodeLineStore(['PRINT 1']), 'v2', 0x8101)), basicProfile.ownsTape(out.tap)], [false, false]);
    // LOAD "demo" of the IDE's tape on a fresh machine, then RUN: the program is back.
    setHomeRom(m, chome); setExRom(m, cexrom); resetMachine(m); crun(cwait, 600);
    const blocks = [];
    for (let p = 0; p < out.tap.length;) { const n = out.tap[p] | (out.tap[p + 1] << 8); blocks.push(out.tap.subarray(p + 2, p + 2 + n)); p += 2 + n; }
    const loaded = command(CT.SH_LOAD, 'demo', () => {
      const b = blocks.shift();
      if (!b || b[0] !== m.cpu.a) { ret(true); return; }
      let ixv = (m.cpu.xh << 8) | m.cpu.xl;
      const de = (m.cpu.d << 8) | m.cpu.e;
      for (let i = 0; i < de; i++) m.bus.write(ixv++, b[1 + i]);
      m.cpu.xh = (ixv >> 8) & 0xFF; m.cpu.xl = ixv & 0xFF; m.cpu.d = 0; m.cpu.e = 0;
      ret(false);                                     // carry clear: loaded
    });
    const store = encodeLineStore(prepareSource(prog).lines);
    const inRam = [];
    for (let i = 0; i < store.length; i++) inRam.push(m.bus.read(crom.progAreaStart + i));
    const progEnd = m.bus.read(crom.progEnd) | (m.bus.read(crom.progEnd + 1) << 8);
    same('LOAD "demo" reads the IDE\'s tape: the line store and PROG_END', [loaded, Buffer.from(inRam).equals(Buffer.from(store)), progEnd - crom.progAreaStart],
      [true, true, store.length]);
  }

  // C9: the cartridge. The program compiled on the checker machine, packed on Leap-C's cartridge
  // build (cartridge/c/<release>/), run on a stock TS2068 (stock ROMs, the cartridge in the dock).
  if (!crom.cartridgeDir) {
    console.log(`SKIP  Leap-C cartridge — the ${crom.version} entry has no cartridgeDir`);
  } else {
    const { isLeapcCartridge, romIdentity } = await import(join(ROOT, 'src/lang/c/cartridge.js'));
    const stock0 = new Uint8Array(readFileSync(join(ROOT, 'tsrun/roms/ts2068-0.rom')));
    const stock1 = new Uint8Array(readFileSync(join(ROOT, 'tsrun/roms/ts2068-1.rom')));
    const pixelOf = (mm, x, y) => (mm.bus.read(0x4000 | ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2) | (x >> 3)) >> (7 - (x & 7))) & 1;
    /** Run a .dck on a stock TS2068 until the report's key wait; the report's text then. */
    const runCart = dck => {
      const sm = createMachine(new Uint8Array(8).fill(0x1F), new Uint8Array(2).fill(0xFF));
      setHomeRom(sm, stock0); setExRom(sm, stock1);
      const err = insertDock(sm, dck);
      resetMachine(sm);
      let at = false;
      for (let f = 0; f < 1500 && !at; f++) {
        const end = sm.frameStart + tStatesPerFrame;
        while (sm.tstates < end && !sm.cpu.halted) {
          if (f > 110 && sm.cpu.pc >= crom.keyWait && sm.cpu.pc < crom.keyWaitEnd) { at = true; break; }
          runZ80(sm.cpu, sm.bus, 1, sm);
        }
        if (!at) runFrame(sm);
      }
      let report = '';
      for (let a = crom.reportBuf; a < crom.reportBuf + 24; a++) { const b = sm.bus.read(a); if (!b) break; report += String.fromCharCode(b); }
      return { err, at, report, sm };
    };
    const hello = main('    cls();\n    printf("CART");\n    draw(16, 60, 239, 150);\n    return 7;');
    const out = await cl.buildCartridge(hello, { confirm: () => true });
    same('C9: the identity of the 1.0.0 ROMs is $E90E (the cartridge build\'s)', romIdentity(chome, cexrom), 0xE90E);
    same('C9: the DCK: chunks 0, 1, 4, 5, 6 as ROM, "LCPG" at DOCK $8000; the flat image 64 KB',
      [[...out.dck.subarray(0, 9)], out.dck.length, isLeapcCartridge(out.dck), out.bin.length, String.fromCharCode(...out.bin.subarray(0x8000, 0x8004)), /bytes of program$/.test(out.summary)],
      [[0, 2, 2, 0, 0, 2, 2, 2, 0], 9 + 5 * 0x2000, true, 0x10000, 'LCPG', true]);
    const ran = runCart(out.dck);
    same('C9: on a stock TS2068 the cartridge runs the program to its report (EXIT 7), the line drawn',
      [ran.err, ran.at, ran.report, pixelOf(ran.sm, 16, 60), pixelOf(ran.sm, 239, 150)], [null, true, 'EXIT 7', 1, 1]);
    const shapes = main('    cls();\n    circle(128, 96, 20);\n    return isqrt(150);');
    const sOut = await cl.buildCartridge(shapes, { confirm: () => true });
    const sRan = runCart(sOut.dck);
    same('C9: a shapes program carries the library (region 3) and draws from the cartridge',
      [/and the shapes library$/.test(sOut.summary), sRan.report, pixelOf(sRan.sm, 148, 96), pixelOf(sRan.sm, 128, 96)], [true, 'EXIT 12', 1, 0]);
    same('C9: a compile error is refused with its line', await cl.buildCartridge(main('    int x = 3 +;\n    return x;'), { confirm: () => true }),
      { error: 'Compile error 20 on line 3: fix it first', line0: 2 });
    same('C9: outp to port 244 asks first (declined: nothing built)', await cl.buildCartridge(main('    outp(244, 0);\n    return 0;'), { confirm: () => false }), null);
  }

  same('manual data: keywords, library functions, the shapes library',
    ['while', 'printf', 'circle'].map(w => LEAPC_KEYWORD_ENTRIES[w]?.kind), ['keyword', 'function', 'library function']);
  same('file-scope names: functions, globals, macros, types',
    (s => [s.functions.map(f => f.name), s.globals.map(g => g.name), s.macros.map(d => d.name), s.types.map(t => t.name)])(
      scanC('#define N 3\nint total, *p;\nstruct pt { int x; };\nint add(int a)\n{\n  /* { */ return a; // }\n}\nint main(void) { return add(N); }')),
    [['add', 'main'], ['total', 'p'], ['N'], ['pt']]);
}

// ── 10. The speed test (src/lang/spin-demo.js): one task in the three languages ──
// Each version runs through its profile's real Run path (startRun, driver.inject /
// next / result) on its own ROMs and must draw exactly the same picture: the
// bitmap below row 0 (where each prints its time) and above row 23 (Leap-C's
// report), and the attributes there. The frame counters the BASIC and Forth
// versions read (they have no word for it) must be the ones that count.
console.log('\nSpeed test in three languages (src/lang/spin-demo.js)');
{
  const { SPIN_DEMO } = await import(join(ROOT, 'src/lang/spin-demo.js'));
  const FRAMES = { basic: 0x8175, forth: 0x80F4 };          // FRAMES in Leap 2.x's and Forth 2.0's .sym
  const shots = {}, notes = [];
  for (const id of ['basic', 'c', 'forth']) {
    const P = profileById(id);
    const dir = { basic: process.env.LEAP_ROMS, c: process.env.LEAPC_ROMS, forth: process.env.FORTH_ROMS }[id] ?? join(ROOT, 'tsrun/roms');
    const h = new Uint8Array(readFileSync(join(dir, P.romFiles.home.split('/').pop())));
    const x = new Uint8Array(readFileSync(join(dir, P.romFiles.exrom.split('/').pop())));
    const r = P.knownRoms[await romPairHash(h, x)];
    const L = await P.attach({ rom: r, romImages: { home: h, exrom: x }, fetchAsset: async p => new Uint8Array(readFileSync(join(ROOT, p))) });
    const ex = P.examples.find(e => e.id === 'spin');
    const m = createMachine(new Uint8Array(8).fill(0x1F), new Uint8Array(2).fill(0xFF));
    setHomeRom(m, h); setExRom(m, x); resetMachine(m);
    const atWait = () => m.cpu.pc >= r.keyWait && m.cpu.pc < r.keyWaitEnd && P.driver.safe(m, r);
    run(m, atWait, 600);
    const lint = L.lint(ex.text);
    const start = L.startRun(ex.text);
    const counter = FRAMES[id] && (() => m.bus.read(FRAMES[id]) | (m.bus.read(FRAMES[id] + 1) << 8));
    const c0 = counter?.();
    P.driver.inject(m, r, start.job);
    let ended = false;
    for (;;) {
      run(m, () => false, 1);
      if (!run(m, atWait, 6000)) break;
      if (P.driver.runState(m, r) === 'ended' && P.driver.next?.(m, r, start.job)) continue;
      ended = P.driver.runState(m, r) === 'ended';
      break;
    }
    const status = ended ? L.describeResult(P.driver.result(m, r, start.job), start.editorLine, null, start.job).text : 'did not end';
    if (lint.length || !/^(Finished|OK)/.test(status)) notes.push(`${id}: ${lint.length ? lint[0].message : status}`);
    if (counter && !(counter() - c0 > 100 && ex.text.includes(String(FRAMES[id])))) notes.push(`${id}: the frame counter it reads (${FRAMES[id]}) did not count, or the program does not read it`);
    shots[id] = [...Array.from({ length: (184 - 8) * 32 }, (_, i) => { const y = 8 + (i >> 5); return m.bus.read(0x4000 | ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2) | (i & 31)); }),
      ...Array.from({ length: 22 * 32 }, (_, i) => m.bus.read(0x5820 + i))].join();
  }
  same('each version runs to its end with no error, timed by a counter that counts', notes, []);
  same('BASIC, C and Forth draw exactly the same picture in the same colours', [shots.basic === shots.c, shots.c === shots.forth, shots.c.split(',').slice(0, 5632).filter(v => v !== '0').length > 300], [true, true, true]);
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
