"use strict";
// m4-runtime.mjs -- milestone M4a runtime test, part 1: Leap Arcade runtime v2 on a stock TS2068 (TSRun): boot state, the game header v2 (asset
// descriptors, instance table, every clamp), the pre-shifted phase copies byte for byte against an independent JS implementation, and the picture:
// 16 instances of assets of different sizes and phase counts over text and tiles, compared with a JS compositor after EVERY refresh (memory byte for
// byte AND on screen as colours); draw order, erase exactness, overruns without tearing.
//   node arcade/tests/m4-runtime.mjs
// Companions: m4-runtime-api.mjs (RT_SHOW / RT_HIDE / RT_HIT vs a model, RT_KEYDOWN), m4-runtime-mem.mjs (memory map, stack), m4-runtime-regs.mjs
// (interrupt injection), m4-runtime-skip.mjs (the unchanged-sprite skip), m4-runtime-perf.mjs (T-states), m4-mutations.mjs.
import { printUsage } from '../tools/build-runtime-v2.mjs';
import * as C from './m4-common.mjs';
import { rng, randomScene, randomTiles } from './m3-scenes.mjs';
const { M, Z, FRAME_T, FIRST_PIXEL_T, hex, makeChecks, rd8, rd16, op } = C;

const { check, finish } = makeChecks();
const rt = C.runtime();
const S = rt.syms;
console.log('M4a runtime test: Leap Arcade runtime v2 on a stock TS2068 (TSRun)\n');
printUsage(rt.usage, rt.dck);
console.log('');

const allEq = (m, from, n, v) => { for (let i = 0; i < n; i++) if (m.ram[from + i] !== v) return false; return true; };
const run = (g, frames = 40) => { const m = C.newMachine(g.dck); C.bootMachine(m, S); for (let f = 0; f < frames; f++) M.runFrame(m); return m; };

// ==================================================================================================================
// 1. Boot state (the placeholder game), with the stale RAM of a real hand-off
// ==================================================================================================================
console.log('1. Boot state (placeholder game; chunk 6, the pools and the display files are filled with garbage when the cartridge starts)');
{
  const m = C.newMachine(rt.dck);
  let seen = false;
  for (let f = 0; f < 400 && !seen; f++) {
    const end = m.frameStart + FRAME_T;
    while (m.tstates < end) {
      if (m.cpu.pc === S.ENTRY && m.cpu.sp !== 0 && m.tstates > 0) { seen = true; break; }
      Z.runZ80(m.cpu, m.bus, 1, m);
    }
    if (!seen) M.runFrame(m);
  }
  check('the cartridge entry was reached', seen);
  for (let a = 0xC000; a < 0xE000; a++) m.ram[a] = 0xA5;          // chunk 6: garbage
  for (let a = 0xF000; a < 0xFB00; a++) m.ram[a] = 0xA5;          // the freed pool B and table
  for (let a = 0x4000; a < 0x7B00; a++) m.ram[a] = 0x5A;          // both display files: garbage
  for (let i = 0; i < 16; i++) m.ay.regs[i] = 0xFF;                // the stock ROM wrote to the AY: garbage
  const b = C.bootMachine(m, S);
  for (let f = 0; f < 6; f++) M.runFrame(m);
  check('boot completes (V_FRAMES counts) within 14 frames of the entry', rd16(m, S.V_FRAMES) > 0 && b.bootFrames <= 14, `${b.bootFrames} frames`);
  check('every cell is a font space (32) with attribute $38 (paper 7, ink 0)', allEq(m, S.CELL_TILE, 768, 32) && allEq(m, S.CELL_ATTR, 768, 0x38));
  check('both dirty maps are empty', allEq(m, S.DIRTY0, 96, 0) && allEq(m, S.DIRTY1, 96, 0));
  const f0 = C.dfileOf(m, 0), f1 = C.dfileOf(m, 1);
  check('both display files: all pixels 0, all attributes $38', f0.bitmap.every((v) => v === 0) && f0.attrs.every((v) => v === 0x38) && f1.bitmap.every((v) => v === 0) && f1.attrs.every((v) => v === 0x38));
  const px = C.shownColours(m);
  check('the screen shows a blank white page (colour 7 everywhere)', px && px.every((v) => v === 7));
  check('glyph table: codes 0..31 blank, 32..127 = the font, 128..255 blank', [...Array(32).keys()].every((v) => C.glyphOfValue(m, S, v).every((b) => b === 0)) &&
    C.FONT.every((g, k) => C.glyphOfValue(m, S, 32 + k).join() === g.join()) && [...Array(128).keys()].every((t) => C.glyphOfValue(m, S, 128 + t).every((b) => b === 0)));
  check('no assets, no instances: PHASE_PTR, AST, SPR_TAB, SPR_DRAWN all 0 (stale $A5 cleared); V_NAST = V_NINST = 0',
    allEq(m, S.PHASE_PTR, 128, 0) && allEq(m, S.AST, 64, 0) && allEq(m, S.SPR_TAB, 96, 0) && allEq(m, S.SPR_DRAWN, 128, 0) && rd8(m, S.V_NAST) === 0 && rd8(m, S.V_NINST) === 0);
  check('keyboard state V_KEYS: eight $FF', allEq(m, S.V_KEYS, 8, 0xFF));
  check('text state: attribute $38, cursor 0,0; sound idle; AY all 0', rd8(m, S.V_TEXT_ATTR) === 0x38 && rd8(m, S.V_CUR_ROW) === 0 && rd8(m, S.V_CUR_COL) === 0 &&
    rd8(m, S.V_SFX_ACTIVE) === 0 && Array.from({ length: 16 }, (_, i) => m.ay.regs[i]).every((v) => v === 0) && allEq(m, S.AY_SHADOW, 16, 0));
  check('stack canary $5AA5 at $FB00 (the stack is 1 KB: $FB02..$FEFF), STACK_TOP $FF00', rd16(m, 0xFB00) === 0x5AA5 && S.STACK_CANARY === 0xFB00 && S.STACK_TOP === 0xFF00 && S.STACK_LIMIT === 0xFB02);
  check('hand-off and play mapping as v1 ($F4 = $33, IM 1, $FF bits 6-7 = 0)', m.portF4 === 0x33 && m.cpu.im === 1 && (m.portFF & 0xC0) === 0);
  check('ISR is exactly 46 bytes ($0038..$0065) and the NMI vector $0066 follows it', S.ISR === 0x38 && S.ISR_END === 0x66 && S.NMI === 0x66);
}

