/**
 * tests/arcade-sc-codegen.mjs — sprite colour (SC) build step 5, the compiler side: the ink tables (src/lang/arcade/arcade-spriteink.js), the table block and the RT_SPRITEINK calls the code
 * generator emits for a game with an ink scene, the sprite-ink-clash warning, games without an ink scene unchanged, and an end-to-end run on TSRun (the attribute file of a sprite game).
 *
 *   node tests/arcade-sc-codegen.mjs
 */

"use strict";

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { compile, requiredRuntime } = await import(join(ROOT, 'src/lang/arcade/arcade-compile.js'));
const SI = await import(join(ROOT, 'src/lang/arcade/arcade-spriteink.js'));
const { Emitter, L: LBL } = await import(join(ROOT, 'src/lang/arcade/z80-emit.js'));
const { convertSprite } = await import(join(ROOT, 'src/lang/arcade/arcade-codegen.js'));
const C = await import(join(ROOT, 'arcade/tests/m4-common.mjs'));
const { M, newMachine, bootMachine, rd16 } = C;

let failed = 0, total = 0;
function check(name, ok, detail = '') {
  total++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  — ' + detail : ''}`);
  if (!ok) failed++;
}
const json = (v) => JSON.stringify(v);
const L = SI.LEAVE;

// ── synthetic sprites (the asset shape of convertSprite: h x 4 bytes mask_hi mask_lo image_hi image_lo, inks) ──
/** cover: per row a 16-bit mask of the covered pixels (bit 15 = leftmost); inks: per row. */
function sprite(cover, inks, phases = 8) {
  const data = new Uint8Array(cover.length * 4);
  cover.forEach((c, k) => { const mask = ~c & 0xFFFF; data.set([mask >> 8, mask & 0xFF, c >> 8, c & 0xFF], 4 * k); });
  return { h: cover.length, data, inks: Uint8Array.from([...inks, ...new Array(16 - inks.length).fill(0)]), phases };
}
const rep = (n, v) => new Array(n).fill(v);
const grid = (t, cls) => [0, 1, 2].map((r) => [0, 1, 2].map((c) => t[9 * cls + 3 * r + c]));
const rows = (...r) => r;

