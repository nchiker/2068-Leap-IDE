"use strict";
// sprite-model.mjs -- tests for src/tools/sprite-model.js (the Leap Arcade Studio sprite editor's data model).
//   node tests/sprite-model.mjs
//   SPRITE_QUICK=1 node tests/sprite-model.mjs     (fewer fuzz steps)
//
// Sections
//   1  creation, the stored form (hex), a round trip through the real example assets
//   2  pixels, layers, bounds
//   3  the two-colours-per-row rule: painting, row colours, a fuzz over every operation
//   4  frame operations, flips, rotate, shift, clear, invert, resize
//   5  mask helpers (auto mask, outline)
//   6  onion skin and the display families (flip = 8x8 cells, hires = 1 bit)
//   7  image import: synthetic images with known answers
//   8  validation against the compiler's limits (checked against the real compiler's own errors) and byte sizes
//   9  undo / redo
//   R  the REAL compiler and runtime: random sprites authored with the model, compiled with a SHOW program, booted on a stock TS2068
//      (TSRun) and the displayed picture compared with the sprite as edited. Skips when arcade/build/v2/runtime.json is absent.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as M from '../src/tools/sprite-model.js';
import { compile } from '../src/lang/arcade/arcade-compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const QUICK = !!process.env.SPRITE_QUICK;

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  cond ? passed++ : failed++;
  return cond;
};
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** A sprite from ASCII art: '#' ink, '-' paper (covered), '.' transparent. Row colours from `colours[y]` or the default. */
function art(rows, colours = []) {
  const w = rows[0].length <= 8 ? 8 : 16;
  rows = rows.map((r) => r.padEnd(w, '.'));
  while (rows.length < (rows.length <= 8 ? 8 : rows.length) && rows.length < w && w === 8) rows.push('.'.repeat(w));
  const s = M.newSprite(w, rows.length);
  rows.forEach((line, y) => {
    if (colours[y]) M.setRowColours(s, 0, y, colours[y]);
    [...line].forEach((ch, x) => { if (ch === '#') M.paintRole(s, 0, x, y, 'ink'); else if (ch === '-') M.paintRole(s, 0, x, y, 'paper'); });
  });
  return s;
}
const keysOf = (s, f = 0) => [...M.framePixels(s, f)];

// ── 1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n1. Creation and the stored form');
{
  const s = M.newSprite(16, 12);
  ok('newSprite(16, 12): one frame of 12 transparent rows, default colours, 8 phases, no hot box',
    s.w === 16 && s.h === 12 && s.frames.length === 1 && s.frames[0].rows.length === 12 && s.frames[0].rows.every((r) => r.bits === 0 && r.mask === 0 && r.ink === 7 && r.paper === 0 && r.bright === 1) && s.phases === 8 && s.hot === null);
  ok('newSprite rejects widths other than 8 / 16 / 24 / 32 and heights outside 1..48', throws(() => M.newSprite(12, 8)) && throws(() => M.newSprite(8, 0)) && throws(() => M.newSprite(8, 49)) && !throws(() => M.newSprite(32, 48)));
  const a = M.toAsset(M.newSprite(24, 2));
  ok('toAsset writes hex of ceil(w/8) bytes per row for 8 / 16 / 24 / 32', a.frames[0].rows[0].bits === '000000' && M.toAsset(M.newSprite(8, 1)).frames[0].rows[0].bits === '00' && M.toAsset(M.newSprite(32, 1)).frames[0].rows[0].mask === '00000000' && M.toAsset(M.newSprite(16, 1)).frames[0].rows[0].bits === '0000');
  let all = 0, exact = 0;
  for (const f of ['shooter', 'bounce', 'breakout']) {
    const doc = JSON.parse(readFileSync(join(ROOT, `arcade/examples/${f}.assets.json`), 'utf8'));
    for (const [name, asset] of Object.entries(doc.sprites ?? {})) {
      all++;
      const back = M.toAsset(M.fromAsset(asset));
      const pick = (x) => x.frames.map((fr) => fr.rows.map((r) => [String(r.bits).toUpperCase(), String(r.mask).toUpperCase()]));
      if (same(pick(back), pick(asset)) && back.w === asset.w && back.h === asset.h && same(back.hot ?? null, asset.hot ?? null) && (back.phases === (asset.phases ?? 8))) exact++;
      else console.log('     differs:', f, name);
    }
  }
  ok(`fromAsset -> toAsset reproduces bits, mask, size, hot and phases of every sprite in the example assets (${all} sprites)`, all >= 8 && exact === all);
  const shooter = JSON.parse(readFileSync(join(ROOT, 'arcade/examples/shooter.assets.json'), 'utf8')).sprites;
  const ship = M.fromAsset(shooter.ship);
  ok('the shooter ship keeps its row colours (ink 7, paper 0, bright 1) and an asset without colours gets the defaults',
    ship.frames[0].rows.every((r) => r.ink === 7 && r.paper === 0 && r.bright === 1) && M.fromAsset({ w: 8, h: 1, frames: [{ rows: [{ bits: 'FF' }] }] }).frames[0].rows[0].mask === 255);
  ok('fromAsset reads the M2 shape (top-level rows) and numeric bits; it names the problem otherwise',
    M.fromAsset({ w: 8, h: 2, rows: [{ bits: 0x81, mask: 0xFF }, { bits: '18' }] }).frames[0].rows[0].bits === 0x81
    && throws(() => M.fromAsset({ w: 8, h: 2, frames: [{ rows: [{ bits: 'FF' }] }] })) && throws(() => M.fromAsset({ w: 8, h: 1, frames: [{ rows: [{ bits: 'ZZ' }] }] })) && throws(() => M.fromAsset(null)));
  const c = M.cloneSprite(ship); c.frames[0].rows[0].bits = 5;
  ok('cloneSprite is deep', ship.frames[0].rows[0].bits !== 5);
}