// ==================================================================================================================
// 2. Assets: descriptors, AST records, PHASE_PTR, the phase copies byte for byte
// ==================================================================================================================
/** Independent JS implementation of the pre-shift: the rows (2 x wb bytes of mask, image pairs) of asset `a` shifted right by s bits. */
function phaseCopy(a, s) {
  const w = C.normW(a.w), h = C.normH(a.h), wb = w / 8 + (s > 0 ? 1 : 0), out = [];
  for (let r = 0; r < h; r++) {
    const row = a.rows[r] ?? { mask: 0, image: 0 };
    const mask = row.mask & (w === 16 ? 0xFFFF : 0xFF), image = row.image & (w === 16 ? 0xFFFF : 0xFF);
    let mw = ((mask << (24 - w)) | ((1 << (24 - w)) - 1)) >>> 0;          // mask: the sprite at the left of a 24 bit window, background shows beyond it
    let iw = (image << (24 - w)) >>> 0;
    mw = (((0xFFFFFF << (24 - s)) & 0xFFFFFF) | (mw >>> s)) >>> 0;       // shifted right: mask fills with 1s, image with 0s
    iw = iw >>> s;
    for (let j = 0; j < wb; j++) out.push((mw >> (16 - 8 * j)) & 0xFF, (iw >> (16 - 8 * j)) & 0xFF);
  }
  return out;
}
function checkAssets(label, game, m) {
  const mdl = new C.Model2(game.spec);
  const bad = [];
  mdl.assets.forEach((a, i) => {
    const ast = Array.from({ length: 8 }, (_, k) => rd8(m, S.AST + 8 * i + k));
    const xmask = a.phases === 8 ? 0xFF : a.phases === 4 ? 0xFE : a.phases === 2 ? 0xFC : 0xF8;
    const want = [a.h, a.w / 8, xmask, a.phases, ...a.hot];
    if (ast.join() !== want.join()) bad.push(`AST[${i}] ${ast} != ${want}`);
    for (let s = 0; s < 8; s++) {
      const ptr = rd16(m, S.PHASE_PTR + 16 * i + 2 * s);
      if (s % a.gran !== 0) { if (ptr !== 0) bad.push(`PHASE_PTR[${i}][${s}] = ${hex(ptr)}, expected none`); continue; }
      if (ptr === 0) { bad.push(`PHASE_PTR[${i}][${s}] missing`); continue; }
      const want2 = phaseCopy(game.spec.assets[i], s);
      const got = Array.from({ length: want2.length }, (_, k) => rd8(m, ptr + k));
      if (got.join() !== want2.join()) bad.push(`copy [${i}][${s}] at ${hex(ptr)} differs`);
    }
  });
  mdl.insts.forEach((s, i) => { if (rd8(m, S.SPR_TAB + 6 * i + 1) !== s.asset) bad.push(`SPR_TAB[${i}] asset ${rd8(m, S.SPR_TAB + 6 * i + 1)} != ${s.asset}`); });
  for (let i = mdl.insts.length; i < 16; i++) for (let k = 0; k < 6; k++) if (rd8(m, S.SPR_TAB + 6 * i + k) !== 0) bad.push(`SPR_TAB[${i}] not zero`);   // (a bad SHOW index must leave them alone)
  check(`${label}: V_NAST = ${mdl.assets.length}, V_NINST = ${mdl.insts.length}; AST, PHASE_PTR, every phase copy and SPR_TAB equal the JS reference`,
    rd8(m, S.V_NAST) === mdl.assets.length && rd8(m, S.V_NINST) === mdl.insts.length && bad.length === 0, bad.slice(0, 3).join('; '));
  // no two copies share a slot: all pointers distinct and inside the three pools
  const ptrs = [];
  for (let k = 0; k < 64; k++) { const p = rd16(m, S.PHASE_PTR + 2 * k); if (p) ptrs.push(p); }
  const inPool = (p) => (p >= S.POOL_A && p + 96 <= S.POOL_A + 32 * 96) || (p >= S.POOL_B && p + 96 <= S.POOL_B + 28 * 96) || (p >= S.POOL_C && p + 96 <= S.POOL_C + 4 * 96);
  check(`${label}: the ${ptrs.length} copies are in distinct 96-byte slots of the three pools`, new Set(ptrs).size === ptrs.length && ptrs.every(inPool));
}
console.log('\n2. Assets, phases and the memory pools');
{
  const r = rng(2);
  const assets = [C.randomAsset(r, 16, 16, 8), C.randomAsset(r, 8, 8, 4), C.randomAsset(r, 16, 12, 2), C.randomAsset(r, 8, 16, 1), C.randomAsset(r, 16, 5, 4), C.randomAsset(r, 16, 16, 1), C.randomAsset(r, 8, 3, 8), C.randomAsset(r, 8, 11, 2)];
  assets[1].hot = [1, 2, 5, 4]; assets[4].hot = [0, 1, 16, 3];
  const g = C.scriptGame({ assets, insts: [0, 1, 2, 3, 4, 5, 6, 7, 7, 6, 5, 4, 3, 2, 1, 0], script: [] });
  checkAssets('2a. 8 assets of every width / phase mix, 16 instances', g, run(g, 10));
  // the worst case for the pools: 8 assets, 16 x 16, 8 phases = 64 slots
  const full = Array.from({ length: 8 }, () => C.randomAsset(r, 16, 16, 8));
  const g2 = C.scriptGame({ assets: full, insts: [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7], script: [] });
  const m2 = run(g2, 10);
  checkAssets('2b. 8 assets of 16 x 16 with 8 phases (all 64 slots)', g2, m2);
  check('2b. every slot of the three pools is used, so the pools hold the worst case exactly', new Set(Array.from({ length: 64 }, (_, k) => rd16(m2, S.PHASE_PTR + 2 * k)).filter(Boolean)).size === 64 && S.SLOT_COUNT === 64);
}

