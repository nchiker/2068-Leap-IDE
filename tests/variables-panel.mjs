#!/usr/bin/env node
"use strict";
// tests/variables-panel.mjs -- the Studio's Variables tab, the pure parts (stage 5, R3): src/tools/variables-model.js and the compiler's report `compile().variables`.
//
//   node tests/variables-panel.mjs          (ARCADE_QUICK=1: shorter runs)
//
// 1. the model on a fake memory: decoding (16-bit little-endian, signed and unsigned, 1-byte), arrays, formatting (decimal, hex, the first 16 elements), the filter, grouping, changed marks.
// 2. the compiler's report on a game made to have every kind of variable: DIMs of the game and of two scenes (the same name in both), arrays (1-D with an initialiser, 2-D), a TIMER, a PROC parameter and local,
//    a DEF FN parameter: names, scopes, roles, sizes, lines, sorted by address, no overlaps, and the address of each equals the linker's own table (map.vars / map.arrays / map.slots).
// 3. THE HEART: the addresses are right. On the REAL v2 runtime (a cartridge booted in TSRun) every tick's variables are decoded by the panel model straight from the machine's memory (res.variables + the
//    machine's bytes, nothing else) and compared with the reference interpreter's record of the same tick: every variable and every array element of the made-up game (known values: a negative number, a
//    16-bit value above 255, a wrapped sum, the extremes -32768 and 32767, a 2-D array's flat slots), and of the examples blockfall (a 2-D board, arrays of 112, initialisers), breakout, bounce (two scenes) and
//    the starter "blank" (a TIMER); an address that is off by one fails these.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as V from '../src/tools/variables-model.js';
import { collectVariables } from '../src/lang/arcade/arcade-compile.js';
import { STARTERS_A } from '../src/starters/starters-a.js';
import { real, compileReal, runReal, interpFor, ROOT } from './arcade-m5-harness.mjs';