// ── 2 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n2. Pixels and layers');
{
  const s = M.newSprite(32, 4);
  ok('setPixel on both layers at the first and the last column of a 32 wide row (unsigned bits)',
    M.setPixel(s, 0, 0, 0, 'image', 1) && M.setPixel(s, 0, 31, 0, 'image', 1) && M.setPixel(s, 0, 0, 0, 'mask', 1) && M.setPixel(s, 0, 31, 0, 'mask', 1)
    && s.frames[0].rows[0].bits === 0x80000001 && M.toAsset(s).frames[0].rows[0].bits === '80000001' && M.getPixel(s, 0, 31, 0) === 1 && M.getPixel(s, 0, 30, 0) === 0);
  ok('setPixel returns false when nothing changes or the pixel is outside', !M.setPixel(s, 0, 0, 0, 'image', 1) && !M.setPixel(s, 0, 32, 0, 'image', 1) && !M.setPixel(s, 0, 0, 4, 'mask', 1) && M.getPixel(s, 0, -1, 0) === 0);
  M.setPixel(s, 0, 5, 1, 'image', 1);
  ok('a pixel is transparent until its mask bit is set; erasing keeps the bit under it', M.pixelKey(s, 0, 5, 1) === -1
    && (M.setPixel(s, 0, 5, 1, 'mask', 1), M.pixelKey(s, 0, 5, 1) === M.colourKey(7, 1)) && M.erasePixel(s, 0, 5, 1) && M.pixelKey(s, 0, 5, 1) === -1 && M.getPixel(s, 0, 5, 1) === 1);
  ok('line() includes both ends and has no gaps', (() => { const l = M.line(0, 0, 7, 3); return l[0].join() === '0,0' && l.at(-1).join() === '7,3' && l.every((p, i) => i === 0 || (Math.abs(p[0] - l[i - 1][0]) <= 1 && Math.abs(p[1] - l[i - 1][1]) <= 1)) && l.length === 8; })());
}

// ── 3 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n3. The two-colours-per-row rule');
{
  const K = M.colourKey;
  const s = M.newSprite(8, 2, { ink: 2, paper: 1, bright: 0 });                     // red on blue, normal
  M.paintColour(s, 0, 0, 0, K(2, 0)); M.paintColour(s, 0, 1, 0, K(1, 0));
  ok('painting a colour the row has picks ink (bit 1) or paper (bit 0) and covers the pixel', s.frames[0].rows[0].bits === 0x80 && s.frames[0].rows[0].mask === 0xC0 && M.pixelKey(s, 0, 0, 0) === K(2, 0) && M.pixelKey(s, 0, 1, 0) === K(1, 0));
  const r = M.paintColour(s, 0, 2, 0, K(4, 0));
  ok('painting a third colour re-colours the row (the less used role) and says so; the row still has exactly two colours',
    r.recoloured === 'ink' || r.recoloured === 'paper');
  const keys = new Set(); for (let x = 0; x < 8; x++) { const k = M.pixelKey(s, 0, x, 0); if (k >= 0) keys.add(k); }
  ok('... covered pixels of a row never show more than two colours', keys.size <= 2 && keys.has(K(4, 0)), [...keys].join(','));
  const t = M.newSprite(8, 1, { ink: 2, paper: 1, bright: 0 });
  for (let x = 0; x < 8; x++) M.paintRole(t, 0, x, 0, x < 6 ? 'ink' : 'paper');
  M.setRowColours(t, 0, 0, { ink: 4 });
  ok('setRowColours changes the row\'s pixels: every ink pixel takes the new colour, paper pixels do not', M.pixelKey(t, 0, 0, 0) === K(4, 0) && M.pixelKey(t, 0, 7, 0) === K(1, 0));
  M.setRowColours(t, 0, 0, { bright: 1 });
  ok('the bright flag is one per row: both colours go bright', M.pixelKey(t, 0, 0, 0) === K(4, 1) && M.pixelKey(t, 0, 7, 0) === K(1, 1));
  ok('invalid row colours are refused and change nothing', !M.setRowColours(t, 0, 0, { ink: 8 }) && !M.setRowColours(t, 0, 0, { bright: 2 }) && !M.setRowColours(t, 0, 0, { paper: -1 }) && t.frames[0].rows[0].ink === 4);
  const u = M.newSprite(8, 1, { ink: 2, paper: 1, bright: 0 });
  M.paintRole(u, 0, 0, 0, 'ink'); M.paintRole(u, 0, 1, 0, 'paper');
  M.swapRowColours(u, 0, 0);
  ok('swapRowColours swaps the roles and flips the bits so the picture does not change', M.pixelKey(u, 0, 0, 0) === K(2, 0) && M.pixelKey(u, 0, 1, 0) === K(1, 0) && u.frames[0].rows[0].ink === 1);
  const b = M.newSprite(8, 1, { ink: 5, paper: 0, bright: 1 });
  M.paintColour(b, 0, 0, 0, M.normKey(8));
  ok('black is one colour in both brightnesses (bright black = black)', M.pixelKey(b, 0, 0, 0) === 0 && M.colourKey(0, 1) === 0 && M.normKey(8) === 0);
  ok('twoColourViolations is empty for a model sprite and finds an out-of-range row from outside', M.twoColourViolations(s).length === 0 && (() => { const bad = M.cloneSprite(s); bad.frames[0].rows[0].ink = 9; return M.twoColourViolations(bad).length === 1 && !M.validateSprite(bad).ok; })());
  const rep = M.rowReport(t, 0)[0];
  ok('rowReport counts the pixels of each role', rep.inkPixels === 6 && rep.paperPixels === 2 && rep.covered === 8 && rep.inkKey === K(4, 1));
  const c = M.newSprite(8, 3); M.setPixel(c, 0, 1, 1, 'mask', 1);
  M.addFrame(c); M.setRowColours(c, 0, 0, { ink: 3 }); M.copyRowColours(c, 0, 'all');
  ok('copyRowColours gives the other frames the same row colours', c.frames[1].rows[0].ink === 3);

  // fuzz: random operations; after each, every shown pixel is the ink or the paper of its row, and the sprite validates
  const rnd = rng(7);
  let bad = 0, steps = QUICK ? 800 : 5000;
  const pick = (n) => Math.floor(rnd() * n);
  let fz = M.newSprite(16, 16);
  for (let i = 0; i < steps; i++) {
    const f = pick(fz.frames.length), x = pick(fz.w), y = pick(fz.h), op = pick(22);
    try {
      switch (op) {
        case 0: case 1: case 2: M.paintColour(fz, f, x, y, M.COLOUR_KEYS[pick(15)], { as: ['ink', 'paper', 'auto'][pick(3)] }); break;
        case 3: M.paintRole(fz, f, x, y, rnd() < 0.5 ? 'ink' : 'paper'); break;
        case 4: M.setRowColours(fz, f, y, { ink: pick(8), paper: pick(8), bright: pick(2) }); break;
        case 5: M.setPixel(fz, f, x, y, 'mask', pick(2)); break;
        case 6: M.fill(fz, f, x, y, 'mask', pick(2)); break;
        case 7: M.fill(fz, f, x, y, 'image', M.COLOUR_KEYS[pick(15)]); break;
        case 8: M.flipH(fz, f); break;
        case 9: M.flipV(fz, f); break;
        case 10: M.rotate90(fz, f, rnd() < 0.5); break;
        case 11: M.shift(fz, f, pick(5) - 2, pick(5) - 2, { wrap: rnd() < 0.5 }); break;
        case 12: M.invertFrame(fz, f, rnd() < 0.5 ? 'image' : 'mask'); break;
        case 13: M.autoMask(fz, f, ['ink', 'silhouette', 'nonblack', 'all'][pick(4)]); break;
        case 14: M.outline(fz, f, { diagonals: rnd() < 0.5, as: rnd() < 0.5 ? 'ink' : 'paper' }); break;
        case 15: if (fz.frames.length < 6) M.addFrame(fz, f); break;
        case 16: if (fz.frames.length < 6) M.duplicateFrame(fz, f); break;
        case 17: M.deleteFrame(fz, f); break;
        case 18: M.moveFrame(fz, f, pick(fz.frames.length)); break;
        case 19: M.swapRowColours(fz, f, y); break;
        case 20: if (rnd() < 0.1) M.resizeSprite(fz, M.WIDTHS[pick(4)], 1 + pick(48)); break;
        case 21: M.clearFrame(fz, f, ['image', 'mask', 'both'][pick(3)]); break;
      }
    } catch (e) { bad++; console.log('     op', op, 'threw', e.message); }
    if (i % 25 === 0) {
      const v = M.validateSprite(fz);
      let viol = M.twoColourViolations(fz).length;
      for (let ff = 0; ff < fz.frames.length && !viol; ff++) for (let yy = 0; yy < fz.h && !viol; yy++) {
        const rk = M.rowReport(fz, ff)[yy];
        for (let xx = 0; xx < fz.w; xx++) { const k = M.pixelKey(fz, ff, xx, yy); if (k >= 0 && k !== rk.inkKey && k !== rk.paperKey) viol++; }
      }
      if (viol || !v.ok || !same(M.toAsset(M.fromAsset(M.toAsset(fz))), M.toAsset(fz))) bad++;
    }
  }
  ok(`fuzz: ${steps} random operations over every edit function: no exception, every shown pixel is its row's ink or paper, hex round trip stays exact`, bad === 0, `${bad} problems`);
}

