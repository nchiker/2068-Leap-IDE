#!/usr/bin/env node
"use strict";
// arcade-sc-parity.mjs -- sprite colour (SC) build step 6: the interpreter applies the same rule as the Z80 (applySpriteInk, src/lang/arcade/arcade-spriteink.js).
// The ink runtime (arcade/dist/v2ink, the "ink" build) runs a compiled game on a stock TS2068 in TSRun; its attribute file (the hidden file the tick just drew: what the next refresh shows) is compared
// BYTE FOR BYTE with the interpreter's records on every tick: three small synthetic ink games (aligned and shifted, moving, 2-phase, hidden / shown, the screen's edge, overlapping sprites; 120 ticks each) and
// the shipped classic Starfall with spriteColour 'ink' set on its play scene by the test (300 ticks of tests/arcade-starfall-script.mjs).  The interpreter has no classic bitmap, so the bitmap is not compared.
// Also: games with no ink scene give the same records with or without a `scenes` object (the interpreter's records are untouched).
//
//   node tests/arcade-sc-parity.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { applySpriteInk, LEAVE, inkAt } from '../src/lang/arcade/arcade-spriteink.js';
import { keysOf, stickOf } from './arcade-starfall-script.mjs';
import { compileReal, runReal, interpFor, ROOT } from './arcade-m5-harness.mjs';

let total = 0, failed = 0;
function check(name, ok, detail = '') {
  total++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  — ' + detail : ''}`);
  if (!ok) failed++;
}
const json = (v) => JSON.stringify(v);

const rt = JSON.parse(readFileSync(join(ROOT, 'arcade/dist/v2ink/runtime.json'), 'utf8'));
const R = { rt, img: new Uint8Array(readFileSync(join(ROOT, 'arcade/dist/v2ink/runtime.bin'))), SYM: rt.symbols, ok: true };
const SYM = rt.symbols;

/** Run `src` on the ink runtime and in the interpreter (with the project's scenes); compare cells, text state, sprites and the shown attribute file on every tick. Returns {d, got, want, inkCells, minK}. */
function parity(name, src, assets, { ticks, keys = null, stick = null }) {
  let res, got;
  try {
    res = compileReal(src, assets, { R });
    const hidden = [];
    got = runReal(res, { ticks, keys, stick, R, hooks: { afterTick: (k, m) => { const at = m.ram[SYM.V_HIDDEN] ? 0x7800 : 0x5800; hidden[k - 1] = m.ram.slice(at, at + 768); } } });
    if (got.error) throw new Error(got.error);
    got.hidden = hidden;
  } catch (e) { check(`${name}: runs on the ink runtime`, false, e.message); return null; }
  const want = interpFor(src, assets, got)(ticks, { keys: keys ? (t, c) => keys(t).includes(c) : undefined, stick: stick ?? undefined, scenes: assets.scenes });
  const plain = interpFor(src, assets, got)(ticks, { keys: keys ? (t, c) => keys(t).includes(c) : undefined, stick: stick ?? undefined });
  let d = null, inkCells = 0, bgOk = true;
  for (let i = 0; i < ticks && !d; i++) {
    const g = got.ticks[i], w = want.ticks[i], p = plain.ticks[i], at = `tick ${i + 1}`;
    for (const [k, v] of Object.entries(w.vars)) if (g.vars[k] !== v) d = `${at}: ${k} = ${g.vars[k]}, interpreter ${v}`;
    for (let c = 0; c < 768 && !d; c++) {
      if (g.cells[c] !== w.cells[c]) d = `${at}: cell ${c} differs`;
      else if (g.attrs[c] !== p.attrs[c]) { bgOk = false; d = `${at}: background attribute ${c} = $${g.attrs[c].toString(16)}, interpreter $${p.attrs[c].toString(16)}`; }
      else if (got.hidden[i][c] !== w.attrs[c]) d = `${at}: shown attribute (row ${c >> 5}, col ${c & 31}) = $${got.hidden[i][c].toString(16)}, interpreter $${w.attrs[c].toString(16)}; sprites ${json(w.sprites.filter((s) => s.visible))}`;
      if (w.attrs[c] !== p.attrs[c]) inkCells++;
    }
    for (let j = 0; j < 4 && !d; j++) { const a = g.sprites[j], b = w.sprites[j]; if (a && b && (!!a.visible !== !!b.visible || (b.visible && (a.x !== b.x || a.y !== b.y)))) d = `${at}: sprite ${j} differs`; }
  }
  check(`${name}: ${ticks} ticks, the ink runtime's attribute file equals the interpreter's on every tick (${inkCells} recoloured cell-ticks)`, d === null && inkCells > 0, d ?? 'no cell was recoloured');
  return { got, want, plain, inkCells };
}

