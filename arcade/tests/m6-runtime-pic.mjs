"use strict";
// m6-runtime-pic.mjs -- runtime v3 part 1, the v2 picture tests run against the v3 build (non-window mode), on a stock TS2068 (TSRun):
//  1. v2-style images (width 8 / 16, up to 16 rows, nframes byte 0): the scenes of m4-runtime.mjs section 4 (16 instances over text and tiles,
//     every phase count, crowding, a screen of text swept and cleared, tiles changing every tick, the overrun, the x rounding) at frame_div 1..3,
//     and the v2 worst case (8 assets of 16 x 16 at 8 phases, 16 instances) -- the picture equals the model after EVERY refresh;
//  2. the unchanged-sprite skip with v3 sprites (big ones, frames): statics overlapped by movers, text under statics, frame-only changes, hide / show,
//     random mixes; the same pictures with the analysis switched off; instances really were skipped;
//  3. the tile operations of language batch 1 (m5-runtime-pic.mjs section 1) over moving v3 sprites at frame_div 1..3 (test_ops.asm, the v3 copy).
//   node arcade/tests/m6-runtime-pic.mjs        (M6_QUICK=1: shorter)
import { join } from 'node:path';
import { assembleGame, linkGame, dckOf, RUNTIME_DIR } from '../tools/build-runtime-v3.mjs';
import * as C from './m6-common.mjs';
import * as C4 from './m4-common.mjs';
import * as C5 from './m5-common.mjs';
import { rng, randomScene, randomTiles } from './m3-scenes.mjs';
const { FRAME_T, hex, makeChecks, rd8, rd16, op } = C;

const QUICK = !!process.env.M6_QUICK;
const { check, finish } = makeChecks();
const S = C.runtime().syms;
console.log('Runtime v3 part 1: the v2 picture tests on the v3 build (non-window mode)\n');

const sceneChecks = (label, st, nframes, { div = 0 } = {}) => {
  check(`${label}: the picture equals the model in every refresh (${st.pictureOk}/${nframes}, memory and colours)`, st.pictureBad === 0 && st.pixelBad === 0 && st.pictureOk >= nframes - 2, st.firstBad ? JSON.stringify(st.firstBad) : `${st.pictureOk}`);
  check(`${label}: no write to the shown file, flips at the interrupt, frame counter exact, ticks in order, canary intact, SP in $FB02..$FF00`,
    st.writeViolations === 0 && st.flipMismatch === 0 && st.missed === 0 && st.shadowBad === 0 && st.canary === 0x5AA5 && st.ticks.every((t, k) => t.n === k) && st.spMin >= S.STACK_LIMIT && st.spMax <= S.STACK_TOP,
    `${st.writeViolations} writes, ${st.flipMismatch} flips, ${st.missed} missed`);
  if (div) check(`${label}: one tick every ${div} refreshes (the work fits)`, st.ticks.slice(2).every((t, k) => t.frames - st.ticks[k + 1].frames === div));
};
const v2 = (a) => C.fromV2(a);
const addSprites = (script, n, r, { box = null, hideRate = 0.03, jumpRate = 0.04 } = {}) => {
  const lim = box ?? { x0: -3, x1: 245, y0: -3, y1: 185 };
  const pos = Array.from({ length: n }, () => ({ x: r.int(Math.max(0, lim.x0), Math.min(230, lim.x1)), y: r.int(Math.max(0, lim.y0), Math.min(170, lim.y1)), dx: r.int(-5, 5), dy: r.int(-4, 4) }));
  script.forEach((t) => pos.forEach((p, i) => {
    if (r.chance(jumpRate)) { p.x = box ? r.int(box.x0, box.x1) : r.int(-40, 300); p.y = box ? r.int(box.y0, box.y1) : r.int(-40, 230); }
    else { p.x += p.dx; p.y += p.dy; if (p.x < lim.x0 || p.x > lim.x1) p.dx = -p.dx; if (p.y < lim.y0 || p.y > lim.y1) p.dy = -p.dy; }
    t.push(r.chance(hideRate) ? op.hide(i) : op.show(i, p.x, p.y));
  }));
  return script;
};
const N = (n) => (QUICK ? Math.ceil(n / 3) : n);