// ==================================================================================================================
// 3. The game header v2: every clamp
// ==================================================================================================================
console.log('\n3. Game header v2: clamping');
{
  const r = rng(3);
  const base = () => [C.randomAsset(r, 16, 16, 8), C.randomAsset(r, 8, 8, 4), C.randomAsset(r, 16, 8, 2)];
  const ticking = (m) => rd16(m, S.V_TICKS) > 5 && rd16(m, S.STACK_CANARY) === 0x5AA5;
  const script = [[op.show(0, 20, 20), op.show(15, 100, 100), op.show(16, 50, 50), op.show(255, 1, 1)], [op.show(1, 60, 60)]];
  // 3a. ninst above 16 is read as 16; bytes beyond the 16th are ignored
  let a = base(); let g = C.scriptGame({ assets: a, insts: Array.from({ length: 40 }, (_, i) => i % 3), ninstHeader: 40, script });
  let m = run(g, 20);
  check('3a. ninst 40 is read as 16 (the 17th..40th bytes are not instances; the unused SPR_TAB entries stay zero)', rd8(m, S.V_NINST) === 16 && ticking(m));
  checkAssets('3a', g, m);
  g = C.scriptGame({ assets: a, insts: Array.from({ length: 255 }, () => 1), ninstHeader: 255, script: [] });
  check('3a. ninst 255 is read as 16', rd8(run(g, 10), S.V_NINST) === 16);
  // 3b. asset index >= nassets is read as nassets - 1
  a = base(); g = C.scriptGame({ assets: a, insts: [0, 1, 2, 3, 7, 255, 2, 0], script });
  m = run(g, 20);
  check('3b. asset indices 3, 7, 255 with 3 assets are read as asset 2', Array.from({ length: 8 }, (_, i) => rd8(m, S.SPR_TAB + 6 * i + 1)).join() === '0,1,2,2,2,2,2,0' && ticking(m));
  checkAssets('3b', g, m);
  // 3c. nassets above 8 is read as 8; nassets 0 gives no instances even with an instance table
  const nine = Array.from({ length: 9 }, () => C.randomAsset(r, 16, 16, 1));
  g = C.scriptGame({ assets: nine.slice(0, 8), nassetsHeader: 200, insts: [0, 7, 7, 3], script: [] });
  m = run(g, 10);
  check('3c. sprite_count 200 is read as 8 assets', rd8(m, S.V_NAST) === 8 && rd8(m, S.V_NINST) === 4);
  g = C.scriptGame({ assets: a, nassetsHeader: 0, insts: [0, 1, 2], script });
  m = run(g, 20);
  check('3c. sprite_count 0 with 3 instances listed: ninst is read as 0 (no instance can be shown), the game runs', rd8(m, S.V_NAST) === 0 && rd8(m, S.V_NINST) === 0 && ticking(m) && allEq(m, S.SPR_TAB, 96, 0));
  g = C.scriptGame({ assets: a, instTable0: true, script });
  m = run(g, 20);
  check('3c. inst_table 0: no instances', rd8(m, S.V_NINST) === 0 && rd8(m, S.V_NAST) === 3 && ticking(m));
  g = C.scriptGame({ assets: a, spriteTable0: true, insts: [0, 1], script });
  m = run(g, 20);
  check('3c. sprite_table 0: no assets, no instances', rd8(m, S.V_NINST) === 0 && rd8(m, S.V_NAST) === 0 && ticking(m));
  // 3d. phases not in {1, 2, 4, 8}: the largest of them not above the value (0 -> 1); width and height clamps
  const odd = [];
  const phaseIn = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 255], phaseOut = [1, 1, 2, 2, 4, 4, 4, 4, 8, 8, 8, 8];
  for (let i = 0; i < 8; i++) odd.push(C.randomAsset(r, 16, 16, phaseIn[i]));
  g = C.scriptGame({ assets: odd, insts: [0, 1, 2, 3, 4, 5, 6, 7], script: [] });
  m = run(g, 10);
  check('3d. phases 0,1,2,3,4,5,6,7 are read as 1,1,2,2,4,4,4,4', Array.from({ length: 8 }, (_, i) => rd8(m, S.AST + 8 * i + 3)).join() === phaseOut.slice(0, 8).join());
  checkAssets('3d', g, m);
  const odd2 = phaseIn.slice(8).map((p) => C.randomAsset(r, 16, 16, p));
  g = C.scriptGame({ assets: odd2, insts: [0, 1, 2, 3], script: [] });
  m = run(g, 10);
  check('3d. phases 8, 9, 16, 255 are read as 8', Array.from({ length: 4 }, (_, i) => rd8(m, S.AST + 8 * i + 3)).join() === '8,8,8,8');
  checkAssets('3d', g, m);
  const sizes = [[0, 0], [1, 1], [8, 8], [9, 17], [16, 16], [24, 255], [255, 1], [7, 15]].map(([w, h]) => C.randomAsset(r, w, h, 8));
  g = C.scriptGame({ assets: sizes, insts: [0, 1, 2, 3, 4, 5, 6, 7], script: [[op.show(0, 5, 5), op.show(3, 77, 77), op.show(5, 120, 90), op.show(6, 200, 100)]] });
  m = run(g, 20);
  check('3d. width <= 8 is read as 8, otherwise 16; height 0 as 1, above 16 as 16', Array.from({ length: 8 }, (_, i) => rd8(m, S.AST + 8 * i + 1) * 100 + rd8(m, S.AST + 8 * i)).join() === '101,101,108,216,216,216,201,115' && ticking(m),
    Array.from({ length: 8 }, (_, i) => rd8(m, S.AST + 8 * i + 1) * 100 + rd8(m, S.AST + 8 * i)).join());
  checkAssets('3d', g, m);
  // 3e. hot box: a pointer is read, 0 means the whole sprite
  const hotA = C.randomAsset(r, 16, 16, 8), hotB = C.randomAsset(r, 8, 8, 8);
  hotA.hot = [3, 2, 9, 11]; g = C.scriptGame({ assets: [hotA, hotB], insts: [0, 1], script: [] });
  m = run(g, 10);
  check('3e. hot box from the descriptor; no hot box = (0, 0, width, height)', [...Array(4).keys()].map((k) => rd8(m, S.AST + 4 + k)).concat([...Array(4).keys()].map((k) => rd8(m, S.AST + 12 + k))).join() === '3,2,9,11,0,0,8,8');
}