// ── 4 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n4. Frames and whole-frame operations');
{
  // a 4x4 triangle in the top-left corner of an 8x8 sprite, a different ink on each of the first four rows
  const mk = () => art(['#...', '##..', '###.', '####'], [{ ink: 2 }, { ink: 3 }, { ink: 4 }, { ink: 5 }]);
  const orig = mk();
  const t = mk(); M.flipH(t, 0);
  ok('flipH mirrors each row; row colours stay with their rows', M.getPixel(t, 0, 7, 0) === 1 && M.getPixel(t, 0, 0, 0) === 0 && t.frames[0].rows[1].ink === 3 && M.getPixel(t, 0, 7, 3) === 1 && M.getPixel(t, 0, 4, 3) === 1);
  M.flipH(t, 0); ok('flipH twice is the identity', same(t, orig));
  M.flipV(t, 0);
  ok('flipV moves whole rows with their colours', t.frames[0].rows[7].ink === 2 && t.frames[0].rows[4].ink === 5 && t.frames[0].rows[4].bits === 0xF0 && M.getPixel(t, 0, 0, 7) === 1);
  M.flipV(t, 0); ok('flipV twice is the identity', same(t, orig));
  const r = mk(); let n = 0; for (let i = 0; i < 4; i++) if (M.rotate90(r, 0, true)) n++;
  ok('four 90 degree turns are the identity for a square sprite (bits and mask)', n === 4 && same(r.frames[0].rows.map((q) => [q.bits, q.mask]), orig.frames[0].rows.map((q) => [q.bits, q.mask])));
  const q = mk(); M.rotate90(q, 0, true);
  let cwOk = true;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (M.getPixel(q, 0, x, y) !== M.getPixel(orig, 0, y, 7 - x) || M.getPixel(q, 0, x, y, 'mask') !== M.getPixel(orig, 0, y, 7 - x, 'mask')) cwOk = false;
  ok('rotate90 clockwise: pixel (x, y) comes from (y, n-1-x); the top-left corner goes to the top-right', cwOk && M.getPixel(q, 0, 7, 0) === 1 && M.getPixel(q, 0, 0, 0) === 0);
  const ccw = mk(); M.rotate90(ccw, 0, false); M.rotate90(ccw, 0, true);
  ok('rotate counter-clockwise undoes clockwise; non-square sprites are refused', same(ccw, orig) && M.rotate90(M.newSprite(16, 8), 0) === false);
  const rot = mk(); M.rotate180(rot, 0);
  ok('rotate180 = flipH + flipV', M.getPixel(rot, 0, 7, 7) === 1 && M.getPixel(rot, 0, 4, 4) === 1 && M.getPixel(rot, 0, 7, 4) === 1 && M.getPixel(rot, 0, 0, 0) === 0);
  const sh = mk(); M.shift(sh, 0, 1, 0);
  ok('shift right by 1 moves pixels', M.getPixel(sh, 0, 1, 0) === 1 && M.getPixel(sh, 0, 0, 0) === 0 && sh.frames[0].rows[3].bits === 0b01111000);
  const lost = art(['.......#']); M.shift(lost, 0, 1, 0);
  ok('shift drops the pixels that fall off the edge (and wraps them when asked)', lost.frames[0].rows[0].bits === 0 && (M.shift(art(['.......#']), 0, 1, 0, { wrap: true }), true) && (() => { const w = art(['.......#']); M.shift(w, 0, 1, 0, { wrap: true }); return w.frames[0].rows[0].bits === 0x80; })());
  const wr = mk(); M.shift(wr, 0, 3, 2, { wrap: true }); M.shift(wr, 0, -3, -2, { wrap: true });
  ok('shift with wrap is reversible', same(wr, orig));
  const dn = mk(); M.shift(dn, 0, 0, 1);
  ok('shift down moves rows with their colours; the new top row is empty and copies the edge colours', dn.frames[0].rows[1].ink === 2 && dn.frames[0].rows[0].mask === 0 && dn.frames[0].rows[0].ink === 2);
  const iv = mk(); M.invertFrame(iv, 0, 'image'); M.invertFrame(iv, 0, 'mask');
  ok('invert image swaps ink and paper pixels; invert mask swaps covered and transparent', iv.frames[0].rows[0].bits === 0x7F && iv.frames[0].rows[0].mask === 0x7F);
  const cl = mk(); M.clearFrame(cl, 0, 'mask');
  ok('clear mask makes all transparent but keeps the image bits; clear both empties', cl.frames[0].rows[3].mask === 0 && cl.frames[0].rows[3].bits === 0xF0 && (M.clearFrame(cl, 0), cl.frames[0].rows[3].bits === 0));
  const fl = M.newSprite(8, 8, { ink: 7, paper: 0, bright: 0 });
  for (let x = 0; x < 8; x++) M.setPixel(fl, 0, x, 3, 'mask', 1);
  const nrow = M.fill(fl, 0, 0, 3, 'mask', 0);
  ok('fill on the mask layer covers the connected region only (4-connected)', nrow === 8 && fl.frames[0].rows[3].mask === 0 && (M.fill(fl, 0, 0, 0, 'mask', 1) === 64) && fl.frames[0].rows[3].mask === 255 && fl.frames[0].rows[0].mask === 255);
  const g = M.newSprite(8, 2);
  M.addFrame(g); M.addFrame(g); M.setPixel(g, 1, 0, 0, 'image', 1); M.setPixel(g, 2, 1, 0, 'image', 1);
  ok('addFrame adds an empty frame with the previous frame\'s row colours at the given place', g.frames.length === 3 && g.frames[1].rows[0].bits === 1 << 7);
  M.duplicateFrame(g, 1);
  ok('duplicateFrame inserts a deep copy after the frame', g.frames.length === 4 && same(g.frames[1], g.frames[2]) && g.frames[1] !== g.frames[2]);
  M.moveFrame(g, 3, 0);
  ok('moveFrame reorders (the old last frame is now first)', g.frames[0].rows[0].bits === 1 << 6 && g.frames.length === 4);
  ok('deleteFrame removes a frame; the last remaining frame cannot be deleted', M.deleteFrame(g, 0) && M.deleteFrame(g, 0) && M.deleteFrame(g, 0) && !M.deleteFrame(g, 0) && g.frames.length === 1);
  ok('at most 255 frames', (() => { const x = M.newSprite(8, 1); while (x.frames.length < 255) M.addFrame(x); return throws(() => M.addFrame(x)) && throws(() => M.duplicateFrame(x, 0)); })());
  const rs = M.newSprite(8, 8); M.autoMask(rs, 0, 'all');
  M.resizeSprite(rs, 16, 12);
  ok('resizeSprite widens (new pixels transparent) and heightens (new rows copy the last row\'s colours)', rs.w === 16 && rs.h === 12 && rs.frames[0].rows[0].mask === 0xFF00 && rs.frames[0].rows[11].mask === 0 && rs.frames[0].rows[11].ink === 7 && M.validateSprite(rs).errors.length === 0);
  M.resizeSprite(rs, 8, 4);
  ok('resizeSprite narrows and shortens from the top-left', rs.w === 8 && rs.h === 4 && rs.frames[0].rows[0].mask === 0xFF);
}

