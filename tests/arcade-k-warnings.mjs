#!/usr/bin/env node
"use strict";
// arcade-k-warnings.mjs -- Studio completion stage 1, items K1, K2 and K3 (docs/ARCADE_STUDIO_COMPLETION_CONTRACT.md section 4): "BRIGHT 1 on black paper".
//
//   node tests/arcade-k-warnings.mjs
//
//   1  K1, the checker walks each PROC in text order with the constant PAPER and BRIGHT: where it warns (and where, line and column), where it is quiet
//   2  K2, WIRE3D and VIEW3D: the clauses and the defaults (both defaults are BRIGHT 0 now)
//   3  warnings never change the code: the compile (which checks first) gives the bytes of the generator run on the unchecked tree
//   4  the example games: K1 (compiler), K2 and K3 (tiles) counts, from the sources and assets of arcade/examples (needs arcade/dist/ for the compile)
//
// No machine is booted here. Exit code 1 when a check fails.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { check } from '../src/lang/arcade/arcade-check.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile, requiredRuntime } from '../src/lang/arcade/arcade-compile.js';
import { generate } from '../src/lang/arcade/arcade-codegen.js';
import { link } from '../src/lang/arcade/arcade-link.js';
import { VIEW_DEFAULTS } from '../src/lang/arcade/arcade-view.js';
import { scanRoles } from '../src/lang/arcade/arcade-scan.js';
import { checkAssets } from '../src/lang/arcade/arcade-assetcheck.js';
import * as P from '../src/arcade-project.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let passed = 0, failed = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const info = (s) => console.log('  INFO  ' + s);

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const K = /BRIGHT 1 on black paper/;
const diag = (src, version = 4) => { const p = parse(src); return [...p.errors, ...check(p.ast, { version })]; };
const kWarns = (src, version) => diag(src, version).filter((d) => d.severity === 'warning' && K.test(d.message));
const errs = (src, version) => diag(src, version).filter((d) => d.severity === 'error');
const where = (ws) => ws.map((w) => `${w.line}:${w.col}`).join(' ');
/** A game with one scene; `init` and `frame` are the PROC bodies (one statement per line, 4 spaces in), `procs` extra PROCs of the scene. */
const game = (init, frame = '', procs = '', top = '') =>
  `GAME "t"\nFRAMERATE 30\n${top}SCENE s\n${procs}  PROC INIT()\n${init}\n  ENDP\n  PROC FRAME()\n${frame}\n  ENDP\nENDSCENE\n`;
const warnsAt = (name, src, lines, version) => {
  const w = kWarns(src, version), e = errs(src, version);
  check_(name, e.length === 0 && w.length === lines.length && w.every((x, i) => x.line === lines[i]), `warnings at ${where(w) || 'none'}, want lines ${lines.join(' ') || 'none'}${e.length ? '; errors: ' + e.map((x) => x.message).join(' | ') : ''}`);
};