const QUICK = !!process.env.ARCADE_QUICK;
let passed = 0, failed = 0;
const check = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const info = (s) => console.log('  INFO  ' + s);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── 1. the model ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('1. the model on a fake memory');
{
  const mem = new Uint8Array(0x10000);
  const put = (addr, ...words) => words.forEach((w, i) => { mem[addr + 2 * i] = w & 255; mem[addr + 2 * i + 1] = (w >> 8) & 255; });
  put(0x8000, 1000, -5, 40000, 32767, -32768);
  const rb = (a) => mem[a];
  const v = (name, address, extra = {}) => ({ name, key: name.toUpperCase(), kind: 'var', scopeKind: 'game', scope: 'game', scene: null, role: 'dim', address, size: 2, length: 1, elementSize: 2, signed: true, type: 'int16', line: 1, col: 0, ...extra });
  check('a 16-bit value above 255 decodes little-endian (1000 = $03E8 stored E8 03)', eq(V.readValue(v('a', 0x8000), rb), [1000]) && mem[0x8000] === 0xE8 && mem[0x8001] === 3);
  check('a negative number decodes signed (-5)', eq(V.readValue(v('b', 0x8002), rb), [-5]));
  check('40000 stored as a 16-bit word reads back as -25536 (the language wraps)', eq(V.readValue(v('c', 0x8004), rb), [-25536]));
  check('the extremes 32767 and -32768', eq(V.readValue(v('d', 0x8006), rb), [32767]) && eq(V.readValue(v('e', 0x8008), rb), [-32768]));
  check('an unsigned variable reads 40000', eq(V.readValue(v('c', 0x8004, { signed: false }), rb), [40000]));
  check('a 1-byte variable (a language with bytes) reads 1 byte, signed or not', eq(V.readValue(v('b1', 0x8000, { elementSize: 1, size: 1, signed: false }), rb), [0xE8]) && eq(V.readValue(v('b1', 0x8000, { elementSize: 1, size: 1 }), rb), [-24]));
  check('an array reads its elements in order', eq(V.readValue(v('arr', 0x8000, { kind: 'array', length: 5, size: 10, dims: [5] }), rb), [1000, -5, -25536, 32767, -32768]));
  check('memory that cannot be read (null, undefined, a throw) gives null', V.readValue(v('a', 0x8000), () => null) === null && V.readValue(v('a', 0x8000), () => undefined) === null && V.readValue(v('a', 0x8000), () => { throw new Error('x'); }) === null);
  check('a half-readable array is null, not a short list', V.readValue(v('arr', 0x8000, { kind: 'array', length: 5, size: 10 }), (a) => (a < 0x8004 ? mem[a] : null)) === null);
  check('formatNumber: decimal, and hex of the 16-bit pattern ($FFFB for -5, $0000 for 0, $8000 for -32768)', V.formatNumber(-5) === '-5' && V.formatNumber(-5, { hex: true }) === '$FFFB' && V.formatNumber(0, { hex: true }) === '$0000' && V.formatNumber(-32768, { hex: true }) === '$8000' && V.formatNumber(1000, { hex: true }) === '$03E8');
  check('formatValues: a variable is its number; an array is [a, b, ...]', V.formatValues([7], { array: false }) === '7' && V.formatValues([1, 2, 3], {}) === '[1, 2, 3]' && V.formatValues([1], { array: true }) === '[1]');
  const many = Array.from({ length: 40 }, (_, i) => i);
  check('formatValues: 16 elements by default, "... (24 more)", all with all: true, hex applies', V.formatValues(many, {}) === `[${many.slice(0, 16).join(', ')}, ... (24 more)]` && V.formatValues(many, { all: true }) === `[${many.join(', ')}]` && V.formatValues([255, -1], { hex: true }) === '[$00FF, $FFFF]' && V.formatValues(many.slice(0, 16), {}) === `[${many.slice(0, 16).join(', ')}]`);
  const vars = [v('score', 0x8000), v('lives', 0x8002), v('board', 0x8004, { kind: 'array', length: 6, size: 12, dims: [3, 2] }), v('t', 0x8010, { scopeKind: 'scene', scope: 'play', scene: 'play' }), v('pv', 0x8012, { scopeKind: 'proc', scope: 'SETP', scene: 'play', role: 'param' }), v('q', 0x8014, { scopeKind: 'fn', scope: 'DBL', role: 'param' })];
  check('filterVariables: empty keeps all; a word matches names and scopes, case-insensitively; every word must match', V.filterVariables(vars, '').length === 6 && eq(V.filterVariables(vars, 'SCO').map((x) => x.name), ['score']) && eq(V.filterVariables(vars, 'setp').map((x) => x.name), ['pv']) && V.filterVariables(vars, 'score setp').length === 0 && V.filterVariables(vars, 'zzz').length === 0);
  const gs = V.groupVariables(vars);
  check('groupVariables: Game first, then scenes, then PROC / DEF FN; a callable of a scene says so', eq(gs.map((g) => g.title), ['Game', 'Scene play', 'PROC SETP (scene play)', 'DEF FN DBL']) && gs[0].items.length === 3);
  check('elementLabel: a(3) and, for a 2-D array with dims [3, 2], flat slot 5 is b(2, 1)', V.elementLabel(v('a', 0, { dims: [9] }), 3) === 'a(3)' && V.elementLabel(vars[2], 5) === 'board(2, 1)' && V.elementLabel(vars[2], 2) === 'board(1, 0)');
  const s1 = V.snapshot(vars, rb);
  put(0x8000, 1001);
  const s2 = V.snapshot(vars, rb);
  check('snapshot + changedIds: only the variable that changed is marked; the first look (no earlier snapshot) marks nothing', eq([...V.changedIds(s1, s2)], [V.variableId(vars[0])]) && V.changedIds(null, s2).size === 0 && V.changedIds(new Map(), s2).size === 0 && V.changedIds(s2, s2).size === 0);
  check('changedElements: the indices that differ', eq(V.changedElements([1, 2, 3], [1, 9, 3]), [1]) && eq(V.changedElements([1, 2], [1, 2, 3]), []));
  check('variableId is unique per slot (address and key)', new Set(vars.map(V.variableId)).size === vars.length);
}

