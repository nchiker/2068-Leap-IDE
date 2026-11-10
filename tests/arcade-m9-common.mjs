"use strict";
// arcade-m9-common.mjs -- shared by tests/arcade-m9-compiler.mjs and tests/arcade-m9-differential.mjs (language batch 4: scenes in the compiler, docs/ARCADE_LANGUAGE_BATCH4.md).
//   rng(seed), pick(r, list), ri(r, lo, hi)     seeded PRNG and helpers
//   ASSETS                                      sprites (orb 16x16, dot 8x8, guard 16x16 with 3 frames for v3 / v4, big 32x16), a tileset, screen maps (m1, m2), a window world (lv), a
//                                               3D floor plan (maze), two sfx (short, long)
//   sceneKeys(src)                              the report keys the contract (section 4.4) gives the variables, arrays, PROCs and DEF FNs of a source: {multi, scenes, vars, arrays, procs, fns}
//   genProgram(seed, opts)                      a random scene program from a grammar (2-4 scenes, or opts.scenes = 1 with opts.enter = false for the grammar self-check): {src, seed, scenes, keys(t), stick(t)}
//   genV3(seed) / genV4(seed)                   template variants for the v3 (WINDOW, frames) and v4 (VIEW3D) runtimes: {src, ticks, stick(t), keys(t), assets}
//   HAND                                        the sources of the hand-written differential programs (one per rule of contract sections 2 and 3)

export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const pick = (r, list) => list[Math.floor(r() * list.length)];
export const ri = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

// ── assets ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const fullSprite = (w, h, odd = 'A', even = '5') => ({ w, h, rows: Array.from({ length: h }, (_, y) => ({ bits: (y & 1 ? odd : even).repeat(w / 4), mask: 'F'.repeat(w / 4) })) });
const mkTile = (i) => ({ flags: i === 1 ? 1 : 0, rows: Array.from({ length: 8 }, (_, y) => ({ bits: ((0x81 << (y & 1)) ^ (i * 0x11)) & 0xFF, ink: (i + 1) % 8, paper: (i * 3) % 8, bright: i % 2 })) });
const MAZE = ['111111111111', '1..........1', '1.22..4444.1', '1.2.......11', '1.2..33..3.1', '1....3.....1', '1.44.3.2...1', '1....3.2.4.1', '1.11...2.4.1', '1.......3..1', '1..44......1', '111111111111'];
/** a window world: columns w, 16 rows; ground at the bottom with pits, a few platforms */
function makeWorld(w, h) {
  const cells = new Array(w * h).fill(0);
  const set = (c, r, t) => { if (c >= 0 && c < w && r >= 0 && r < h) cells[r * w + c] = t; };
  for (let c = 0; c < w; c++) { if (!(c % 11 >= 8 && c % 11 <= 9)) { set(c, h - 1, 1); set(c, h - 2, 1); } if (c % 7 === 3) set(c, h - 5, 4); }
  for (let r = 0; r < h; r++) { set(0, r, 1); set(w - 1, r, 1); }
  return { w, h, cells };
}
export const ASSETS = {
  sprites: {
    orb: fullSprite(16, 16),
    dot: fullSprite(8, 8, 'F', 'F'),
    guard: { w: 16, h: 16, frames: [0, 1, 2].map((f) => ({ rows: Array.from({ length: 16 }, () => ({ bits: (0xFFFF >> f) & 0xFFFF, mask: 'FFFF' })) })) },
    big: fullSprite(32, 16),
  },
  tilesets: { ts: { tiles: Array.from({ length: 6 }, (_, i) => mkTile(i)) } },
  sfx: {
    short: { ticks: [{ tone: 200, vol: 8, noise: 0, mix: 6 }, { tone: 300, vol: 6, noise: 0, mix: 6 }, { tone: 400, vol: 4, noise: 0, mix: 6 }] },
    long: { ticks: Array.from({ length: 300 }, (_, i) => ({ tone: 100 + (i % 20) * 10, vol: 7, noise: 0, mix: 6 })) },
  },
  maps: {
    m1: { w: 5, h: 4, cells: Array.from({ length: 20 }, (_, i) => (i % 3 === 0 ? -1 : i % 6)) },
    m2: { w: 12, h: 3, cells: Array.from({ length: 36 }, (_, i) => (i * 5) % 6) },
    lv: makeWorld(48, 16),
    maze: { w: 12, h: 12, cells: MAZE.flatMap((r) => [...r].map((ch) => (ch === '.' ? 0 : Number(ch)))) },
  },
};

