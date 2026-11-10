"use strict";
// arcade-m10-common.mjs -- shared by tests/arcade-m10-compiler.mjs and tests/arcade-m10-differential.mjs (language batch 5, compiler half: docs/ARCADE_LANGUAGE_BATCH5.md
// Part A timers and key edges, Part B PRINT ... USING, Part C `PLAY` by index; the three-channel effects are NOT covered here).
//   rng, pick, ri, ASSETS            re-exported from tests/arcade-m9-common.mjs (the same assets: sprites orb / dot / guard / big, a tileset, maps m1 m2 lv maze, sfx short (3 records) and long (300))
//   USING_PATTERNS                   the 8 patterns of the full-range sweeps
//   modelUsing(v, pat)               an INDEPENDENT model of contract item 12 (written per character, not like fmtUsing)
//   edgeModel(seq)                   edge = now AND NOT before over a sequence of masks, the first "before" being 0
//   genProgram10(seed, opts)         a random program with TIMERs (game level and in scenes), KEYPRESS / JOYPRESS, PRINT ... USING of many patterns, PLAY by index / name / (name), 2-4 scenes
//                                    with the same names reused: {src, seed, scenes, keys(t), stick(t)}
//   HAND10                           hand-written programs, one per rule, with scripted inputs and the series of values worked out by hand: {src, ticks, keys, stick, series, scene, rows, ...}
//   rowText(rec, row)                the text of one screen row of a record / snapshot (cells as characters, trailing blanks cut)
//   genV3x(seed) / genV4x(seed)      v3 (WINDOW) and v4 (VIEW3D) spot programs using TIMER / KEYPRESS / JOYPRESS / USING
//   sweepProgram(pat, opts)          a program that prints 64 values a tick through `x USING pat` (opts.accumulate: contiguous from -32768; opts.bases: a table of start values)
//   foldProgram(pat, values)         a program that prints each value as a LITERAL item with USING (the build-time path), laid out for rowText

import { rng, pick, ri, ASSETS } from './arcade-m9-common.mjs';
export { rng, pick, ri, ASSETS };

// ── contract item 12, as a model written independently of the implementation ─────────────────────────────────────────────────────
/** Pattern of # and 0 (1..8 characters), value a signed 16-bit number -> the field as text. */
export function modelUsing(v, pat) {
  const w = pat.length;
  let z = 0;
  for (let i = 0; i < w; i++) if (pat[i] === '0') { z = w - i; break; }       // positions from the leftmost 0 to the right end
  const neg = v < 0;
  let digits = String(neg ? -v : v);
  // READING: item 12 says "zeros up to max(len(d), z)", then the sign, then spaces up to w, and gives "0000": -5 -> "-005". The text alone would give "-0005" (5 characters: "****"),
  // so the model follows the EXAMPLES: the zero padding stops when the sign would no longer fit (the sign takes the leftmost zero position of a pattern that starts with 0):
  // the digits are padded to max(len(d), min(z, w - (negative ? 1 : 0))).
  const pad = Math.max(digits.length, Math.min(z, w - (neg ? 1 : 0)));
  if (digits.length < pad) digits = '0'.repeat(pad - digits.length) + digits;
  const s = (neg ? '-' : '') + digits;
  if (s.length > w) return '*'.repeat(w);
  return ' '.repeat(w - s.length) + s;
}
export const USING_PATTERNS = ['0000', '###', '##00', '#', '00000000', '########', '0#', '#0#0'];

/** edge(t) = now(t) AND NOT now(t - 1), now(0) = 0 (nothing was held before the first tick that began) */
export function edgeModel(seq) { let before = 0; return seq.map((now) => { const e = now & ~before; before = now; return e; }); }

/** the text of a screen row from a record / snapshot (cells as character codes), trailing blanks cut */
export function rowText(rec, row) {
  let s = '';
  for (let c = 0; c < 32; c++) s += String.fromCharCode(rec.cells[row * 32 + c]);
  return s.replace(/ +$/, '');
}

// ── the random program generator ─────────────────────────────────────────────────────────────────────────────────────────────────
const HEAD_ASSETS = 'TILESET ts = "ts"\nMAP ma = "m1"\nMAP mb = "m2"\nSFX snda = "short"\nSFX sndb = "long"\nSPRITE ship = "orb"\nSPRITE rock(4) = "dot"\n';
const PATS = ['0000', '###', '##00', '#', '00000000', '0', '00', '####', '000', '#0', '0#', '########', '#0#0', '##0', '00000'];
const KEYARGS = ['"O"', '79', '"P"', '80', '"Q"', '81', '65', '32', '"o"', '" "'];

/**
 * A grammar-based random program, in the style of tests/arcade-m9-common.mjs genProgram. Scenes sa, sb, sc, sd (2 to 4) with the same names (TIMER ts [, tu]; DIM t, u, [w], arr(3); CONST K;
 * DEF FN fa; PROC UPDATE L1 L2 L3), game level TIMER tg1 [, tg2 [, tg3]], DIM g1 g2 g3 [snda], DIM ga(3), CONST GK, DEF FN gf, PROC GP. New statements: a timer assigned (1..9, 0, a small
 * negative, an expression), PRINT items with USING (15 patterns, run-time values and literals, SEPARATORS , ;), PLAY by index: a literal 0 or 1, BAND(expr, 1), a variable, a random expression
 * (mostly out of range), by name, `PLAY (snda)` where snda is also a variable; conditions with timers, KEYPRESS("O"/code), JOYPRESS(1/2), BIT(JOYPRESS(n), b).
 * ENTER appears as in genProgram (end of FRAME on `t`, in the PROC chain under conditions that now include timers and key edges, in INIT guarded by g2).
 */
