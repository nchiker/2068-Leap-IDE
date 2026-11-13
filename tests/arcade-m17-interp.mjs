#!/usr/bin/env node
"use strict";
// arcade-m17-interp.mjs -- tests for the reference interpreter and the display model of the wireframe 3D (slice W3b): docs/ARCADE_WIREFRAME_CONTRACT.md sections 2.2 to 2.6.
//
//   node tests/arcade-m17-interp.mjs
//
// The interpreter (src/lang/arcade/arcade-interp.js) draws EYE / DRAWMODEL / LINE with src/lang/arcade/arcade-wire.js (the bit-exact reference, itself compared with the runtime by arcade/tests/m17-runtime-wire.mjs); the
// pictures it records (`rec.wire.bits`) are therefore compared here with arcade-wire.js drawn BY HAND, scene by scene. No machine is booted. Sections
//   1  the picture of a tick: clear + DRAWMODEL / LINE equal the reference drawn by hand (all ticks, both scales, outside-the-area clipping), the eye, the evaluation order, the model asset
//   2  the tick model: the clear at the start of every tick, INIT's drawing (not cleared before the first tick), nothing drawn outside the play rows
//   3  the eye: stored as written (x, y, z signed 16 bits, heading AND 255), kept across ticks, reset to 0, 0, 0, 0 by ENTER
//   4  NOVIEW scenes: the switch (on / off), DRAWMODEL and LINE do nothing while off, `fresh`, `show`
//   5  the display model (arcade-display.js wireLayer): lines and the declared attribute while on, the cell map hidden (kept) while on and shown again when off, sprites are the caller's, stale
//   6  what the interpreter refuses; games without WIRE3D are unchanged
import { parse } from '../src/lang/arcade/arcade-parse.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { wireLayer, sceneModes } from '../src/lang/arcade/arcade-display.js';
import { areaOf, clearArea, drawModel, drawLine, EYE0 } from '../src/lang/arcade/arcade-wire.js';

let passed = 0, failed = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const firstDiff = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return `byte ${i}: ${a[i]} vs ${b[i]}`; return 'equal'; };

// the models
const GATE = { points: [[-12, -12, 0], [12, -12, 0], [12, 12, 0], [-12, 12, 0]], edges: [[0, 1], [1, 2], [2, 3], [3, 0]] };
const SHIP = { points: [[0, 0, 24], [-16, 0, -16], [16, 0, -16], [0, 8, -8], [0, -8, -8]], edges: [[0, 1], [0, 2], [1, 2], [0, 3], [0, 4], [3, 1], [3, 2], [4, 1], [4, 2]] };
const MODELS = { gate: GATE, ship: SHIP };

const HEAD = (rows = 'ROWS 2 TO 21 INK 5 PAPER 0 BRIGHT 1') => `GAME "w"\nFRAMERATE 20\nWIRE3D ${rows}\nMODEL gate = "gate"\nMODEL ship = "ship"\nDIM t, a\n`;
const scene = (name, init, frame, mode = '') => `SCENE ${name}${mode}\n  PROC INIT()\n${init}  ENDP\n  PROC FRAME()\n${frame}  ENDP\nENDSCENE\n`;
const run = (src, ticks, opts = {}) => {
  const p = parse(src);
  if (p.errors.length) throw new Error(`test bug: ${p.errors.map((e) => `${e.line}: ${e.message}`).join(' | ')}`);
  return interpret(p.ast, { ticks, version: 2, assets: { models: MODELS }, ...opts });
};
const AREA = areaOf(2, 21);
/** What the reference draws by hand in one tick: clear, then the operations in order. */
const byHand = (area, ops) => {
  const bm = new Uint8Array(6144);
  clearArea(bm, area);
  let eye = { ...EYE0 };
  for (const o of ops) {
    if (o.eye) eye = o.eye;
    else if (o.model) drawModel(bm, MODELS[o.model], o.pose, eye, area);
    else drawLine(bm, ...o.line, area);
  }
  return bm;
};
const lit = (bm) => bm.reduce((n, v) => n + v.toString(2).replace(/0/g, '').length, 0);
const rowOfByte = (off) => ((off >> 8) & 7) | (((off >> 5) & 7) << 3) | (((off >> 11) & 3) << 6);     // the pixel row of a display file offset

