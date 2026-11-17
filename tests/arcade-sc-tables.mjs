/**
 * tests/arcade-sc-tables.mjs — sprite colour (SC) step 7: hand-computed checks of arcade-spriteink.js that the first mutation run (arcade/tests/sc-mutations.mjs) showed the other suites lack:
 * the table byte of a cell the sprite leaves, the shifts of each class (a thin art makes every shift count), the inks 0 and 7 and an ink beyond 3 bits, an asset without inks or height,
 * the 2-phase asset's y shifts, the clash check at the last pixel of a block, and applySpriteInk's defaults, guards, FLASH bit and overlap. Pure Node, no ROMs; expectations are worked
 * out by hand from the layout in the header of arcade-spriteink.js (a pixel p of an art row, drawn at shift s, lands in cell (s + p) >> 3).
 *
 *   node tests/arcade-sc-tables.mjs
 */

"use strict";

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SI = await import(join(ROOT, 'src/lang/arcade/arcade-spriteink.js'));
const L = 8;

let failed = 0, total = 0;
function check(name, ok, detail = '') {
  total++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  — ' + detail : ''}`);
  if (!ok) failed++;
}
const json = (v) => JSON.stringify(v);
const same = (name, got, want) => check(name, json(got) === json(want), `got ${json(got)}, want ${json(want)}`);

/** An asset from rows of {cover: 16-bit covered-pixel mask (bit 15 = leftmost pixel), ink}; rows past the list are uncovered with ink 0. */
function asset(rows, { h = rows.length, phases } = {}) {
  const data = new Uint8Array(h * 4), inks = new Uint8Array(16);
  rows.forEach(({ cover, ink }, k) => {
    const mask = ~cover & 0xFFFF;
    data.set([mask >> 8, mask & 0xFF, cover >> 8, cover & 0xFF], 4 * k);
    inks[k] = ink;
  });
  return { h, data, inks, ...(phases ? { phases } : {}) };
}
const rep = (n, v) => new Array(n).fill(v);
const row0 = (g) => g[0];

// ── 1. the byte of a cell the sprite leaves is 8 ──
{
  const A = asset(rep(8, { cover: 0xFF00, ink: 3 }));
  const t = SI.inkTable(A);
  check('LEAVE is 8 and an untouched cell\'s table byte is exactly 8 (bit 3 set, nothing else)', SI.LEAVE === 8 && t[0] === 3 && t[1] === 8 && t[2] === 8 && t[3] === 8 && t[9 + 0] === 3, `${t[0]} ${t[1]} ${t[2]} ${t[3]}`);
}