export function genProgram10(seed, opts = {}) {
  const r = rng(seed * 6271 + 29);
  const ns = opts.scenes ?? ri(r, 2, 4);
  const names = ['sa', 'sb', 'sc', 'sd'].slice(0, ns);
  const rate = pick(r, [20, 15, 12]);
  const gtimers = ['tg1', 'tg2', 'tg3'].slice(0, ri(r, 1, 3));
  const hasSnd = r() < 0.7;
  const L = [];
  const emit = (s = '') => L.push(s);
  const lit = (lo = 0, hi = 40) => String(ri(r, lo, hi));
  const keyArg = () => pick(r, KEYARGS);
  const inputEx = () => pick(r, [`BIT(STICK(1), ${ri(r, 0, 4)})`, `KEYDOWN(${pick(r, [81, 65, 79, 80, 32])})`, 'STICK(1)', `KEYPRESS(${keyArg()})`, `KEYPRESS(${keyArg()})`, `JOYPRESS(${ri(r, 1, 2)})`, `BIT(JOYPRESS(${ri(r, 1, 2)}), ${ri(r, 0, 4)})`]);
  const ex = (c, d = 0) => {
    const k = ri(r, 0, d >= 2 ? 3 : 13);
    switch (k) {
      case 0: return lit(0, 60);
      case 1: case 2: return pick(r, c.nums);
      case 3: return c.consts.length && r() < 0.5 ? pick(r, c.consts) : pick(r, c.nums);
      case 4: { const a = pick(r, c.arrs); return a ? `${a.name}(BAND(${ex(c, d + 1)}, ${a.mask}))` : lit(); }
      case 5: case 6: return `(${ex(c, d + 1)} ${pick(r, ['+', '-', '*'])} ${ex(c, d + 1)})`;
      case 7: return `(${ex(c, d + 1)} ${pick(r, ['MOD', 'DIV'])} ${ri(r, 1, 9)})`;
      case 8: return c.rnd ? `RND(${ri(r, 2, 50)})` : lit();
      case 9: return c.fns.length ? `FN ${pick(r, c.fns)}(${ex(c, d + 1)})` : `ABS(${ex(c, d + 1)})`;
      case 10: case 11: return c.input ? inputEx() : `ABS(${ex(c, d + 1)})`;
      case 12: return c.timers.length ? pick(r, c.timers) : lit();
      default: return `BAND(${ex(c, d + 1)}, ${pick(r, [3, 7, 15, 31, 63])})`;
    }
  };
  const cond = (c, d = 0) => {
    const k = ri(r, 0, d >= 1 ? 2 : 6);
    const rel = () => `${ex(c, 1)} ${pick(r, ['=', '<>', '<', '>', '<=', '>='])} ${ex(c, 1)}`;
    if (k <= 2) return rel();
    if (k === 3) return `${cond(c, d + 1)} ${pick(r, ['AND', 'OR'])} ${cond(c, d + 1)}`;
    if (k === 4) return c.input ? inputEx() : rel();
    if (k === 5 && c.timers.length) return `${pick(r, c.timers)} ${pick(r, ['=', '=', '>', '<='])} ${ri(r, 0, 5)}`;
    return `NOT (${rel()})`;
  };
  const ind = (n) => '    '.repeat(n);
  const usingItem = (c) => {
    const pat = pick(r, PATS);
    const k = ri(r, 0, 9);
    let e;
    if (k <= 5) e = ex(c, 1);
    else if (k === 6) e = lit(0, 99999 > 65535 ? 65535 : 99999);
    else if (k === 7) e = `-${lit(1, 32768)}`;
    else if (k === 8 && c.consts.length) e = pick(r, c.consts);
    else e = `(${ex(c, 1)})`;
    return `${e} USING "${pat}"`;
  };
  const stmt = (c, n) => {
    const out = [];
    const I = ind(n);
    const target = () => pick(r, c.nums.filter((v) => !c.readonly?.includes(v)));
    const wts = [
      ['assign', 6], ['arr', 3], ['if', c.depth < 2 ? 3 : 0], ['for', c.depth < 2 ? 1.5 : 0], ['call', c.calls.length ? 3 : 0],
      ['show', c.draw ? 2.5 : 0], ['hide', c.draw ? 1.5 : 0], ['print', c.draw ? 2 : 0], ['using', c.draw ? 5 : 0], ['color', c.draw ? 1 : 0], ['tile', c.draw ? 1.5 : 0],
      ['fill', c.draw ? 1 : 0], ['cls', c.draw ? 0.3 : 0], ['playidx', c.draw ? 3 : 0], ['border', c.draw ? 0.8 : 0], ['timer', c.timers.length ? 5 : 0], ['randomise', 0.2],
    ];
    const total = wts.reduce((s, [, w]) => s + w, 0);
    let x = r() * total, kind = 'assign';
    for (const [k, w] of wts) { if (x < w) { kind = k; break; } x -= w; }
    switch (kind) {
      case 'assign': out.push(`${I}${target()} = ${ex(c)}`); break;
      case 'arr': { const a = pick(r, c.arrs); out.push(a ? `${I}${a.name}(BAND(${ex(c, 1)}, ${a.mask})) = ${ex(c)}` : `${I}${target()} = ${ex(c)}`); break; }
      case 'if': {
        out.push(`${I}IF ${cond(c)} THEN`);
        const cc = { ...c, depth: c.depth + 1 };
        for (let i = ri(r, 1, 2); i > 0; i--) out.push(...stmt(cc, n + 1));
        if (r() < 0.4) { out.push(`${I}ELSE`); for (let i = ri(r, 1, 2); i > 0; i--) out.push(...stmt(cc, n + 1)); }
        out.push(`${I}ENDIF`);
        break;
      }
      case 'for': {
        const v = c.depth === 0 ? 'i' : 'j';
        out.push(`${I}FOR ${v} = 0 TO ${ri(r, 1, 3)}`);
        const cc = { ...c, depth: c.depth + 1, nums: [...c.nums, v], readonly: [...(c.readonly ?? []), v] };
        for (let i = ri(r, 1, 2); i > 0; i--) out.push(...stmt(cc, n + 1));
        out.push(`${I}NEXT ${v}`);
        break;
      }
      case 'call': { const p = pick(r, c.calls); out.push(`${I}CALL ${p}(${p === 'UPDATE' ? '' : ex(c, 1)})`); break; }
      case 'show': out.push(r() < 0.4 ? `${I}SHOW ship AT ${ex(c, 1)}, ${ex(c, 1)}` : `${I}SHOW rock(BAND(${ex(c, 1)}, 3)) AT ${ex(c, 1)}, ${ex(c, 1)}`); break;
      case 'hide': out.push(r() < 0.3 ? `${I}HIDE ship` : `${I}HIDE rock(BAND(${ex(c, 1)}, 3))`); break;
      case 'print': {
        const items = [`"${pick(r, ['A', 'HI', 'T:', 'SCORE'])}"`]; if (r() < 0.8) items.push(ex(c, 1));
        out.push(`${I}PRINT AT ${ri(r, 0, 20)}, ${ri(r, 0, 14)}; ${items.join('; ')}${r() < 0.5 ? ';' : ''}`);
        break;
      }
      case 'using': {
        const items = [];
        for (let i = ri(r, 1, 3); i > 0; i--) { items.push(r() < 0.25 ? `"${pick(r, ['T', 'LV', ':', '|'])}"` : usingItem(c)); }
        let s = `${I}PRINT AT ${ri(r, 0, 22)}, ${ri(r, 0, 20)}; `;
        items.forEach((it, i) => { s += it; if (i < items.length - 1) s += pick(r, ['; ', '; ', ', ']); });
        if (r() < 0.3) s += ';';
        out.push(s);
        break;
      }
      case 'color': out.push(`${I}${pick(r, [`INK ${ri(r, 0, 7)}`, `PAPER ${ri(r, 0, 7)}`, `BRIGHT ${ri(r, 0, 1)}`, `INK ${ri(r, 0, 7)} : PAPER ${ri(r, 0, 7)} : BRIGHT ${ri(r, 0, 1)}`])}`); break;
      case 'tile': out.push(r() < 0.5 ? `${I}TILE ${ri(r, 0, 31)}, ${ri(r, 0, 23)} = ${ri(r, 0, 5)}` : `${I}TILE BAND(${ex(c, 1)}, 31), BAND(${ex(c, 1)}, 15) + 2 = BAND(${ex(c, 1)}, 3)`); break;
      case 'fill': out.push(`${I}FILL ${ri(r, 0, 28)}, ${ri(r, 0, 20)}, ${ri(r, 1, 5)}, ${ri(r, 1, 4)} = ${ri(r, 0, 5)}`); break;
      case 'cls': out.push(`${I}CLS`); break;
      case 'playidx': {
        const forms = ['PLAY snda', 'PLAY sndb', `PLAY ${ri(r, 0, 1)}`, `PLAY ${ri(r, 0, 1)}`, `PLAY BAND(${ex(c, 1)}, 1)`, `PLAY ${pick(r, c.nums.filter((v) => v !== 'snda'))}`, `PLAY ${pick(r, c.nums.filter((v) => v !== 'snda'))} MOD 4`, `PLAY (${pick(r, c.nums.filter((v) => v !== 'snda'))} + ${ri(r, 0, 1)})`, `PLAY (${ex(c, 1)} * ${pick(r, c.nums.filter((v) => v !== 'snda'))})`, 'SILENCE'];
        if (hasSnd) forms.push('PLAY (snda)', 'PLAY (snda)', 'PLAY (snda)');
        out.push(I + pick(r, forms));
        break;
      }
      case 'border': out.push(`${I}BORDER ${r() < 0.5 ? ri(r, 0, 7) : `BAND(${ex(c, 1)}, 7)`}`); break;
      case 'timer': {
        const v = pick(r, [lit(1, 9), lit(1, 9), lit(2, 20), '0', `-${lit(1, 4)}`, ex(c, 1), lit(1, 4)]);
        out.push(`${I}${pick(r, c.timers)} = ${v}`);
        break;
      }
      case 'randomise': out.push(`${I}RANDOMISE ${ri(r, 1, 999)}`); break;
      default: break;
    }
    return out;
  };
  const block = (c, n, count) => { const o = []; for (let i = 0; i < count; i++) o.push(...stmt(c, n)); return o; };
  const enterCond = (c) => pick(r, [
    `t = ${ri(r, 1, 6)}`, `t MOD ${ri(r, 3, 7)} = ${ri(r, 0, 2)}`, `g1 MOD ${ri(r, 5, 11)} = ${ri(r, 0, 3)}`, `RND(${ri(r, 6, 14)}) = 0`, `KEYPRESS(${keyArg()})`, `KEYDOWN(81)`,
    `BIT(JOYPRESS(${ri(r, 1, 2)}), ${ri(r, 0, 4)})`, `${ex(c, 1)} > ${ri(r, 20, 90)}`, ...(c.timers.length ? [`(${pick(r, c.timers)} = 0) AND (t > ${ri(r, 2, 5)})`] : []),
  ]);

  emit(`GAME "m10gen${seed}"`);
  emit(`FRAMERATE ${rate}`);
  for (const l of HEAD_ASSETS.trimEnd().split('\n')) emit(l);
  emit(`CONST GK = ${ri(r, 2, 9)}`);
  emit(`TIMER ${gtimers.join(', ')}`);
  emit(`DIM g1, g2, g3${hasSnd ? ', snda' : ''}`);
  emit(`DIM ga(3) = ${ri(r, 0, 9)}, ${ri(r, 0, 9)}, ${ri(r, 0, 9)}, ${ri(r, 0, 9)}`);
  const RO = ['g1', 'g2', 't'];
  const gnums = ['g1', 'g2', 'g3', ...(hasSnd ? ['snda'] : []), ...gtimers];
  const gctx = { nums: gnums, arrs: [{ name: 'ga', mask: 3 }], fns: ['gf'], consts: ['GK'], rnd: true, input: true, depth: 0, calls: [], draw: true, readonly: RO, timers: gtimers };
  emit(`DEF FN gf(x) = x * GK + g1 MOD ${ri(r, 3, 9)}`);
  emit('PROC GP(n)');
  for (const l of block({ ...gctx, depth: 1 }, 1, ri(r, 1, 3))) emit(l);
  emit(`    IF (g1 MOD ${ri(r, 5, 12)} = ${ri(r, 0, 2)}) AND (${ex({ ...gctx, nums: [...gnums, 'n'] }, 1)} > ${ri(r, 0, 30)}) THEN ENTER ${pick(r, names)} ENDIF`);
  for (const l of block({ ...gctx, depth: 1 }, 1, ri(r, 0, 2))) emit(l);
  emit('ENDP');

  for (let si = 0; si < ns; si++) {
    const nm = names[si];
    const hasW = r() < 0.5, arrInit = r() < 0.6, arr2 = r() < 0.4, twoT = r() < 0.5;
    const stimers = twoT ? ['ts', 'tu'] : ['ts'];
    emit(`SCENE ${nm}`);
    emit(`  TIMER ${stimers.join(', ')}`);
    emit(`  DIM t, u${hasW ? ', w' : ''}`);
    emit(`  DIM arr(3)${arrInit ? ` = ${ri(r, 0, 9)}, ${ri(r, 0, 9)}, ${ri(r, 0, 9)}, ${ri(r, 0, 9)}` : ''}`);
    if (arr2) emit(`  DIM bb(7)${r() < 0.5 ? ` = ${Array.from({ length: ri(r, 2, 8) }, () => ri(r, 0, 20)).join(', ')}` : ''}`);
    emit(`  CONST K = ${ri(r, 1, 9)}`);
    const nums = ['t', 'u', ...(hasW ? ['w'] : []), ...gnums, ...stimers];
    const arrs = [{ name: 'arr', mask: 3 }, { name: 'ga', mask: 3 }, ...(arr2 ? [{ name: 'bb', mask: 7 }] : [])];
    const timers = [...stimers, ...gtimers];
    const sctx = { nums, arrs, fns: ['fa', 'gf'], consts: ['K', 'GK'], rnd: true, input: true, depth: 0, calls: [], draw: true, readonly: RO, timers };
    emit(`  DEF FN fa(x) = x * K + t + ${ri(r, 0, 9)}`);
    emit('  PROC INIT()');
    emit('    g2 = g2 + 1');
    for (const l of block({ ...sctx, calls: ['UPDATE'] }, 2, ri(r, 0, 4))) emit(l);
    if (r() < 0.45) { const m = ri(r, 3, 7); emit(`    IF g2 MOD ${m} < ${ri(r, 1, m - 1)} THEN ENTER ${pick(r, names)} ENDIF`); }
    for (const l of block({ ...sctx, calls: ['UPDATE'] }, 2, ri(r, 0, 2))) emit(l);
    emit('  ENDP');
    emit('  PROC UPDATE()');
    for (const l of block({ ...sctx, depth: 1 }, 2, ri(r, 1, 4))) emit(l);
    emit('  ENDP');
    const nn = [...nums, 'n'];
    emit('  PROC L3(n)');
    for (const l of block({ ...sctx, nums: nn, depth: 1 }, 2, ri(r, 0, 2))) emit(l);
    emit(`    IF ${enterCond({ ...sctx, nums: nn })} THEN ENTER ${pick(r, names)} ENDIF`);
    for (const l of block({ ...sctx, nums: nn, depth: 1 }, 2, ri(r, 1, 3))) emit(l);
    emit('  ENDP');
    emit('  PROC L2(n)');
    for (const l of block({ ...sctx, nums: nn, depth: 1 }, 2, ri(r, 0, 2))) emit(l);
    if (r() < 0.8) emit(`    CALL L3(${ex({ ...sctx, nums: nn }, 1)})`);
    else emit(`    IF ${cond({ ...sctx, nums: nn })} THEN\n      CALL L3(n)\n    ELSE\n      u = u + 1\n    ENDIF`);
    emit('    u = u + 3');
    for (const l of block({ ...sctx, nums: nn, depth: 1 }, 2, ri(r, 0, 2))) emit(l);
    emit('  ENDP');
    emit('  PROC L1(n)');
    for (const l of block({ ...sctx, nums: nn, depth: 1 }, 2, ri(r, 0, 2))) emit(l);
    if (r() < 0.3) emit(`    FOR i = 0 TO ${ri(r, 1, 3)}\n      CALL L2(i + n)\n    NEXT i`);
    else emit(`    CALL L2(${ex({ ...sctx, nums: nn }, 1)})`);
    emit(`    ${hasW ? 'w' : 'u'} = ${hasW ? 'w' : 'u'} + 1`);
    for (const l of block({ ...sctx, nums: nn, depth: 1 }, 2, ri(r, 0, 2))) emit(l);
    emit('  ENDP');
    emit('  PROC FRAME()');
    emit('    t = t + 1 : g1 = g1 + 1');
    for (const l of block({ ...sctx, calls: ['UPDATE', 'L1', 'L1'] }, 2, ri(r, 1, 4))) emit(l);
    emit(`    CALL L1(${ex(sctx, 1)})`);
    emit('    CALL UPDATE()');
    emit(`    CALL GP(${ex(sctx, 1)})`);
    for (const l of block({ ...sctx, calls: ['UPDATE'] }, 2, ri(r, 0, 2))) emit(l);
    emit(`    IF t >= ${ri(r, 3, 12)} THEN ENTER ${r() < 0.2 ? nm : pick(r, names)} ENDIF`);
    emit('  ENDP');
    emit('ENDSCENE');
  }
  const kseed = ri(r, 0, 1000);
  return {
    src: L.join('\n') + '\n', seed, scenes: names, rate,
    // a key is held in runs (so there are edges AND holds); stick masks never have all four directions (STICK reads 0 then on v2)
    keys: (t0) => {
      const t = Math.max(1, t0), o = [];
      if ((t + kseed) % 11 < 4) o.push(79);
      if ((t * 3 + kseed) % 7 < 3) o.push(80);
      if ((t * 7 + kseed) % 9 < 2) o.push(81);
      if ((t * 5 + kseed) % 13 < 3) o.push(65);
      if ((t + kseed) % 17 === 0) o.push(32);
      return o;
    },
    stick: (t0) => {
      const t = Math.max(1, t0);
      const m1 = ((t * 11 + kseed) % 7 < 2 ? 16 : 0) | ((t * 3 + kseed) % 5 === 0 ? 8 : 0) | ((t + kseed) % 6 === 0 ? 4 : 0) | ((t + 2 * kseed) % 9 < 2 ? 1 : 0);
      const m2 = ((t * 5 + kseed) % 8 < 3 ? 16 : 0) | ((t + kseed) % 4 === 0 ? 2 : 0) | ((t * 2 + kseed) % 7 === 0 ? 4 : 0) | ((t + kseed) % 10 < 2 ? 1 : 0);
      return { 1: m1, 2: m2 };
    },
  };
}