// =================================================================================================================
// 1. The picture of a tick
// =================================================================================================================
console.log('1. the picture of a tick equals the reference drawn by hand');
{
  const src = HEAD() + scene('s', '', '    t = t + 1\n    EYE 10 * t, 0, 5, t * 4\n    DRAWMODEL gate AT 100 + t, 0, 400 YAW t * 6\n    DRAWMODEL ship AT 0, 20, 300 YAW t PITCH t * 3 SCALE 2\n    LINE 10, 20 TO 250 - t, 100\n');
  const res = run(src, 12);
  let bad = '', total = 0;
  res.ticks.forEach((rec, k) => {
    const t = k + 1, eye = { x: 10 * t, y: 0, z: 5, a: (t * 4) & 255 };
    const want = byHand(AREA, [{ eye }, { model: 'gate', pose: { x: 100 + t, y: 0, z: 400, yaw: t * 6, pitch: 0, scale: 1 } }, { model: 'ship', pose: { x: 0, y: 20, z: 300, yaw: t, pitch: t * 3, scale: 2 } }, { line: [10, 20, 250 - t, 100] }]);
    total += lit(want);
    if (!same(rec.wire.bits, want)) bad += `tick ${t}: ${firstDiff(rec.wire.bits, want)}; `;
  });
  check_('12 ticks of EYE + 2 DRAWMODELs (yaw, pitch, SCALE 2) + LINE: every byte of the play area equals the reference', bad === '' && total > 500, bad || `${total} lit pixels in all`);
  check_('the pictures are not empty and change from tick to tick', res.ticks.every((r) => lit(r.wire.bits) > 40) && !same(res.ticks[0].wire.bits, res.ticks[1].wire.bits));
  check_('the record carries the declaration: r0, r1, attr = bright << 6 | paper << 3 | ink', res.ticks[0].wire.r0 === 2 && res.ticks[0].wire.r1 === 21 && res.ticks[0].wire.attr === 0x45, JSON.stringify({ ...res.ticks[0].wire, bits: 0 }));
  check_('bits is a 6,144-byte copy per record (a later tick does not change an earlier record)', res.ticks[0].wire.bits.length === 6144 && res.ticks[0].wire.bits !== res.ticks[1].wire.bits);
}
for (const k of [1, 2, 4, 8]) {
  const z = 150 * k;
  const res = run(HEAD() + scene('s', '', `    DRAWMODEL ship AT 0, 0, ${z} YAW 30 PITCH 20 SCALE ${k}\n`), 1);
  const want = byHand(AREA, [{ model: 'ship', pose: { x: 0, y: 0, z, yaw: 30, pitch: 20, scale: k } }]);
  check_(`SCALE ${k}: equals the reference`, same(res.ticks[0].wire.bits, want) && lit(want) > 20, firstDiff(res.ticks[0].wire.bits, want));
}
{
  const res = run(HEAD('ROWS 5 TO 12') + scene('s', '', '    DRAWMODEL ship AT 0, 0, 120 YAW 10 SCALE 8\n    LINE -50, -50 TO 400, 300\n    LINE 0, 40 TO 255, 40\n    LINE 0, 103 TO 255, 103\n    LINE 0, 104 TO 255, 104\n'), 1);
  const bits = res.ticks[0].wire.bits, area = areaOf(5, 12);
  const want = byHand(area, [{ model: 'ship', pose: { x: 0, y: 0, z: 120, yaw: 10, pitch: 0, scale: 8 } }, { line: [-50, -50, 400, 300] }, { line: [0, 40, 255, 40] }, { line: [0, 103, 255, 103] }, { line: [0, 104, 255, 104] }]);
  let outside = 0;
  for (let i = 0; i < 6144; i++) if (bits[i] && (rowOfByte(i) < 40 || rowOfByte(i) > 103)) outside++;
  check_('ROWS 5 TO 12 (an 8-row play area, a SCALE 8 ship and lines that cross it): equals the reference, clipped, and no pixel outside pixel rows 40..103', same(bits, want) && outside === 0 && lit(want) > 100, firstDiff(bits, want) + `, ${outside} outside`);
  check_('... a line along the last row (103) is drawn, one along the row below (104) is not', bits[0x0000 | ((103 & 7) << 8) | (((103 >> 3) & 7) << 5) | ((103 >> 6) << 11)] === 0xFF && bits[((104 & 7) << 8) | (((104 >> 3) & 7) << 5) | ((104 >> 6) << 11)] === 0);
}
{
  // evaluation order: x, y, z, YAW, PITCH, whatever the order of the clauses
  const seq = [10, 20, 100, 40, 5];
  let i = 0;
  const res = run(HEAD() + scene('s', '', '    DRAWMODEL ship AT RND(1000), RND(1000), RND(1000) PITCH RND(1000) YAW RND(1000)\n'), 1, { rnd: () => seq[i++] });
  const right = byHand(AREA, [{ model: 'ship', pose: { x: 10, y: 20, z: 100, yaw: 40, pitch: 5, scale: 1 } }]);
  const swapped = byHand(AREA, [{ model: 'ship', pose: { x: 10, y: 20, z: 100, yaw: 5, pitch: 40, scale: 1 } }]);
  check_('operands are evaluated x, y, z, yaw, pitch whatever the order of the clauses (PITCH written first is evaluated last)', same(res.ticks[0].wire.bits, right) && !same(right, swapped) && lit(right) > 10, firstDiff(res.ticks[0].wire.bits, right));
  let j = 0;
  const l = run(HEAD() + scene('s', '', '    LINE RND(1000), RND(1000) TO RND(1000), RND(1000)\n'), 1, { rnd: () => [5, 6, 200, 90][j++] });
  check_('LINE evaluates x0, y0, x1, y1 in that order', same(l.ticks[0].wire.bits, byHand(AREA, [{ line: [5, 6, 200, 90] }])));
}
{
  const res = run(HEAD() + scene('s', '', '    DRAWMODEL GATE AT 0, 0, 200\n'), 1, { assets: { models: { Gate: GATE, ship: SHIP } } });
  check_('the model asset is found ignoring case (as every asset)', lit(res.ticks[0].wire.bits) > 10);
  const sc = run(HEAD() + scene('s', '', '    DRAWMODEL gate AT 0, 0, 200 SCALE 4\n'), 1);
  check_('SCALE is the constant of the statement (a model at SCALE 4 is bigger than at SCALE 1)', lit(sc.ticks[0].wire.bits) > lit(byHand(AREA, [{ model: 'gate', pose: { x: 0, y: 0, z: 200, scale: 1 } }])));
  const far = run(HEAD() + scene('s', '', '    DRAWMODEL gate AT 20000, 0, 200\n    DRAWMODEL gate AT 0, 0, 5\n    DRAWMODEL ship AT 0, 0, 40000\n'), 1);
  check_('a model more than 16,000 away, one with a near end and a z that wraps: nothing is drawn (the reference\'s guards)', lit(far.ticks[0].wire.bits) === 0 || same(far.ticks[0].wire.bits, byHand(AREA, [{ model: 'gate', pose: { x: 20000, y: 0, z: 200, scale: 1 } }, { model: 'gate', pose: { x: 0, y: 0, z: 5, scale: 1 } }, { model: 'ship', pose: { x: 0, y: 0, z: 40000 - 65536, scale: 1 } }])));
}