// ── 2. every shift of a class counts ──
{
  const P67 = asset(rep(8, { cover: 0x0300, ink: 4 }));            // covered pixels 6 and 7 of the left byte
  // class 1 (shifts 1..3): s1: p6 -> 7 (cell 0), p7 -> 8 (cell 1); s2, s3: cell 1 only => both cells; a class starting at shift 2 would leave cell 0
  same('thin art at pixels 6, 7: class x1 / y0 covers cells 0 and 1 (shift 1 puts pixel 6 in cell 0)', row0(SI.classGrid(P67, 1, 0)), [4, 4, L]);
  const P1 = asset(rep(8, { cover: 0x4000, ink: 2 }));             // covered pixel 1 only
  // class 2 (shifts 4..7): s4..s6: pixel 1 -> 5..7 (cell 0), s7: -> 8 (cell 1) => both cells; class 1 (1..3): 2..4, always cell 0
  same('thin art at pixel 1: class x2 / y0 covers cells 0 and 1 (shift 7 puts pixel 1 in cell 1)', row0(SI.classGrid(P1, 2, 0)), [2, 2, L]);
  same('thin art at pixel 1: class x1 / y0 covers cell 0 only', row0(SI.classGrid(P1, 1, 0)), [2, L, L]);
  // y: only art row 6 covered, a full row: class y1 (shifts 1..3): s1: row 6 -> 7 (cell row 0), s2, s3 -> 8, 9 (cell row 1) => both cell rows
  const R6 = asset([...rep(6, { cover: 0, ink: 0 }), { cover: 0xFF00, ink: 6 }]);
  const g = SI.classGrid(R6, 0, 1);
  same('art row 6 only: class x0 / y1 covers cell rows 0 (shift 1) and 1 (shifts 2, 3)', [g[0][0], g[1][0], g[2][0]], [6, 6, L]);
  // a 2-phase asset is drawn at x shifts 0 and 4 only, but at every y shift
  const R6p = asset([...rep(6, { cover: 0, ink: 0 }), { cover: 0xFF00, ink: 6 }], { phases: 2 });
  const gp = SI.classGrid(R6p, 0, 1);
  same('a 2-phase asset keeps all its y shifts (x class 0, y class 1 is the same as with 8 phases)', [gp[0][0], gp[1][0], gp[2][0]], [6, 6, L]);
  same('...and has no x class 1 (shifts 1..3 are never drawn): the grid is all LEAVE', SI.classGrid(R6p, 1, 0), [[L, L, L], [L, L, L], [L, L, L]]);
  same('...and x class 2 is the shift 4 alone', SI.classGrid(asset(rep(8, { cover: 0xFF00, ink: 1 }), { phases: 2 }), 2, 0), [[1, 1, L], [L, L, L], [L, L, L]]);
  same('a 4-phase asset is drawn at shifts 0, 2, 4, 6: class 1 is the shift 2 alone (thin art at pixel 6: p6 -> 8)', row0(SI.classGrid(asset(rep(8, { cover: 0x0200, ink: 5 }), { phases: 4 }), 1, 0)), [L, 5, L]);
}

// ── 3. inks ──
{
  for (const ink of [0, 7]) same(`ink ${ink} is an ink like any other (a solid art block gives ${ink})`, row0(SI.classGrid(asset(rep(8, { cover: 0xFF00, ink })), 0, 0)), [ink, L, L]);
  same('an ink beyond 3 bits is cut to 3 bits (9 -> 1)', row0(SI.classGrid(asset(rep(8, { cover: 0xFF00, ink: 9 })), 0, 0)), [1, L, L]);
  // an asset without an `inks` array: every row reads as ink 7; without `h`: no rows at all
  const noInks = asset(rep(8, { cover: 0xFF00, ink: 3 })); delete noInks.inks;
  same('an asset without inks draws in ink 7', row0(SI.classGrid(noInks, 0, 0)), [7, L, L]);
  const noH = asset(rep(8, { cover: 0xFF00, ink: 3 })); delete noH.h;
  same('an asset without a height covers nothing: every cell LEAVE', SI.classGrid(noH, 0, 0), [[L, L, L], [L, L, L], [L, L, L]]);
}

// ── 4. spriteCellInks and inkAt ──
{
  const P67 = asset(rep(8, { cover: 0x0300, ink: 4 }));
  same('spriteCellInks takes the shift modulo 8 (9 is 1: cells 0 and 1 for pixels 6, 7)', SI.spriteCellInks(P67, 9, 0)[0], SI.spriteCellInks(P67, 1, 0)[0]);
  same('spriteCellInks at shift 1 is [4, 4, LEAVE] and at shift 2 [LEAVE, 4, LEAVE]', [SI.spriteCellInks(P67, 1, 0)[0], SI.spriteCellInks(P67, 2, 0)[0]], [[4, 4, L], [L, 4, L]]);
}

// ── 5. the clash check at a block's last pixel ──
{
  const C = asset([...rep(4, { cover: 0x8000, ink: 1 }), ...rep(4, { cover: 0x0100, ink: 2 })]);       // rows 0-3: pixel 0, ink 1; rows 4-7: pixel 7, ink 2
  same('a block whose second ink is only on its last pixel column is a clash (inks 1 and 2)', SI.inkClashes(C), [{ row: 0, col: 0, inks: [1, 2] }]);
  const D = asset([{ cover: 0xFF00, ink: 5 }, { cover: 0x00FF, ink: 3 }, ...rep(6, { cover: 0, ink: 0 })]);
  same('rows with several covered pixels count their ink once; the two blocks of one row are separate (no clash between columns)', SI.inkClashes(D), []);
}