// ── report keys (contract section 4.4), read off the parser's AST ────────────────────────────────────────────────────────────────
/**
 * What a program's reports must be keyed by: in a game with MORE THAN ONE scene a scene's variables, arrays, PROCs and DEF FNs are `SCENE.NAME` (upper case), game-level names
 * stay plain; with one scene every name stays plain. CONSTs are not reported. Returns {multi, scenes: [NAME], vars: [keys], arrays: [keys], procs: [keys], fns: [keys]}.
 */
export function sceneKeys(src, parseFn) {
  const ast = parseFn(src).ast;
  const multi = (ast.scenes ?? []).length > 1;
  const out = { multi, scenes: (ast.scenes ?? []).map((s) => s.name.toUpperCase()), vars: [], arrays: [], procs: [], fns: [] };
  const level = (node, prefix) => {
    const pre = multi && prefix ? `${prefix}.` : '';
    for (const d of node.decls ?? []) {
      if (d.type === 'Dim') for (const it of d.items ?? []) (it.dims ? out.arrays : out.vars).push(pre + it.name.toUpperCase());
      else if (d.type === 'DefFn') out.fns.push(pre + d.name.toUpperCase());
    }
    for (const p of node.procs ?? []) out.procs.push(pre + p.name.toUpperCase());
  };
  level(ast, null);
  for (const s of ast.scenes ?? []) level(s, s.name.toUpperCase());
  return out;
}

// ── the random scene program generator ───────────────────────────────────────────────────────────────────────────────────────────
const HEAD_ASSETS = 'TILESET ts = "ts"\nMAP ma = "m1"\nMAP mb = "m2"\nSFX snda = "short"\nSFX sndb = "long"\nSPRITE ship = "orb"\nSPRITE rock(4) = "dot"\n';

/**
 * A grammar-based random program. Scenes sa, sb, sc, sd (2 to 4), all with the SAME names (DIM t, u, [w], arr(3); CONST K; DEF FN fa; PROC UPDATE L1 L2 L3) and different bodies and initialisers;
 * game level: DIM g1 g2 g3, DIM ga(3) = ..., CONST GK, DEF FN gf, PROC GP. Statements: assignments (also to array elements), IF / ELSE, FOR, CALL (nested PROCs three deep), SHOW / HIDE
 * of the ship and the pool of four rocks, PRINT AT with INK / PAPER / BRIGHT, TILE, FILL, FILLC, CLS, LOADMAP, PLAY / SILENCE, BORDER, RANDOMISE n, RND, STICK, KEYDOWN. ENTER appears
 *   - at the end of every FRAME (`IF t >= N THEN ENTER x ENDIF`, x any scene, also the scene itself: a restart),
 *   - in the leaf of the PROC chain L1 -> L2 -> L3 (and in the game-level PROC GP), under conditions on the tick counters, the key states and RND, with statements AFTER the CALL at every level,
 *   - in INIT, guarded by the game variable g2 that every INIT increments (`IF g2 MOD m < th THEN ENTER x ENDIF`, th < m, so a chain of INITs always ends).
 * opts: {scenes: n (default 2..4), enter: false (no ENTER at all: the grammar self-check on the existing single-scene code)}.
 */