// ── 5 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n5. Mask helpers');
{
  const ring = art(['........', '..####..', '.#----#.', '.#-..-#.', '.#-..-#.', '.#----#.', '..####..', '........']);
  const mk = (mode) => { const s = M.cloneSprite(ring); M.autoMask(s, 0, mode); return s.frames[0].rows.map((r) => r.mask.toString(2).padStart(8, '0')); };
  ok("autoMask 'ink' covers only the ink pixels", mk('ink')[1] === '00111100' && mk('ink')[2] === '01000010' && mk('ink')[3] === '01000010');
  ok("autoMask 'silhouette' covers the ring and its inside, not the outside", same(mk('silhouette'), ['00000000', '00111100', '01111110', '01111110', '01111110', '01111110', '00111100', '00000000']));
  ok("autoMask 'all' covers everything", mk('all').every((r) => r === '11111111'));
  const nb = art(['#-'], [{ ink: 2, paper: 0 }]); M.autoMask(nb, 0, 'nonblack');
  ok("autoMask 'nonblack' leaves black pixels transparent", nb.frames[0].rows[0].mask === 0b10000000);
  const dot = M.newSprite(8, 5); M.setPixel(dot, 0, 3, 2, 'mask', 1); M.setPixel(dot, 0, 3, 2, 'image', 1);
  const added8 = M.outline(M.cloneSprite(dot), 0, { diagonals: true });
  const d4 = M.cloneSprite(dot), added4 = M.outline(d4, 0, { diagonals: false });
  ok('outline adds the 8 (or 4) neighbours of a single pixel as paper', added8 === 8 && added4 === 4 && d4.frames[0].rows[2].mask === 0b00111000 && d4.frames[0].rows[1].mask === 0b00010000 && d4.frames[0].rows[2].bits === 0b00010000);
  const ink = M.cloneSprite(dot); M.outline(ink, 0, { as: 'ink' });
  ok("outline 'ink' makes the new ring ink", ink.frames[0].rows[1].bits === 0b00111000);
}