// ── hand-written programs (v2), each with the values worked out BY HAND from the contract ────────────────────────────────────────────
const H10 = (body, rate = 12) => `GAME "h"\nFRAMERATE ${rate}\n${HEAD_ASSETS}${body}`;
const runs = (...pairs) => { const a = []; for (const [v, n] of pairs) for (let i = 0; i < n; i++) a.push(v); return a; };
const keyScript = (a) => (t) => (a[Math.max(1, t) - 1] ? [79] : []);
const stickScript = (a1, a2 = []) => (t) => ({ 1: a1[Math.max(1, t) - 1] | 0, 2: a2[Math.max(1, t) - 1] | 0 });

/**
 * name -> {src, ticks, keys, stick, series: {VARKEY: [value after tick 1, 2, ...]}, scene: [index after each tick] | undefined, rows: [{tick, row, want}], vis: [{tick, sprite, visible}], sfx: [...]}.
 * `series` keys are the record keys (game level plain, scene level SCENE.NAME).
 */
export const HAND10 = {
  // 1 / 2: a timer is a variable the game counts down by itself before FRAME: assigned 3 in INIT (INIT never counts), 0 stays, a value assigned in FRAME at tick k reads n - 1 at k + 1 and 0 from k + n,
  //        a negative value stays, 1 gives 0 at the next FRAME, 0 stays 0
  timer: {
    src: H10(`TIMER cd
DIM n, saw, s2
SCENE s
  PROC INIT()
    cd = 3
    s2 = cd
  ENDP
  PROC FRAME()
    n = n + 1
    saw = cd
    IF n = 6 THEN cd = 4 ENDIF
    IF n = 12 THEN cd = -5 ENDIF
    IF n = 14 THEN cd = 1 ENDIF
    IF n = 16 THEN cd = 0 ENDIF
  ENDP
ENDSCENE
`),
    ticks: 17, keys: () => [], stick: () => ({}),
    series: {
      SAW: [2, 1, 0, 0, 0, 0, 3, 2, 1, 0, 0, 0, -5, -5, 0, 0, 0],
      CD: [2, 1, 0, 0, 0, 4, 3, 2, 1, 0, 0, -5, -5, 1, 0, 0, 0],
      S2: Array(17).fill(3),
      N: Array.from({ length: 17 }, (_, i) => i + 1),
    },
  },
  // 2: game timers count in every scene and keep their value across ENTER, scene timers are zeroed on entry (INIT then sets them, uncounted) and count only in their scene; the same name in two scenes
  timerScenes: {
    src: H10(`TIMER gt
DIM n, log
SCENE a
  TIMER tm
  DIM seena
  PROC INIT()
    tm = 5
    log = log * 10 + 1
  ENDP
  PROC FRAME()
    n = n + 1
    seena = tm
    IF n = 1 THEN gt = 10 ENDIF
    IF n = 3 THEN ENTER b ENDIF
  ENDP
ENDSCENE
SCENE b
  TIMER tm, tb
  PROC INIT()
    tm = 4
    tb = 2
    log = log * 10 + 2
  ENDP
  PROC FRAME()
    n = n + 1
    IF n = 6 THEN ENTER a ENDIF
  ENDP
ENDSCENE
`),
    ticks: 12, keys: () => [], stick: () => ({}),
    series: {
      'A.TM': [4, 3, 2, 2, 2, 5, 4, 3, 2, 1, 0, 0],
      'B.TM': [0, 0, 4, 3, 2, 1, 1, 1, 1, 1, 1, 1],
      'B.TB': [0, 0, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0],
      'A.SEENA': [4, 3, 2, 2, 2, 0, 4, 3, 2, 1, 0, 0],
      GT: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0],
      N: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      LOG: [1, 1, 12, 12, 12, 121, 121, 121, 121, 121, 121, 121],
    },
    scene: [0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0],
  },
  // 5 / 6: KEYPRESS is 1 for the tick in which the key went down; held from boot = a press in tick 1; one edge per press; the same value every time it is read in a tick ("O", 79 and "o" are one key);
  //        INIT reads the last snapshot (0 at boot; at a switch the edge of that very tick); ENTER does not touch the edge state: a key held through a switch gives no second edge.
  //        keys down at ticks 1 2 | 5 6 | 8 9 | 11 ...: edges at 1, 5, 8, 11
  keypress: {
    src: H10(`DIM n, p, q, sum2, presses, i0
SCENE a
  PROC INIT()
    i0 = i0 * 10 + KEYPRESS("O")
  ENDP
  PROC FRAME()
    n = n + 1
    p = KEYPRESS("O")
    q = KEYPRESS(79)
    sum2 = KEYPRESS("O") + KEYPRESS("o")
    presses = presses + p
    IF n = 3 THEN ENTER b ENDIF
    IF n = 8 THEN ENTER b ENDIF
  ENDP
ENDSCENE
SCENE b
  DIM bp, binit
  PROC INIT()
    binit = KEYPRESS("O")
  ENDP
  PROC FRAME()
    n = n + 1
    bp = KEYPRESS("O")
    presses = presses + bp
    IF n = 5 THEN ENTER a ENDIF
  ENDP
ENDSCENE
`),
    ticks: 11, keys: keyScript(runs([1, 2], [0, 2], [1, 2], [0, 1], [1, 2], [0, 1], [1, 20])), stick: () => ({}),
    series: {
      N: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      P: [1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
      Q: [1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
      SUM2: [2, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2],
      PRESSES: [1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 4],
      I0: [0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1],
      'B.BP': [0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 1],
      'B.BINIT': [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1],
    },
    scene: [0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1],
  },
  // 5: JOYPRESS(n) is the mask of the STICK(n) bits that went down this tick (STICK(n) AND NOT the previous tick's value); BIT(JOYPRESS(1), 4) is a fresh fire press; the two sticks are independent
  //    stick 1: 16 24 8 0 17 4 20 0 0 16 -> edges 16 8 0 0 17 4 16 0 0 16;  stick 2: 0 1 1 3 2 0 1 17 17 16 -> edges 0 1 0 2 0 0 1 16 0 0
  joypress: {
    src: H10(`DIM n, e1, e2, f1, cnt
SCENE s
  PROC INIT()
  ENDP
  PROC FRAME()
    n = n + 1
    e1 = JOYPRESS(1)
    e2 = JOYPRESS(2)
    f1 = BIT(JOYPRESS(1), 4)
    IF BIT(JOYPRESS(2), 0) THEN cnt = cnt + 1 ENDIF
  ENDP
ENDSCENE
`),
    ticks: 12, keys: () => [],
    stick: stickScript([16, 24, 8, 0, 17, 4, 20, 0, 0, 16], [0, 1, 1, 3, 2, 0, 1, 17, 17, 16]),
    series: {
      E1: [16, 8, 0, 0, 17, 4, 16, 0, 0, 16, 0, 0],
      E2: [0, 1, 0, 2, 0, 0, 1, 16, 0, 0, 0, 0],
      F1: [1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0],
      CNT: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2],
    },
  },
  // 6: INIT of the new scene sees the edge of the tick in which the switch happened; ENTER does not touch the edge state; the same for a stick
  //    key 79 down at ticks 3 4 | 7 ...; fire (stick 1, 16) down at ticks 3 | 6 7; a -> b at tick 3 (FRAME of a runs n = 3 and enters), b -> a at tick 6, a -> b at tick 8
  switchEdge: {
    src: H10(`DIM n, ik, ij, fa, fb, ja, jb
SCENE a
  PROC INIT()
    ik = ik * 10 + KEYPRESS("O")
    ij = ij * 10 + BIT(JOYPRESS(1), 4)
  ENDP
  PROC FRAME()
    n = n + 1
    fa = fa * 10 + KEYPRESS("O")
    ja = ja * 10 + BIT(JOYPRESS(1), 4)
    IF n = 3 THEN ENTER b ENDIF
    IF n = 8 THEN ENTER b ENDIF
  ENDP
ENDSCENE
SCENE b
  PROC INIT()
    ik = ik * 10 + KEYPRESS("O")
    ij = ij * 10 + BIT(JOYPRESS(1), 4)
  ENDP
  PROC FRAME()
    n = n + 1
    fb = fb * 10 + KEYPRESS("O")
    jb = jb * 10 + BIT(JOYPRESS(1), 4)
    IF n = 6 THEN ENTER a ENDIF
  ENDP
ENDSCENE
`),
    ticks: 9,
    keys: keyScript([0, 0, 1, 1, 0, 0, 1, 1, 1]),
    stick: stickScript([0, 0, 16, 0, 0, 16, 16, 0, 0]),
    // INIT at boot: ik = 0, ij = 0. t1 a: key 0 joy 0 -> fa 0, ja 0. t2: fa 0 ja 0. t3: key goes down (edge 1), fire down (edge 1): fa 1 (0 * 10 + 1), ja 1, ENTER b: INIT b sees the edges: ik 01 = 1, ij 1.
    // t4 b: key still down (0), fire up: fb 0, jb 0. t5 b: key up, fire up: fb 0, jb 0. t6 b: key up, fire DOWN (edge 1): fb 0, jb 1; ENTER a: INIT a: ik = 1 * 10 + 0 = 10, ij = 1 * 10 + 1 = 11.
    // t7 a: key down (edge 1), fire still down (0): fa = 1 * 10 + 1 = 11, ja = 10. t8 a: key held (0), fire up: fa 110, ja 100; ENTER b (n = 8): INIT b: key edge 0, fire 0: ik = 100, ij = 110.
    // t9 b: n = 9: nothing; fb = 0 * 10 + 0 stays 0 (fb 0 -> 0), jb = 1 * 10 + 0 = 10.
    series: {
      N: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      IK: [0, 0, 1, 1, 1, 10, 10, 100, 100],
      IJ: [0, 0, 1, 1, 1, 11, 11, 110, 110],
      FA: [0, 0, 1, 1, 1, 1, 11, 110, 110],
      JA: [0, 0, 1, 1, 1, 1, 10, 100, 100],
      FB: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      JB: [0, 0, 0, 0, 0, 1, 1, 1, 10],
    },
    scene: [0, 0, 1, 1, 1, 0, 0, 1, 1],
  },
  // 11 / 12: PRINT ... USING: run-time values, literals (folded at build time), expression items, negative, overflow = asterisks, -32768, separators, wrap at the right edge
  using: {
    src: H10(`DIM a, b, c, d
SCENE s
  PROC INIT()
    a = 7 : b = -5 : c = 12345 : d = -32768
  ENDP
  PROC FRAME()
  PRINT AT 0, 0; a USING "0000"; ","; b USING "0000"; ","; c USING "0000"
  PRINT AT 1, 0; a USING "####"; "|"; b USING "####"; "|"; 12345 USING "####"
  PRINT AT 2, 0; a USING "##00"; "|"; (0 - a) USING "##00"; "|"; -7 USING "##00"
  PRINT AT 3, 0; 0 USING "#"; "|"; 10 USING "#"; "|"; (c - c) USING "#"; "|"; (c - c + 10) USING "#"
  PRINT AT 4, 0; d USING "########"; "|"; d USING "#####"; "|"; (d + 1) USING "######"
  PRINT AT 5, 0; a USING "00000000"; "|"; b USING "00000000"
  PRINT AT 6, 0; a USING "00", b USING "00"; c USING "#"
  PRINT AT 7, 30; a USING "000"
  PRINT AT 10, 30; 7 USING "000"
  PRINT AT 12, 0; (a + 3) USING "000"; "|"; a * 100 USING "00000"; "|"; a USING "#0#0"; "|"; b USING "0#"
  ENDP
ENDSCENE
`),
    ticks: 3, keys: () => [], stick: () => ({}),
    series: {},
    rows: [
      [0, '0007,-005,****'], [1, '   7|  -5|****'], [2, '  07| -07| -07'], [3, '0|*|0|*'], [4, '  -32768|*****|-32767'], [5, '00000007|-0000005'],
      [6, '07 -5*'], [7, ' '.repeat(30) + '00'], [8, '7'], [10, ' '.repeat(30) + '00'], [11, '7'], [12, '010|00700| 007|-5'],
    ],
  },
  // 1 + 11: a countdown on the screen: cd = 12 in INIT, FRAME prints it with USING and shows the ship once it is 0
  hud: {
    src: H10(`TIMER cd
DIM n
SCENE s
  PROC INIT()
    cd = 12
  ENDP
  PROC FRAME()
    n = n + 1
    PRINT AT 0, 0; cd USING "00"; " "; n USING "###"
    IF cd = 0 THEN SHOW ship AT n * 4, 40 ENDIF
  ENDP
ENDSCENE
`),
    ticks: 14, keys: () => [], stick: () => ({}),
    series: { CD: [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 0], N: Array.from({ length: 14 }, (_, i) => i + 1) },
    rows: [],
    rowsAt: [[1, 0, '11   1'], [5, 0, '07   5'], [11, 0, '01  11'], [12, 0, '00  12'], [14, 0, '00  14']],
    vis: [[11, false], [12, true], [14, true]],
  },
  // 15: PLAY by index (0 = the first SFX; short = 0 is 3 records, long = 1 is 300), by name, `PLAY (name)` for a variable with an SFX's name; out of range does nothing (does not even stop what plays)
  //   tick: 1 PLAY 1 | 4 SILENCE | 5 PLAY (snda = 0) | 8 PLAY (snda = 1) | 10 PLAY snda (the EFFECT, 0) | 12 PLAY (snda = 7): nothing | 13 PLAY 1 | 14 PLAY (-1): nothing, the long one plays on
  //   | 16 PLAY (257): nothing (not index 1) | 18 PLAY k - 18 = 0
  playidx: {
    src: H10(`DIM snda, k
SCENE s
  PROC INIT()
  ENDP
  PROC FRAME()
    k = k + 1
    IF k = 1 THEN PLAY 1 ENDIF
    IF k = 4 THEN SILENCE ENDIF
    IF k = 5 THEN snda = 0 : PLAY (snda) ENDIF
    IF k = 8 THEN snda = 1 : PLAY (snda) ENDIF
    IF k = 10 THEN PLAY snda ENDIF
    IF k = 12 THEN snda = 7 : PLAY (snda) ENDIF
    IF k = 13 THEN PLAY 1 ENDIF
    IF k = 14 THEN snda = -1 : PLAY (snda) ENDIF
    IF k = 16 THEN snda = 257 : PLAY (snda) ENDIF
    IF k = 18 THEN PLAY k - 18 ENDIF
  ENDP
ENDSCENE
`),
    ticks: 19, keys: () => [], stick: () => ({}),
    series: { K: Array.from({ length: 19 }, (_, i) => i + 1), SNDA: [0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 7, 7, -1, -1, 257, 257, 257, 257] },
    // V_SFX_ACTIVE after each tick on the machine (the long effect lasts 60 ticks, the short one ends within the tick after it starts)
    sfxActive: [1, 1, 1, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, 0],
    // the effect index the interpreter reports after each tick (it keeps the last one started)
    sfxIndex: [1, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0],
  },
};

