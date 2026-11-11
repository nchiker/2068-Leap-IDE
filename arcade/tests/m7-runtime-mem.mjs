"use strict";
// m7-runtime-mem.mjs -- runtime v3 part 2, memory-write confinement in window mode (the m6-runtime-mem.mjs method):
//  1. the map: the new variables inside V3VARS $E102-$E1AE (disjoint from V_CAM and the frame cache's $E1C0-$E1FF), V_WIN in a formerly free byte of
//     the variables, the three tile pages in the display files' unused tails; nothing overlaps;
//  2. window games with every free area poisoned after the boot: play writes only the hidden display file, the variables, V3VARS up to W3_END, the
//     frame cache's scratch, the cell map / dirty maps (HUD), SPR_TAB, GAME_VARS, RT_ARGS (the script's calls), the stack, and WORLD_RAM only in the
//     cells SETWORLD names (inside the world); never SPR_DRAWN (no erase in window mode), the tile pages, PHASE_OFF, TILE_ATTR, GLYPH_TAB, the free
//     tails of V3VARS and the display files, T2, T4, the unallocated pool; in cache mode the pool only in slots / FTAB slot words and AST only at AST_RR;
//     Window fast path (docs/ARCADE_WINDOW_FASTPATH.md sections 2 and 6): $5E00-$5EFF may hold a per-tile blank page written by the boot in window mode (so it is read-only
//     during play, like the three pages before it), $5F00-$5FFF and $7B00-$7FFF stay free; the attribute page and the flags page hold the tile's value at all 8 bytes.
//  3. the stack depth of a window tick (cache misses from win_draw_all included) and of an interrupt.
//   node arcade/tests/m7-runtime-mem.mjs        (M7_QUICK=1: shorter)
import * as W from './m7-common.mjs';
import { rng, randomTiles } from './m3-scenes.mjs';
const { makeChecks, rd16, op, hex } = W;

const QUICK = !!process.env.M7_QUICK;
const { check, finish } = makeChecks();
const S = W.runtime().syms;
console.log('Runtime v3 part 2: memory-write confinement in window mode\n');

// ---- 1. the map -------------------------------------------------------------------------------------------------------------------
console.log('1. The map');
{
  const regs = [['V_CAM', S.V_CAM, 2], ['window state (W_CX .. W3_END)', S.W_CX, S.W3_END - S.W_CX], ['V3VARS free tail', S.W3_END, S.V3VARS + 0xC0 - S.W3_END], ['FC_VARS', S.V3VARS + 0xC0, 0x40],
    ['W_TROWS', S.W_TROWS, 256], ['W_ATTRT', S.W_ATTRT, 256], ['W_FLAGT', S.W_FLAGT, 256], ['display file 1 attributes', 0x5800, 0x300], ['W_BLANKT (the blank page, if the runtime has one)', 0x5E00, 256], ['display tail 1 free', 0x5F00, 0x100]];
  let overlap = null;
  for (let i = 0; i < regs.length; i++) for (let j = i + 1; j < regs.length; j++) { const [, a, la] = regs[i], [, b, lb] = regs[j]; if (a < b + lb && b < a + la) overlap ??= `${regs[i][0]} / ${regs[j][0]}`; }
  check('V3VARS: V_CAM $E100, the window state $E102..$E1AE, free $E1AF-$E1BF, the frame cache $E1C0-$E1FF: disjoint; the three pages $5B00/$5C00/$5D00 in display file 1\'s tail (after its attributes)',
    overlap === null && S.W_CX === 0xE102 && S.W3_END <= 0xE1C0 && S.W_TROWS === 0x5B00 && S.W_ATTRT === 0x5C00 && S.W_FLAGT === 0x5D00, overlap ?? `W3_END ${hex(S.W3_END)}`);
  check('V_WIN is $E061, a byte of the variables that part 1 left free ($E061-$E06F)', S.V_WIN === 0xE061);
}