// =================================================================================================================
// 2. The tick model
// =================================================================================================================
console.log('\n2. the tick: clear first, then draw');
{
  const res = run(HEAD() + scene('s', '    LINE 0, 30 TO 255, 30\n', '    t = t + 1\n    IF t = 1 THEN\n      LINE 0, 40 TO 255, 40\n    ENDIF\n    IF t = 3 THEN\n      DRAWMODEL gate AT 0, 0, 200\n    ENDIF\n'), 4);
  const row = (bits, y) => bits[((y & 7) << 8) | (((y >> 3) & 7) << 5) | ((y >> 6) << 11)];
  check_('INIT draws (the clear runs at the start of a tick, not before INIT): the init record has its line and fresh false', row(res.init.wire.bits, 30) === 0xFF && res.init.wire.fresh === false && res.init.wire.on === true);
  check_('tick 1: the clear wiped INIT\'s line; FRAME\'s own line is there; fresh', row(res.ticks[0].wire.bits, 30) === 0 && row(res.ticks[0].wire.bits, 40) === 0xFF && res.ticks[0].wire.fresh === true);
  check_('tick 2: nothing is drawn, so the play area is empty (the clear runs every tick)', lit(res.ticks[1].wire.bits) === 0 && res.ticks[1].wire.fresh === true);
  check_('tick 3: only the model of this tick', same(res.ticks[2].wire.bits, byHand(AREA, [{ model: 'gate', pose: { x: 0, y: 0, z: 200, scale: 1 } }])));
  check_('tick 4: empty again', lit(res.ticks[3].wire.bits) === 0);
}
{
  const res = run(HEAD() + scene('s', '', '    LINE 0, 0 TO 255, 191\n    LINE 0, 191 TO 255, 0\n    DRAWMODEL ship AT 0, 0, 90 SCALE 8\n'), 1);
  let out = 0;
  for (let i = 0; i < 6144; i++) if (res.ticks[0].wire.bits[i] && (rowOfByte(i) < 16 || rowOfByte(i) > 175)) out++;
  check_('ROWS 2 TO 21: no pixel is ever drawn on the character rows 0, 1, 22, 23 (the HUD rows)', out === 0 && lit(res.ticks[0].wire.bits) > 100, `${out} pixels outside`);
}