// ── 2. the compiler's report ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('2. compile().variables on a game with every kind of variable');
const R = real();
if (!R.ok) { console.log(`  SKIP  the compiler and the real runtime (${R.why})`); console.log(`\nPASS: variables-panel (${passed} checks, the real-runtime sections skipped)`); process.exit(failed ? 1 : 0); }

const VARTEST = `GAME "vartest"
FRAMERATE 30
CONST K = 7
DIM g1, neg, big, wrap
DIM arr(19) = 1, -2, 300, -400, 5000, -6000
DIM grid(2, 3)
TIMER tm
DEF FN dbl(q) = q * 2

SCENE one
  DIM s1, sarr(4)

  PROC SETP(pv):
    LOCAL lv
    lv = pv + 1
    s1 = lv
  ENDP

  PROC INIT():
    g1 = 5 : neg = -123 : big = 30000 : wrap = 40000
    arr(19) = -32768 : arr(0) = 32767
    tm = 100
    grid(2, 3) = 77 : grid(1, 2) = -9
  ENDP

  PROC FRAME():
    g1 = g1 + 1
    big = big + 1000
    arr(6) = g1 * 300
    grid(0, 0) = g1
    sarr(g1 MOD 5) = FN dbl(g1)
    CALL SETP(g1 + 1000)
    IF g1 > 10 THEN
      ENTER two
    ENDIF
  ENDP
ENDSCENE

SCENE two
  DIM s1, t2(3)

  PROC INIT():
    t2(3) = 1234
  ENDP

  PROC FRAME():
    s1 = s1 + K
    t2(s1 MOD 4) = -s1
  ENDP
ENDSCENE
`;
const res = compileReal(VARTEST, {});
const vars = res.variables;
const by = (name, scope) => vars.find((x) => x.name.toUpperCase() === name.toUpperCase() && (scope === undefined || x.scope.toUpperCase() === scope.toUpperCase()));
check('compile() reports `variables` (an array)', Array.isArray(vars) && vars.length > 0, `${vars?.length} entries`);
check('it is sorted by address, no two entries overlap, and every entry lies inside the game variable block', vars.every((x, i) => i === 0 || x.address >= vars[i - 1].address + vars[i - 1].size) && vars.every((x) => x.address >= R.rt.constants.GAME_VARS_BASE && x.address + x.size - 1 <= R.rt.constants.GAME_VARS_LIMIT));
check('every entry is a 16-bit signed integer (type int16, elementSize 2, signed) with size = 2 * length', vars.every((x) => x.type === 'int16' && x.elementSize === 2 && x.signed === true && x.size === 2 * x.length));
check('the game DIMs: g1 neg big wrap, scope game, role dim, line of their DIM', ['g1', 'neg', 'big', 'wrap'].every((n) => { const x = by(n); return x && x.scopeKind === 'game' && x.scope === 'game' && x.scene === null && x.role === 'dim' && x.kind === 'var' && x.length === 1 && x.line === 4; }));
const arr = by('arr'), grid = by('grid'), tm = by('tm');
check('arr(19): an array of 20 elements, 40 bytes, dims [20], line 5', arr.kind === 'array' && arr.length === 20 && arr.size === 40 && eq(arr.dims, [20]) && arr.line === 5);
check('grid(2, 3): 3 x 4 = 12 elements, dims [3, 4], line 6', grid.kind === 'array' && grid.length === 12 && eq(grid.dims, [3, 4]) && grid.line === 6);
check('the TIMER is a variable with role timer', tm.kind === 'var' && tm.role === 'timer' && tm.scopeKind === 'game');
check('the same name in two scenes is two variables: s1 of one, s1 of two, different addresses', vars.filter((x) => x.name === 's1').length === 2 && by('s1', 'one').address !== by('s1', 'two').address && by('s1', 'one').scene === 'one' && by('s1', 'two').scopeKind === 'scene');
check('scene arrays: sarr(4) in one (5 elements), t2(3) in two (4 elements)', by('sarr').length === 5 && by('sarr').scene === 'one' && by('t2').length === 4 && by('t2').scene === 'two');
check('the PROC parameter pv is a param of SETP (scene one), the local LV a local; both one slot', by('pv').role === 'param' && by('pv').scopeKind === 'proc' && by('pv').scope === 'SETP' && by('pv').scene === 'one' && by('LV').role === 'local' && by('LV').scope === 'SETP' && by('pv').size === 2);
check('the DEF FN parameter q is a param with scopeKind fn and scope dbl', by('q').role === 'param' && by('q').scopeKind === 'fn' && by('q').scope === 'dbl' && by('q').scene === null);
check('CONST K is not a variable and the hidden slots (scene driver, FOR, SELECT, key snapshots) are not listed', !by('K') && vars.every((x) => !/^(scene|for|select|arr|press|show|tile)\./i.test(x.key)));
// the linker's own tables: every variable's address is the one the compiler's maps give
const slotAt = new Map(res.map.slots.map((s) => [s.addr, s.name]));
check('every address is a slot the compiler allocated, with the matching name (map.slots), and the first slot of each array is named NAME(0)', vars.every((x) => {
  const nm = slotAt.get(x.address);
  if (!nm) return false;
  if (x.kind === 'array') return nm.endsWith('(0)') || nm.endsWith('(0,0)');
  return true;
}));
check('map.vars and map.arrays agree: every game / scene DIM address is the map\'s (keys SCENE.NAME with several scenes)', vars.filter((x) => x.scopeKind === 'game' || x.scopeKind === 'scene').every((x) => {
  const key = x.scene ? `${x.scene.toUpperCase()}.${x.key}` : x.key;
  return x.kind === 'array' ? res.map.arrays[key]?.addr === x.address && res.map.arrays[key].n + 1 === x.length : res.map.vars[key] === x.address;
}));
check('collectVariables(ast, gen) is what compile() returned (a pure function of the AST and the generator\'s symbols)', eq(collectVariables(res.ast, res.gen), vars));
// an error: no variables
{
  const bad = compileReal.length >= 0 ? (() => { try { return compileReal('GAME "x"\nSCENE a\n  PROC FRAME():\n    x = \n  ENDP\nENDSCENE\n', {}); } catch (e) { return e; } })() : null;
  check('a program with an error has no `variables` (the compile throws in compileReal; compile() itself returns none)', bad instanceof Error);
}