// ── v3 and v4 spot programs ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** v3 template of tests/arcade-m9-common.mjs genV3 with a game timer, a scene timer, KEYPRESS / JOYPRESS and USING added. */
export function genV3x(seed) {
  const r = rng(seed * 92821 + 3);
  const n1 = ri(r, 3, 9), n2 = ri(r, 3, 7), n3 = ri(r, 2, 5);
  const camStep = ri(r, 1, 12);
  const pat = pick(r, ['000', '###', '#0#0', '##00', '0']);
  const src = `GAME "v3m10x${seed}"
FRAMERATE 20
TILESET ts = "ts"
MAP level = "lv"
SPRITE g(3) = "guard"
SPRITE b = "big"
SFX snda = "short"
SFX sndb = "long"
TIMER cool
DIM score, laps
WINDOW level
SCENE title
  TIMER blink
  DIM t
  PROC INIT()
    PRINT AT 10, 10; "TITLE"
    blink = ${ri(r, 2, 6)}
    cool = ${ri(r, 3, 12)}
  ENDP
  PROC FRAME()
    t = t + 1
    SHOW g(0) AT t * 4, 60 FRAME t MOD 3
    PRINT AT 12, 8; blink USING "00"; " "; cool USING "##"
    IF KEYPRESS("O") OR BIT(JOYPRESS(1), 4) THEN blink = 5 ENDIF
    IF t >= ${n1} THEN ENTER play ENDIF
  ENDP
ENDSCENE
SCENE play
  TIMER shot
  DIM t, x
  PROC INIT()
    laps = laps + 1
    x = ${ri(r, 0, 100)}
    shot = 4
  ENDP
  PROC FRAME()
    t = t + 1
    IF t < ${n2} THEN
      x = x + ${camStep} + JOYPRESS(2)
      CAMERA x
      IF KEYPRESS("P") THEN shot = 6 : PLAY laps MOD 2 ENDIF
      IF shot = 0 THEN score = score + 1 : shot = 3 ENDIF
      SHOW g(t MOD 3) AT x MOD 200, 90 FRAME t MOD 3
      score = score + WORLDTILE(x + 16, 120) + KEYPRESS("O")
      PRINT AT 0, 0; score USING "${pat}"; " "; shot USING "0"; " "; cool USING "0"
    ELSE
      ENTER over
    ENDIF
  ENDP
ENDSCENE
SCENE over
  DIM t
  PROC INIT()
    PRINT AT 8, 4; "OVER"; score USING "#####"
  ENDP
  PROC FRAME()
    t = t + 1
    SHOW g(2) AT t * 8, 70 FRAME 1
    IF t >= ${n3} THEN ENTER ${pick(r, ['play', 'play', 'title'])} ENDIF
  ENDP
ENDSCENE
`;
  const kseed = ri(r, 0, 100);
  return {
    src, ticks: 60,
    keys: (t) => { const o = []; if ((Math.max(1, t) + kseed) % 8 < 3) o.push(79); if ((Math.max(1, t) * 3 + kseed) % 7 < 2) o.push(80); return o; },
    stick: (t) => ({ 1: ((t + kseed) % 6 < 2 ? 16 : 0) | ((t + kseed) % 5 < 2 ? 8 : 0), 2: ((t * 2 + kseed) % 5 < 2 ? 1 : 0) | ((t + kseed) % 7 < 3 ? 16 : 0) }),
  };
}