// ==================================================================================================================
console.log('1. v2-style images (nframes 0) in the m4-runtime scenes');
{
  const r = rng(41);
  const assets = [C4.randomAsset(r, 16, 16, 8), C4.randomAsset(r, 8, 8, 4), C4.randomAsset(r, 16, 10, 2)].map(v2);
  const script = addSprites(randomScene(401, N(80), { sprites: 0, tiles: 8, textRate: 0.55, tileRate: 0.6, wild: true }), 16, r);
  const game = C.scriptGame({ div: 2, assets, insts: Array.from({ length: 16 }, (_, i) => i % 3), tiles: randomTiles(rng(11), 8), script });
  sceneChecks('1a. 16 instances of 3 v2 assets over text and tiles, frame_div 2', C.observe6(game, N(80) * 2, { script }), N(80) * 2);
}
{
  const r = rng(42);
  const assets = [C4.randomAsset(r, 16, 16, 8), C4.randomAsset(r, 8, 8, 8), C4.randomAsset(r, 16, 12, 2), C4.randomAsset(r, 16, 16, 4), C4.randomAsset(r, 8, 5, 1), C4.randomAsset(r, 16, 16, 1), C4.randomAsset(r, 8, 16, 2), C4.randomAsset(r, 16, 7, 8)].map(v2);
  const script = addSprites(randomScene(402, N(75), { sprites: 0, tiles: 6, textRate: 0.5, tileRate: 0.5 }), 16, r);
  const game = C.scriptGame({ div: 3, assets, insts: Array.from({ length: 16 }, (_, i) => (i * 5) % 8), tiles: randomTiles(rng(12), 6), script });
  const st = C.observe6(game, N(75) * 3, { script });
  sceneChecks('1b. 16 instances of 8 v2 assets (all phase counts, widths 8 / 16), frame_div 3', st, N(75) * 3, { div: 3 });
  console.log(`  tick work avg ${Math.round(C.avg(st.work))}, max ${Math.max(...st.work)} T`);
}
{
  const r = rng(43);
  const assets = [C4.randomAsset(r, 16, 16, 8), C4.randomAsset(r, 8, 8, 2), C4.randomAsset(r, 16, 14, 4), C4.randomAsset(r, 16, 16, 1)].map(v2);
  const script = addSprites(randomScene(403, N(80), { sprites: 0, tiles: 4, textRate: 0.4, tileRate: 0.4 }), 16, r, { box: { x0: 90, x1: 140, y0: 70, y1: 115 }, jumpRate: 0.08 });
  const game = C.scriptGame({ div: 3, assets, insts: Array.from({ length: 16 }, (_, i) => (i * 7 + (i >> 2)) % 4), tiles: randomTiles(rng(13), 4), script });
  sceneChecks('1c. 16 v2 instances crowded into 50 x 45 pixels (overlaps in every order), frame_div 3', C.observe6(game, N(80) * 3, { script }), N(80) * 3, { div: 3 });
}
{
  const fill = [];
  for (let row = 0; row < 24; row++) fill.push(op.at(row, 0), op.prints('0123456789ABCDEFGHIJKLMNOPQRSTU'), op.printc(65 + (row % 26)));
  const walk = [];
  for (let t = 0; t < N(60); t++) walk.push(Array.from({ length: 16 }, (_, i) => op.show(i, (7 * t + 17 * i) % 232 + (i & 1), (3 * t + 11 * i) % 172 + (i & 3))));
  const r = rng(44);
  const assets = [C4.randomAsset(r, 16, 16, 8), C4.randomAsset(r, 8, 8, 8), C4.randomAsset(r, 16, 12, 4), C4.randomAsset(r, 16, 16, 2)].map(v2);
  const script = [fill.slice(0, 36), fill.slice(36), ...walk, Array.from({ length: 16 }, (_, i) => op.hide(i)), [], [], []];
  const game = C.scriptGame({ div: 3, assets, insts: Array.from({ length: 16 }, (_, i) => i % 4), script });
  const st = C.observe6(game, script.length * 3 + 5, { script });
  sceneChecks('1d. 16 v2 instances sweeping over a screen of text, then hidden, frame_div 3', st, script.length * 3 + 5);
  const cells = st.model.render(), d0 = C.dfileOf(st.m, 0), d1 = C.dfileOf(st.m, 1);
  check('1d. after the hide both display files equal the text alone (the erase restored every cell)', C.diffCount(d0.bitmap, cells.bitmap) + C.diffCount(d1.bitmap, cells.bitmap) === 0);
}
{
  const r = rng(45);
  const map = Array.from({ length: 768 }, () => (r.chance(0.6) ? 0x80 | r.int(0, 15) : r.int(32, 126)));
  const assets = [C4.randomAsset(r, 16, 16, 8), C4.randomAsset(r, 8, 8, 4)].map(v2);
  const script = addSprites(randomScene(405, N(90), { sprites: 0, tiles: 16, textRate: 0.4, tileRate: 1, tileBurst: 6 }), 12, r);
  const game = C.scriptGame({ div: 2, assets, insts: Array.from({ length: 12 }, (_, i) => i & 1), tiles: randomTiles(rng(21), 16), map, script });
  sceneChecks('1e. a full screen map, tiles and text changing every tick, 12 v2 instances, frame_div 2', C.observe6(game, N(90) * 2, { script }), N(90) * 2);
}
{
  const r = rng(46);
  const assets = [C4.randomAsset(r, 16, 16, 8), C4.randomAsset(r, 16, 12, 2)].map(v2);
  const script = addSprites(randomScene(406, N(70), { sprites: 0, tiles: 6, textRate: 0.6, tileRate: 0.8 }), 16, r);
  for (let t = 4; t < script.length; t += 5) script[t].push(op.burn());
  const game = C.scriptGame({ div: 1, assets, insts: Array.from({ length: 16 }, (_, i) => i & 1), tiles: randomTiles(rng(31), 6), script });
  const st = C.observe6(game, N(300), { script });
  sceneChecks('1f. 16 v2 instances plus a frame_entry that overruns (BURN), frame_div 1', st, N(300));
  check('1f. the overruns happened (interrupts during the work flipped nothing)', st.skippedFlips > 3 && Math.max(...st.work) > 2 * FRAME_T);
}
{
  const r = rng(47);
  const assets = [8, 4, 2, 1].map((ph) => v2(C4.randomAsset(r, 16, 8, ph)));
  const script = [];
  for (let x = 0; x < 40; x++) script.push([0, 1, 2, 3].map((i) => op.show(i, x + 50 * i, 20 + 30 * i)));
  const game = C.scriptGame({ div: 1, assets, insts: [0, 1, 2, 3], script });
  const st = C.observe6(game, 46, { script });
  sceneChecks('1g. one v2 instance per phase count moving one pixel a tick (x rounded down to 1 / 2 / 4 / 8 when drawn)', st, 46, { div: 1 });
  check('1g. the stored x is unchanged by the rounding (SPR_TAB at 8 i + 2 holds 39, 89, 139, 189)', [0, 1, 2, 3].map((i) => rd16(st.m, S.SPR_TAB + 8 * i + 2)).join() === '39,89,139,189');
}
{
  const r = rng(77);
  const assets = Array.from({ length: 8 }, () => v2(C4.randomAsset(r, 16, 16, 8)));
  const mdl = new C.Model6({ assets, insts: Array.from({ length: 16 }, (_, i) => i % 8) });
  const plan = C.planPool(mdl.assets, mdl.ninstOf(), C.POOL_PIECES(S));
  const script = addSprites(randomScene(7701, N(70), { sprites: 0, tiles: 12, textRate: 0.7, tileRate: 0.8, wild: true }), 16, r);
  const game = C.scriptGame({ div: 3, assets, insts: Array.from({ length: 16 }, (_, i) => i % 8), tiles: randomTiles(rng(78), 12), script });
  const st = C.observe6(game, N(70) * 3, { script });
  check(`1h. the v2 worst case (8 assets of 16 x 16 at 8 phases, 16 instances) fits: ${C.poolNeed(mdl.assets, mdl.ninstOf())} of ${S.PHASE_POOL_BYTES} bytes, every frame in a slot`, plan.ok && plan.K.every((k) => k === 1));
  sceneChecks('1h. the v2 worst case runs', st, N(70) * 3, { div: 3 });
  console.log(`  tick work avg ${Math.round(C.avg(st.work))}, max ${Math.max(...st.work)} T (v2: max 105,903 T in m4-runtime-perf's measurement)`);
}