// ==================================================================================================================
// 4. The picture
// ==================================================================================================================
function sceneChecks(label, nframes, st, { expectOneTickPerRefresh = true, div = 1 } = {}) {
  console.log(`\n${label}`);
  check(`the picture on screen equals the model (cells, then masked instances in index order) in 100 % of the ${nframes} refreshes (memory: bitmap + attributes)`,
    st.pictureOk === nframes && st.pictureBad === 0, st.firstBad ? JSON.stringify(st.firstBad) : `${st.pictureOk}/${nframes}`);
  check('...and as colours on the screen (ink / paper / bright of every pixel, 100 % of refreshes)', st.pixelBad === 0, `${st.pixelBad} frames differ`);
  check('no tearing: no instruction ever writes the displayed display file', st.writeViolations === 0, `${st.writeViolations} writes`);
  check('every flip request is honoured at the next interrupt and nowhere else; frame counter exact', st.flipMismatch === 0 && st.shadowBad === 0 && st.missed === 0,
    `${st.flipMismatch} flip mismatches, ${st.missed} frames off`);
  check('the flip (OUT $FF) executes before the first pixel line', st.flipWrites.length > 0 && Math.max(...st.flipWrites) < FIRST_PIXEL_T, `latest ${Math.max(...st.flipWrites)} T`);
  check('IM 1 and interrupts enabled whenever a tick starts', st.imBad === 0 && st.work.length > 0, `${st.imBad} violations`);
  check('stack canary intact; SP within $FB02..$FF00', st.canary === 0x5AA5 && st.spMin >= S.STACK_LIMIT && st.spMax <= S.STACK_TOP, `SP ${hex(st.spMin)}..${hex(st.spMax)}`);
  check('ticks are never skipped: V_TICKS counts 0, 1, 2, ...', st.ticks.every((t, k) => t.n === k), `${st.ticks.length} ticks`);
  if (expectOneTickPerRefresh) check(`one tick every ${div} refresh${div > 1 ? 'es' : ''} (the work fits)`, st.ticks.slice(2).every((t, k) => t.frames - st.ticks[k + 1].frames === div),
    `gaps ${[...new Set(st.ticks.slice(2).map((t, k) => t.frames - st.ticks[k + 1].frames))].join(',')}`);
}