/** v4 template of genV4 (the maze) with a timer, KEYPRESS / JOYPRESS and USING added. */
export function genV4x(seed) {
  const r = rng(seed * 130363 + 11);
  const n1 = ri(r, 3, 9), n2 = ri(r, 3, 6);
  const src = `GAME "v4m10x${seed}"
FRAMERATE 12
TILESET ts = "ts"
MAP level = "maze"
SPRITE g(3) = "guard"
SPRITE o = "orb"
SFX snda = "short"
SFX sndb = "long"
TIMER hurt
DIM px, py, pa, hp
VIEW3D level COLW 4 INK 7 CEIL 1 FLOOR ${ri(r, 1, 6)}
SCENE walk
  TIMER stp
  DIM t
  PROC INIT()
    px = ${ri(r, 3, 9) * 256 + 128} : py = ${ri(r, 3, 9) * 256 + 128} : pa = ${ri(r, 0, 255)}
    VIEW px, py, pa
    stp = 3
  ENDP
  PROC FRAME()
    t = t + 1
    IF t < ${n1} THEN
      pa = pa + ${ri(r, 1, 9)} + 4 * KEYPRESS("O")
      px = px + FXMUL(COSA(pa), ${ri(r, 10, 60)})
      py = py + FXMUL(SINA(pa), 30)
      IF WALL(px, py) = 0 THEN VIEW px, py, pa ELSE hurt = 4 ENDIF
      IF stp = 0 THEN hp = hp + 1 : stp = 2 ENDIF
      IF BIT(JOYPRESS(1), 4) THEN PLAY 1 - t MOD 2 ENDIF
      SHOW g(t MOD 3) AT px + t * 40, py + 100 FRAME t MOD 3
      PRINT AT 1, 1; hp USING "000"; " "; hurt USING "0"; " "; stp USING "0"
    ELSE
      ENTER dead
    ENDIF
  ENDP
ENDSCENE
SCENE dead
  DIM t
  PROC INIT()
    PRINT AT 2, 2; "DEAD"; hp USING "##00"
    hp = hp + 1000
  ENDP
  PROC FRAME()
    t = t + 1
    SHOW o AT t * 20, 300
    IF KEYPRESS(80) THEN hurt = 9 ENDIF
    IF t >= ${n2} THEN ENTER walk ENDIF
  ENDP
ENDSCENE
`;
  const kseed = ri(r, 0, 100);
  return {
    src, ticks: 60,
    keys: (t) => { const o = []; if ((Math.max(1, t) + kseed) % 9 < 3) o.push(79); if ((Math.max(1, t) * 3 + kseed) % 7 < 3) o.push(80); return o; },
    stick: (t) => ({ 1: (t + kseed) % 5 < 2 ? 16 : 0, 2: (t + kseed) % 4 === 0 ? 2 : 0 }),
  };
}