// ── synthetic sprites: rows of {bits, mask, ink} (mask 1 = the sprite covers the pixel) ──
const rows = (spec) => spec.map(([bits, mask, ink]) => ({ bits, mask, ink }));
const rep = (n, v) => new Array(n).fill(v);
const SHIP = rows([...rep(4, ['FFFF', 'FFFF', 2]), ...rep(4, ['3C3C', '7E7E', 6]), ...rep(8, ['FFFF', 'FFFF', 5])]);        // two blocks high, two inks, holes in the middle rows
const DOT = rows([...rep(6, ['F0F0', 'F0F0', 3]), ['0000', '0000', 3], ['FFFF', 'FFFF', 1]]);                                // 7 + 1 rows, a ragged sprite
const BAR = rows(rep(8, ['FFFF', 'FFFF', 4]));
const MID = rows([...rep(3, ['00FF', '00FF', 2]), ...rep(5, ['FF00', 'FF00', 7]), ...rep(8, ['0FF0', '0FF0', 1])]);
const baseAssets = { sprites: {
  ship: { w: 16, h: 16, frames: [{ rows: SHIP }] },
  dot: { w: 16, h: 8, frames: [{ rows: DOT }], phases: 2 },
  bar: { w: 16, h: 8, frames: [{ rows: BAR }] },
  mid: { w: 16, h: 16, frames: [{ rows: MID }] },
} };
const withScenes = (scenes) => ({ ...baseAssets, scenes });
// a background of varied attributes (paper, bright, ink), so the AND $F8 keeps something visible
const BACKGROUND = `    FOR r = 0 TO 23
      PAPER (r MOD 7) + 1 : INK 0 : BRIGHT r MOD 2
      PRINT AT r, 0; "###############################";
    NEXT r
    BRIGHT 0
`;
const HEAD = 'GAME "p"\nFRAMERATE 30\nSPRITE ship = "ship"\nSPRITE dot = "dot"\nSPRITE bar = "bar"\nSPRITE mid = "mid"\n';

// 1. aligned and shifted, still: every class of x and y, two phases, an overlap
const G1 = HEAD + `SCENE s
  PROC INIT():
    CLS
${BACKGROUND}    SHOW ship AT 8, 8
    SHOW dot AT 53, 21
    SHOW bar AT 100, 100
    SHOW mid AT 101, 99
  ENDP
  PROC FRAME():
  ENDP
ENDSCENE
`;
// 2. moving: bouncing sprites at speeds that visit every shift (a 2-phase one included), a changing background cell under them
const G2 = HEAD + `SCENE s
  DIM x, y, dx, dy, u, v, du, dv, t
  PROC INIT():
    CLS
${BACKGROUND}    x = 5 : y = 3 : dx = 3 : dy = 2
    u = 200 : v = 150 : du = -5 : dv = -7
    SHOW ship AT x, y
    SHOW dot AT u, v
  ENDP
  PROC FRAME():
    t = t + 1
    x = x + dx : y = y + dy
    IF x > 239 THEN
      x = 239 : dx = 0 - dx
    ENDIF
    IF x < 0 THEN
      x = 0 : dx = 0 - dx
    ENDIF
    IF y > 176 THEN
      y = 176 : dy = 0 - dy
    ENDIF
    IF y < 0 THEN
      y = 0 : dy = 0 - dy
    ENDIF
    u = u + du : v = v + dv
    IF u > 239 THEN
      du = 0 - du
    ENDIF
    IF u < 0 THEN
      du = 0 - du
    ENDIF
    IF v > 176 THEN
      dv = 0 - dv
    ENDIF
    IF v < 0 THEN
      dv = 0 - dv
    ENDIF
    SHOW ship AT x, y
    SHOW dot AT u, v
    IF t MOD 9 = 0 THEN
      PAPER (t MOD 7) + 1 : INK 2 : PRINT AT (t MOD 20) + 2, 5; "XXXXXXXXXXXXXXXX";
    ENDIF
  ENDP
ENDSCENE
`;
// 3. hidden / shown, the edge of the screen (SHOW clamps x to 239 and y to 176), two sprites on top of each other (the higher index lies on top)
const G3 = HEAD + `SCENE s
  DIM t, k
  PROC INIT():
    CLS
${BACKGROUND}  ENDP
  PROC FRAME():
    t = t + 1
    k = t MOD 12
    IF k < 6 THEN
      SHOW ship AT 300, 300
    ELSE
      HIDE ship
    ENDIF
    IF t MOD 7 < 4 THEN
      SHOW bar AT 232 + (t MOD 3), 170 + (t MOD 5)
    ELSE
      HIDE bar
    ENDIF
    SHOW mid AT 60 + t, 60 + (t MOD 13)
    SHOW dot AT 64 + t, 64 + (t MOD 11)
    IF t MOD 15 = 0 THEN
      HIDE mid
    ENDIF
    IF t MOD 20 = 0 THEN
      HIDE dot
    ENDIF
  ENDP
ENDSCENE
`;
const ink = withScenes({ s: { spriteColour: 'ink' } });
const out1 = parity('1. still sprites, every class, two phases, an overlap', G1, ink, { ticks: 120 });
const out2 = parity('2. moving sprites (bounce, a 2-phase one), the background changing', G2, ink, { ticks: 120 });
const out3 = parity('3. hidden / shown, the screen edge, overlap', G3, ink, { ticks: 130 });