// ── 6 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n6. Onion skin and display families');
{
  const s = M.newSprite(8, 2); M.addFrame(s); M.addFrame(s);
  const o = M.onionSkin(s, 1, { before: 1, after: 1 });
  ok('onionSkin lists the previous and the next frame with offsets', o.length === 2 && o[0].offset === -1 && o[1].offset === 1 && o[0].pixels.length === 16);
  ok('onionSkin at the ends has nothing beyond', M.onionSkin(s, 0, { before: 2, after: 0 }).length === 0 && M.onionSkin(s, 2, { before: 0, after: 3 }).length === 0 && M.onionSkin(s, 2, { before: 2, after: 0 }).length === 2);
  // an 8x8 sprite with a different colour pair in every row: ecm exact, flip loses detail
  const rainbow = M.newSprite(8, 8);
  for (let y = 0; y < 8; y++) { M.setRowColours(rainbow, 0, y, { ink: 1 + (y % 7), paper: 0, bright: 0 }); for (let x = 0; x < 8; x++) M.paintRole(rainbow, 0, x, y, x < 4 ? 'ink' : 'paper'); }
  const ecm = M.familyPixels(rainbow, 0, 'ecm'), flip = M.familyPixels(rainbow, 0, 'flip');
  ok('ecm shows the sprite as authored with no warning', same([...ecm.pixels], keysOf(rainbow)) && ecm.warning === null && ecm.lostPixels === 0);
  ok('flip keeps two hues per 8x8 cell: 8 ink hues + black in one cell lose pixels, and the warning says how many',
    flip.lostPixels > 0 && flip.lostCells === 1 && /flip/.test(flip.warning) && /change colour/.test(flip.warning) && flip.pixels.some((k, i) => k !== keysOf(rainbow)[i]), `${flip.lostPixels} pixels lost`);
  const two = M.newSprite(16, 16);
  for (let y = 0; y < 16; y++) { M.setRowColours(two, 0, y, { ink: y < 8 ? 2 : 4, paper: 0, bright: 1 }); for (let x = 0; x < 16; x++) M.paintRole(two, 0, x, y, (x + y) & 1 ? 'ink' : 'paper'); }
  const f2 = M.familyPixels(two, 0, 'flip');
  ok('flip loses nothing when each 8x8 cell already has two colours of one brightness', f2.lostPixels === 0 && f2.warning === null);
  const mixedBright = M.newSprite(8, 8);
  for (let y = 0; y < 8; y++) { M.setRowColours(mixedBright, 0, y, { ink: 2, paper: 0, bright: y < 4 ? 1 : 0 }); for (let x = 0; x < 8; x++) M.paintRole(mixedBright, 0, x, y, 'ink'); }
  const fb = M.familyPixels(mixedBright, 0, 'flip');
  ok('flip: a cell cannot mix normal and bright red (one BRIGHT per cell)', fb.lostPixels === 32 && fb.pixels.every((k) => k === fb.pixels[0]));
  const hi = M.familyPixels(rainbow, 0, 'hires'), hi2 = M.familyPixels(two, 0, 'hires', { hiresInk: 7, hiresPaper: 0 });
  ok('hires reduces to two colours (ink / paper by brightness) and warns when more than two were authored',
    new Set([...hi.pixels]).size <= 2 && /hires/.test(hi.warning) && hi.colours === 8 && (hi2.warning !== null) );
  const bw = M.newSprite(8, 2, { ink: 7, paper: 0, bright: 0 });
  for (let x = 0; x < 8; x++) { M.paintRole(bw, 0, x, 0, x & 1 ? 'ink' : 'paper'); M.paintRole(bw, 0, x, 1, 'ink'); }
  const hb = M.familyPixels(bw, 0, 'hires');
  ok('hires of a black and white sprite is unchanged and has no warning', same([...hb.pixels], keysOf(bw)) && hb.warning === null);
  ok('familyPixels rejects an unknown family', throws(() => M.familyPixels(bw, 0, 'bogus')));
}