// ═══ 1  K1: the statements ══════════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('1. K1: PAPER and BRIGHT in a body, text order');
{
  // game(): line 1 GAME, 2 FRAMERATE, 3 SCENE, 4 PROC INIT, 5.. the init statements
  const src1 = game('    PAPER 0\n    BRIGHT 1');
  warnsAt('PAPER 0 then BRIGHT 1 warns at the BRIGHT line (line 6)', src1, [6]);
  const w = kWarns(src1)[0];
  check_('the warning is a warning, with the contract\'s words, at the statement\'s column', w.severity === 'warning' && w.col === 4 && /dark grey next to a black border/.test(w.message) && /Fuse and ZEsarUX show black/.test(w.message) && /use BRIGHT 0 on black paper/.test(w.message), w.message);
  check_('the message is exactly the contract\'s sentence', w.message === 'BRIGHT 1 on black paper: TSRun shows it as dark grey next to a black border (Fuse and ZEsarUX show black); use BRIGHT 0 on black paper', w.message);
  warnsAt('BRIGHT 1 then PAPER 0 warns at the PAPER line (line 6)', game('    BRIGHT 1\n    PAPER 0'), [6]);
  warnsAt('PAPER 0 : BRIGHT 1 on one line warns once, at BRIGHT\'s column', game('    PAPER 0 : BRIGHT 1'), [5]);
  check_('... column of the BRIGHT statement', kWarns(game('    PAPER 0 : BRIGHT 1'))[0]?.col === 14, where(kWarns(game('    PAPER 0 : BRIGHT 1'))));
  warnsAt('PAPER 0 : BRIGHT 0 is quiet', game('    PAPER 0 : BRIGHT 0'), []);
  warnsAt('BRIGHT 0 : PAPER 0 is quiet', game('    BRIGHT 0 : PAPER 0'), []);
  warnsAt('PAPER 7 : BRIGHT 1 is quiet (bright on white)', game('    PAPER 7 : BRIGHT 1'), []);
  warnsAt('a scene\'s INIT starts at PAPER 7 BRIGHT 0: BRIGHT 1 alone is quiet', game('    BRIGHT 1'), []);
  warnsAt('a scene\'s INIT starts at PAPER 7 BRIGHT 0: PAPER 0 alone is quiet', game('    PAPER 0'), []);
  warnsAt('a scene\'s FRAME starts at PAPER 7 BRIGHT 0 too (BRIGHT 1 alone, then PAPER 0 alone: only the second statement completes the pair)', game('    INK 1', '    BRIGHT 1\n    PAPER 0'), [9]);
  warnsAt('INIT and FRAME are separate bodies: INIT\'s PAPER 0 does not reach FRAME\'s BRIGHT 1', game('    PAPER 0', '    BRIGHT 1'), []);
  warnsAt('the warning is at the transition only: later statements while the pair holds do not warn again', game('    PAPER 0 : BRIGHT 1\n    INK 5\n    PAPER 0\n    BRIGHT 1\n    CLS'), [5]);
  warnsAt('leaving and re-entering the pair warns again at each entry', game('    PAPER 0 : BRIGHT 1\n    BRIGHT 0\n    BRIGHT 1\n    PAPER 3\n    PAPER 0'), [5, 7, 9]);
  warnsAt('FLASH 1 is not BRIGHT: PAPER 0 : FLASH 1 is quiet', game('    PAPER 0 : FLASH 1'), []);
  warnsAt('INK and FLASH between the two do not break the pair (it warns once): PAPER 0 : BRIGHT 1 : INK 3 : FLASH 1 : BRIGHT 1', game('    PAPER 0 : BRIGHT 1 : INK 3 : FLASH 1 : BRIGHT 1'), [5]);
  warnsAt('INK, FLASH and BORDER do not matter', game('    PAPER 0 : INK 7 : FLASH 1 : BORDER 0 : BRIGHT 0'), []);

  // non-constant values: the colour becomes unknown, no warning while unknown
  warnsAt('PAPER from a variable makes paper unknown: PAPER 0 : PAPER v : BRIGHT 1 is quiet', game('    PAPER 0\n    PAPER v\n    BRIGHT 1', '', '', 'DIM v\n'), []);
  warnsAt('BRIGHT from a variable makes bright unknown: BRIGHT 1 : BRIGHT v : PAPER 0 is quiet', game('    BRIGHT 1\n    BRIGHT v\n    PAPER 0', '', '', 'DIM v\n'), []);
  warnsAt('an unknown colour becomes known again by the next constant: PAPER v then PAPER 0, BRIGHT 1 warns', game('    PAPER v\n    PAPER 0\n    BRIGHT 1', '', '', 'DIM v\n'), [8]);
  warnsAt('a CONST is a constant: CONST dark = 0 ... PAPER dark : BRIGHT 1 warns', game('    PAPER dark : BRIGHT 1', '', '', 'CONST dark = 0\n'), [6]);
  warnsAt('a constant expression folds: PAPER 3 - 3 : BRIGHT 1 warns', game('    PAPER 3 - 3 : BRIGHT 1'), [5]);
  { const src = game('    PAPER 8 : BRIGHT 1'); check_('an out-of-range literal (PAPER 8) is the range error and leaves the colour unknown: no K1 warning', kWarns(src).length === 0 && errs(src).length === 1, JSON.stringify(diag(src).map((d) => d.message))); }

  // other bodies: a PROC that is not INIT / FRAME starts with both unknown
  const proc = (body) => `  PROC fx()\n${body}\n  ENDP\n`;
  warnsAt('another PROC starts unknown: BRIGHT 1 alone is quiet', game('    CALL fx()', '', proc('    BRIGHT 1')), []);
  warnsAt('another PROC starts unknown: PAPER 0 alone is quiet', game('    CALL fx()', '', proc('    PAPER 0')), []);
  warnsAt('another PROC that sets both warns inside itself (line 5 of the PROC body)', game('    CALL fx()', '', proc('    PAPER 0\n    BRIGHT 1')), [6]);
  warnsAt('a top-level PROC (not INIT / FRAME) is its own body, unknown at the start', `GAME "t"\nFRAMERATE 30\nPROC fx()\n  BRIGHT 1\nENDP\nPROC gx()\n  PAPER 0\n  BRIGHT 1\nENDP\nSCENE s\n  PROC INIT()\n    CALL fx()\n    CALL gx()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n`, [8]);
  warnsAt('a PROC does not inherit the caller\'s state (INIT sets PAPER 0 and BRIGHT 1 and warns; fx\'s BRIGHT 1 does not warn again)', game('    PAPER 0 : BRIGHT 1\n    CALL fx()', '', proc('    BRIGHT 1')), [8]);
  warnsAt('a PROC\'s statements do not leak into the caller (fx sets PAPER 0; INIT\'s BRIGHT 1 stays quiet)', game('    CALL fx()\n    BRIGHT 1', '', proc('    PAPER 0')), []);

  // text order, no branch analysis
  warnsAt('an IF body is followed in text order: IF c THEN PAPER 0 ENDIF then BRIGHT 1 warns', game('    IF v = 1 THEN\n      PAPER 0\n    ENDIF\n    BRIGHT 1', '', '', 'DIM v\n'), [9]);
  warnsAt('both arms of an IF are followed in text order (the pair is built across THEN and ELSE)', game('    IF v = 1 THEN\n      PAPER 0\n    ELSE\n      BRIGHT 1\n    ENDIF', '', '', 'DIM v\n'), [9]);
  warnsAt('a WHILE body is followed', game('    WHILE v < 3\n      PAPER 0 : BRIGHT 1\n      v = v + 1\n    WEND', '', '', 'DIM v\n'), [7]);

  // the warning does not hide errors or other warnings, and an error elsewhere is still an error
  const bad = game('    PAPER 0 : BRIGHT 1 : BRIGHT 2');
  check_('a bad value (BRIGHT 2 after the pair) is still the range error (one error), and the first statement that made the pair warns (one K1)', errs(bad).length === 1 && kWarns(bad).length === 1 && kWarns(bad)[0].col === 14, JSON.stringify(diag(bad).map((d) => `${d.severity} ${d.line}:${d.col} ${d.message}`)));
}