// ── 3. the addresses are right: the panel model on the machine's memory against the interpreter ────────────────────────────────────────────────────
console.log('3. the model reads the machine\'s memory and agrees with the interpreter, tick by tick, on the real runtime');

/** The interpreter's name for a listed variable (game names plain; a scene's own names SCENE.NAME in a game of several scenes); null for a parameter or local (the interpreter keeps no record of those). */
const interpKey = (x, scenes) => (x.scopeKind === 'game' ? x.key : x.scopeKind === 'scene' ? (scenes > 1 ? `${x.scene.toUpperCase()}.${x.key}` : x.key) : null);

/** Run the cartridge; after each tick decode every variable with the panel model from the machine's bytes alone; compare with the interpreter's record. */
function agree(label, src, assets, { ticks, keys = null, stick = null, extra = null }) {
  const res = compileReal(src, assets);
  const scenes = res.ast.scenes?.length ?? 0;
  const decoded = [];
  const got = runReal(res, { ticks, keys, stick, hooks: { afterTick: (k, m) => { decoded[k - 1] = V.snapshot(res.variables, (a) => m.ram[a]); } } });
  if (got.error) { check(`${label}: the run on the real runtime`, false, got.error); return null; }
  const want = interpFor(src, assets, got)(ticks, { keys: keys ? (t, c) => keys(t).includes(c) : undefined, stick: stick ?? undefined });
  let compared = 0, arrays = 0, first = null, changedTicks = 0;
  const listed = res.variables.filter((x) => interpKey(x, scenes) !== null);
  for (let t = 0; t < ticks && !first; t++) {
    const rec = want.ticks[t], snap = decoded[t];
    if (!snap) { first = `tick ${t + 1}: no snapshot`; break; }
    for (const x of listed) {
      const k = interpKey(x, scenes), vals = snap.get(V.variableId(x));
      const w = x.kind === 'array' ? rec.arrays[k] : [rec.vars[k]];
      if (!vals || !w) { first = `tick ${t + 1}: ${x.name} (${k}) missing (model ${!!vals}, interpreter ${!!w})`; break; }
      if (!eq(vals, w)) { const i = vals.findIndex((q, j) => q !== w[j]); first = `tick ${t + 1}: ${x.scene ? x.scene + '.' : ''}${x.name}${x.kind === 'array' ? `(${i})` : ''} = ${vals[i]} at $${x.address.toString(16).toUpperCase()}, interpreter ${w[i]}`; break; }
      compared += vals.length; if (x.kind === 'array') arrays += vals.length;
    }
    if (t > 0 && V.changedIds(decoded[t - 1], snap).size) changedTicks++;
  }
  check(`${label}: ${listed.length} variables (${listed.filter((x) => x.kind === 'array').length} arrays), ${ticks} ticks: the values the model reads from memory equal the interpreter's`, !first && compared > 0, first ?? `${compared} values compared (${arrays} array elements), the values changed in ${changedTicks} ticks`);
  check(`${label}: the run is not trivial (some variables change while it runs)`, changedTicks >= 3, `${changedTicks} ticks with a change`);
  return { res, got, want, decoded, listed };
}