// ── 6. applySpriteInk ──
{
  const A = asset(rep(8, { cover: 0xFF00, ink: 3 }));
  const B = asset(rep(8, { cover: 0xFF00, ink: 5 }));
  const bg = () => Array.from({ length: 768 }, (_, i) => (i * 37 + 11) & 0xFF);
  const at = (r, c) => r * 32 + c;
  const vis = (x, y) => ({ visible: 1, x, y });
  {
    const b = bg(), o = SI.applySpriteInk(b, [vis(8, 8)], [], [A, B]);
    check('an instance without an asset entry takes asset 0', o[at(1, 1)] === ((b[at(1, 1)] & 0xF8) | 3), `${o[at(1, 1)]} from ${b[at(1, 1)]}`);
  }
  {
    const b = bg(), o = SI.applySpriteInk(b, [vis(8, 8)], [7], [A, B]);
    check('an instance of an asset that does not exist is not drawn', json(o) === json(b));
  }
  {
    const b = bg(), o = SI.applySpriteInk(b, [vis(3, 8)], [0], [A]);
    // no `phases`: 8 positions, x = 3 is drawn at 3 (class 1): pixels 0..7 -> 3..10: cells 0 and 1 of the sprite's first cell (column 0)
    check('an asset without phases is drawn at the exact x (x = 3 covers columns 0 and 1)', o[at(1, 0)] === ((b[at(1, 0)] & 0xF8) | 3) && o[at(1, 1)] === ((b[at(1, 1)] & 0xF8) | 3));
  }
  {
    const b = bg(), o = SI.applySpriteInk(b, [vis(1, 8)], [0], [A]);
    // no `phases`: all 8 positions are drawn, x = 1 is class 1 (cells 0 and 1: pixels 0..7 land in 1..8), not rounded to a 4-phase position (x = 0, class 0, one cell)
    check('an asset without phases has 8 positions: x = 1 is drawn at 1 and covers cell column 1 too (a 4-phase default would round it to x = 0, one cell)', b[at(1, 1)] !== ((b[at(1, 1)] & 0xF8) | 3) && o[at(1, 1)] === ((b[at(1, 1)] & 0xF8) | 3), `${b[at(1, 1)]} -> ${o[at(1, 1)]}`);
  }
  {
    const b = bg().map((v) => v | 0x80), o = SI.applySpriteInk(b, [vis(8, 8)], [0], [A]);
    check('FLASH, BRIGHT and the paper stay the background\'s (only the low 3 bits change)', o[at(1, 1)] === ((b[at(1, 1)] & 0xF8) | 3) && (o[at(1, 1)] & 0x80) === 0x80);
  }
  {
    // two overlapping sprites: the later instance lies on top, the cell keeps the later ink; the background's paper / bright come from the cell, not from the earlier ink
    const b = bg(), o = SI.applySpriteInk(b, [vis(8, 8), vis(8, 8)], [0, 1], [A, B]);
    check('overlapping sprites: the later instance\'s ink wins, the rest of the byte is the background\'s', o[at(1, 1)] === ((b[at(1, 1)] & 0xF8) | 5));
    const o2 = SI.applySpriteInk(b, [vis(8, 8), vis(8, 8)], [1, 0], [A, B]);
    check('...and in the other order the other ink wins (instance order, not asset order)', o2[at(1, 1)] === ((b[at(1, 1)] & 0xF8) | 3));
  }
  {
    // a sprite partly outside the screen (never produced by SHOW's clamps) is cut, not wrapped: a plain Array shows a write past the end as a longer array
    const b = Array.from(bg());
    const o = SI.applySpriteInk(b, [vis(8, 190)], [0], [asset(rep(16, { cover: 0xFF00, ink: 3 }))]);
    check('a sprite below the screen writes no cell past the 768th', o.length === 768);
    const o2 = SI.applySpriteInk(b, [vis(250, 8)], [0], [asset(rep(16, { cover: 0xFFFF, ink: 6 }))]);
    check('a sprite at the right edge does not wrap into the next row (column 32 would be column 0 of the next row)', b[at(2, 0)] !== ((b[at(2, 0)] & 0xF8) | 6) && o2[at(1, 0)] === b[at(1, 0)] && o2[at(2, 0)] === b[at(2, 0)] && o2[at(1, 31)] === ((b[at(1, 31)] & 0xF8) | 6));
    const o3 = SI.applySpriteInk(b, [vis(16, 184)], [0], [asset(rep(16, { cover: 0xFFFF, ink: 3 }))]);
    check('a sprite on the last cell row (23) is drawn there', o3[at(23, 2)] === ((b[at(23, 2)] & 0xF8) | 3));
    const o4 = SI.applySpriteInk(b, [vis(248, 8)], [0], [asset(rep(16, { cover: 0xFFFF, ink: 3 }))]);
    check('a sprite on the last cell column (31) is drawn there', o4[at(1, 31)] === ((b[at(1, 31)] & 0xF8) | 3));
  }
  {
    const b = bg();
    SI.applySpriteInk(b, [vis(8, 8)], [0], [A]);
    check('the background array is not changed', json(b) === json(bg()));
  }
}
// ── 7. compile(): messages, positions, the word table, the interpreter's built flag ──
{
  const { readFileSync } = await import('node:fs');
  const { compile } = await import(join(ROOT, 'src/lang/arcade/arcade-compile.js'));
  const { parse } = await import(join(ROOT, 'src/lang/arcade/arcade-parse.js'));
  const { sceneDisplayPlan } = await import(join(ROOT, 'src/lang/arcade/arcade-display.js'));
  const { interpret } = await import(join(ROOT, 'src/lang/arcade/arcade-interp.js'));
  const { SRC, ASSETS } = await import(join(ROOT, 'arcade/tools/xemu/sc-ink-game.mjs'));
  const ld = (d) => ({ runtime: JSON.parse(readFileSync(join(ROOT, `arcade/dist/${d}/runtime.json`), 'utf8')), image: new Uint8Array(readFileSync(join(ROOT, `arcade/dist/${d}/runtime.bin`))) });
  const ink = ld('v2ink'), plainRt = ld('v2');
  const run = (text, rt, assets = ASSETS) => compile(text, { runtime: rt.runtime, image: rt.image, assets, scenes: assets.scenes });

  const onPlain = run(SRC, plainRt);
  same('an ink scene on a plain v2 runtime: one error that names the ink variant', onPlain.errors.map((e) => e.message), ["scene 's': spriteColour 'ink' needs the ink variant of runtime v2 (variant 'ink'); this runtime is not one"]);
  const noSym = { runtime: { ...ink.runtime, symbols: Object.fromEntries(Object.entries(ink.runtime.symbols).filter(([k]) => k !== 'RT_SPRITEINK')) }, image: ink.image };
  same('a runtime that says "ink" but has no RT_SPRITEINK: one error that names the scene', run(SRC, noSym).errors.map((e) => e.message), ["scene 's': spriteColour 'ink' needs RT_SPRITEINK, which this runtime does not provide (the ink variant of runtime v2)"]);
  const wire = SRC.replace('SPRITE ship = "ship"', 'WIRE3D ROWS 2 TO 21 INK 5 PAPER 0 BRIGHT 0\nSPRITE ship = "ship"');
  same('an ink scene in a WIRE3D game is an error', run(wire, ink).errors.map((e) => e.message), ['sprite colour needs the v2 runtime and no WIRE3D']);

  // the clash warning: one per ink scene and clashing block, marked at the scene's name
  const clashAssets = { ...ASSETS, sprites: { ...ASSETS.sprites, ship: { w: 16, h: 16, frames: [{ rows: Array.from({ length: 16 }, (_, k) => ({ bits: 'FFFF', mask: 'FFFF', ink: k < 4 ? 1 : 2 })) }] } } };
  const cw = run(SRC.replace('SCENE s\n', '  SCENE s\n'), ink, clashAssets).warnings.filter((w) => w.id === 'sprite-ink-clash');
  check('the clash warning is marked at the scene\'s name (line 5, columns 8 to 9 of "  SCENE s")', cw.length === 4 && cw.every((w) => w.line === 5 && w.col === 8 && w.endCol === 9), json(cw.map((w) => [w.line, w.col, w.endCol])));

  // the word table: 7 assets, so that an entry's high byte differs from one computed with 80 bytes per grid (asset 3: 2 * 7 + 3 * 81 = 257 against 254)
  const names = Array.from({ length: 7 }, (_, k) => 'sp' + k);
  const manyAssets = { sprites: Object.fromEntries(names.map((n, k) => [n, { w: 16, h: 8, frames: [{ rows: Array.from({ length: 8 }, () => ({ bits: 'FFFF', mask: 'FFFF', ink: (k % 7) + 1 })) }] }])), scenes: { s: { spriteColour: 'ink' } } };
  const manySrc = `GAME "m"\nFRAMERATE 30\n${names.map((n) => `SPRITE ${n} = "${n}"`).join('\n')}\nSCENE s\n  PROC INIT():\n${names.map((n, k) => `    SHOW ${n} AT ${8 + 24 * k}, 8\n`).join('')}  ENDP\n  PROC FRAME():\n  ENDP\nENDSCENE\n`;
  const many = run(manySrc, ink, manyAssets);
  check('the 7-asset ink game compiles', many.errors.length === 0 && !!many.gen?.ink, json(many.errors));
  if (many.gen?.ink) {
    const { tableAt } = many.gen.ink, code = many.gen.code, base = many.gen.base;
    const word = (a) => code[tableAt - base + 2 * a] | (code[tableAt - base + 2 * a + 1] << 8);
    check('the word table of the 7 assets points at tableAt + 14 + 81 * a, page by page', names.every((_, a) => word(a) === tableAt + 14 + 81 * a), names.map((_, a) => word(a) - tableAt).join(','));
  }

  // the display plan reads a spriteColour that is not text as "no setting" (an array of one word is not the word)
  const ast = parse('GAME "p"\nSCENE a\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n  ENDP\nENDSCENE\n').ast;
  const pl = sceneDisplayPlan(ast, { scenes: { a: { spriteColour: ['ink'] } }, version: 2 })[0];
  check('spriteColour: ["ink"] is not "ink": ignored with a note, nothing built', pl.spriteColour.built === 'none' && pl.spriteColour.setting === 'none' && pl.notes.length === 1, json(pl.spriteColour));

  // the interpreter builds the ink of a scene by the plan's built value, not by the setting: a fine scene with spriteColour 'ink' shows no ink
  const fineAssets = { ...ASSETS, scenes: { s: { display: 'fine', spriteColour: 'ink' } } };
  const r = interpret(parse(SRC).ast, { version: 2, ticks: 3, assets: fineAssets, scenes: fineAssets.scenes, maxSteps: 5_000_000 });
  const plain = interpret(parse(SRC).ast, { version: 2, ticks: 3, assets: fineAssets, maxSteps: 5_000_000 });
  const dflt = interpret(parse(SRC).ast, { ticks: 3, assets: ASSETS, scenes: ASSETS.scenes, maxSteps: 5_000_000 });      // no `version`: the interpreter's default is runtime v2, where the ink is built
  const none = interpret(parse(SRC).ast, { ticks: 3, assets: ASSETS, maxSteps: 5_000_000 });
  check('with no version given the interpreter builds the ink scene (default runtime v2): some tick\'s attrs differ from the run without scenes', dflt.ticks.some((t, i) => json(Array.from(t.attrs)) !== json(Array.from(none.ticks[i].attrs))));
  check('a fine scene with spriteColour ink: the interpreter applies no sprite ink (its attrs are the plain run\'s, no ink key)', !('ink' in r) && r.ticks.every((t, i) => json(Array.from(t.attrs)) === json(Array.from(plain.ticks[i].attrs))));
}
console.log(`\n${total} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