// ═══ 2  K2: WIRE3D and VIEW3D ═══════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('2. K2: WIRE3D and VIEW3D');
{
  const wire = (clauses, v = 2) => `GAME "t"\nFRAMERATE 20\nWIRE3D ROWS 2 TO 21${clauses}\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n`;
  const w1 = kWarns(wire(' INK 5 PAPER 0 BRIGHT 1'), 2);
  check_('WIRE3D PAPER 0 BRIGHT 1 warns, once, at the BRIGHT clause (line 3)', w1.length === 1 && w1[0].line === 3 && w1[0].col === wire(' INK 5 PAPER 0 BRIGHT 1').split('\n')[2].indexOf('BRIGHT') + 7, where(w1));
  check_('... the text says WIRE3D and the reason', /^WIRE3D PAPER 0 with BRIGHT 1/.test(w1[0].message) && /dark grey/.test(w1[0].message) && /use BRIGHT 0 on black paper/.test(w1[0].message), w1[0]?.message);
  check_('WIRE3D with no clauses is quiet (the default is BRIGHT 0 now)', kWarns(wire(''), 2).length === 0 && errs(wire(''), 2).length === 0);
  check_('WIRE3D INK 5 PAPER 0 BRIGHT 0 is quiet (orbit\'s)', kWarns(wire(' INK 5 PAPER 0 BRIGHT 0'), 2).length === 0);
  const w2 = kWarns(wire(' BRIGHT 1'), 2);
  check_('WIRE3D BRIGHT 1 alone warns: the default PAPER is 0, and the text says so', w2.length === 1 && /default, 0/.test(w2[0].message), w2[0]?.message);
  check_('WIRE3D PAPER 1 BRIGHT 1 is quiet', kWarns(wire(' PAPER 1 BRIGHT 1'), 2).length === 0);
  check_('WIRE3D PAPER 0 alone is quiet (BRIGHT defaults to 0)', kWarns(wire(' PAPER 0'), 2).length === 0);
  check_('WIRE3D with a CONST for each clause: PAPER dark BRIGHT lit (0 and 1) warns', kWarns(wire(' PAPER dark BRIGHT lit').replace('WIRE3D', 'CONST dark = 0\nCONST lit = 1\nWIRE3D'), 2).length === 1);
  check_('WIRE3D with a variable-free but non-constant clause is an error, not a K2 warning', kWarns(wire(' PAPER v BRIGHT 1').replace('SCENE s', 'DIM v\nSCENE s'), 2).length === 0);

  const view = (clauses) => `GAME "t"\nFRAMERATE 12\nMAP level = "maze"\nVIEW3D level${clauses}\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n`;
  check_('VIEW3D with no clauses is quiet now: the default is BRIGHT 0', kWarns(view(''), 4).length === 0 && VIEW_DEFAULTS.bright === 0, `VIEW_DEFAULTS.bright = ${VIEW_DEFAULTS.bright}`);
  const v1 = kWarns(view(' CEIL 0 BRIGHT 1'), 4);
  check_('VIEW3D CEIL 0 BRIGHT 1 warns at the BRIGHT clause (line 4), naming CEIL', v1.length === 1 && v1[0].line === 4 && /^VIEW3D CEIL is 0/.test(v1[0].message) && /use BRIGHT 0 on black paper/.test(v1[0].message), `${where(v1)} ${v1[0]?.message}`);
  const v2 = kWarns(view(' BRIGHT 1'), 4);
  check_('... and at the column of the BRIGHT clause\'s value', v1[0].col === view(' CEIL 0 BRIGHT 1').split('\n')[3].indexOf('BRIGHT') + 7, `${v1[0].col}`);
  check_('VIEW3D BRIGHT 1 alone warns (the default CEIL is 0)', v2.length === 1 && /^VIEW3D CEIL is 0/.test(v2[0].message), v2[0]?.message);
  const v3 = kWarns(view(' CEIL 3 FLOOR 0 BRIGHT 1'), 4);
  check_('VIEW3D FLOOR 0 BRIGHT 1 warns, naming FLOOR', v3.length === 1 && /^VIEW3D FLOOR is 0/.test(v3[0].message), v3[0]?.message);
  const v4 = kWarns(view(' CEIL 0 FLOOR 0 BRIGHT 1'), 4);
  check_('VIEW3D CEIL 0 FLOOR 0 BRIGHT 1 warns once, naming both', v4.length === 1 && /^VIEW3D CEIL and FLOOR are 0/.test(v4[0].message), v4[0]?.message);
  check_('VIEW3D CEIL 3 FLOOR 5 BRIGHT 1 is quiet (no black)', kWarns(view(' CEIL 3 FLOOR 5 BRIGHT 1'), 4).length === 0);
  check_('VIEW3D CEIL 0 BRIGHT 0 is quiet', kWarns(view(' CEIL 0 BRIGHT 0'), 4).length === 0);
  check_('VIEW3D CEIL 3 BRIGHT 1 with the default FLOOR 1 is quiet', kWarns(view(' CEIL 3 BRIGHT 1'), 4).length === 0);
  check_('VIEW3D with a CONST CEIL: CONST dark = 0 ... CEIL dark BRIGHT 1 warns', kWarns(view(' CEIL dark BRIGHT 1').replace('MAP level', 'CONST dark = 0\nMAP level'), 4).length === 1);
  check_('VIEW3D with INK 0 and BRIGHT 1 is quiet (only paper counts)', kWarns(view(' INK 0 CEIL 3 BRIGHT 1'), 4).length === 0);
  check_('the defaults moved together: scanRoles reads a VIEW3D with no BRIGHT as BRIGHT 0', scanRoles('MAP m = "x"\nVIEW3D m').view?.bright === 0, JSON.stringify(scanRoles('MAP m = "x"\nVIEW3D m').view));
}