// the shared function itself, against the model of the table (inkAt) and the overlap rule
{
  const asset = { h: 8, data: Uint8Array.from(rep(8, [0, 0, 0xFF, 0xFF]).flat()), inks: rep(8, 3), phases: 8 };
  const bg = new Uint8Array(768).fill(0x38 | 0x40);
  const a1 = applySpriteInk(bg, [{ visible: 1, x: 0, y: 0 }], [0], [asset]);
  check('applySpriteInk: does not change its input, keeps paper and BRIGHT, sets the ink of the covered cells', bg.every((v) => v === 0x78) && a1[0] === 0x7B && a1[1] === 0x7B && a1[2] === 0x78 && a1[32] === 0x78, json([a1[0], a1[1], a1[2], a1[32]]));
  const a2 = applySpriteInk(bg, [{ visible: 0, x: 0, y: 0 }], [0], [asset]);
  check('applySpriteInk: a hidden sprite recolours nothing', a2.every((v) => v === 0x78));
  const two = applySpriteInk(bg, [{ visible: 1, x: 0, y: 0 }, { visible: 1, x: 0, y: 0 }], [0, 1], [asset, { ...asset, inks: rep(8, 5) }]);
  check('applySpriteInk: two sprites on the same cells: the higher index lies on top', two[0] === 0x7D);
  const g = inkAt(asset, 5, 3), want = applySpriteInk(bg, [{ visible: 1, x: 5, y: 3 }], [0], [asset]);
  let n = 0; for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) if (g[r][c] !== LEAVE && ((r === 0 && c < 3) || r < 2)) n++;
  check('applySpriteInk at a shifted position recolours the cells of the class grid within the rows the blit covers', want.filter((v) => v !== 0x78).length === n && n > 0, `${want.filter((v) => v !== 0x78).length} vs ${n}`);
}

// ── the shipped classic Starfall, ink on in its play scene ──
{
  const SRC = readFileSync(join(ROOT, 'arcade/examples/shooter-classic.arc'), 'utf8');
  const A = JSON.parse(readFileSync(join(ROOT, 'arcade/examples/shooter-classic.assets.json'), 'utf8'));
  const assets = { ...A, scenes: { ...(A.scenes ?? {}), play: { spriteColour: 'ink' } } };
  const o = parity('4. Starfall (classic), spriteColour ink on the play scene', SRC, assets, { ticks: 300, keys: keysOf, stick: stickOf });
  if (o) check('Starfall: the interpreter result carries nothing the plain run lacks but the recoloured attributes (cells, sprites, variables equal)', o.want.ticks.every((q, i) => json(q.vars) === json(o.plain.ticks[i].vars) && json(q.sprites) === json(o.plain.ticks[i].sprites) && Buffer.compare(Buffer.from(q.cells), Buffer.from(o.plain.ticks[i].cells)) === 0));
  // the same game with the setting naming a scene that does not exist: no ink scene, the records are exactly the plain ones
  const none = interpFor(SRC, A, null)(60, { keys: (t, c) => keysOf(t).includes(c), stick: stickOf, scenes: { play: { spriteColour: 'none' } } });
  const plain = interpFor(SRC, A, null)(60, { keys: (t, c) => keysOf(t).includes(c), stick: stickOf });
  check('a game with no ink scene: the interpreter records are identical with and without a scenes object (60 ticks of Starfall)', json(none.ticks) === json(plain.ticks) && !('ink' in none));
}

console.log(`\n${total} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