// =================================================================================================================
// 3. The eye
// =================================================================================================================
console.log('\n3. the eye');
{
  // EYE in INIT only: it is kept for every tick; the heading is taken AND 255 and x, y, z are signed 16 bits
  const res = run(HEAD() + scene('s', '    EYE 40000, -3, 70000, 300\n', '    DRAWMODEL gate AT -25349, -3, 4564 YAW 44\n'), 2);
  const eye = { x: -25536, y: -3, z: 4464, a: 44 };
  const want = byHand(AREA, [{ eye }, { model: 'gate', pose: { x: -25349, y: -3, z: 4564, yaw: 44, pitch: 0, scale: 1 } }]);
  check_('EYE 40000, -3, 70000, 300 keeps -25536, -3, 4464 and heading 44 (signed 16 bits, AND 255), for every later tick', same(res.ticks[0].wire.bits, want) && same(res.ticks[1].wire.bits, want) && lit(want) > 8, firstDiff(res.ticks[0].wire.bits, want));
  check_('the record\'s eye is what was stored', JSON.stringify(res.ticks[1].wire.eye) === JSON.stringify(eye), JSON.stringify(res.ticks[1].wire.eye));
  const heading = run(HEAD() + scene('s', '', '    EYE 0, 0, 0, -1\n'), 1);
  check_('a negative heading is taken AND 255: -1 is 255', heading.ticks[0].wire.eye.a === 255);
  const none = run(HEAD() + scene('s', '', '    t = t + 1\n'), 1);
  check_('the eye is 0, 0, 0, 0 at the start (init and every tick until an EYE)', JSON.stringify(none.init.wire.eye) === JSON.stringify(EYE0) && JSON.stringify(none.ticks[0].wire.eye) === JSON.stringify(EYE0));
  const seen = run(HEAD() + scene('s', '', '    DRAWMODEL gate AT 0, 0, 100\n    EYE 30, 0, 0, 8\n    DRAWMODEL gate AT 0, 0, 100\n'), 1);
  check_('a DRAWMODEL uses the eye as it was when the statement ran (before and after an EYE in the same tick)', same(seen.ticks[0].wire.bits, byHand(AREA, [{ model: 'gate', pose: { x: 0, y: 0, z: 100, scale: 1 } }, { eye: { x: 30, y: 0, z: 0, a: 8 } }, { model: 'gate', pose: { x: 0, y: 0, z: 100, scale: 1 } }])));
  // ENTER resets the eye (boot value 0, 0, 0, 0), also between two scenes that both show the play area
  const two = run(HEAD() + scene('a', '    EYE 5, 6, 7, 8\n', '    t = t + 1\n    IF t = 2 THEN\n      ENTER b\n    ENDIF\n') + scene('b', '', '    DRAWMODEL gate AT 0, 0, 200\n'), 4);
  const e = two.ticks.map((r) => r.wire.eye);
  check_('ENTER resets the eye to 0, 0, 0, 0 (scene a had EYE 5, 6, 7, 8; after the switch in tick 2 the eye is 0)', JSON.stringify(e[0]) === '{"x":5,"y":6,"z":7,"a":8}' && JSON.stringify(e[1]) === JSON.stringify(EYE0) && JSON.stringify(e[2]) === JSON.stringify(EYE0), JSON.stringify(e));
  check_('... and scene b draws with the reset eye', same(two.ticks[2].wire.bits, byHand(AREA, [{ model: 'gate', pose: { x: 0, y: 0, z: 200, scale: 1 } }])));
  // between two scenes that both show the play area nothing is cleared by the switch itself
  check_('a switch from one play scene to another keeps the play area on and the lines of that tick (no clear): fresh stays true', two.ticks[1].wire.on === true && two.ticks[1].wire.fresh === true);
}

