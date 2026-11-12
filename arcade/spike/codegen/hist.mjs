// hist.mjs -- histogram of the generated code by idiom (from listing/<game>.json, made by instr.mjs). Attribution: the code generator function (and line) that emitted each instruction.
import { readFileSync, writeFileSync } from 'node:fs';
const GAMES = ['runner', 'vaults', 'platformer', 'shooter', 'blockfall', 'breakout', 'bounce'];
const fnOf = (f) => (f ?? '?:0').split(':');
function classify(it) {
  if (['db', 'dw', 'ds'].includes(it.t)) return 'Z data (strings, tiles, sound, songs, maps, initialisers)';
  const fr = it.fr, [f0, l0s] = fnOf(fr[0]), l0 = +l0s, names = fr.map((f) => fnOf(f)[0]);
  const under = (n) => names.includes(n);
  if (['arrayAddr', 'arrayRead', 'arrayWrite', 'addr2', 'limitTest'].includes(f0)) return 'B array element: bounds test, address, element read / write';
  if (f0 === '?' && l0 >= 1304 && l0 <= 1360) return 'B2 array element: out-of-range stubs';
  if (f0 === 'generateOnce' && l0 >= 2380 && l0 <= 2392) return 'B3 array element: 2-D shared routines';
  if (f0 === 'lessBranch') return names[1] === 'forStmt' ? 'J FOR: init, step, limit test' : 'C signed compare < > <= >= (subtract and jump)';
  if (f0 === 'compare') return l0 >= 1715 && l0 <= 1716 ? 'C signed compare < > <= >= (subtract and jump)' : l0 >= 1712 ? 'D compare = <> (subtract and jump)' : 'D2 compare with 0 (test and jump)';
  if (f0 === 'branch') return 'D3 truth test of a value / BIT (test and jump)';
  if (f0 === 'boolValue') return 'H boolean made a 0/1 value';
  if (f0 === 'forStmt' || f0 === 'loadLim') return 'J FOR: init, step, limit test';
  if (f0 === 'selectStmt') return 'K SELECT CASE: selector store, value tests, jumps';
  if (f0 === 'gen' && (l0 === 1401 || l0 === 1402)) return 'L PROC / FN call: argument stores, CALL, RET, LOCAL clearing';
  if ((f0 === 'gen' && l0 === 1389) || (f0 === 'loadSimple' && l0 === 1210)) {
    return under('selectStmt') && f0 === 'loadSimple' ? 'K SELECT CASE: selector store, value tests, jumps' : under('forStmt') && names[1] === 'forStmt' ? 'J FOR: init, step, limit test' : 'E variable load (LD HL/DE/BC,(slot))';
  }
  if ((f0 === 'gen' && l0 === 1387) || (f0 === 'loadSimple' && l0 === 1209)) {
    return under('selectStmt') && f0 === 'loadSimple' ? 'K SELECT CASE: selector store, value tests, jumps' : 'E2 constant load (LD HL/DE/BC,n)';
  }
  if (f0 === 'stmt' && l0 === 2026) return 'F variable store (LD (slot),HL)';
  if (['arith', 'addConst', 'shiftLeft', 'shiftRightArith', 'mulConst', 'negHL', 'byteOp', 'operands'].includes(f0)) return 'G arithmetic: + - * DIV MOD, shifts, BAND.., operand shuffles';
  if (f0 === 'func') return l0 < 1542 ? 'G arithmetic: + - * DIV MOD, shifts, BAND.., operand shuffles' : 'N2 runtime functions (STICK, HIT, KEYDOWN, TILEHIT, SOLID, WORLDTILE ...): set-up and CALL';
  if (f0 === 'hitV2') return 'N2 runtime functions (STICK, HIT, KEYDOWN, TILEHIT, SOLID, WORLDTILE ...): set-up and CALL';
  if (f0 === 'setArg' && under('func')) return 'N2 runtime functions (STICK, HIT, KEYDOWN, TILEHIT, SOLID, WORLDTILE ...): set-up and CALL';
  if (f0 === 'stmt' && (l0 === 2036 || (l0 >= 2040 && l0 <= 2049) || l0 === 2136)) return 'I IF / WHILE / EXIT: structure jumps';
  if (f0 === 'callArgs' || f0 === 'clearLocals' || (f0 === '?' && l0 >= 1790 && l0 <= 1802) || (f0 === 'stmt' && l0 === 2057) || (f0 === 'generateOnce' && l0 === 2323)) return 'L PROC / FN call: argument stores, CALL, RET, LOCAL clearing';
  if (f0 === 'printStmt' || f0 === 'setCursor') return 'M PRINT: cursor, strings, numbers';
  if (['setArg', 'fillStmt', 'copyStmt', 'tileStmt', 'showFrameStmt', 'regs', 'xy', 'instToA', 'worldStmt', 'loadTableStmt', 'loadMapStmt', 'setWorldStmt', 'viewStmt', 'stmt'].includes(f0)) return 'N runtime statements (SHOW, HIDE, TILE, FILL, PLAY, INK ...): set-up and CALL';
  return 'O scene driver, init, tick prologue, timers, shared library routines';
}
const tot = new Map(); const sums = {};
for (const g of GAMES) {
  const L = JSON.parse(readFileSync(`listing/${g}.json`));
  for (const it of L.items) { const k = classify(it); const r = tot.get(k) ?? tot.set(k, {}).get(k); r[g] = (r[g] ?? 0) + it.n; r.all = (r.all ?? 0) + it.n; sums[g] = (sums[g] ?? 0) + it.n; }
}
let out = `| idiom | ${GAMES.join(' | ')} | all |\n|---|${GAMES.map(() => '--:').join('|')}|--:|\n`;
for (const [k, r] of [...tot].sort((a, b) => a[0] < b[0] ? -1 : 1)) out += `| ${k.replace(/^\S+ /, '')} | ${GAMES.map((g) => r[g] ?? 0).join(' | ')} | ${r.all} |\n`;
const code = (g) => sums[g] - (tot.get('Z data (strings, tiles, sound, songs, maps, initialisers)')[g] ?? 0);
out += `| **instructions (code proper)** | ${GAMES.map(code).join(' | ')} | ${GAMES.reduce((s, g) => s + code(g), 0)} |\n| **"code" as the linker counts it (with data)** | ${GAMES.map((g) => sums[g]).join(' | ')} | ${GAMES.reduce((s, g) => s + sums[g], 0)} |\n`;
writeFileSync('histogram.md', out); console.log(out);