// ── USING sweeps ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const fieldLayout = (w) => { const cpr = Math.floor(32 / (w + 1)); return { cpr, rows: Math.ceil(64 / cpr) }; };
/**
 * 64 run-time values a tick through `x USING pat`, each in its own field of the 32 x 24 screen: field i at row i DIV cpr, column (i MOD cpr) * (w + 1).
 * opts.accumulate: the first value of tick t is -32768 + 64 * (t - 1) (the whole 16-bit range in 1024 ticks); opts.bases: an array of start values, tick t starts at bases[(t - 1) % length]
 * (read from a DIM array initialised with them, so the values are computed by the machine, not stored as text).
 * Returns {src, ticks, expect(t) -> [64 strings], w, cpr}.
 */
export function sweepProgram(pat, { accumulate = false, bases = null, rate = 12 } = {}) {
  const w = pat.length, { cpr } = fieldLayout(w);
  const body = (base) => `    FOR i = 0 TO 63
      x = ${base} + i
      PRINT AT i DIV ${cpr}, (i MOD ${cpr}) * ${w + 1}; x USING "${pat}"
    NEXT i
`;
  let src;
  if (accumulate) {
    src = `GAME "sweep"\nFRAMERATE ${rate}\nDIM b, x\nSCENE s\n  PROC INIT()\n    b = -32768\n  ENDP\n  PROC FRAME()\n${body('b')}    b = b + 64\n  ENDP\nENDSCENE\n`;
  } else {
    src = `GAME "sweep"\nFRAMERATE ${rate}\nDIM k, x\nDIM bs(${bases.length - 1}) = ${bases.join(', ')}\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n${body(`bs(k MOD ${bases.length})`)}    k = k + 1\n  ENDP\nENDSCENE\n`;
  }
  const wrap = (v) => ((v + 32768) & 0xFFFF) - 32768;
  const first = (t) => (accumulate ? wrap(-32768 + 64 * (t - 1)) : bases[(t - 1) % bases.length]);
  return {
    src, w, cpr, first,
    values: (t) => Array.from({ length: 64 }, (_, i) => wrap(first(t) + i)),
    expect: (t) => Array.from({ length: 64 }, (_, i) => modelUsing(wrap(first(t) + i), pat)),
    cellsAt: (i) => ({ row: Math.floor(i / cpr), col: (i % cpr) * (w + 1) }),
  };
}

