// patterns.mjs -- count the wasteful patterns in the real generated code (listing/<game>.json from instr.mjs). Counted estimates; the prototypes give the measured figures.
import { readFileSync, writeFileSync } from 'node:fs';
const DIR = process.argv[2] ?? 'listing';
const GAMES = ['runner', 'vaults', 'platformer', 'shooter', 'blockfall', 'breakout', 'bounce'];
const rows = new Map();
const add = (key, g, n, bytes) => { const r = rows.get(key) ?? rows.set(key, { n: {}, b: {} }).get(key); r.n[g] = (r.n[g] ?? 0) + n; r.b[g] = (r.b[g] ?? 0) + bytes; };
const fn = (it, i = 0) => (it.fr[i] ?? '?:0');
const isData = (it) => ['db', 'dw', 'ds'].includes(it.t);
const num = (s) => (s === undefined ? NaN : /^-?\$/.test(s) ? (s[0] === '-' ? -1 : 1) * parseInt(s.replace(/^-?\$/, ''), 16) : Number(s));
for (const g of GAMES) {
  const L = JSON.parse(readFileSync(`${DIR}/${g}.json`)), I = L.items;
  const labAt = new Set(Object.values(L.labels));
  const at = new Map(I.map((it, i) => [it.a, i]));
  const lo = L.base, hi = L.base + L.codeLen;
  // 1. signed compares: constant operand or not
  for (let i = 0; i < I.length; i++) {
    const it = I[i];
    if (fn(it).startsWith('lessBranch:1683') && it.t === 'or') {
      const inFor = (it.fr[1] ?? '').startsWith('forStmt');
      let j = i - 1; if (I[j].t === 'ex') j--;
      const konst = fn(I[j]).startsWith('loadSimple:1209') || fn(I[j]).startsWith('loadLim') && /^-?[\d$]/.test(I[j].args[1]) || (inFor && fn(I[j - 1]).startsWith('loadLim') && /^-?[\d$]/.test(I[j - 1].args[1]));
      add(inFor ? (konst ? 'signed compare in a FOR limit test, constant limit' : 'signed compare in a FOR limit test, run-time limit') : konst ? 'signed compare < > <= >= with a constant' : 'signed compare < > <= >= of two run-time values', g, 1, 14);
    }
    // 2. = / <> with a constant
    if (fn(it).startsWith('compare:171') && it.t === 'or' && (fn(it).startsWith('compare:1712') || fn(it).startsWith('compare:1713'))) {
      const p = I[i - 1];
      if (fn(p).startsWith('loadSimple:1209')) { const k = num(p.args[1]); add((k >= 1 && k <= 255) || k === -1 ? '= / <> with a constant 1..255 or -1' : '= / <> with another constant', g, 1, 6); }
      else add('= / <> of two run-time values', g, 1, 3);
    }
    // 3. SELECT
    if (fn(it).startsWith('selectStmt:2190')) add('SELECT statements', g, 1, 3);
    if (fn(it).startsWith('selectStmt:2200') || (fn(it).startsWith('selectStmt:2197') && it.t === 'ld' && it.args[0] === 'hl')) add('SELECT case values', g, 1, fn(it).startsWith('selectStmt:2200') ? 12 : 8);
    if (fn(it).startsWith('selectStmt:2205')) add('SELECT cases (JP next)', g, 1, 3);
    // 4. arrays (1-D, run-time index)
    if (fn(it).startsWith('arrayAddr:1270') && it.t === 'ld' && it.args[0] === 'a' && it.args[1] === 'l') {
      const base = I[i + 6].args[1];
      const read = fn(I[i + 8]).startsWith('arrayRead:1321');
      add(read ? '1-D array element reads (run-time index)' : '1-D array element writes (run-time index)', g, 1, read ? 24 : 20);
      (L.arr ??= new Map()).set(base + (read ? 'r' : 'w'), (L.arr.get(base + (read ? 'r' : 'w')) ?? 0) + 1);
    }
    // 5. jumps
    if (it.t === 'jp' && it.tg !== null && it.tg >= lo && it.tg < hi) {
      add(it.cc === null ? 'JP (unconditional, inside the code)' : ['pe', 'po', 'p', 'm'].includes(it.cc) ? 'JP PE/PO/P/M (no JR form)' : 'JP NZ/Z/NC/C (inside the code)', g, 1, 3);
      const d = it.tg - (it.a + 2);
      if (it.cc === null || ['nz', 'z', 'nc', 'c'].includes(it.cc)) if (d >= -128 && d <= 127) add('  of them within JR reach as the code stands', g, 1, 1);
      const ti = at.get(it.tg);
      if (ti !== undefined && I[ti].t === 'ret' && I[ti].args.length === 0) add(it.cc === null ? 'JP to a RET (could be RET: 2 bytes)' : 'JP cc to a RET (could be RET cc: 2 bytes)', g, 1, 2);
      if (ti !== undefined && I[ti].t === 'jp' && I[ti].cc === null && it.cc !== null) add('JP cc to an unconditional JP (threading: time only)', g, 1, 0);
    }
    if (it.t === 'call' && I[i + 1]?.t === 'ret' && I[i + 1].args.length === 0 && !labAt.has(I[i + 1].a)) add('CALL followed by RET (tail call: JP, 1 byte, 17 T)', g, 1, 1);
    // 6. constant stores, x = x +/- k
    if (it.t === 'ld' && fn(it).startsWith('stmt:2026')) {
      const p = I[i - 1], pp = I[i - 2];
      if (fn(p).startsWith('gen:1387')) add('constant stored to a variable (LD HL,n / LD (v),HL: 6 bytes)', g, 1, 6);
      if (fn(p).startsWith('addConst:1225') && pp && (fn(pp).startsWith('gen:1389') && pp.args[1] === it.args[0] || fn(pp).startsWith('addConst') )) { let q = i - 1; while (fn(I[q]).startsWith('addConst:1225')) q--; if (I[q].args[1] === it.args[0]) add('v = v +/- 1..4 (LD HL,(v) / INC HL.. / LD (v),HL)', g, 1, 6 + (i - 1 - q)); }
      if (fn(p).startsWith('addConst:1226') && I[i - 3] && I[i - 3].args[1] === it.args[0]) add('v = v + k, other k (LD HL,(v) / LD DE,k / ADD HL,DE / LD (v),HL: 10 bytes)', g, 1, 10);
    }
    // 7. booleans as values
    if (fn(it).startsWith('boolValue:1414') && it.t === 'ld') add('boolean made a 0/1 value (8 bytes each besides the test)', g, 1, 8);
    // 8. BAND(x, const) straight into a truth test
    if (fn(it).startsWith('branch:1676') && it.t === 'ld' && fn(I[i - 1]).startsWith('byteOp')) add('BAND/BOR/BXOR with a constant straight into a truth test', g, 1, 0);
    if (fn(it).startsWith('compare:1700') && it.t === 'ld' && fn(I[i - 1]).startsWith('byteOp')) add('BAND/BOR/BXOR with a constant compared with 0', g, 1, 0);
    // 9. PRINT AT with constants
    if (fn(it).startsWith('setCursor:1749') && it.args[0] === 'b') add('PRINT AT constant row, col (LD B / LD C: LD BC saves 1)', g, 1, 1);
    if (fn(it).startsWith('printStmt:1765') && it.t === 'ld') add('PRINT string pieces (LD HL,str / CALL RT_PRINTS: 6 bytes)', g, 1, 6);
    // 10. PROC calls and locals
    if (fn(it).startsWith('stmt:2057')) add('PROC calls', g, 1, 3);
    if ((fn(it).startsWith('?:1801') || fn(it).startsWith('?:1798') || fn(it).startsWith('callArgs')) && it.t === 'ld' && it.args[1] === 'hl') add('PROC argument stores', g, 1, 3);
    if (fn(it).startsWith('clearLocals:1248') && it.args[0] === 'hl') { let n = 0; while (fn(I[i + 1 + n]).startsWith('clearLocals:1248')) n++; add('PROCs that clear LOCALs inline', g, 1, 3 + 3 * n); add('  of them: bytes over a shared clearing routine (LD HL,addr / LD B,n / CALL: 8)', g, n >= 2 ? 1 : 0, Math.max(0, 3 + 3 * n - 8)); }
    // 11. shifts
    if (fn(it).startsWith('shiftRightArith:1236') && it.t === 'sra' && !fn(I[i - 1]).startsWith('shiftRightArith:1236')) { let n = 0; while (fn(I[i + n]).startsWith('shiftRightArith:1236')) n++; add(`SHR by ${n / 2} (inline, ${2 * n} bytes)`, g, 1, 2 * n); }
    // 12. FOR
    if (fn(it).startsWith('forStmt:2159')) { add('FOR loops', g, 1, 0); if (fn(I[i - 2]).startsWith('gen:1387')) add('  FOR with a constant start', g, 1, 0); }
    // 13. runtime argument block
    if (fn(it).startsWith('setArg:1807') && it.args[1] === 'hl') { add('runtime argument-block stores (RA_X..RA_V)', g, 1, 3); if (fn(I[i - 1]).startsWith('gen:1387')) add('  of them a constant (6 bytes with its load)', g, 1, 6); }
  }
  for (const [k, n] of L.arr ?? []) { const read = k.endsWith('r'); add(read ? 'distinct arrays read with a run-time index' : 'distinct arrays written with a run-time index', g, 1, read ? 22 : 18); if (n === 1) add('  arrays with a single ' + (read ? 'read' : 'write') + ' site', g, 1, 0); }
}
let out = `| pattern | ${GAMES.map((g) => g + ' n').join(' | ')} | all n | bytes now, all games |\n|---|${GAMES.map(() => '--:').join('|')}|--:|--:|\n`;
for (const [k, r] of rows) out += `| ${k} | ${GAMES.map((g) => r.n[g] ?? 0).join(' | ')} | ${GAMES.reduce((s, g) => s + (r.n[g] ?? 0), 0)} | ${GAMES.reduce((s, g) => s + (r.b[g] ?? 0), 0)} |\n`;
writeFileSync(`patterns-${DIR.replace(/\W/g, '_')}.md`, out); console.log(out);