// ── 7 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n7. Image import');
{
  const mkImg = (w, h, fn) => { const data = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b, a = 255] = fn(x, y); data.set([r, g, b, a], (y * w + x) * 4); } return { width: w, height: h, data }; };
  const P = (key) => { const c = M.PALETTE[key].rgb; return [...c, 255]; };
  // rows alternate between two exact palette colours; row k uses colours (A, B) from a table -> every dither must reproduce exactly
  const pairs = [[2, 5], [1, 6], [4, 3], [7, 0], [6, 2], [5, 1], [3, 4], [2, 7]];
  const img = mkImg(16, 8, (x, y) => P((x & 1 ? pairs[y][0] : pairs[y][1])));
  for (const dither of ['none', 'ordered', 'sierra']) {
    const s = M.importRGBA(img, { w: 16, h: 8, dither });
    const got = keysOf(s);
    const want = []; for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) want.push(x & 1 ? pairs[y][0] : pairs[y][1]);
    ok(`import of exact two-colour rows reproduces them exactly (${dither}); each row fits its pair`, same(got, want) && M.validateSprite(s).errors.length === 0);
  }
  const red = mkImg(8, 4, () => [255, 0, 0, 255]);
  const sr = M.importRGBA(red, { w: 8, h: 4, dither: 'none' });
  ok('a solid pure red image becomes red (the nearest of the 15 colours is the normal red)', keysOf(sr).every((k) => k === M.colourKey(2, 0)));
  const brightRed = mkImg(8, 4, () => [...M.PALETTE[10].rgb, 255]);
  ok('the bright red of the palette comes back as bright red in a bright row', keysOf(M.importRGBA(brightRed, { w: 8, h: 4 })).every((k) => k === M.colourKey(2, 1)) && M.importRGBA(brightRed, { w: 8, h: 4 }).frames[0].rows.every((r) => r.bright === 1));
  const dark = mkImg(8, 4, () => [0, 0, 190, 255]);
  ok('a dark blue image becomes normal blue in a normal-brightness row (all of it without dither, nearly all with dither)',
    keysOf(M.importRGBA(dark, { w: 8, h: 4, dither: 'none' })).every((k) => k === M.colourKey(1, 0))
    && ['ordered', 'sierra'].every((d) => { const k = keysOf(M.importRGBA(dark, { w: 8, h: 4, dither: d })); return k.filter((v) => v === 1).length >= 28 && M.importRGBA(dark, { w: 8, h: 4, dither: d }).frames[0].rows.every((r) => r.bright === 0); }));
  // three colours in one row: the result is the exhaustive best pair of one brightness
  const three = mkImg(8, 1, (x) => P(x < 4 ? 2 : x < 6 ? 4 : 1));
  const st = M.importRGBA(three, { w: 8, h: 1, dither: 'none' });
  const used = new Set(keysOf(st));
  ok('three colours in a row: only two remain (the two most used: red and green), blue becomes the nearest of them', used.size === 2 && used.has(M.colourKey(2, 0)) && used.has(M.colourKey(4, 0)));
  const fit = M.fitRow([[201, 5, 0], [201, 5, 0], [0, 204, 8], [0, 0, 204]], 0);
  ok('fitRow chooses the least-error pair of one brightness (red + green normal) with red as ink', fit.bright === 0 && fit.ink === 2 && fit.paper === 4 && fit.cost > 0);
  // brute-force check of fitRow on random pixel sets: no pair of one brightness has a lower cost
  const rnd = rng(3); let worse = 0;
  for (let t = 0; t < 30; t++) {
    const px = Array.from({ length: 12 }, () => [rnd() * 255, rnd() * 255, rnd() * 255]);
    const f = M.fitRow(px, 1);
    const cost = (a, b) => px.reduce((n, p) => n + Math.min(...[a, b].map((c) => 2 * (p[0] - c[0]) ** 2 + 4 * (p[1] - c[1]) ** 2 + 3 * (p[2] - c[2]) ** 2)), 0);
    let best = Infinity;
    for (const br of [0, 1]) for (let i = 0; i < 8; i++) for (let j = i; j < 8; j++) best = Math.min(best, cost(M.PALETTE[M.colourKey(i, br)].rgb, M.PALETTE[M.colourKey(j, br)].rgb));
    if (f.cost > best + 1e-6) worse++;
  }
  ok('fitRow finds the minimum-error pair on 30 random rows (brute force)', worse === 0);
  // alpha
  const half = mkImg(8, 2, (x) => (x < 4 ? [255, 255, 255, 255] : [255, 255, 255, 10]));
  const sa = M.importRGBA(half, { w: 8, h: 2 });
  ok('alpha below the threshold becomes transparent (mask 0); opaque pixels are covered', sa.frames[0].rows[0].mask === 0xF0 && keysOf(sa).slice(0, 4).every((k) => k >= 0) && keysOf(sa).slice(4, 8).every((k) => k === -1));
  const clear = mkImg(8, 2, () => [9, 9, 9, 0]);
  const sc = M.importRGBA(clear, { w: 8, h: 2 });
  ok('a fully transparent image gives an empty sprite (default colours, mask 0)', sc.frames[0].rows.every((r) => r.mask === 0));
  // dither
  const grey = mkImg(32, 8, () => [102, 102, 102, 255]);                                 // half way between black and white
  const frac = (d) => { const s = M.importRGBA(grey, { w: 32, h: 8, dither: d, bright: 0 }); const k = keysOf(s); return k.filter((v) => v === 7).length / k.length; };
  ok('dither: a flat mid grey is all one colour without dither and about half white with ordered dither and with Sierra-lite',
    (frac('none') === 0 || frac('none') === 1) && Math.abs(frac('ordered') - 0.5) < 0.1 && Math.abs(frac('sierra') - 0.5) < 0.1, `none ${frac('none')} ordered ${frac('ordered').toFixed(2)} sierra ${frac('sierra').toFixed(2)}`);
  // a horizontal ramp: dithered mean brightness follows the ramp
  const ramp = mkImg(32, 4, (x) => { const v = Math.round(x / 31 * 204); return [v, v, v, 255]; });
  const rs = M.importRGBA(ramp, { w: 32, h: 4, dither: 'ordered', bright: 0 });
  const left = keysOf(rs).filter((v, i) => i % 32 < 8 && v === 7).length, right = keysOf(rs).filter((v, i) => i % 32 >= 24 && v === 7).length;
  ok('dither: a black-to-white ramp has few white pixels on the left and many on the right', left < 10 && right > 22, `${left} / ${right} of 32`);
  // resampling
  const checker = mkImg(16, 16, (x, y) => ((x >> 1) + (y >> 1)) & 1 ? P(7) : P(0));
  const small = M.importRGBA(checker, { w: 8, h: 8, dither: 'none' });
  ok('downscaling 2:1 an image of 2x2 blocks keeps the blocks pixel for pixel', keysOf(small).every((k, i) => k === (((i % 8) + ((i / 8) | 0)) & 1 ? 7 : 0)));
  ok('suggestSize picks the nearest allowed width and keeps the aspect', same(M.suggestSize(30, 15), { w: 32, h: 16 }) && same(M.suggestSize(10, 20), { w: 8, h: 16 }) && same(M.suggestSize(100, 50), { w: 32, h: 16 }));
  const sheet = mkImg(32, 16, (x) => (x < 16 ? P(2) : P(1)));
  const sh = M.importSheet(sheet, { cols: 2, rows: 1, dither: 'none', bright: 0 });
  ok('importSheet splits a grid into frames (16x16 each: red then blue)', sh.frames.length === 2 && sh.w === 16 && sh.h === 16 && M.framePixels(sh, 0).every((k) => k === M.colourKey(2, 0)) && M.framePixels(sh, 1).every((k) => k === M.colourKey(1, 0)));
  ok('import rejects an empty or short image', throws(() => M.importRGBA({ width: 0, height: 0, data: new Uint8Array(0) })) && throws(() => M.importRGBA({ width: 4, height: 4, data: new Uint8Array(8) })));
  const big = mkImg(40, 100, () => [255, 255, 255, 255]);
  const sb = M.importRGBA(big, { w: 32 });
  ok('import clamps the height to 48', sb.h === 48);
}