// ── 1. table bytes, hand-computed ──
{
  // A: 8 x 8 solid, ink 3, drawn at the left of the 16 columns
  const A = sprite(rep(8, 0xFF00), rep(8, 3));
  const tA = SI.inkTable(A);
  check('inkTable is 81 bytes', tA.length === 81 && SI.TABLE_BYTES === 81);
  const cases = [
    ['A aligned x aligned y (class 0): one cell', 0, [[3, L, L], [L, L, L], [L, L, L]]],
    ['A x 1-3, y aligned (class 3): two cells side by side', 3, [[3, 3, L], [L, L, L], [L, L, L]]],
    ['A x 4-7, y aligned (class 6): two cells side by side', 6, [[3, 3, L], [L, L, L], [L, L, L]]],
    ['A x aligned, y 1-3 (class 1): two cells one above the other', 1, [[3, L, L], [3, L, L], [L, L, L]]],
    ['A x aligned, y 4-7 (class 2)', 2, [[3, L, L], [3, L, L], [L, L, L]]],
    ['A x 4-7, y 4-7 (class 8): four cells', 8, [[3, 3, L], [3, 3, L], [L, L, L]]],
  ];
  for (const [name, cls, want] of cases) check(name, json(grid(tA, cls)) === json(want), json(grid(tA, cls)));
  check('every unused byte has bit 3 set, every used byte is an ink 0..7', [...tA].every((b) => b === L || b < 8));

  // B: 16 x 16 solid, rows 0-7 ink 2, rows 8-15 ink 5: a two-ink ship keeps both inks at cell level
  const B = sprite(rep(16, 0xFFFF), [...rep(8, 2), ...rep(8, 5)]);
  const tB = SI.inkTable(B);
  check('B aligned: 2 x 2 cells, ink 2 on the top row of cells, 5 on the lower; the third column and row are left alone', json(grid(tB, 0)) === json([[2, 2, L], [5, 5, L], [L, L, L]]), json(grid(tB, 0)));
  check('B x 1-3, y aligned: three columns', json(grid(tB, 3)) === json([[2, 2, 2], [5, 5, 5], [L, L, L]]), json(grid(tB, 3)));
  // y 1-3: row of cells 1 sees 8 - t rows of ink 2 ... summed over t = 1..3: ink 2 gets 1+2+3 = 6 pixel rows, ink 5 gets 7+6+5 = 18, so ink 5 wins; the last row of cells gets only ink 5
  check('B x aligned, y 1-3: the ink most used wins per cell (summed over the shifts of the class)', json(grid(tB, 1)) === json([[2, 2, L], [5, 5, L], [5, 5, L]]), json(grid(tB, 1)));
  check('B x 4-7, y 4-7: three by three; the middle row of cells gets 22 pixel rows of ink 2 against 10 of ink 5, the bottom only ink 5', json(grid(tB, 8)) === json([[2, 2, 2], [2, 2, 2], [5, 5, 5]]), json(grid(tB, 8)));

  // C: 8 x 2, row 0 ink 1, row 1 ink 6, equal counts in the one cell: the tie goes to the lower ink
  const Cc = sprite([0xFF00, 0xFF00], [1, 6]);
  check('a tie goes to the lower ink', grid(SI.inkTable(Cc), 0)[0][0] === 1);
  const C2 = sprite([0xFF00, 0xFF00, 0xFF00], [6, 6, 1]);
  check('the most used ink wins (6 of 3 rows)', grid(SI.inkTable(C2), 0)[0][0] === 6);

  // D: 16 x 8, only the left 8 columns covered: the right-hand block has no opaque pixel => leave alone
  const D = sprite(rep(8, 0xFF00), rep(8, 4));
  check('D (right half transparent): the right cell stays LEAVE in the aligned class', grid(SI.inkTable(D), 0)[0][1] === L);
  // E: holes: the left block has one pixel of ink 6 in the last row only
  const E = sprite([0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x8000], [1, 1, 1, 1, 1, 1, 1, 6]);
  check('E: a block with one opaque pixel takes that pixel\'s ink', grid(SI.inkTable(E), 0)[0][0] === 6);
  // F: A with phases 2: x is only drawn at shifts 0 and 4, so class 1 (shifts 1-3) is empty and class 2 is shift 4 alone
  const F = sprite(rep(8, 0xFF00), rep(8, 3), 2);
  const tF = SI.inkTable(F);
  check('F (2 phases): the class of shifts 1-3 is never drawn: all LEAVE', json(grid(tF, 3)) === json([[L, L, L], [L, L, L], [L, L, L]]));
  check('F (2 phases): shift 4 touches the two cells', json(grid(tF, 6)) === json([[3, 3, L], [L, L, L], [L, L, L]]));
  // spriteCellInks: one shift
  check('spriteCellInks: B at shift 5 / 2: cell (2, 2) holds the 2 lowest rows (ink 5), cell (0, 0) ink 2', SI.spriteCellInks(B, 5, 2)[2][2] === 5 && SI.spriteCellInks(B, 5, 2)[0][0] === 2);
  check('spriteCellInks: a single shift is exact (A at x 3: both cells, nothing below)', json(SI.spriteCellInks(A, 3, 0)) === json([[3, 3, L], [L, L, L], [L, L, L]]));
  check('inkAt rounds x to the phase (F at x 5 draws at 4: class 2)', json(SI.inkAt(F, 5, 0)) === json([[3, 3, L], [L, L, L], [L, L, L]]) && json(SI.inkAt(F, 3, 0)) === json([[3, L, L], [L, L, L], [L, L, L]]));
  const many = SI.inkTables([A, B, Cc]);
  check('inkTables gives one table per asset', many.length === 3 && many.every((t) => t.length === 81) && json([...many[1]]) === json([...tB]));
  // clashes
  check('inkClashes: A none, B none (one ink per block)', SI.inkClashes(A).length === 0 && SI.inkClashes(B).length === 0);
  const G = sprite(rep(8, 0xFFFF), [1, 1, 1, 1, 2, 2, 2, 2]);
  check('inkClashes: G (two inks in each of its two blocks)', json(SI.inkClashes(G)) === json([{ row: 0, col: 0, inks: [1, 2] }, { row: 0, col: 1, inks: [1, 2] }]), json(SI.inkClashes(G)));
  check('inkClashes: an ink on a row with no opaque pixel in the block does not count', SI.inkClashes(sprite([0xFF00, 0x00FF], [1, 2])).length === 0);
}