/** start values for the table sweep: the boundaries of every pattern (digit counts 1 to 5, +-, 0, -32768, 32767) minus 20 so that each 64-value window straddles them, then pseudo-random ones */
export function sweepBases(seed, n) {
  const r = rng(seed);
  const edge = [-32768, -32768 + 40, -10000, -9999, -1000, -999, -100, -99, -10, -9, 0, 9, 10, 99, 100, 999, 1000, 9999, 10000, 12345, 32700, 32704, 255, 256, 65535 - 65536];
  const out = edge.map((v) => v - 20).map((v) => ((v + 32768) & 0xFFFF) - 32768);
  while (out.length < n) out.push(ri(r, -32768, 32767));
  return out.slice(0, n);
}

/**
 * Each value as a LITERAL item (the build-time path): one PRINT per value in INIT, each in its own field laid out like sweepProgram. Literals above 32767 wrap (a positive literal may be written
 * up to 65535, the checker says so), so values are given signed and written as `-n USING` for negatives. Returns {src, values, expect: [strings], cellsAt(i)}.
 */
export function foldProgram(pat, values) {
  const w = pat.length, { cpr } = fieldLayout(w);
  const lines = values.map((v, i) => `  PRINT AT ${Math.floor(i / cpr)}, ${(i % cpr) * (w + 1)}; ${v < 0 ? '-' + (-v) : v} USING "${pat}"`);
  return {
    src: `GAME "fold"\nFRAMERATE 12\nSCENE s\n  PROC INIT()\n${lines.join('\n')}\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n`,
    values, w, cpr,
    expect: values.map((v) => modelUsing(v, pat)),
    cellsAt: (i) => ({ row: Math.floor(i / cpr), col: (i % cpr) * (w + 1) }),
  };
}