// the defaults themselves (K2 changed them to BRIGHT 0): the reference interpreter's record (the code generator's descriptors are in section 3)
console.log('2b. The defaults: the interpreter agrees with the checker');
{
  const wireSrc = (clauses) => `GAME "t"\nFRAMERATE 20\nWIRE3D ROWS 2 TO 21${clauses}\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n`;
  const attrOf = (clauses) => interpret(parse(wireSrc(clauses)).ast, { ticks: 1, version: 2, assets: { models: {} } }).ticks[0].wire.attr;
  check_('the interpreter: WIRE3D with no clauses is INK 7 PAPER 0 BRIGHT 0 = $07', attrOf('') === 0x07, `$${attrOf('').toString(16)}`);
  check_('the interpreter: WIRE3D INK 7 PAPER 0 BRIGHT 1 = $47 (an explicit BRIGHT 1 still works)', attrOf(' INK 7 PAPER 0 BRIGHT 1') === 0x47);
  check_('the interpreter: WIRE3D BRIGHT 1 alone (default PAPER 0) = $47', attrOf(' BRIGHT 1') === 0x47);
}

// ═══ 3  the warnings do not change the code ═════════════════════════════════════════════════════════════════════════════════════════
console.log('3. Warnings never change the generated bytes');
const dist = ROOT + 'arcade/dist/';
const builds = {};
for (const v of [2, 3, 4]) {
  if (existsSync(dist + `v${v}/runtime.json`)) builds[v] = { rt: JSON.parse(readFileSync(dist + `v${v}/runtime.json`, 'utf8')), im: new Uint8Array(readFileSync(dist + `v${v}/runtime.bin`)) };
}
const sameBytes = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
/** The bytes the generator and linker give for the tree parse() made, with the checker never run. */
function uncheckedDck(text, b, assets) {
  const { ast } = parse(text);
  const gen = generate(ast, b.rt, assets, {});
  return gen.code ? link(gen, b.rt, b.im).dck : null;
}
if (builds[2] && builds[4]) {
  const ASSETS = { sprites: {}, tilesets: {}, sfx: {}, maps: {} };
  const cases = [
    ['K1 (PAPER 0 : BRIGHT 1 in INIT and FRAME)', 2, game('    PAPER 0 : BRIGHT 1 : CLS', '    BRIGHT 1\n    PAPER 0\n    PRINT AT 1, 1; "x"'), ASSETS, (r) => r.warnings.filter((w) => K.test(w.message)).length === 2],
    ['K2 (WIRE3D PAPER 0 BRIGHT 1)', 2, `GAME "t"\nFRAMERATE 20\nWIRE3D ROWS 2 TO 21 INK 5 PAPER 0 BRIGHT 1\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n`, ASSETS, (r) => r.warnings.filter((w) => /^WIRE3D PAPER/.test(w.message)).length === 1],
  ];
  for (const [name, v, src, assets, expectWarn] of cases) {
    const r = compile(src, { runtime: builds[v].rt, image: builds[v].im, assets });
    const bare = uncheckedDck(src, builds[v], assets);
    check_(`${name}: it compiles with ${r.warnings.length} warning(s), the K warning is there, and the dck equals the unchecked tree's`, r.errors.length === 0 && !!r.dck && expectWarn(r) && sameBytes(r.dck, bare), r.errors.map((e) => e.message).join(' | '));
  }
  // the code generator's defaults: no WIRE3D clause is attribute $07 (INK 7, PAPER 0, BRIGHT 0), BRIGHT 1 gives $47
  const wd = (clauses) => compile(`GAME "t"\nFRAMERATE 20\nWIRE3D ROWS 2 TO 21${clauses}\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n`, { runtime: builds[2].rt, image: builds[2].im, assets: ASSETS });
  const w0 = wd(''), w1 = wd(' INK 7 PAPER 0 BRIGHT 1');
  check_('the code generator: WIRE3D with no clauses has attribute $07 (and no warning); with BRIGHT 1 it is $47 (and warns)',
    w0.gen?.wire?.attr === 0x07 && w0.gen.wire.bright === 0 && w0.warnings.every((w) => !K.test(w.message)) && w1.gen?.wire?.attr === 0x47 && w1.warnings.some((w) => /^WIRE3D PAPER/.test(w.message)), `${w0.gen?.wire?.attr} / ${w1.gen?.wire?.attr}`);
  // the same two statements, different order: the warning count differs, the bytes of the program with the statement order are what the statements say (a smoke check that
  // the K1 walk has no side effect on codegen: BRIGHT 1 : PAPER 0 and PAPER 0 : BRIGHT 1 both warn, and differ only in the two calls)
  const a = compile(game('    PAPER 0 : BRIGHT 1'), { runtime: builds[2].rt, image: builds[2].im, assets: ASSETS });
  const b = compile(game('    BRIGHT 1 : PAPER 0'), { runtime: builds[2].rt, image: builds[2].im, assets: ASSETS });
  check_('PAPER 0 : BRIGHT 1 and BRIGHT 1 : PAPER 0 both warn and both compile', a.dck && b.dck && a.warnings.filter((w) => K.test(w.message)).length === 1 && b.warnings.filter((w) => K.test(w.message)).length === 1);
} else {
  console.log('  SKIP  the byte checks: arcade/dist/ is not published (node arcade/tools/publish-runtime.mjs)');
}