// ── 2. the compiler ──
const load = (dir) => ({ runtime: JSON.parse(readFileSync(join(ROOT, 'arcade/dist', dir, 'runtime.json'), 'utf8')), image: new Uint8Array(readFileSync(join(ROOT, 'arcade/dist', dir, 'runtime.bin'))) });
const v2 = load('v2'), ink = load('v2ink');
const sh = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);
const SHIP_ROWS = (inks) => inks.map((i) => ({ bits: 'FFFF', mask: 'FFFF', ink: i }));
const assets = { sprites: {
  ship: { w: 16, h: 16, frames: [{ rows: SHIP_ROWS([...rep(8, 2), ...rep(8, 5)]) }] },
  mono: { w: 16, h: 8, frames: [{ rows: SHIP_ROWS(rep(8, 3)) }] },
} };
const scene = (name, body = '', frame = '') => `SCENE ${name}\n  PROC INIT():\n    CLS\n${body}  ENDP\n  PROC FRAME():\n${frame}  ENDP\nENDSCENE\n`;
const HEAD = 'GAME "t"\nFRAMERATE 30\nSPRITE ship = "ship"\nSPRITE mono = "mono"\n';
const GAME = HEAD + scene('a', '    SHOW ship AT 21, 35\n    SHOW mono AT 100, 100\n', '    IF KEYDOWN("Z") THEN\n      ENTER b\n    ENDIF\n') + scene('b', '    SHOW mono AT 50, 50\n', '    ENTER a\n');
const run = (text, rt, scenes) => compile(text, { runtime: rt.runtime, image: rt.image, assets, scenes });