// 3a. the made-up game
{
  const T = 14;
  const r = agree('vartest', VARTEST, {}, { ticks: T });
  if (r) {
    const { res: rs, decoded } = r;
    const at = (k, name, scope) => decoded[k - 1].get(V.variableId(rs.variables.find((x) => x.name.toUpperCase() === name.toUpperCase() && (scope === undefined || x.scope.toUpperCase() === scope.toUpperCase()))));
    const s16 = (n) => ((n & 0xFFFF) ^ 0x8000) - 0x8000;
    const ex = [];
    for (let k = 1; k <= 6; k++) {              // scene one runs ticks 1..6 (g1 reaches 11 at tick 6, then ENTER two)
      if (at(k, 'g1')[0] !== 5 + k) ex.push(`g1 at tick ${k} = ${at(k, 'g1')[0]}`);
      if (at(k, 'neg')[0] !== -123) ex.push(`neg at tick ${k}`);
      if (at(k, 'big')[0] !== s16(30000 + 1000 * k)) ex.push(`big at tick ${k} = ${at(k, 'big')[0]}, want ${s16(30000 + 1000 * k)}`);
      if (at(k, 'wrap')[0] !== -25536) ex.push(`wrap at tick ${k} = ${at(k, 'wrap')[0]}`);
      if (at(k, 'arr')[0] !== 32767 || at(k, 'arr')[19] !== -32768) ex.push(`arr extremes at tick ${k}: ${at(k, 'arr')[0]} ${at(k, 'arr')[19]}`);
      if (at(k, 'arr')[6] !== s16((5 + k) * 300)) ex.push(`arr(6) at tick ${k} = ${at(k, 'arr')[6]}`);
      if (at(k, 'arr')[4] !== 5000 || at(k, 'arr')[5] !== -6000 || at(k, 'arr')[3] !== -400) ex.push(`arr initialiser at tick ${k}`);
      const g = at(k, 'grid');
      if (g[2 * 4 + 3] !== 77 || g[1 * 4 + 2] !== -9 || g[0] !== 5 + k) ex.push(`grid flat slots at tick ${k}: ${g}`);
      if (at(k, 'pv')[0] !== 5 + k + 1000 || at(k, 'lv')[0] !== 5 + k + 1001) ex.push(`pv / lv at tick ${k} = ${at(k, 'pv')}, ${at(k, 'lv')}`);
      if (at(k, 'q', 'dbl')[0] !== 5 + k) ex.push(`FN dbl parameter at tick ${k} = ${at(k, 'q', 'dbl')}`);
      if (at(k, 's1', 'one')[0] !== 5 + k + 1001) ex.push(`one.s1 at tick ${k} = ${at(k, 's1', 'one')}`);
    }
    if (at(2, 'tm')[0] !== 98) ex.push(`the TIMER after 2 ticks = ${at(2, 'tm')[0]}, want 98`);
    if (at(T, 's1', 'two')[0] !== 7 * (T - 6)) ex.push(`two.s1 at tick ${T} = ${at(T, 's1', 'two')[0]}, want ${7 * (T - 6)}`);
    check('vartest: independent of the interpreter, the decoded values are the ones the program must have (the negative, the wrapped 16-bit sum, the extremes, an initialiser, the 2-D flat slots, the parameter, the local, the timer, the second scene)', ex.length === 0, ex.slice(0, 4).join('; ') || 'all as computed by hand');
    // the 5th-tick spot check of hex
    check('vartest: in hex the negative number reads $FF85 and the wrapped sum $9C40', V.formatValues(at(1, 'neg'), { hex: true, array: false }) === '$FF85' && V.formatValues(at(1, 'wrap'), { hex: true, array: false }) === '$9C40');
  }
}