/** A random-walk of `n` instances: show / hide / jump ops appended to the text and tile ops of a tick. */
function addSprites(script, n, r, { box = null, hideRate = 0.03, jumpRate = 0.04 } = {}) {
  const lim = box ?? { x0: -3, x1: 245, y0: -3, y1: 185 };
  const pos = Array.from({ length: n }, () => ({ x: r.int(Math.max(0, lim.x0), Math.min(230, lim.x1)), y: r.int(Math.max(0, lim.y0), Math.min(170, lim.y1)), dx: r.int(-5, 5), dy: r.int(-4, 4) }));
  script.forEach((t) => {
    pos.forEach((p, i) => {
      if (r.chance(jumpRate)) { p.x = box ? r.int(box.x0, box.x1) : r.int(-40, 300); p.y = box ? r.int(box.y0, box.y1) : r.int(-40, 230); }
      else { p.x += p.dx; p.y += p.dy; if (p.x < lim.x0 || p.x > lim.x1) p.dx = -p.dx; if (p.y < lim.y0 || p.y > lim.y1) p.dy = -p.dy; }
      if (r.chance(hideRate)) t.push(op.hide(i)); else t.push(op.show(i, p.x, p.y));
    });
  });
  return script;
}

{ // 4a. the acceptance scene: 16 instances, 3 assets of different sizes and phases, text and tiles
  const r = rng(41);
  const assets = [C.randomAsset(r, 16, 16, 8), C.randomAsset(r, 8, 8, 4), C.randomAsset(r, 16, 10, 2)];
  const insts = Array.from({ length: 16 }, (_, i) => i % 3);
  const script = addSprites(randomScene(401, 80, { sprites: 0, tiles: 8, textRate: 0.55, tileRate: 0.6, wild: true }), 16, r);
  const spec = { div: 2, assets, insts, tiles: randomTiles(rng(11), 8), script };
  const st = C.observe(C.scriptGame(spec), 200, { script });
  sceneChecks('4a. 16 instances of 3 assets (16x16 / 8 phases, 8x8 / 4 phases, 16x10 / 2 phases), random positions, text and tiles (frame_div 2, 200 refreshes)', 200, st, { expectOneTickPerRefresh: false });
  console.log(`  tick work (ISR excluded) avg ${C.avg(st.work).toFixed(0)}  max ${Math.max(...st.work)} T`);
}