// ── 8 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n8. Validation and sizes');
{
  const v = (s) => M.validateSprite(s);
  ok('a 16x16 one-frame sprite validates clean of errors and has only the "colours are for the Studio" note', v(M.newSprite(16, 16)).ok && v(M.newSprite(16, 16)).warnings.length === 1);
  ok('24 / 32 wide, taller than 16, and several frames are valid data with warnings that the build does not support them yet',
    (() => { const a = v(M.newSprite(24, 16)), b = v(M.newSprite(16, 32)), s = M.newSprite(8, 8); M.addFrame(s); const c = v(s); return a.ok && /24/.test(a.warnings.join()) && b.ok && /32/.test(b.warnings.join()) && c.ok && /only frame 0/.test(c.warnings.join()); })());
  const bad = M.newSprite(16, 8); bad.phases = 3; bad.hot = [10, 0, 10, 4];
  ok('a bad phases value and a hot box outside the sprite are errors', (() => { const r = v(bad); return !r.ok && r.errors.length === 2; })());
  ok('validateAsset reads the stored form and reports unreadable data as an error', M.validateAsset(M.toAsset(M.newSprite(8, 8))).ok && !M.validateAsset({ w: 8, h: 8 }).ok && !M.validateAsset({ w: 8, h: 2, frames: [{ rows: [] }] }).ok);
  const si = M.sizeInfo(M.newSprite(16, 16));
  ok('sizeInfo: 16x16, 8 phases = 64 B cartridge, RAM 64 + 7 x 96 = 736 B (aligned copy 2 bytes a row x2, shifted copies 3 bytes x2)', si.cartridge === 64 && si.ram === 736 && si.phaseShifts.length === 8, JSON.stringify(si));
  const s2 = M.newSprite(16, 16); s2.phases = 2; s2.frames.push(...M.cloneSprite(s2).frames);
  const si2 = M.sizeInfo(s2);
  ok('sizeInfo: 2 phases = shifts 0 and 4 (64 + 96 B), all frames counted separately', si2.ram === 160 && si2.phaseShifts.join() === '0,4' && si2.cartridgeAll === 128 && si2.cartridge === 64);
  ok('sizeInfo: 1 phase = one aligned copy', (() => { const s = M.newSprite(8, 8); s.phases = 1; return M.sizeInfo(s).ram === 8 * 2 * 2; })());
}

// ── 9 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n9. Undo / redo');
{
  const s = M.newSprite(8, 8), h = M.createHistory(s);
  ok('a fresh history cannot undo or redo', !h.canUndo && !h.canRedo && h.undo() === null && h.redo() === null);
  M.setPixel(s, 0, 1, 1, 'mask', 1); ok('commit records a change', h.commit(s) === true && h.canUndo);
  ok('commit of an unchanged sprite records nothing', h.commit(s) === false);
  M.setPixel(s, 0, 2, 2, 'mask', 1); h.commit(s);
  const u1 = h.undo(); ok('undo returns the previous state', u1.frames[0].rows[2].mask === 0 && u1.frames[0].rows[1].mask !== 0);
  const u2 = h.undo(); ok('undo again returns the first state; redo goes forward', u2.frames[0].rows[1].mask === 0 && h.canRedo && h.redo().frames[0].rows[1].mask !== 0);
  h.undo(); const w = h.undo(); void w;
  const t = M.newSprite(8, 8); M.setPixel(t, 0, 3, 3, 'mask', 1);
  ok('a new commit after undo drops the redo branch', h.commit(t) && !h.canRedo);
  const lim = M.createHistory(s, 5);
  for (let i = 0; i < 20; i++) { M.setPixel(s, 0, i % 8, 5, 'image', i & 1 ? 0 : 1); M.setPixel(s, 0, (i * 3) % 8, 6, 'mask', i & 2 ? 0 : 1); lim.commit(s); }
  ok('the history is limited', lim.depth.undo <= 5);
}