// a game with one ink scene (a) and one plain scene (b)
const gInk = run(GAME, ink, { a: { spriteColour: 'ink' } });
check('the ink game compiles with no errors', gInk.errors.length === 0 && !!gInk.dck, json(gInk.errors));
const sym = ink.runtime.symbols;
/** Every `LD A,n / LD HL,nnnn / CALL RT_SPRITEINK` of the image: [{a, hl, at}]. */
function setterCalls(mem, symbols) {
  const out = [];
  for (let at = 0x8000; at < 0xC000 - 8; at++) {
    if (mem[at] === 0x3E && mem[at + 2] === 0x21 && mem[at + 5] === 0xCD && (mem[at + 6] | (mem[at + 7] << 8)) === symbols.RT_SPRITEINK) out.push({ at, a: mem[at + 1], hl: mem[at + 3] | (mem[at + 4] << 8) });
  }
  return out;
}
{
  const mem = gInk.memory, g = gInk.gen;
  const calls = setterCalls(mem, sym);
  const tableAt = g.ink?.tableAt;
  check('gen.ink says which scenes are ink and where the table is; the table is on a 256-byte page', json(g.ink?.scenes) === '[true,false]' && tableAt > 0 && tableAt % 256 === 0, json(g.ink));
  check('the table (2 words + 2 x 81 bytes) is the end of the game code', tableAt >= g.base && tableAt + 2 * 2 + 81 * 2 === g.base + g.code.length, `${tableAt} base ${g.base} len ${g.code.length}`);
  check('one setter call per scene entry (a: A=1, b: A=0) and one at the start of init_entry (the first scene is ink): 3 calls, all HL = the table', calls.length === 3 && calls.filter((c) => c.a === 1).length === 2 && calls.filter((c) => c.a === 0).length === 1 && calls.every((c) => c.hl === tableAt), json(calls));
  const word = (k) => mem[tableAt + 2 * k] | (mem[tableAt + 2 * k + 1] << 8);
  check('the word table points at each asset\'s 81 bytes, which follow it', word(0) === tableAt + 4 && word(1) === tableAt + 4 + 81, `${word(0).toString(16)} ${word(1).toString(16)}`);
  const sp = g.sprites;
  const want = SI.inkTables(sp);
  check('the table bytes in the image are inkTables() of the converted sprites', sp.length === 2 && [0, 1].every((k) => Buffer.compare(Buffer.from(mem.slice(word(k), word(k) + 81)), Buffer.from(want[k])) === 0));
  const ship = mem.slice(word(0), word(0) + 81);
  check('the ship (rows 0-7 ink 2, rows 8-15 ink 5), aligned: top cells 2, bottom cells 5', json([...ship.slice(0, 9)]) === json([2, 2, L, 5, 5, L, L, L, L]), json([...ship.slice(0, 9)]));
  const mono = mem.slice(word(1), word(1) + 81);
  check('a mono 16 x 8 sprite aligned: [3, 3, 8]', json([...mono.slice(0, 3)]) === json([3, 3, L]));
  check('the table block is counted in the usage', g.usage.dataBytes.ink === 2 * 2 + 81 * 2, json(g.usage.dataBytes));
}
// one scene only: the call sits in init_entry alone
{
  const one = run(HEAD + scene('a', '    SHOW ship AT 21, 35\n'), ink, { a: { spriteColour: 'ink' } });
  const calls = setterCalls(one.memory, sym);
  check('a one-scene ink game: a single setter call, A = 1', one.errors.length === 0 && calls.length === 1 && calls[0].a === 1 && calls[0].hl === one.gen.ink.tableAt, json([one.errors, calls]));
}
// the second scene ink, the first plain: init_entry has no call; the entries do
{
  const g2 = run(GAME, ink, { b: { spriteColour: 'ink' } });
  const calls = setterCalls(g2.memory, sym);
  check('first scene plain, second ink: two calls in the entries (A = 0 for a, A = 1 for b), none in init_entry', g2.errors.length === 0 && calls.length === 2 && calls.map((c) => c.a).sort().join() === '0,1', json(calls));
}
// a fine scene beside an ink one: the fine one gets A = 0 (and keeps its RT_FINEMODE call)
{
  const TS = { tilesets: { gfx: { tiles: Array.from({ length: 2 }, () => ({ rows: Array.from({ length: 8 }, () => ({ bits: '00', ink: 0, paper: 7, bright: 0 })), flags: 0 })) } } };
  const fineText = HEAD + 'TILESET gfx = "gfx"\n' + scene('a', '    SHOW ship AT 21, 35\n', '    ENTER b\n') + scene('b', '    TILE 1, 1 = 1\n', '    ENTER a\n');
  const f = compile(fineText, { runtime: ink.runtime, image: ink.image, assets: { ...assets, ...TS }, scenes: { a: { spriteColour: 'ink' }, b: { display: 'fine' } } });
  const built = f.scenes?.map((s) => `${s.built}/${s.spriteColour.built}`).join(' ');
  check('a fine scene beside an ink scene compiles (a: buffers/ink, b: fine/none)', f.errors.length === 0 && built === 'buffers/ink fine/none', json([f.errors, built]));
  if (f.memory) {
    const calls = setterCalls(f.memory, sym);
    const fm = []; for (let at = 0x8000; at < 0xC000 - 8; at++) if (f.memory[at] === 0x3E && f.memory[at + 2] === 0x21 && f.memory[at + 5] === 0xCD && (f.memory[at + 6] | (f.memory[at + 7] << 8)) === sym.RT_FINEMODE) fm.push({ at, a: f.memory[at + 1] });
    check('the fine scene\'s ENTER sequence sets A = 0 for ink; the ink scene A = 1 (init_entry too)', calls.length === 3 && calls.filter((c) => c.a === 0).length === 1 && calls.filter((c) => c.a === 1).length === 2, json(calls));
    check('the fine calls are still there (A = 1 for b, A = 0 for a; none in init_entry, a is not fine)', fm.length === 2 && fm.filter((c) => c.a === 1).length === 1, json(fm));
  } else check('fine build produced an image', false, json(f.errors));
}
// no sprites: nothing emitted even with the setting
{
  const none = run('GAME "t"\nFRAMERATE 30\n' + scene('a', '    PRINT AT 1, 1; "x";\n'), ink, { a: { spriteColour: 'ink' } });
  const plain = run('GAME "t"\nFRAMERATE 30\n' + scene('a', '    PRINT AT 1, 1; "x";\n'), ink, undefined);
  check('an ink scene in a game without sprites emits nothing (same bytes as without the setting)', none.errors.length === 0 && Buffer.compare(Buffer.from(none.dck), Buffer.from(plain.dck)) === 0, json(none.errors));
}
// refused on the plain runtime stays an error
check('on the plain v2 runtime the ink game is still refused', run(GAME, v2, { a: { spriteColour: 'ink' } }).errors.length === 1);