// ==================================================================================================================
console.log('\n2. The unchanged-sprite skip with v3 sprites');
function skipScene(label, spec, nframes, { expectSkips = 1 } = {}) {
  const run = (noSkip) => {
    const game = C.scriptGame({ ...spec, noSkip });
    let marked = 0, leftover = 0;
    const st = C.observe6(game, nframes, { script: spec.script, hooks: (pc, { m, inIsr }) => {
      if (inIsr) return;
      if (pc === S.TICK_REQUEST) for (let k = 0; k < 32; k++) if (rd8(m, S.SPR_DRAWN + 4 * k) > 1) leftover++;
      if (pc === S.erase_all) { const base = S.SPR_DRAWN + 64 * rd8(m, S.V_HIDDEN); for (let i = 0; i < rd8(m, S.V_NINST); i++) if (rd8(m, base + 4 * i) === 0x81) marked++; }
    } });
    return { st, marked, leftover };
  };
  const on = run(false), off = run(true);
  check(`${label}: picture = model in every refresh with the skip (${on.st.pictureOk}/${nframes}) and without it (${off.st.pictureOk}), no write to the shown file`,
    on.st.pictureBad === 0 && off.st.pictureBad === 0 && on.st.pixelBad === 0 && on.st.pictureOk >= nframes - 2 && off.st.pictureOk >= nframes - 2 && on.st.writeViolations === 0, JSON.stringify(on.st.firstBad ?? off.st.firstBad));
  check(`${label}: instances were skipped (${on.marked} marks), none without the analysis; no mark is left at the end of a tick`, on.marked >= expectSkips && off.marked === 0 && on.leftover === 0, `${on.marked} marks, ${on.leftover} left`);
}
{
  const r = rng(51);
  const assets = [C.randomAsset(r, 32, 48, 2, 2), C.randomAsset(r, 24, 16, 4, 3), C.randomAsset(r, 16, 24, 4, 4), C.randomAsset(r, 8, 8, 8, 2)];
  const insts = [0, 1, 2, 3, 1, 2, 3, 3, 2, 1, 3, 2];
  const statics = [[10, 10], [60, 12], [100, 20], [150, 30], [190, 40], [20, 80], [70, 90], [120, 100], [160, 110], [210, 120]];
  const script = [];
  for (let t = 0; t < N(60); t++) {
    const tick = statics.map(([x, y], i) => op.showf(i, x + 1, y + 1, t > 30 && i === 3 && t % 7 === 0 ? (t >> 3) : 0));   // frame-only changes of instance 3 now and then
    tick.push(op.showf(10, (t * 6) % 230, 60 + (t % 20), t % 3), op.showf(11, 200 - (t * 4) % 200, 95, t % 4));          // two movers crossing the statics
    if (t % 11 === 5) tick.push(op.at(2 + (t % 5), 3), op.prints('TEXT UNDER'), op.tile(1, 13, 20));
    if (t === 25) tick.push(op.hide(5));
    script.push(tick);
  }
  skipScene('2a. 10 static v3 instances (32x48, 24x16, 16x24, 8x8; frames), 2 movers over them, text and tiles under them, a hide, frame-only changes, frame_div 1',
    { div: 1, assets, insts, tiles: randomTiles(rng(52), 3), script }, N(60) + 4, { expectSkips: 50 });
  for (const div of [2, 3]) {
    const rr = rng(530 + div);
    const sc = [];
    const pos = insts.map(() => ({ x: rr.int(0, 220), y: rr.int(0, 140), still: rr.chance(0.6), f: 0 }));
    for (let t = 0; t < N(50); t++) sc.push(pos.map((p, i) => { if (!p.still) { p.x = (p.x + 3) % 220; p.y = (p.y + 2) % 140; } if (rr.chance(0.05)) p.f = rr.int(0, 3); if (rr.chance(0.04)) p.still = !p.still; return op.showf(i, p.x, p.y, p.f); }));
    sc.forEach((t, k) => { if (k % 9 === 3) t.push(op.at(rr.int(0, 23), rr.int(0, 20)), op.prints('XY' + k)); });
    skipScene(`2.${div} a random mix of still and moving v3 instances with frame changes, frame_div ${div}`, { div, assets, insts, tiles: randomTiles(rng(54), 3), script: sc }, N(50) * div + 4, { expectSkips: 10 });
  }
}