// =================================================================================================================
// 4. NOVIEW scenes
// =================================================================================================================
console.log('\n4. NOVIEW scenes: the switch');
{
  const TITLE = scene('title', '    PRINT AT 10, 5; "TITLE"\n    EYE 9, 9, 9, 9\n', '    t = t + 1\n    DRAWMODEL gate AT 0, 0, 200\n    LINE 0, 50 TO 255, 60\n    IF t MOD 2 = 0 THEN\n      ENTER play\n    ENDIF\n', ' NOVIEW');
  const PLAY = scene('play', '    LINE 0, 70 TO 255, 70\n', '    a = a + 1\n    DRAWMODEL gate AT 0, 0, 200\n    IF a = 3 THEN\n      ENTER title\n    ENDIF\n');
  const res = run(HEAD() + TITLE + PLAY, 8);
  const R = [res.init, ...res.ticks];
  check_('every record has show: a NOVIEW scene is "screen", a scene with the play area "wire"', R.map((r) => r.show).join() === 'screen,screen,wire,wire,wire,screen,screen,wire,wire', R.map((r) => r.show).join());
  check_('on follows show (off in the title, on in play)', R.every((r) => r.wire.on === (r.show === 'wire')));
  check_('the first scene is NOVIEW: the play area is off from the start; nothing is drawn there (DRAWMODEL and LINE do nothing), the eye is stored', res.init.wire.on === false && lit(res.init.wire.bits) === 0 && JSON.stringify(res.init.wire.eye) === '{"x":9,"y":9,"z":9,"a":9}' && R[1].wire.on === false && lit(R[1].wire.bits) === 0 && lit(R[2].wire.bits) > 0);
  // record 2 (tick 2): the title ENTERs play: the play area switches on in that tick and the switch clears the hidden file's play area at once (contract 2.6 as amended), the eye is reset, play's INIT draws its line
  const r2 = R[2];
  const lineOnly = new Uint8Array(6144); drawLine(lineOnly, 0, 70, 255, 70, AREA);
  check_('tick 2 (title -> play): on, fresh (the switch cleared the hidden file\'s play area), the eye 0, 0, 0, 0, and the bits are exactly play\'s INIT line (nothing drawn in the title reached them)', r2.wire.on && r2.wire.fresh && JSON.stringify(r2.wire.eye) === JSON.stringify(EYE0) && same(r2.wire.bits, lineOnly), firstDiff(r2.wire.bits, lineOnly));
  check_('tick 3 (play, started on): fresh, cleared, the model drawn with eye 0', R[3].wire.on && R[3].wire.fresh && same(R[3].wire.bits, byHand(AREA, [{ model: 'gate', pose: { x: 0, y: 0, z: 200, scale: 1 } }])));
  check_('tick 5 (play -> title): off, the bitmap is empty, show screen', !R[5].wire.on && lit(R[5].wire.bits) === 0 && R[5].show === 'screen');
  check_('tick 6 (title again, off from the start of the tick): no pixel, fresh false', !R[6].wire.on && lit(R[6].wire.bits) === 0 && !R[6].wire.fresh);
  check_('the second visit to play (tick 7): on, fresh (cleared by the switch), the INIT line', R[7].wire.on && R[7].wire.fresh && same(R[7].wire.bits, lineOnly));
  check_('the following tick of play is fresh again', R[8].wire.fresh && R[8].wire.on);
  // two ENTERs in one tick (a ring of INITs): the last scene decides
  const ring = run(HEAD() + scene('a', '', '    ENTER b\n') + scene('b', '    ENTER c\n', '', ' NOVIEW') + scene('c', '    LINE 0, 80 TO 255, 80\n', ''), 2);
  const l80 = new Uint8Array(6144); drawLine(l80, 0, 80, 255, 80, AREA);
  check_('a -> b (NOVIEW) -> c in one tick: the play area went off and on again (the switch on cleared it), so only c\'s line is there and the tick is fresh', ring.ticks[0].wire.on && ring.ticks[0].wire.fresh && same(ring.ticks[0].wire.bits, l80), firstDiff(ring.ticks[0].wire.bits, l80));
  // a game with no NOVIEW scene: no `show` key (as batch 7)
  const plain = run(HEAD() + scene('s', '', '    t = t + 1\n'), 1);
  check_('a game without a NOVIEW scene has no `show` key in its records', plain.ticks[0].show === undefined && plain.init.show === undefined);
  check_('sceneModes of a WIRE3D game: "wire" for a scene with the play area, "screen" for NOVIEW', JSON.stringify(sceneModes(parse(HEAD() + TITLE + PLAY).ast).map((m) => m.show)) === '["screen","wire"]');
}