// ── 3. the warning ──
{
  const clash = { sprites: { ship: { w: 16, h: 16, frames: [{ rows: SHIP_ROWS([...rep(4, 2), ...rep(4, 5), ...rep(8, 3)]) }] }, mono: assets.sprites.mono } };
  const r = compile(GAME, { runtime: ink.runtime, image: ink.image, assets: clash, scenes: { a: { spriteColour: 'ink' } } });
  const w = r.warnings.filter((x) => x.id === 'sprite-ink-clash');
  check('a sprite with two inks in one 8 x 8 block: a warning (not an error), once per ink scene and block, naming asset, block and inks', r.errors.length === 0 && w.length === 2
    && w.every((x) => x.severity === 'warning' && /sprite "ship"/.test(x.message) && /inks 2 and 5/.test(x.message) && /scene 'a'/.test(x.message)) && /row 0, column 0/.test(w[0].message) && /row 0, column 1/.test(w[1].message), json(w));
  const r2 = compile(GAME, { runtime: ink.runtime, image: ink.image, assets: clash, scenes: { a: { spriteColour: 'ink' }, b: { spriteColour: 'ink' } } });
  check('two ink scenes: the warning once for each', r2.warnings.filter((x) => x.id === 'sprite-ink-clash').length === 4);
  check('no warning for sprites whose blocks have one ink each', run(GAME, ink, { a: { spriteColour: 'ink' } }).warnings.filter((x) => x.id === 'sprite-ink-clash').length === 0);
  const r3 = compile(GAME, { runtime: v2.runtime, image: v2.image, assets: clash, scenes: undefined });
  check('no warning in a game without an ink scene', r3.warnings.filter((x) => x.id === 'sprite-ink-clash').length === 0);
}

// ── 4. the emitter's endAlign ──
{
  for (const opt of [{}, { hl: true, ret: true, jr: true }]) {
    const e = new Emitter(0x8123, opt);
    e.label('x'); e.ld('hl', LBL('tab')); e.call(0x1234); e.ret();
    e.endAlign(256, 'tab');
    const bytes = e.finish();
    const at = e.addressOf('tab');
    check(`endAlign (${json(opt)}): the label is on a page boundary at the end of the padded code`, at % 256 === 0 && at === 0x8123 + bytes.length && bytes.length < 7 + 256 && bytes[1] === (at & 0xFF) && bytes[2] === (at >> 8), `${at} ${bytes.length}`);
  }
  check('a plain emitter has no padding', (() => { const e = new Emitter(0x8123); e.nop(); return e.finish().length === 1; })());
}