// ── R ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const RT_JSON = join(ROOT, 'arcade/build/v2/runtime.json');
const ROMDIR = join(ROOT, 'tsrun/roms');
if (!existsSync(RT_JSON) || !existsSync(join(ROMDIR, 'ts2068-0.rom'))) {
  console.log('\nR. SKIPPED: arcade/build/v2/runtime.json or the stock ROMs are missing (node arcade/tools/build-runtime-v2.mjs)');
} else {
  console.log('\nR. Round trip through the real compiler and the v2 runtime (stock TS2068 on TSRun)');
  const M_ = await import(pathToFileURL(join(ROOT, 'tsrun/machine.js')).href);
  const rt = JSON.parse(readFileSync(RT_JSON, 'utf8'));
  const img = new Uint8Array(readFileSync(join(dirname(RT_JSON), rt.image ?? 'runtime.bin')));
  const SYM = rt.symbols;
  const ZX_ROW = (y) => ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2);
  // background: tile 0 is a checkerboard (0xAA / 0x55 rows), so a transparent pixel shows it and a covered one hides it
  const BG = { rows: Array.from({ length: 8 }, (_, y) => ({ bits: y & 1 ? 0x55 : 0xAA, ink: 0, paper: 7, bright: 0 })), flags: 0 };
  const bgBit = (x, y) => ((y & 1 ? 0x55 : 0xAA) >> (7 - (x & 7))) & 1;

  /** Compile a program that shows the given sprites (name -> {sprite model, x, y}) and return the screen after it settled. */
  function showPicture(placed, { sprites = null } = {}) {
    const names = Object.keys(placed);
    const assets = { sprites: {}, tilesets: { bg: { tiles: [BG] } }, sfx: {}, maps: {} };
    for (const n of names) assets.sprites[n] = sprites?.[n] ?? M.toAsset(placed[n].sprite);
    const src = ['GAME "spt"', 'FRAMERATE 30', ...names.map((n) => `SPRITE ${n} = "${n}"`), 'TILESET bg = "bg"', 'SCENE play', '  DIM i, j', '  PROC INIT():',
      '    FOR j = 0 TO 23', '      FOR i = 0 TO 31', '        TILE i, j = 0', '      NEXT i', '    NEXT j',
      ...names.map((n) => `    SHOW ${n} AT ${placed[n].x}, ${placed[n].y}`), '  ENDP', '  PROC FRAME():', '    REM still', '  ENDP', 'ENDSCENE'].join('\n');
    const res = compile(src, { runtime: rt, image: img, assets });
    if (res.errors.length) return { errors: res.errors.map((e) => `${e.line}:${e.col} ${e.message}`) };
    const m = M_.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
    const must = (e) => { if (e) throw new Error(e); };
    must(M_.setHomeRom(m, readFileSync(join(ROMDIR, 'ts2068-0.rom'))));
    must(M_.setExRom(m, readFileSync(join(ROMDIR, 'ts2068-1.rom'))));
    must(M_.insertDock(m, res.dck));
    M_.resetMachine(m);
    const rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
    for (let f = 0; f < 600 && rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE; f++) M_.runFrame(m);
    if (rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE) return { errors: ['the runtime did not boot'] };
    for (let f = 0; f < 400 && rd16(SYM.V_TICKS) < 6; f++) M_.runFrame(m);
    for (let f = 0; f < 6; f++) M_.runFrame(m);
    const file = m.ram[SYM.V_SHADOW_FF] & 7;
    const bmp = file === 0 ? SYM.DFILE0 : SYM.DFILE1;
    const plane = new Uint8Array(192 * 256);
    for (let y = 0; y < 192; y++) for (let x = 0; x < 32; x++) for (let b = 0; b < 8; b++) plane[y * 256 + x * 8 + b] = (m.ram[bmp + ZX_ROW(y) + x] >> (7 - b)) & 1;
    return { plane, ticks: rd16(SYM.V_TICKS), errors: [] };
  }
  /** The picture the sprite model says: the checkerboard, then each sprite's covered pixels (x rounded down for fewer phases). */
  function expected(placed) {
    const plane = new Uint8Array(192 * 256);
    for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) plane[y * 256 + x] = bgBit(x, y);
    for (const { sprite, x, y } of Object.values(placed)) {
      const x0 = x & (0xFF << (3 - Math.log2(sprite.phases)) & 0xFF);
      for (let r = 0; r < sprite.h; r++) for (let c = 0; c < sprite.w; c++) {
        if (!M.getPixel(sprite, 0, c, r, 'mask')) continue;
        plane[(y + r) * 256 + x0 + c] = M.getPixel(sprite, 0, c, r, 'image');
      }
    }
    return plane;
  }
  const diff = (got, want) => { let n = 0, first = ''; for (let i = 0; i < got.length; i++) if (got[i] !== want[i]) { if (!n) first = `x ${i % 256}, y ${(i / 256) | 0}`; n++; } return { n, first }; };

  // a hand-made sprite first: the ship of the shooter example, mask holes included
  {
    const shooter = JSON.parse(readFileSync(join(ROOT, 'arcade/examples/shooter.assets.json'), 'utf8')).sprites;
    const placed = { ship: { sprite: M.fromAsset(shooter.ship), x: 100, y: 80 } };
    const got = showPicture(placed);
    const bgOnly = expected({});
    ok('the shooter ship (from its asset file through the model) is drawn exactly as the model says (and is visible: it changes the background)', !got.errors.length && diff(got.plane, expected(placed)).n === 0 && diff(got.plane, bgOnly).n > 30, got.errors.join('; ') || `${diff(got.plane, expected(placed)).n} pixels differ ${diff(got.plane, expected(placed)).first}`);
  }

  // 20 random sprites authored through the model's API (pixels, masks, flips, shifts, auto mask), 4 per program, 4 slots across the screen
  const rnd = rng(2026);
  const pick = (n) => Math.floor(rnd() * n);
  const make = () => {
    const w = [8, 16][pick(2)], h = 1 + pick(16);
    const s = M.newSprite(w, h);
    for (let y = 0; y < h; y++) M.setRowColours(s, 0, y, { ink: 1 + pick(7), paper: pick(8), bright: pick(2) });
    const dens = 0.2 + rnd() * 0.6;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (rnd() < dens) M.paintRole(s, 0, x, y, rnd() < 0.5 ? 'ink' : 'paper'); }
    const style = pick(4);
    if (style === 0) M.autoMask(s, 0, 'ink');
    else if (style === 1) M.autoMask(s, 0, 'silhouette');
    else if (style === 2) { M.outline(s, 0, { as: 'paper' }); }
    if (rnd() < 0.5) M.flipH(s, 0);
    if (rnd() < 0.3) M.flipV(s, 0);
    if (rnd() < 0.3) M.shift(s, 0, pick(3) - 1, pick(3) - 1);
    if (rnd() < 0.3 && w === h) M.rotate90(s, 0);
    s.phases = M.PHASE_CHOICES[pick(4)];
    return s;
  };
  let batches = 0, good = 0, total = 0;
  const fails = [];
  for (let b = 0; b < (QUICK ? 2 : 5); b++) {
    const placed = {};
    for (let k = 0; k < 4; k++) {
      const s = make();
      placed[`r${b}x${k}`] = { sprite: s, x: k * 64 + 8 + pick(32), y: 16 + pick(120) };
    }
    // the stored form goes through JSON like a saved project
    const stored = Object.fromEntries(Object.entries(placed).map(([n, p]) => [n, JSON.parse(JSON.stringify(M.toAsset(p.sprite)))]));
    const got = showPicture(placed, { sprites: stored });
    batches++;
    if (got.errors.length) { fails.push(got.errors.join('; ')); continue; }
    const d = diff(got.plane, expected(placed));
    total += 4;
    if (d.n === 0) good += 4; else fails.push(`batch ${b}: ${d.n} pixels differ, first at ${d.first}; sprites ` + Object.entries(placed).map(([n, p]) => `${n}:${p.sprite.w}x${p.sprite.h}/ph${p.sprite.phases}@${p.x},${p.y}`).join(' '));
  }
  ok(`${total} random sprites (8 / 16 wide, 1..16 high, masks, phases 1..8, random positions) are drawn on the real runtime exactly as edited`, good === total && total >= 8, fails.join(' | ') || `${batches} programs`);

  // authored beyond the build's reach: the editor's warning must match what the compiler does
  const w24 = { w24: { sprite: M.newSprite(24, 8), x: 10, y: 10 } }, tall = { t: { sprite: M.newSprite(8, 20), x: 10, y: 10 } };
  const r24 = showPicture(w24), rt20 = showPicture(tall);
  ok('a 24 wide sprite is refused by the compiler, and validateSprite had warned', r24.errors.length === 1 && /width/.test(r24.errors[0]) && M.validateSprite(w24.w24.sprite).warnings.some((x) => /24/.test(x)), r24.errors.join());
  ok('a 20 high sprite is refused by the compiler, and validateSprite had warned', rt20.errors.length === 1 && /height/.test(rt20.errors[0]) && M.validateSprite(tall.t.sprite).warnings.some((x) => /20/.test(x)), rt20.errors.join());
  const multi = M.newSprite(16, 8); M.addFrame(multi);
  for (let y = 0; y < 8; y++) { M.paintRole(multi, 0, 3, y, 'ink'); M.paintRole(multi, 1, 12, y, 'ink'); }
  const pm = { m: { sprite: multi, x: 40, y: 40 } };
  const gm = showPicture(pm);
  ok('a sprite with two frames compiles: frame 0 is what is drawn (the build ignores the others today), and validateSprite said so', !gm.errors.length && diff(gm.plane, expected(pm)).n === 0 && M.validateSprite(multi).warnings.some((x) => /only frame 0/.test(x)));
}

console.log(`\n${failed === 0 ? 'All' : 'Some'} checks done: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