// =================================================================================================================
// 5. The display model
// =================================================================================================================
console.log('\n5. the display model: wireLayer');
{
  const off = (bm, y, c) => ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2) | c;
  const cellBits = new Uint8Array(6144).map((_, i) => 0xA0 | (i & 7)), cellAttrs = new Uint8Array(768).fill(0x38);
  const src = HEAD().replace('MODEL gate', 'TILESET ts = "ts"\nMODEL gate') + scene('s', '', '    t = t + 1\n    PRINT AT 10, 5; "HI"\n    PRINT AT 0, 0; "SC"\n    TILE 3, 22 = 0\n    DRAWMODEL gate AT 0, 0, 200\n');
  const r2 = run(src, 2, { assets: { models: MODELS, tilesets: { ts: { tiles: [{ rows: Array.from({ length: 8 }, () => ({ bits: 0xFF, ink: 1, paper: 2 })) }] } } } });
  const rec = r2.ticks[1];
  check_('the cell map keeps PRINT and TILE in the play rows (cell 10,5 = "H") and outside them (0,0 = "S", 3,22 a tile)', rec.cells[10 * 32 + 5] === 72 && rec.cells[0] === 83 && rec.cells[22 * 32 + 3] === 128);
  const lay = wireLayer(rec, cellBits, cellAttrs);
  let inRows = true, outRows = true;
  for (let y = 0; y < 192; y++) for (let c = 0; c < 32; c++) {
    const inside = y >= 16 && y < 176, o = off(0, y, c);
    if (inside ? lay.bits[o] !== rec.wire.bits[o] : lay.bits[o] !== cellBits[o]) { if (inside) inRows = false; else outRows = false; }
  }
  check_('while on, the play rows of the picture are the lines (the cells there, the text "HI", are not shown); the rows outside are the cell picture', inRows && outRows && lit(rec.wire.bits) > 5);
  let attrOk = true;
  for (let r = 0; r < 24; r++) for (let c = 0; c < 32; c++) if (lay.attrs[r * 32 + c] !== (r >= 2 && r <= 21 ? 0x45 : 0x38)) attrOk = false;
  check_('while on, the attribute cells of rows 2..21 are the declared one ($45: INK 5, PAPER 0, BRIGHT 1), the others the cell map\'s', attrOk);
  check_('the input arrays are not changed (wireLayer returns copies)', cellBits.every((v, i) => v === (0xA0 | (i & 7))) && cellAttrs.every((v) => v === 0x38));
  check_('fresh: a normal tick is not stale', lay.stale === false && rec.wire.fresh === true);
  const l0 = wireLayer(r2.init, cellBits, cellAttrs);
  check_('init (no clear ran before INIT): stale true, the play rows hold more than the lines', l0.stale === true);
}
{
  const src = HEAD() + scene('play', '    PRINT AT 10, 5; "OLD"\n', '    t = t + 1\n    IF t = 1 THEN\n      ENTER menu\n    ENDIF\n') + scene('menu', '    PRINT AT 10, 5; "MENU"\n', '    t = t + 1\n', ' NOVIEW');
  const res = run(src, 2);
  const rec = res.ticks[0];
  const cellBits = new Uint8Array(6144).map((_, i) => (i * 7) & 255), cellAttrs = new Uint8Array(768).map((_, i) => i & 63);
  const lay = wireLayer(rec, cellBits, cellAttrs);
  check_('after the switch off (ENTER a NOVIEW scene) every cell of the cell map is shown again, the play rows included: the picture is the cell picture, text of the new scene at row 10 in the cell map', rec.wire.on === false && same(lay.bits, cellBits) && same(lay.attrs, cellAttrs) && lay.stale === false && rec.cells[10 * 32 + 5] === 77);
  const no = wireLayer({}, cellBits, cellAttrs);
  check_('a record without `wire` (a game without WIRE3D) is returned as it is', same(no.bits, cellBits) && same(no.attrs, cellAttrs) && no.stale === false);
}
{
  // the cell map is also kept while on: text printed in the play scene is there when the scene entered later does not clear it (a NOVIEW scene entered by ENTER does clear: CLS)
  const res = run(HEAD() + scene('s', '', '    PRINT AT 12, 3; "KEEP"\n'), 1);
  check_('text printed into the play rows while on is kept in the cell map ("KEEP" at 12, 3)', [75, 69, 69, 80].every((c, i) => res.ticks[0].cells[12 * 32 + 3 + i] === c));
}