// ---- 2. play with the free areas poisoned ---------------------------------------------------------------------------------------------
const pat = (k) => 0xA5 ^ (k & 0x3F);
function confined(label, { seed, cacheMode, nticks }) {
  const r = rng(seed);
  const tiles = [...W.randomWinTiles(r, 32), ...randomTiles(r, 8)];
  tiles[1].attr = 0x0F; tiles[2].attr = 0x31;
  const ram = W.randomWorld(r, 100, 32, { sky: 0.5 });
  for (let y = 0; y < 16; y++) for (let x = 0; x < 100; x++) ram[y * 128 + x] = ram[y * 128 + (x & ~7)];
  const win = { cx: 3, cy: 5, worldW: 100, bands: [{ rows: 3, code: 0 }, { rows: 2, code: 1 }, { rows: 11, code: 3 }], ram, flags: Array.from({ length: 32 }, () => r.int(0, 255)) };
  const assets = cacheMode ? [W.randomAsset(r, 16, 24, 4, 32), W.randomAsset(r, 16, 16, 8, 12), W.randomAsset(r, 8, 8, 8, 4)]
    : [W.randomAsset(r, 16, 24, 4, 3), W.randomAsset(r, 16, 16, 8, 2), W.randomAsset(r, 32, 30, 2, 1), W.randomAsset(r, 8, 8, 8, 2)];
  const insts = cacheMode ? [0, 0, 0, 1, 1, 2, 2, 2] : [0, 1, 2, 3, 1, 3];
  const nfs = insts.map((a) => W.normAsset(assets[a]).nf);
  const script = Array.from({ length: nticks }, () => []);
  const worldCells = new Set();
  let cam = 0;
  script.forEach((t, k) => {
    cam = Math.max(0, cam + r.int(-4, 9));
    t.push(op.camera(cam));
    insts.forEach((_, i) => {
      const sx = r.chance(0.4) ? r.pick([24, 216]) + r.int(-24, 8) : r.int(0, 240), sy = r.chance(0.4) ? r.pick([40, 168]) + r.int(-30, 8) : r.int(0, 180);
      t.push(r.chance(0.05) ? op.hide(i) : op.showf(i, sx + cam - 24, sy - 40, r.chance(cacheMode ? 0.7 : 0.3) ? r.int(0, nfs[i] - 1) : 0));
    });
    if (k % 2 === 0) {
      const x = r.int(-20, 820), y = r.int(-20, 140), t2 = r.int(0, 31);
      t.push(op.setworld(x, y, t2));
      const c = Math.floor(x / 8), rr = Math.floor(y / 8);
      if (c >= 0 && c < 100 && rr >= 0 && rr < 16) for (const k of W.CLASS_BITS ? [c - 1, c, c + 1] : [c]) if (k >= 0 && k < 100) worldCells.add(S.WORLD_RAM + rr * 128 + k);   // the class bits of x - 1 and x + 1 change with it
    }
    t.push(op.tilehit(r.int(-30, 830), r.int(-30, 140), r.int(-2, 40), r.int(-2, 40), r.int(0, 255)), op.tileflags(r.int(-30, 830), r.int(-30, 140)), op.worldtile(r.int(-30, 830), r.int(-30, 140)));
    t.push(op.hit(r.int(0, insts.length - 1), r.int(0, insts.length - 1)));
    if (k % 5 === 1) t.push(op.ink(r.int(0, 7)), op.at(r.pick([0, 1, 2, 23]), r.int(0, 25)), op.prints('S' + k), op.at(8, 10), op.prints('IN THE WINDOW'), op.tile(32 + r.int(0, 7), r.pick([0, 22]), r.int(0, 31)));
  });
  const spec = { div: 3, tiles, win, assets, insts, script };
  const game = W.winGame(spec);
  const mdl = new W.Model7(spec);
  const plan = W.planPool(mdl.assets, mdl.ninstOf(), W.POOL_PIECES(S));
  const allocated = new Set(), slotByte = new Set(), ftabSlotWord = new Set();
  plan.ftab.forEach((a, k) => { if (a) for (let i = 0; i < 4 * mdl.assets[k].nf; i++) allocated.add(a + i); if (a) for (let f = 0; f < mdl.assets[k].nf; f++) { ftabSlotWord.add(a + 4 * f + 2); ftabSlotWord.add(a + 4 * f + 3); } });
  plan.slots.forEach((list, k) => list.forEach((a) => { for (let i = 0; i < mdl.assets[k].slen; i++) { allocated.add(a + i); slotByte.add(a + i); } }));
  const REG = [
    ['PHASE_OFF', S.PHASE_OFF, 128], ['POOL_A', S.POOL_A, S.POOL_A_LEN], ['CELL_TILE', S.CELL_TILE, 768], ['CELL_ATTR', S.CELL_ATTR, 768], ['DIRTY0', S.DIRTY0, 96], ['SPR_TAB', S.SPR_TAB, 128],
    ['T2', S.T2_FREE, 32], ['DIRTY1', S.DIRTY1, 96], ['SPR_DRAWN', S.SPR_DRAWN, 128], ['T4', S.T4_FREE, 32], ['TILE_ATTR', S.TILE_ATTR, 128], ['AST', S.AST, 128], ['POOL_C', S.POOL_C, S.POOL_C_LEN],
    ['GLYPH_TAB', S.GLYPH_TAB, 2048], ['VARS', S.VARS, 0xFC], ['VARS free', S.VARS + 0xFC, 4], ['V3VARS window', S.V3VARS, S.W3_END - S.V3VARS], ['V3VARS free', S.W3_END, S.V3VARS + 0xC0 - S.W3_END],
    ['FC_VARS', S.V3VARS + 0xC0, 0x40], ['GAME_VARS', S.GAME_VARS_BASE, 0x800], ['WORLD_RAM', S.WORLD_RAM, 0x800], ['POOL_B', S.POOL_B, S.POOL_B_LEN], ['T3', S.T3, 0x80], ['STACK', S.STACK_CANARY, S.STACK_TOP - S.STACK_CANARY],
    ['HANDOFF', 0xFF00, 0x100], ['W_TROWS', S.W_TROWS, 256], ['W_ATTRT', S.W_ATTRT, 256], ['W_FLAGT', S.W_FLAGT, 256], ['W_BLANKT', 0x5E00, 0x100], ['tail $5F00', 0x5F00, 0x100], ['tail $7B00', 0x7B00, 0x500]];
  const free = REG.filter(([n]) => ['T2', 'T4', 'VARS free', 'V3VARS free', 'tail $5F00', 'tail $7B00'].includes(n));
  const ro = REG.filter(([n]) => ['PHASE_OFF', 'TILE_ATTR', 'GLYPH_TAB', 'W_TROWS', 'W_ATTRT', 'W_FLAGT', 'W_BLANKT', ...(cacheMode ? [] : ['AST'])].includes(n));
  const pools = REG.filter(([n]) => n.startsWith('POOL'));
  let poisoned = false, snapRo = null;
  const writes = new Map();
  const st = W.observe6(game, (nticks + 4) * 3, { script, ModelClass: W.Model7, untilTicks: nticks, hooks: (pc, { m }) => {
    if (!poisoned && pc === S.MAIN) {
      poisoned = true;
      for (const [, a, l] of free) for (let k = 0; k < l; k++) m.ram[a + k] = pat(k);
      for (const [, a, l] of pools) for (let k = 0; k < l; k++) if (!allocated.has(a + k)) m.ram[a + k] = pat(k);
      for (let k = 0; k < 128; k++) m.ram[S.SPR_DRAWN + k] = pat(k);
      snapRo = ro.map(([, a, l]) => m.ram.slice(a, a + l));
      const w = m.bus.write;
      m.bus.write = (addr, v) => { const a = addr & 0xFFFF; if (a >= 0xC000 || (a >= 0x5B00 && a < 0x6000) || (a >= 0x7B00 && a < 0x8000)) writes.set(a, (writes.get(a) ?? 0) + 1); w(addr, v); };
    }
  } });
  const m = st.m;
  const name = (a) => { for (const [n, s, l] of REG) if (a >= s && a < s + l) return n; return 'gap'; };
  const touched = {};
  for (const a of writes.keys()) touched[name(a)] = (touched[name(a)] ?? 0) + 1;
  console.log(`  ${label}: regions written during play (bytes): ${Object.entries(touched).map(([n, c]) => `${n} ${c}`).join(', ')}`);
  check(`${label}: the picture equals the model after every refresh (${st.pictureOk}), no write to the shown file`, st.pictureBad === 0 && st.writeViolations === 0 && st.pictureOk >= nticks * 3 - 6, JSON.stringify(st.firstBad));
  const freeOk = free.every(([, a, l]) => Array.from({ length: l }, (_, k) => m.ram[a + k]).every((v, k) => v === pat(k)));
  const poolTailOk = pools.every(([, a, l]) => Array.from({ length: l }, (_, k) => k).every((k) => allocated.has(a + k) || m.ram[a + k] === pat(k)));
  const drawnOk = Array.from({ length: 128 }, (_, k) => m.ram[S.SPR_DRAWN + k] === pat(k)).every(Boolean);
  check(`${label}: no free area written (T2, T4, $E0FC-$E0FF, $E1AF-$E1BF, $5F00-$5FFF, $7B00-$7FFF), no unallocated pool byte, SPR_DRAWN never (no erase in window mode)`, freeOk && poolTailOk && drawnOk);
  const allowed = ['CELL_TILE', 'CELL_ATTR', 'DIRTY0', 'DIRTY1', 'SPR_TAB', 'VARS', 'V3VARS window', 'FC_VARS', 'GAME_VARS', 'WORLD_RAM', 'T3', 'STACK', ...(cacheMode ? ['POOL_A', 'POOL_B', 'POOL_C', 'AST'] : [])];
  check(`${label}: play writes only the cell map, dirty maps, SPR_TAB, variables, V3VARS up to W3_END, the cache scratch, GAME_VARS, RT_ARGS, the stack, WORLD_RAM${cacheMode ? ', the pool / AST (cache mode)' : ''}`,
    Object.keys(touched).every((n) => allowed.includes(n)), JSON.stringify(touched));
  const worldW = [...writes.keys()].filter((a) => a >= S.WORLD_RAM && a < S.WORLD_RAM + 0x800);
  check(`${label}: WORLD_RAM is written only in the ${worldCells.size} cells SETWORLD named inside the world${W.CLASS_BITS ? ' and their left and right neighbours (the class bits)' : ''} (${worldW.length} bytes written)`, worldW.length > 0 && worldW.every((a) => worldCells.has(a)));
  check(`${label}: PHASE_OFF, TILE_ATTR, GLYPH_TAB, the three tile pages and the blank page $5E00-$5EFF${cacheMode ? '' : ', AST'} are byte for byte what the boot left`, ro.every(([, a, l], i) => Array.from({ length: l }, (_, k) => m.ram[a + k]).every((v, k) => v === snapRo[i][k])));
  const pagesAll = Array.from({ length: 256 }, (_, i) => m.ram[S.W_ATTRT + i] === tiles[i >> 3].attr && m.ram[S.W_FLAGT + i] === win.flags[i >> 3]).every(Boolean);
  check(`${label}: new: the attribute page and the flags page hold each tile's value at all 8 bytes 8 t .. 8 t + 7 after the play (class bits in WORLD_RAM index them raw)`, pagesAll);
  if (cacheMode) {
    const poolW = [...writes.keys()].filter((a) => pools.some(([, p, l]) => a >= p && a < p + l));
    const astW = [...writes.keys()].filter((a) => a >= S.AST && a < S.AST + 128);
    check(`${label}: pool writes are slot bytes or FTAB slot words only (${poolW.length} bytes); AST writes are AST_RR only; ${rd16(m, S.FC_MISSES)} misses`,
      poolW.length > 0 && poolW.every((a) => slotByte.has(a) || ftabSlotWord.has(a)) && astW.every((a) => (a - S.AST) % 16 === S.AST_RR) && rd16(m, S.FC_MISSES) > 5);
  }
  return st;
}
console.log('\n2. Poisoned free areas, writes tracked');
confined('2a. every frame in a slot, 6 sprites crossing the window border, SETWORLD, collision, HUD', { seed: 801, cacheMode: false, nticks: QUICK ? 25 : 34 });
confined('2b. cache mode (32- and 12-frame assets), frames changing all the time', { seed: 802, cacheMode: true, nticks: QUICK ? 25 : 34 });