export function genProgram(seed, opts = {}) {
  const r = rng(seed * 7919 + 13);
  const ns = opts.scenes ?? ri(r, 2, 4);
  const withEnter = opts.enter !== false;
  const names = ['sa', 'sb', 'sc', 'sd'].slice(0, ns);
  const rate = pick(r, [20, 15, 12]);
  const L = [];
  const emit = (s = '') => L.push(s);

  // ---- expression / statement grammar over a context ----
  // ctx: {nums: [names], arrs: [{name, mask}], fns: [names], consts: [names], rnd, input}
  const lit = (lo = 0, hi = 40) => String(ri(r, lo, hi));
  const ex = (c, d = 0) => {
    const k = ri(r, 0, d >= 2 ? 3 : 11);
    switch (k) {
      case 0: return lit(0, 60);
      case 1: case 2: return pick(r, c.nums);
      case 3: return c.consts.length && r() < 0.5 ? pick(r, c.consts) : pick(r, c.nums);
      case 4: { const a = pick(r, c.arrs); return a ? `${a.name}(BAND(${ex(c, d + 1)}, ${a.mask}))` : lit(); }
      case 5: case 6: return `(${ex(c, d + 1)} ${pick(r, ['+', '-', '*'])} ${ex(c, d + 1)})`;
      case 7: return `(${ex(c, d + 1)} ${pick(r, ['MOD', 'DIV'])} ${ri(r, 1, 9)})`;
      case 8: return c.rnd ? `RND(${ri(r, 2, 50)})` : lit();
      case 9: return c.fns.length ? `FN ${pick(r, c.fns)}(${ex(c, d + 1)})` : `ABS(${ex(c, d + 1)})`;
      case 10: return c.input ? pick(r, [`BIT(STICK(1), ${ri(r, 0, 4)})`, `KEYDOWN(${pick(r, [81, 65, 79, 80, 32])})`, 'STICK(1)']) : `ABS(${ex(c, d + 1)})`;
      default: return `BAND(${ex(c, d + 1)}, ${pick(r, [3, 7, 15, 31, 63])})`;
    }
  };
  const cond = (c, d = 0) => {
    const k = ri(r, 0, d >= 1 ? 2 : 5);
    const rel = () => `${ex(c, 1)} ${pick(r, ['=', '<>', '<', '>', '<=', '>='])} ${ex(c, 1)}`;
    if (k <= 2) return rel();
    if (k === 3) return `${cond(c, d + 1)} ${pick(r, ['AND', 'OR'])} ${cond(c, d + 1)}`;
    if (k === 4) return c.input ? pick(r, [`BIT(STICK(1), ${ri(r, 0, 4)})`, `KEYDOWN(${pick(r, [81, 65, 79, 80, 32])})`]) : rel();
    return `NOT (${rel()})`;
  };
  const ind = (n) => '    '.repeat(n);
  /** statements; c.depth = nesting depth for the indent and the recursion limit; c.calls = PROCs this one may CALL (acyclic); c.sprites / c.draw: what it may touch */
  const stmt = (c, n) => {
    const out = [];
    const I = ind(n);
    const target = () => pick(r, c.nums.filter((v) => !c.readonly?.includes(v)));
    const wts = [
      ['assign', 7], ['arr', 3], ['if', c.depth < 2 ? 3 : 0], ['for', c.depth < 2 ? 1.5 : 0], ['call', c.calls.length ? 3 : 0],
      ['show', c.draw ? 3 : 0], ['hide', c.draw ? 2 : 0], ['print', c.draw ? 3 : 0], ['color', c.draw ? 1.5 : 0], ['tile', c.draw ? 2.5 : 0], ['fill', c.draw ? 1.5 : 0], ['cls', c.draw ? 0.4 : 0],
      ['loadmap', c.draw ? 0.6 : 0], ['play', c.draw ? 1.5 : 0], ['border', c.draw ? 1 : 0], ['randomise', 0.3],
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
        const cc = { ...c, depth: c.depth + 1, nums: [...c.nums, v], readonly: [...(c.readonly ?? []), v], forVars: [...(c.forVars ?? []), v] };
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
      case 'color': out.push(`${I}${pick(r, [`INK ${ri(r, 0, 7)}`, `PAPER ${ri(r, 0, 7)}`, `BRIGHT ${ri(r, 0, 1)}`, `INK ${ri(r, 0, 7)} : PAPER ${ri(r, 0, 7)} : BRIGHT ${ri(r, 0, 1)}`])}`); break;
      case 'tile': out.push(r() < 0.5 ? `${I}TILE ${ri(r, 0, 31)}, ${ri(r, 0, 23)} = ${ri(r, 0, 5)}` : `${I}TILE BAND(${ex(c, 1)}, 31), BAND(${ex(c, 1)}, 15) + 2 = BAND(${ex(c, 1)}, 3)`); break;
      case 'fill': out.push(r() < 0.7 ? `${I}FILL ${ri(r, 0, 28)}, ${ri(r, 0, 20)}, ${ri(r, 1, 5)}, ${ri(r, 1, 4)} = ${ri(r, 0, 5)}` : `${I}FILLC ${ri(r, 0, 28)}, ${ri(r, 0, 20)}, ${ri(r, 1, 6)}, ${ri(r, 1, 3)} = ${ri(r, 33, 90)}`); break;
      case 'cls': out.push(`${I}CLS`); break;
      case 'loadmap': out.push(`${I}LOADMAP ${pick(r, ['ma', 'mb'])} AT ${ri(r, 0, 20)}, ${ri(r, 0, 18)}`); break;
      case 'play': out.push(`${I}${pick(r, ['PLAY snda', 'PLAY sndb', 'PLAY sndb', 'SILENCE'])}`); break;
      case 'border': out.push(`${I}BORDER ${r() < 0.5 ? ri(r, 0, 7) : `BAND(${ex(c, 1)}, 7)`}`); break;
      case 'randomise': out.push(`${I}RANDOMISE ${ri(r, 1, 999)}`); break;
      default: break;
    }
    return out;
  };
  const block = (c, n, count) => { const o = []; for (let i = 0; i < count; i++) o.push(...stmt(c, n)); return o; };
  const enterCond = (c) => pick(r, [
    `t = ${ri(r, 1, 6)}`, `t MOD ${ri(r, 3, 7)} = ${ri(r, 0, 2)}`, `g1 MOD ${ri(r, 5, 11)} = ${ri(r, 0, 3)}`, `RND(${ri(r, 6, 14)}) = 0`, `KEYDOWN(81)`, `BIT(STICK(1), 4)`, `${ex(c, 1)} > ${ri(r, 20, 90)}`,
  ]);

  // ---- the program ----
  emit(`GAME "gen${seed}"`);
  emit(`FRAMERATE ${rate}`);
  for (const l of HEAD_ASSETS.trimEnd().split('\n')) emit(l);
  emit(`CONST GK = ${ri(r, 2, 9)}`);
  emit('DIM g1, g2, g3');
  emit(`DIM ga(3) = ${ri(r, 0, 9)}, ${ri(r, 0, 9)}, ${ri(r, 0, 9)}, ${ri(r, 0, 9)}`);
  const RO = ['g1', 'g2', 't'];       // the tick counters and the INIT guard are never assigned by the random statements (a chain of INITs must end)
  const gctx = { nums: ['g1', 'g2', 'g3'], arrs: [{ name: 'ga', mask: 3 }], fns: ['gf'], consts: ['GK'], rnd: true, input: true, depth: 0, calls: [], draw: true, readonly: RO };
  emit(`DEF FN gf(x) = x * GK + g1 MOD ${ri(r, 3, 9)}`);
  // game-level PROC GP: game names only; it may ENTER (called from FRAME context only)
  emit('PROC GP(n)');
  for (const l of block({ ...gctx, depth: 1 }, 1, ri(r, 1, 3))) emit(l);
  if (withEnter) emit(`    IF (g1 MOD ${ri(r, 5, 12)} = ${ri(r, 0, 2)}) AND (${ex({ ...gctx, nums: ['g1', 'g2', 'g3', 'n'] }, 1)} > ${ri(r, 0, 30)}) THEN ENTER ${pick(r, names)} ENDIF`);
  for (const l of block({ ...gctx, depth: 1 }, 1, ri(r, 0, 2))) emit(l);
  emit('ENDP');

  for (let si = 0; si < ns; si++) {
    const nm = names[si];
    const hasW = r() < 0.5;
    const arrInit = r() < 0.6;
    const arr2 = r() < 0.4;
    emit(`SCENE ${nm}`);
    emit(`  DIM t, u${hasW ? ', w' : ''}`);
    emit(`  DIM arr(3)${arrInit ? ` = ${ri(r, 0, 9)}, ${ri(r, 0, 9)}, ${ri(r, 0, 9)}, ${ri(r, 0, 9)}` : ''}`);
    if (arr2) emit(`  DIM bb(7)${r() < 0.5 ? ` = ${Array.from({ length: ri(r, 2, 8) }, () => ri(r, 0, 20)).join(', ')}` : ''}`);
    emit(`  CONST K = ${ri(r, 1, 9)}`);
    const nums = ['t', 'u', ...(hasW ? ['w'] : []), 'g1', 'g2', 'g3'];
    const arrs = [{ name: 'arr', mask: 3 }, { name: 'ga', mask: 3 }, ...(arr2 ? [{ name: 'bb', mask: 7 }] : [])];
    const sctx = { nums, arrs, fns: ['fa', 'gf'], consts: ['K', 'GK'], rnd: true, input: true, depth: 0, calls: [], draw: true, readonly: RO };
    emit(`  DEF FN fa(x) = x * K + t + ${ri(r, 0, 9)}`);
    // INIT (it may CALL UPDATE, which never enters; its own ENTER is guarded by g2, which every INIT increments)
    emit('  PROC INIT()');
    emit('    g2 = g2 + 1');
    for (const l of block({ ...sctx, calls: ['UPDATE'] }, 2, ri(r, 0, 4))) emit(l);
    if (withEnter && r() < 0.45) { const m = ri(r, 3, 7); emit(`    IF g2 MOD ${m} < ${ri(r, 1, m - 1)} THEN ENTER ${pick(r, names)} ENDIF`); }
    for (const l of block({ ...sctx, calls: ['UPDATE'] }, 2, ri(r, 0, 2))) emit(l);
    emit('  ENDP');
    emit('  PROC UPDATE()');
    for (const l of block({ ...sctx, depth: 1 }, 2, ri(r, 1, 4))) emit(l);
    emit('  ENDP');
    // L3 (leaf, may ENTER), L2 -> L3, L1 -> L2, each with statements AFTER its CALL
    emit('  PROC L3(n)');
    for (const l of block({ ...sctx, nums: [...nums, 'n'], depth: 1 }, 2, ri(r, 0, 2))) emit(l);
    if (withEnter) emit(`    IF ${enterCond({ ...sctx, nums: [...nums, 'n'] })} THEN ENTER ${pick(r, names)} ENDIF`);
    for (const l of block({ ...sctx, nums: [...nums, 'n'], depth: 1 }, 2, ri(r, 1, 3))) emit(l);
    emit('  ENDP');
    emit('  PROC L2(n)');
    for (const l of block({ ...sctx, nums: [...nums, 'n'], depth: 1 }, 2, ri(r, 0, 2))) emit(l);
    if (r() < 0.8) emit(`    CALL L3(${ex({ ...sctx, nums: [...nums, 'n'] }, 1)})`);
    else emit(`    IF ${cond({ ...sctx, nums: [...nums, 'n'] })} THEN\n      CALL L3(n)\n    ELSE\n      u = u + 1\n    ENDIF`);
    emit('    u = u + 3');
    for (const l of block({ ...sctx, nums: [...nums, 'n'], depth: 1 }, 2, ri(r, 0, 2))) emit(l);
    emit('  ENDP');
    emit('  PROC L1(n)');
    for (const l of block({ ...sctx, nums: [...nums, 'n'], depth: 1 }, 2, ri(r, 0, 2))) emit(l);
    if (r() < 0.3) emit(`    FOR i = 0 TO ${ri(r, 1, 3)}\n      CALL L2(i + n)\n    NEXT i`);
    else emit(`    CALL L2(${ex({ ...sctx, nums: [...nums, 'n'] }, 1)})`);
    emit(`    ${hasW ? 'w' : 'u'} = ${hasW ? 'w' : 'u'} + 1`);
    for (const l of block({ ...sctx, nums: [...nums, 'n'], depth: 1 }, 2, ri(r, 0, 2))) emit(l);
    emit('  ENDP');
    emit('  PROC FRAME()');
    emit('    t = t + 1 : g1 = g1 + 1');
    const calls = ['UPDATE', 'L1', 'L1'];
    for (const l of block({ ...sctx, calls }, 2, ri(r, 1, 4))) emit(l);
    emit(`    CALL L1(${ex(sctx, 1)})`);
    emit('    CALL UPDATE()');
    emit(`    CALL GP(${ex(sctx, 1)})`);
    for (const l of block({ ...sctx, calls: ['UPDATE'] }, 2, ri(r, 0, 2))) emit(l);
    if (withEnter) {
      const target = r() < 0.2 ? nm : pick(r, names);
      emit(`    IF t >= ${ri(r, 3, 12)} THEN ENTER ${target} ENDIF`);
    }
    emit('  ENDP');
    emit('ENDSCENE');
  }
  const src = L.join('\n') + '\n';
  const kseed = ri(r, 0, 1000);
  return {
    src, seed, scenes: names, rate,
    // INIT of the first scene runs at "tick 0" for the interpreter and while the harness holds the keys of tick 1: both must see the same input
    keys: (t0) => { const t = Math.max(1, t0); const o = []; if ((t * 7 + kseed) % 9 < 2) o.push(81); if ((t * 5 + kseed) % 13 < 3) o.push(65); if ((t + kseed) % 17 === 0) o.push(32); return o; },
    stick: (t0) => { const t = Math.max(1, t0); return ((t * 11 + kseed) % 7 < 2 ? 16 : 0) | ((t * 3 + kseed) % 5 === 0 ? 8 : 0) | ((t + kseed) % 6 === 0 ? 4 : 0); },
  };
}