{ // 4b. every phase count and width, 16 instances, frame_div 3 (the worst case must fit in 3 refreshes)
  const r = rng(42);
  const assets = [C.randomAsset(r, 16, 16, 8), C.randomAsset(r, 8, 8, 8), C.randomAsset(r, 16, 12, 2), C.randomAsset(r, 16, 16, 4), C.randomAsset(r, 8, 5, 1), C.randomAsset(r, 16, 16, 1), C.randomAsset(r, 8, 16, 2), C.randomAsset(r, 16, 7, 8)];
  const insts = Array.from({ length: 16 }, (_, i) => (i * 5) % 8);
  const script = addSprites(randomScene(402, 75, { sprites: 0, tiles: 6, textRate: 0.5, tileRate: 0.5 }), 16, r);
  const spec = { div: 3, assets, insts, tiles: randomTiles(rng(12), 6), script };
  const st = C.observe(C.scriptGame(spec), 220, { script });
  sceneChecks('4b. 16 instances of 8 assets (widths 8 / 16, phases 8 / 4 / 2 / 1, heights 5..16), frame_div 3 (220 refreshes)', 220, st, { div: 3 });
  console.log(`  tick work avg ${C.avg(st.work).toFixed(0)}  max ${Math.max(...st.work)} T`);
}

{ // 4c. crowding: all 16 instances inside a 56 x 56 area, so they overlap in every order; assets of different phases and sizes
  const r = rng(43);
  const assets = [C.randomAsset(r, 16, 16, 8), C.randomAsset(r, 8, 8, 2), C.randomAsset(r, 16, 14, 4), C.randomAsset(r, 16, 16, 1)];
  const insts = Array.from({ length: 16 }, (_, i) => (i * 7 + (i >> 2)) % 4);
  const script = addSprites(randomScene(403, 80, { sprites: 0, tiles: 4, textRate: 0.4, tileRate: 0.4 }), 16, r, { box: { x0: 90, x1: 140, y0: 70, y1: 115 }, jumpRate: 0.08 });
  const spec = { div: 3, assets, insts, tiles: randomTiles(rng(13), 4), script };
  const st = C.observe(C.scriptGame(spec), 240, { script });
  sceneChecks('4c. 16 instances crowded into 50 x 45 pixels (overlaps in every draw order), 4 assets, frame_div 3 (240 refreshes)', 240, st, { div: 3 });
}