// ==================================================================================================================
console.log('\n3. The tile operations (language batch 1) over moving v3 sprites');
let _ops = null;
function opsGame6(spec) {
  const rt = C.runtime(), g = (_ops ??= assembleGame(join(RUNTIME_DIR, 'test_ops.asm'), { name: 'ops3' }));
  const img = linkGame(rt.img, g.bytes);
  const put = (a, bytes) => img.set(bytes, a);
  const O = C5.OPS, w16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
  img[0x8004] = spec.div | 0x80;
  img[0x8005] = spec.assets.length;
  let at = O.SPRDATA;
  spec.assets.forEach((a, i) => { const b = C.assetBytes(a); put(at, b); put(O.SPRTAB + 8 * i, [a.w, a.h, ...w16(at), 0, 0, a.phases, a.nframes]); at += b.length; });
  if (at > O.TILESET) throw new Error('art too big for test_ops');
  put(O.INST, [spec.insts.length, ...spec.insts]);
  put(O.TILESET, [spec.tiles.length, ...spec.tiles.flatMap((t) => [...t.bmp, t.attr])]);
  let mp = O.MAPS; const tab = [spec.maps.length];
  spec.maps.forEach((m) => { put(mp, [m.w, m.h, ...m.cells]); tab.push(...w16(mp)); mp += 2 + m.cells.length; });
  put(O.MAPTAB, tab);
  put(0x8006, w16(O.SPRTAB));
  put(0x8008, [...w16(O.TILESET), 0, 0, 0, 0, ...w16(O.INST)]);
  put(0x8010, w16(O.MAPTAB));
  img.fill(0, O.BASE, O.END);
  const bytes = [];                                               // SHOWF is op 31 of test_ops.asm (v3); the rest as m5-common encodes it
  for (const t of spec.script) { for (const o of t) bytes.push(...(o.op === 'showf' ? [31, o.i, o.x, o.y, o.f] : C5.encodeScript([[o]]).slice(0, -1))); bytes.push(0); }
  if (bytes.length > O.END - O.BASE) throw new Error('script too long');
  put(O.BASE, bytes);
  return { img, dck: dckOf(img), syms: rt.syms, gsyms: g.syms, spec };
}
/** Model6 with the tile operations of Model5 (m5-common, written from the batch 1 contract). */
class Model6Ops extends C.Model6 {
  constructor(spec = {}) {
    super({ ...spec, map: null });
    this.maps = (spec.maps ?? []).map((m) => ({ w: m.w, h: m.h, cells: m.cells, zero: false }));
    this.changed = new Set();
    this.seed = 0xACE1;
    if (!spec.noBoot && this.maps.length) this.loadRecord(this.maps[0], 0, 0);
  }
  apply(o) {
    if (['fill', 'fillc', 'copy', 'loadmap', 'loadmapat', 'loadmapptr', 'border', 'randomise', 'rnd'].includes(o.op)) return C5.Model5.prototype.apply.call(this, o);
    return super.apply(o);
  }
}
for (const k of ['set', 'fill', 'copy', 'loadRecord', 'rndStep']) Model6Ops.prototype[k] = C5.Model5.prototype[k];
{
  const tiles = randomTiles(rng(21), 7);
  const randMap = (r, w, h) => ({ w, h, cells: Array.from({ length: w * h }, () => (r.chance(0.6) ? 0x80 | r.int(0, 6) : r.int(32, 126))) });
  for (const [div, seed, nticks] of [[1, 31, N(80)], [2, 32, N(70)], [3, 33, N(60)]]) {
    const r = rng(seed);
    const maps = [randMap(r, 32, 24), randMap(r, 14, 9), randMap(r, 24, 16), randMap(r, 3, 3)];
    const assets = [C.randomAsset(r, 16, 24, 4, 2), C.randomAsset(r, 8, 8, 8, 2), C.randomAsset(r, 24, 12, 2, 1)];   // (art inside test_ops' 512 bytes)
    const insts = [0, 1, 2, 0, 1, 2];
    const script = Array.from({ length: nticks }, () => C5.randomTileOps(r, { maps: 4, tiles: 7, size: div === 1 ? 'small' : 'mixed' }));
    const pos = insts.map(() => ({ x: r.int(0, 220), y: r.int(0, 160), dx: r.int(-5, 5), dy: r.int(-4, 4) }));
    script.forEach((t, k) => pos.forEach((p, i) => { p.x += p.dx; p.y += p.dy; if (p.x < 0 || p.x > 230) p.dx = -p.dx; if (p.y < 0 || p.y > 170) p.dy = -p.dy; t.push(r.chance(0.04) ? op.hide(i) : op.showf(i, Math.max(0, p.x), Math.max(0, p.y), (k >> 2) & 1)); }));
    const game = opsGame6({ div, tiles, maps, assets, insts, script });
    const st = C.observe6(game, nticks * div + 4, { script, ModelClass: Model6Ops });
    sceneChecks(`3.${div} random FILL / FILLC / COPY / LOADMAP / TILE / PRINT every tick over 6 v3 instances with frames, frame_div ${div}`, st, nticks * div + 4);
  }
}

finish('runtime v3 part 1, pictures');
void hex;