// ── 5. games without an ink scene are unchanged (the DCKs the compiler gave before SC step 5, plain runtimes) ──
const BASELINE = { blockfall: 'ac044a1a20b9083e', bounce: 'c02dea0f00130105', breakout: '700debd686c0d95a', crabsmash: '01d88c36e79087a8', lumen: '7f7b5072820e56d0', orbit: 'f7188341691f3065', platformer: '0ef02a7821ac945d',
  runner: 'e9372c6d0dd0be34', 'shooter-classic': '78c997df68d55ed9', shooter: 'b9e154a15704dee5', vaults: 'eacfe20b943c4a1b' };
{
  const rts = { 2: v2, 3: load('v3'), 4: load('v4') };
  const dir = join(ROOT, 'arcade/examples');
  let n = 0;
  for (const [id, want] of Object.entries(BASELINE)) {
    const af = join(dir, id + '.assets.json');
    const a = existsSync(af) ? JSON.parse(readFileSync(af, 'utf8')) : { sprites: {} };
    const text = readFileSync(join(dir, id + '.arc'), 'utf8');
    const r = rts[requiredRuntime(text, a).version];
    const res = compile(text, { runtime: r.runtime, image: r.image, assets: a, scenes: a.scenes });
    check(`example ${id}: the DCK is byte for byte the one before SC step 5 (plain runtime)`, !!res.dck && sh(res.dck) === want, res.dck ? sh(res.dck) : json(res.errors));
    n++;
  }
  check('every example of the baseline was found', n === 11 && readdirSync(dir).filter((f) => f.endsWith('.arc') && !/static/.test(f)).length === n);
}

// ── 6. end to end on TSRun: the attribute file of a game with an ink scene ──
{
  const m = newMachine(gInk.dck);
  bootMachine(m, sym);
  const base = rd16(m, sym.V_TICKS);
  for (let f = 0; f < 80 && rd16(m, sym.V_TICKS) - base < 6; f++) M.runFrame(m);
  const shown = () => m.ram.slice((m.portFF & 1) ? 0x7800 : 0x5800, ((m.portFF & 1) ? 0x7800 : 0x5800) + 768);
  const attrs = shown();
  // the game: scene a shows ship at (21, 35) and mono at (100, 100); its first cell is (y >> 3, x >> 3); expected from the model alone
  const expected = new Uint8Array(768).fill(0x38);
  const put = (asset, x, y) => {
    const g = SI.inkAt(asset, x, y);
    for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) if (g[dr][dc] !== L) { const r = (y >> 3) + dr, c = (x >> 3) + dc; if (r < 24 && c < 32) expected[r * 32 + c] = (expected[r * 32 + c] & 0xF8) | g[dr][dc]; }
  };
  const conv = Object.fromEntries(Object.entries(assets.sprites).map(([k, v]) => [k, convertSprite(v)]));
  put(conv.ship, 21, 35); put(conv.mono, 100, 100);
  let diff = 0, first = '';
  for (let i = 0; i < 768; i++) if (attrs[i] !== expected[i]) { diff++; first ||= `cell ${i} (row ${i >> 5}, col ${i & 31}): ${attrs[i].toString(16)} expected ${expected[i].toString(16)}`; }
  const recoloured = [...expected].filter((v) => v !== 0x38).length;
  check(`TSRun: the shown attribute file is the background with the covered cells recoloured (${recoloured} cells, ship at (21, 35) = x class 2 / y class 1, mono at (100, 100) = classes 1 / 1)`, diff === 0 && recoloured > 6, diff ? `${diff} cells differ, first ${first}` : '');
  check('TSRun: the ship\'s top cells are ink 2 and its lower cells ink 5 (the two inks of the art)', attrs[4 * 32 + 2] === 0x3A && attrs[6 * 32 + 2] === 0x3D, `${attrs[4 * 32 + 2].toString(16)} ${attrs[6 * 32 + 2].toString(16)}`);
  // the same game on the plain runtime (no setting): the sprite writes no attributes
  const gPlain = run(GAME, v2, undefined);
  const mp = newMachine(gPlain.dck);
  bootMachine(mp, v2.runtime.symbols);
  const bp = rd16(mp, v2.runtime.symbols.V_TICKS);
  for (let f = 0; f < 80 && rd16(mp, v2.runtime.symbols.V_TICKS) - bp < 6; f++) M.runFrame(mp);
  const pa = mp.ram.slice((mp.portFF & 1) ? 0x7800 : 0x5800, ((mp.portFF & 1) ? 0x7800 : 0x5800) + 768);
  check('TSRun: without the setting the attribute file is plain paper and ink 0 everywhere', pa.every((v) => v === 0x38));
}

console.log(`\n${total} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