// ── hand-written differential programs (v2) ──────────────────────────────────────────────────────────────────────────────────────
const H = (body, rate = 12) => `GAME "h"\nFRAMERATE ${rate}\n${HEAD_ASSETS}${body}`;
const FRAMEWRAP = (decl, init, frame) => `  ${decl}\n  PROC INIT()\n${init}\n  ENDP\n  PROC FRAME()\n${frame}\n  ENDP\n`;
export const HAND = {
  // 2.1 / 2.3 / 3 the machine after a switch: everything the first scene started from. Scene a makes a mess in INIT and FRAME and enters b at tick 3; b's INIT and FRAME are empty.
  reset: H(`DIM g
SCENE a
  DIM t
  PROC INIT()
    INK 3 : PAPER 1 : BRIGHT 1
    PRINT AT 5, 5; "hello"; 42
    SHOW ship AT 40, 50
    SHOW rock(2) AT 100, 90
    TILE 3, 3 = 2
    FILL 10, 10, 4, 3 = 4
    LOADMAP mb AT 8, 12
    BORDER 5
    PLAY sndb
  ENDP
  PROC FRAME()
    t = t + 1
    g = g + 7
    IF t = 3 THEN ENTER b ENDIF
    SHOW ship AT 40 + t * 3, 50
    PRINT AT 2, 2; "tick "; t
    BORDER t
    PLAY sndb
  ENDP
ENDSCENE
SCENE b
  DIM t
  PROC INIT()
  ENDP
  PROC FRAME()
    t = t + 1
    g = g + 1
  ENDP
ENDSCENE
`),
  // 4.3 scene variables zero and initialisers re-applied on EVERY entry (also a restart); game variables kept; two scenes with the same names
  vars: H(`DIM g, log
SCENE a
  DIM t, u, arr(3) = 5, 6, 7, 8
  PROC INIT()
    u = u + 100
    arr(1) = arr(1) + 1
    log = log * 10 + 1
  ENDP
  PROC FRAME()
    t = t + 1 : g = g + 1 : arr(0) = arr(0) + t
    IF t = 3 THEN ENTER b ENDIF
  ENDP
ENDSCENE
SCENE b
  DIM t, u, arr(3) = 9, 8
  PROC INIT()
    u = u + 200
    log = log * 10 + 2
  ENDP
  PROC FRAME()
    t = t + 1 : g = g + 10 : arr(2) = arr(2) + 2
    IF t = 2 THEN ENTER a ENDIF
    IF g > 60 THEN ENTER b ENDIF
  ENDP
ENDSCENE
`),
  // 2.2 ENTER from depth 3 abandons everything; ENTER of itself restarts; locals of the abandoned PROCs
  depth: H(`DIM g, h1, h2, h3, n
SCENE a
  DIM t
  PROC INIT()
    n = n + 1
  ENDP
  PROC L3(k)
    h3 = h3 + 1
    FOR i = 0 TO 5
      g = g + 1
      IF t = 3 AND i = 2 THEN ENTER b ENDIF
    NEXT i
    h3 = h3 + 1000
  ENDP
  PROC L2(k)
    CALL L3(k + 1)
    h2 = h2 + 1
  ENDP
  PROC L1(k)
    CALL L2(k + 1)
    h1 = h1 + 1
  ENDP
  PROC FRAME()
    t = t + 1
    CALL L1(t)
    g = g + 100
  ENDP
ENDSCENE
SCENE b
  DIM t
  PROC INIT()
    g = g * 2
  ENDP
  PROC FRAME()
    t = t + 1
    IF t = 2 THEN ENTER b ENDIF
    IF t = 4 THEN ENTER a ENDIF
  ENDP
ENDSCENE
`),
  // 2.4 / 2.6 INIT chain a -> b -> c at boot and later; the tick that switches draws what INIT made
  chain: H(`DIM log, g2
SCENE a
  DIM t
  PROC INIT()
    log = log * 10 + 1
    g2 = g2 + 1
    PRINT AT 1, 1; "A"
    IF g2 < 3 THEN ENTER b ENDIF
  ENDP
  PROC FRAME()
    t = t + 1
    IF t = 3 THEN ENTER b ENDIF
  ENDP
ENDSCENE
SCENE b
  DIM t
  PROC INIT()
    log = log * 10 + 2
    PRINT AT 3, 3; "B"
    ENTER c
  ENDP
  PROC FRAME()
    t = t + 1
  ENDP
ENDSCENE
SCENE c
  DIM t
  PROC INIT()
    log = log * 10 + 3
    PRINT AT 5, 5; "C"; log
  ENDP
  PROC FRAME()
    t = t + 1
    IF t = 2 THEN ENTER a ENDIF
  ENDP
ENDSCENE
`),
  // 3 RND continues (no re-seed), RANDOMISE n inside a scene, sound stopped by the switch and a new PLAY in the new INIT
  rnd: H(`DIM g, r1, r2, r3
SCENE a
  DIM t
  PROC INIT()
    r1 = RND(1000)
    PLAY sndb
  ENDP
  PROC FRAME()
    t = t + 1
    r2 = RND(1000)
    IF t = 2 THEN RANDOMISE 77 : ENTER b ENDIF
    IF t = 5 THEN SILENCE ENDIF
  ENDP
ENDSCENE
SCENE b
  DIM t
  PROC INIT()
    r3 = RND(1000)
  ENDP
  PROC FRAME()
    t = t + 1
    r1 = RND(1000) : r2 = RND(1000)
    IF t = 3 THEN PLAY snda : ENTER a ENDIF
  ENDP
ENDSCENE
`),
  // 3 a top-level PROC and a branch / loop / WHILE that ENTER; border and keys; all text state
  toplevel: H(`DIM g, k
PROC GO(n)
  g = g + n
  IF g > 20 THEN
    ENTER b
  ENDIF
ENDP
SCENE a
  DIM t
  PROC INIT()
    INK 2 : PAPER 6
    CLS
  ENDP
  PROC FRAME()
    t = t + 1
    k = 0
    WHILE k < 10
      k = k + 1
      CALL GO(k)
    WEND
    BORDER 3
  ENDP
ENDSCENE
SCENE b
  DIM t
  PROC INIT()
    BRIGHT 1
    PRINT AT 0, 0; "B"
  ENDP
  PROC FRAME()
    t = t + 1
    IF t >= 2 THEN g = 0 : ENTER a ENDIF
  ENDP
ENDSCENE
`),
  // 2.1 the single-scene game with ENTER of itself (names stay plain) and no other scene
  selfOnly: H(`DIM g
SCENE a
  DIM n, arr(2) = 1, 2, 3
  PROC INIT()
    g = g + 1
    n = n + 7
    arr(2) = arr(2) + g
  ENDP
  PROC FRAME()
    n = n + 1
    arr(0) = arr(0) + 1
    IF n = 9 THEN ENTER a ENDIF
  ENDP
ENDSCENE
`),
};