// =================================================================================================================
// 6. Refusals and unchanged games
// =================================================================================================================
console.log('\n6. refusals, and a game without WIRE3D');
{
  const throws = (name, fn, part) => { try { fn(); check_(name, false, 'no error'); } catch (e) { check_(name, e.message.includes(part), e.message); } };
  throws('a MODEL whose asset is not in the project: "interp: unsupported a MODEL whose asset"', () => run(HEAD() + scene('s', '', ''), 1, { assets: { models: { gate: GATE } } }), 'a MODEL whose asset "ship" is not in the project');
  throws('a model that fails the contract (a coordinate beyond 64)', () => run(HEAD() + scene('s', '', ''), 1, { assets: { models: { gate: GATE, ship: { points: [[65, 0, 0]], edges: [[0, 0]] } } } }), 'a MODEL with a bad asset');
  throws('WIRE3D on the v3 runtime', () => run(HEAD() + scene('s', '', ''), 1, { version: 3 }), 'WIRE3D outside the v2 runtime');
  const plain = interpret(parse('GAME "p"\nDIM t\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    t = t + 1\n  ENDP\nENDSCENE\n').ast, { ticks: 2, version: 2 });
  check_('a game without WIRE3D: no `wire` key in any record, no `show`', plain.init.wire === undefined && plain.ticks.every((r) => r.wire === undefined && r.show === undefined) && Object.keys(plain.ticks[0]).join() === Object.keys(plain.init).join());
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