{ // 4d. a screen full of text, instances sweep over it, then all are hidden: the erase restores every cell exactly in both files
  const fill = [];
  for (let row = 0; row < 24; row++) fill.push(op.at(row, 0), op.prints('0123456789ABCDEFGHIJKLMNOPQRSTU'), op.printc(65 + (row % 26)));
  const walk = [];
  for (let t = 0; t < 60; t++) walk.push(Array.from({ length: 16 }, (_, i) => op.show(i, (7 * t + 17 * i) % 232 + (i & 1), (3 * t + 11 * i) % 172 + (i & 3))));
  const hide = [Array.from({ length: 16 }, (_, i) => op.hide(i)), [], [], []];
  const r = rng(44);
  const assets = [C.randomAsset(r, 16, 16, 8), C.randomAsset(r, 8, 8, 8), C.randomAsset(r, 16, 12, 4), C.randomAsset(r, 16, 16, 2)];
  const script = [fill.slice(0, 36), fill.slice(36), ...walk, ...hide];
  const spec = { div: 3, assets, insts: Array.from({ length: 16 }, (_, i) => i % 4), script };
  const st = C.observe(C.scriptGame(spec), 215, { script });
  sceneChecks('4d. 16 instances sweeping over a screen full of text, then hidden (frame_div 3)', 215, st, { expectOneTickPerRefresh: false });
  const m = st.m;
  const cellsOnly = st.model.render();
  const d0 = C.dfileOf(m, 0), d1 = C.dfileOf(m, 1);
  check('after hide, BOTH display files equal the text alone: the erase restored every character exactly (no trace of any instance)',
    st.ticks.length >= script.length + 1 && C.diffCount(d0.bitmap, cellsOnly.bitmap) + C.diffCount(d0.attrs, cellsOnly.attrs) + C.diffCount(d1.bitmap, cellsOnly.bitmap) + C.diffCount(d1.attrs, cellsOnly.attrs) === 0, `${st.ticks.length} ticks of ${script.length}`);
  check('...and the dirty maps are empty at rest, SPR_DRAWN is clear in both files', allEq(m, S.DIRTY0, 96, 0) && allEq(m, S.DIRTY1, 96, 0) && Array.from({ length: 32 }, (_, i) => rd8(m, S.SPR_DRAWN + 4 * i)).every((v) => v === 0));
}

{ // 4e. tiles and text change every tick under 12 moving instances; frame_div 2
  const tiles = randomTiles(rng(21), 16);
  const r = rng(45);
  const map = Array.from({ length: 768 }, () => (r.chance(0.6) ? 0x80 | r.int(0, 15) : r.int(32, 126)));
  const assets = [C.randomAsset(r, 16, 16, 8), C.randomAsset(r, 8, 8, 4)];
  const script = addSprites(randomScene(405, 90, { sprites: 0, tiles: 16, textRate: 0.4, tileRate: 1, tileBurst: 6 }), 12, r);
  const spec = { div: 2, assets, insts: Array.from({ length: 12 }, (_, i) => i & 1), tiles, map, script };
  const st = C.observe(C.scriptGame(spec), 180, { script });
  sceneChecks('4e. A full screen map of tiles and text; 1-6 tiles changed every tick, text, 12 instances (frame_div 2)', 180, st, { expectOneTickPerRefresh: false });
}

{ // 4f. overrun: every 5th tick burns ~80,000 T on top of 16 instances
  const r = rng(46);
  const assets = [C.randomAsset(r, 16, 16, 8), C.randomAsset(r, 16, 12, 2)];
  const script = addSprites(randomScene(406, 70, { sprites: 0, tiles: 6, textRate: 0.6, tileRate: 0.8 }), 16, r);
  for (let t = 4; t < script.length; t += 5) script[t].push(op.burn());
  const spec = { div: 1, assets, insts: Array.from({ length: 16 }, (_, i) => i & 1), tiles: randomTiles(rng(31), 6), script };
  const st = C.observe(C.scriptGame(spec), 300, { script });
  sceneChecks('4f. 16 instances plus a frame_entry that overruns (BURN, ~80,000 T extra), frame_div 1', 300, st, { expectOneTickPerRefresh: false });
  check('the overruns happened: interrupts during the work flipped nothing, and were skipped cleanly', st.skippedFlips > 5 && Math.max(...st.work) > 2 * FRAME_T, `${st.skippedFlips} flips skipped, longest work ${Math.max(...st.work)} T`);
}