// ── v3 and v4 templates ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * v3: a WINDOW game (world "lv": 48 columns, a band list), sprites with frames (guard has 3, SHOW ... FRAME), three scenes play -> over -> play (and a title). The camera, the world edits (SETWORLD)
 * and the sprites' frames are set before the switch; the window must survive it and the sprites must be back at (0, 0) frame 0, hidden.
 */
export function genV3(seed) {
  const r = rng(seed * 104729 + 5);
  const n1 = ri(r, 3, 9), n2 = ri(r, 2, 6), n3 = ri(r, 2, 5);
  const camStep = ri(r, 1, 12), band = pick(r, ['BAND 2, 1, 4\nBAND 3, 1, 2\nBAND 11, 1, 1\n', 'BAND 5, 0, 1\nBAND 11, 1, 1\n', '']);
  const hud = r() < 0.25 ? 'MAP hud = "m1"\n' : '';
  const src = `GAME "v3x${seed}"
FRAMERATE 20
TILESET ts = "ts"
MAP level = "lv"
${hud}SPRITE g(3) = "guard"
SPRITE b = "big"
DIM score, laps
WINDOW level${r() < 0.4 ? ' AT 0, 2' : ''}
${band}SCENE title
  DIM t
  PROC INIT()
    PRINT AT 10, 10; "TITLE"
    SHOW g(1) AT 30 + ${ri(r, 0, 40)}, 40 FRAME 2
    CAMERA ${ri(r, 0, 60)}
  ENDP
  PROC FRAME()
    t = t + 1
    SHOW g(0) AT t * 4, 60 FRAME t MOD 3
    IF t >= ${n1} THEN ENTER play ENDIF
  ENDP
ENDSCENE
SCENE play
  DIM t, x, arr(2) = ${ri(r, 1, 9)}, 2, 3
  PROC INIT()
    laps = laps + 1
    x = ${ri(r, 0, 100)}
  ENDP
  PROC FRAME()
    t = t + 1
    IF t < ${n2} THEN
      x = x + ${camStep}
      CAMERA x
      SETWORLD x DIV 8 + 3, 40 + t = t MOD 6
      IF t = 1 THEN SHOW b AT 100, 20 FLIP ENDIF
      SHOW g(t MOD 3) AT x MOD 200, 90 FRAME t MOD 3
      SHOW b AT 60 + t, 100 + t
      score = score + WORLDTILE(x + 16, 120) + CAMX()
      PRINT AT 0, 0; "S"; score
    ELSE
      ENTER over
    ENDIF
  ENDP
ENDSCENE
SCENE over
  DIM t
  PROC INIT()
    PRINT AT 8, 4; "OVER"; CAMX()
    score = score + 1000 * CAMX() MOD 7
  ENDP
  PROC FRAME()
    t = t + 1
    SHOW g(2) AT t * 8, 70 FRAME 1
    IF t >= ${n3} THEN ENTER ${pick(r, ['play', 'play', 'title'])} ENDIF
  ENDP
ENDSCENE
`;
  const kseed = ri(r, 0, 100);
  return { src, ticks: 60, stick: (t) => ((t + kseed) % 5 < 2 ? 8 : 0), keys: undefined };
}