// ═══ 4  the example games ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
console.log('4. The example games');
if (builds[2] && builds[3] && builds[4]) {
  const load = (id) => {
    const arc = readFileSync(ROOT + `arcade/examples/${id}.arc`, 'utf8').replace(/\r\n?/g, '\n');
    const af = ROOT + `arcade/examples/${id}.assets.json`;
    const assets = existsSync(af) ? JSON.parse(readFileSync(af, 'utf8')) : {};
    const project = P.exampleProject(id, arc, assets);
    const text = P.buildSource(project).text;
    const b = builds[requiredRuntime(text, project.assets).version];
    const r = compile(text, { runtime: b.rt, image: b.im, assets: project.assets });
    const k12 = r.warnings.filter((w) => K.test(w.message));
    const k3 = checkAssets(project, scanRoles(text)).filter((f) => f.id === 'bright-black-paper');
    return { r, k1: k12.filter((w) => !/^(WIRE3D|VIEW3D)/.test(w.message)), k2: k12.filter((w) => /^(WIRE3D|VIEW3D)/.test(w.message)), k3, project };
  };
  const out = {};
  for (const id of ['bounce', 'breakout', 'orbit', 'shooter', 'vaults', 'blockfall', 'platformer', 'runner']) {
    out[id] = load(id);
    const tiles = out[id].k3.reduce((n, f) => n + f.tiles.length, 0);
    info(`${id}: K1 ${out[id].k1.length} (lines ${out[id].k1.map((w) => w.line).join(', ') || '-'}), K2 ${out[id].k2.length}, K3 ${out[id].k3.length} finding(s) naming ${tiles} tile(s)${out[id].k3.map((f) => ` [${f.asset}: ${f.tiles.length} of ${tilesOf(out[id].project, f.asset)}]`).join('')}`);
  }
  function tilesOf(project, name) { return (project.assets.tilesets?.[name]?.tiles ?? []).length; }
  for (const id of ['bounce', 'breakout', 'orbit']) {
    check_(`${id}: no K1, K2 or K3 finding`, out[id].r.errors.length === 0 && out[id].k1.length === 0 && out[id].k2.length === 0 && out[id].k3.length === 0, out[id].r.errors.map((e) => e.message).join(' | '));
  }
  for (const id of ['shooter', 'vaults', 'blockfall', 'platformer', 'runner']) {
    check_(`${id}: compiles, and K1 fires in its code (PAPER 0 with BRIGHT 1)`, out[id].r.errors.length === 0 && out[id].k1.length > 0, `${out[id].k1.length} warning(s)`);
  }
  for (const id of ['shooter', 'vaults', 'blockfall']) {
    check_(`${id}: K3 fires (a tile set with paper 0, BRIGHT 1 and paper pixels)`, out[id].k3.length > 0 && out[id].k3.every((f) => f.severity === 'warning' && f.tiles.length > 0), `${out[id].k3.length}`);
  }
  const tilesNamed = (id, name) => new Set(out[id].k3.filter((f) => f.asset === name).flatMap((f) => f.tiles)).size;
  check_('Starfall (shooter): all 16 tiles of its tile set are bright-black-paper', tilesNamed('shooter', 'gfx') === 16 && tilesOf(out.shooter.project, 'gfx') === 16, `${tilesNamed('shooter', 'gfx')} of ${tilesOf(out.shooter.project, 'gfx')}`);
  check_('Vaults: 28 tiles of vl_tiles are bright-black-paper', tilesNamed('vaults', 'vl_tiles') === 28, String(tilesNamed('vaults', 'vl_tiles')));
  check_('Blockfall: 3 of its 12 tiles are bright-black-paper', tilesNamed('blockfall', 'gfx') === 3 && tilesOf(out.blockfall.project, 'gfx') === 12, `${tilesNamed('blockfall', 'gfx')} of ${tilesOf(out.blockfall.project, 'gfx')}`);
  check_('Vaults (VIEW3D with no BRIGHT clause): the descriptor has BRIGHT 0: attr_top $05 (INK 5, CEIL 0), attr_bottom $0D (FLOOR 1)', out.vaults.r.gen?.view?.bright === 0 && out.vaults.r.gen.view.attrTop === 0x05 && out.vaults.r.gen.view.attrBottom === 0x0D, JSON.stringify([out.vaults.r.gen?.view?.bright, out.vaults.r.gen?.view?.attrTop, out.vaults.r.gen?.view?.attrBottom]));
  check_('Vaults: no K2 (its VIEW3D has no BRIGHT clause, and the default is BRIGHT 0 now); no example has an explicit K2 clause', Object.values(out).every((o) => o.k2.length === 0));
} else {
  console.log('  SKIP  the example games: arcade/dist/ is not published (node arcade/tools/publish-runtime.mjs)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