{ // 4g. x rounding: stored x unchanged, drawn x rounded down; each phase count at every x
  const r = rng(47);
  const mk = (ph) => C.randomAsset(r, 16, 8, ph);
  const assets = [mk(8), mk(4), mk(2), mk(1)];
  const script = [];
  for (let x = 0; x < 40; x++) script.push([0, 1, 2, 3].map((i) => op.show(i, 8 * (i + 1) * 0 + x + 50 * i, 20 + 30 * i)));
  const spec = { div: 1, assets, insts: [0, 1, 2, 3], script };
  const game = C.scriptGame(spec);
  const st = C.observe(game, 46, { script });
  sceneChecks('4g. one instance per phase count (8 / 4 / 2 / 1) moving one pixel a tick: x is rounded down to 1 / 2 / 4 / 8 when drawn', 46, st);
  const mm = st.m;
  check('the stored x is unchanged by the rounding (SPR_TAB holds 39, 89, 139, 189)', [0, 1, 2, 3].map((i) => rd16(mm, S.SPR_TAB + 6 * i + 2)).join() === '39,89,139,189');
  check('SPR_DRAWN records, per file, the screen address of the first byte drawn: byte column 4, 11, 17, 23 (= the rounded x 39 / 88 / 136 / 184 divided by 8)',
    [0, 1, 2, 3].every((i) => [0, 64].some((o) => (rd8(mm, S.SPR_DRAWN + o + 4 * i + 1) & 31) === [4, 11, 17, 23][i])));
}

// ==================================================================================================================
// 5. erase_cells, directly: every (cell rows, cell columns) variant, both files, the page edges of the cell map
// ==================================================================================================================
console.log('\n5. erase_cells called directly (the cells a sprite covered are redrawn from the map, nothing else is touched)');
{
  const r = rng(55);
  const map = Array.from({ length: 768 }, (_, i) => (i % 5 === 0 ? 0x80 | (i % 7) : 32 + ((i * 7) % 96)));
  const game = C.scriptGame({ tiles: randomTiles(rng(56), 7), map, script: [] });
  const m = C.newMachine(game.dck);
  C.bootMachine(m, S);
  for (let f = 0; f < 12; f++) M.runFrame(m);
  for (let i = 0; i < 400000 && !(m.cpu.pc === S.TICK_LOOP && !m.cpu.halted); i++) Z.runZ80(m.cpu, m.bus, 1, m);
  const mdl = new C.Model2(game.spec);
  let bad = 0, first = null, cases = 0, regs = 0;
  const seen = new Set();
  for (let k = 0; k < 9000; k++) {
    const hoff = r.chance(0.5) ? 0 : 0x20, ncols = r.int(1, 3), h = r.pick([1, 2, 5, 7, 8, 9, 12, 15, 16, r.int(1, 16)]);
    const c0 = r.chance(0.3) ? 32 - ncols : r.int(0, 32 - ncols);
    let y = r.chance(0.3) ? 8 * r.pick([6, 7, 14, 15, 22, 23]) - r.int(0, 8) : r.int(0, 191);
    y = Math.max(0, Math.min(y, 192 - h));
    const xd = 8 * c0 + (ncols > 0 && r.chance(0.5) ? 0 : 0);
    m.ram[S.V_HOFF] = hoff;
    for (let a = 0x4000 + hoff * 256; a < 0x5800 + hoff * 256; a++) m.ram[a] = 0xFF;
    const scr = 0x4000 + hoff * 256 + C.rowAddr(y) + (xd >> 3);
    const res = C.callRoutine(m, S.erase_cells, { a: ncols << 5 | h, de: scr });
    cases++; seen.add(`${(y + h - 1 >> 3) - (y >> 3) + 1}x${ncols}`);
    if (!res.preserved || !res.spOk) regs++;
    const r0 = y >> 3, r1 = (y + h - 1) >> 3;
    let wrong = 0;
    for (let rr = 0; rr < 24 && !wrong; rr++) for (let c = 0; c < 32 && !wrong; c++) {
      const inside = rr >= r0 && rr <= r1 && c >= c0 && c < c0 + ncols;
      const g = mdl.glyph(rr * 32 + c);
      for (let kk = 0; kk < 8; kk++) {
        const got = m.ram[0x4000 + hoff * 256 + C.rowAddr(rr * 8 + kk) + c], want = inside ? g[kk] : 0xFF;
        if (got !== want) { wrong = 1; first ??= { hoff, ncols, h, y, xd, rr, c, kk, got, want }; break; }
      }
    }
    bad += wrong;
  }
  check(`${cases} random calls (both files, 1..3 cell columns incl. the right edge, 1..3 cell rows incl. the page edges of the map, heights 1..16): exactly the covered cells are redrawn, nothing else changes`, bad === 0 && seen.size === 9, first ? JSON.stringify(first) : `${seen.size} of 9 variants`);
  check('erase_cells clobbers AF BC DE HL only and keeps SP', regs === 0, `${regs} violations`);
  m.ram[S.V_HOFF] = 0;
}

finish('M4a runtime');