/**
 * v4: a VIEW3D game on the 12 x 12 maze: scenes walk -> dead -> walk. The pose (VIEW), the walls (SETWALL) and the sprites are set in `walk`; after the switch the pose and the walls must be
 * as they were and the sprites hidden at (0, 0) frame 0. No SEEN / DEPTH (they read the renderer's buffer).
 */
export function genV4(seed) {
  const r = rng(seed * 130363 + 9);
  const n1 = ri(r, 3, 9), n2 = ri(r, 3, 6);
  const src = `GAME "v4x${seed}"
FRAMERATE 12
TILESET ts = "ts"
MAP level = "maze"
SPRITE g(3) = "guard"
SPRITE o = "orb"
DIM px, py, pa, hp
VIEW3D level COLW 4 INK 7 CEIL 1 FLOOR ${ri(r, 1, 6)}
SCENE walk
  DIM t, door
  PROC INIT()
    px = ${ri(r, 3, 9) * 256 + 128} : py = ${ri(r, 3, 9) * 256 + 128} : pa = ${ri(r, 0, 255)}
    VIEW px, py, pa
    SHOW o AT px + 300, py
  ENDP
  PROC FRAME()
    t = t + 1
    IF t < ${n1} THEN
      pa = pa + ${ri(r, 1, 9)}
      px = px + FXMUL(COSA(pa), ${ri(r, 10, 60)})
      py = py + FXMUL(SINA(pa), 30)
      IF WALL(px, py) = 0 THEN VIEW px, py, pa ENDIF
      SETWALL ${ri(r, 1, 10) * 256 + 5}, ${ri(r, 1, 10) * 256 + 5} = ${ri(r, 0, 4)}
      SHOW g(t MOD 3) AT px + t * 40, py + 100 FRAME t MOD 3
      hp = hp + WALL(px, py)
    ELSE
      ENTER dead
    ENDIF
  ENDP
ENDSCENE
SCENE dead
  DIM t
  PROC INIT()
    PRINT AT 2, 2; "DEAD"
    hp = hp + 1000
  ENDP
  PROC FRAME()
    t = t + 1
    SHOW o AT t * 20, 300
    IF t = 2 THEN SETWALL 256 * 5 + 7, 256 * 5 + 7 = 2 ENDIF
    IF t >= ${n2} THEN ENTER walk ENDIF
  ENDP
ENDSCENE
`;
  return { src, ticks: 60, stick: () => 0 };
}