// ---- 3. the stack -------------------------------------------------------------------------------------------------------------------
console.log('\n3. The stack');
{
  const r = rng(803);
  const tiles = W.randomWinTiles(r, 32);
  const win = { cx: 4, cy: 4, worldW: 128, bands: [{ rows: 16, code: 3 }], ram: W.randomWorld(r, 128, 32, { sky: 1 }) };
  const assets = [W.randomAsset(r, 32, 40, 4, 12), W.randomAsset(r, 16, 24, 8, 8)];
  const rec = (k) => [(60 + 3 * k) & 255, (((60 + 3 * k) >> 8) & 15) | ((15 - ((k >> 3) % 16)) << 4), (k % 31) | ((k % 4) << 5), 0];
  const script = Array.from({ length: 30 }, (_, t) => [op.camera(t * 5), op.showf(0, 13 + 3 * t + t * 5, 20, t % 12), op.showf(1, 101 + 2 * t + t * 5, 90, (t * 3) % 8), op.showf(2, t * 5 - 6, 70 - t, (t * 5) % 8),
    op.tilehit(t * 9, 30, 20, 20, 255), ...(t === 0 ? [op.play(0)] : [])]);
  const game = W.winGame({ div: 3, tiles, win, assets, insts: [0, 1, 1], sfx: [Array.from({ length: 160 }, (_, k) => rec(k))], script });
  let workMin = 0xFFFF, ownMin = 0xFFFF, inWork = false, isrMax = 0, isrSp0 = -1;
  const st = W.observe6(game, 100, { script, ModelClass: W.Model7, hooks: (pc, { m, inIsr }) => {
    if (pc === S.AFTER_FRAME) inWork = true;
    if (pc === S.TICK_REQUEST) inWork = false;
    const sp = m.cpu.sp;
    if (inWork && sp < workMin) workMin = sp;
    if (inWork && !inIsr && sp < ownMin) ownMin = sp;
    if (inIsr) { if (pc === S.ISR) isrSp0 = sp + 2; if (isrSp0 >= 0) isrMax = Math.max(isrMax, isrSp0 - sp); } else isrSp0 = -1;
  } });
  const own = S.STACK_TOP - ownMin, depth = S.STACK_TOP - workMin;
  console.log(`  the deepest stack during the window tick work (mask, redraw, repaint, sprites with cache misses, ring repair): ${own} bytes of the runtime's own; ${isrMax} for an interrupt; ${depth} together`);
  check('the runtime\'s own stack use in a window tick is at most 26 bytes (as part 1: win_draw_all > fc_miss > build_frame), an interrupt adds at most 10', own <= 26 && isrMax <= 10 && depth <= 36 && rd16(st.m, S.FC_MISSES) > 5,
    `${own} + ${isrMax}, ${rd16(st.m, S.FC_MISSES)} misses`);
  check('the canary is intact, the stack never below $FB02, the picture right', st.canary === 0x5AA5 && st.spMin >= S.STACK_LIMIT && st.pictureBad === 0, JSON.stringify(st.firstBad));
}

finish('runtime v3 part 2, memory');