// 3b. examples and a starter
const ex = (name) => ({ src: readFileSync(join(ROOT, `arcade/examples/${name}.arc`), 'utf8'), assets: JSON.parse(readFileSync(join(ROOT, `arcade/examples/${name}.assets.json`), 'utf8')) });
const KEYS = (cycle) => (t) => cycle(t).map((c) => c.charCodeAt(0));      // (key codes, as runReal and the interpreter take them)
{
  const { src, assets } = ex('blockfall');
  // the title waits for fire; then a piece falls: a few moves
  agree('blockfall', src, assets, { ticks: QUICK ? 120 : 400, keys: KEYS((t) => (t >= 5 && t < 8 ? [' '] : t >= 40 && t % 6 === 0 ? ['O'] : t >= 60 && t % 9 === 0 ? ['P'] : t % 50 > 30 ? ['A'] : [])) });
}
{
  const { src, assets } = ex('breakout');
  agree('breakout', src, assets, { ticks: QUICK ? 120 : 400, keys: KEYS((t) => (t >= 5 && t < 8 ? [' '] : t % 40 < 20 ? ['O'] : ['P'])) });
}
{
  const { src, assets } = ex('bounce');
  agree('bounce (two scenes)', src, assets, { ticks: QUICK ? 120 : 300, keys: KEYS((t) => (t >= 5 && t < 8 ? [' '] : t % 60 < 30 ? ['O'] : ['P'])) });
}
{
  const st = STARTERS_A.find((s) => s.id === 'blank').make();
  agree('starter blank (a TIMER)', st.files['main.arc'], { ...st.assets, scenes: st.scenes }, { ticks: QUICK ? 120 : 300, keys: KEYS((t) => (t % 30 < 10 ? ['O'] : t % 30 < 20 ? ['Q'] : ['P'])) });
}
void info;

console.log(`\n${failed ? 'FAIL' : 'PASS'}: variables-panel (${passed} passed, ${failed} failed)`);
process.exit(failed ? 1 : 0);
