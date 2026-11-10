"use strict";
// m6-runtime.mjs -- runtime v3 part 1 test (docs/ARCADE_PLATFORMER_CONTRACT.md sections 1, 2, 3b; docs/ARCADE_RUNTIME_API_V3.md), on a stock TS2068 (TSRun):
//  1. memory map v3 and boot state (V3VARS, GAME_VARS, WORLD_RAM zeroed; runtime.json constants);
//  2. descriptor v3 clamps (w 8/16/24/32, h 1..48, nframes 1..32, phases), AST records, PHASE_OFF, FTAB game-image pointers;
//  3. the phase-pool plan against the JS planner (FTABs, slots, K) and every cached frame's copies byte for byte against an independent pre-shift;
//  4. the contract's reference art set fits, plans and runs; 5. pool overflow: a visible stop (magenta border), FC_MISS = the planner's bytes,
//     nothing written outside the boot's regions; one byte under the capacity boots;
//  6. RT_SHOW / RT_SHOWF / RT_HIDE / RT_HIT against the model (8-byte SPR_TAB entries, per-asset clamps, frame AND $FF, V_CHG, registers);
//  7. the picture: every width (8/16/24/32) x height (1/7/16/24/48) x phase count, frames changing, all shifts and y offsets, both display files;
//  8. the frame cache: more frames than slots (misses, victims, round robin), copies right after the misses; 9. erase_cells for 1..7 x 1..5 cells;
//  10. a header with DIV_WIN (bit 6) and a window_desc pointer boots and runs as non-window mode.
//   node arcade/tests/m6-runtime.mjs        (M6_QUICK=1: fewer combinations, for the mutation run)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printUsage, dckOf } from '../tools/build-runtime-v3.mjs';
import * as C from './m6-common.mjs';
import { rng, randomTiles, randomScene } from './m3-scenes.mjs';
const { M, Z, FRAME_T, hex, makeChecks, rd8, rd16, op } = C;

const QUICK = !!process.env.M6_QUICK;
const { check, finish } = makeChecks();
const rt = C.runtime();
const S = rt.syms;
console.log('Runtime v3 part 1: sprite frames, sizes up to 32 x 48, memory map v3 (stock TS2068, TSRun)\n');
printUsage(rt.usage, rt.dck);
console.log('');
const allEq = (m, from, n, v) => { for (let i = 0; i < n; i++) if (m.ram[from + i] !== v) return false; return true; };
const PIECES = C.POOL_PIECES(S);

// ==================================================================================================================
console.log('1. Memory map v3 and boot state');
{
  const json = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../build/v3/runtime.json'), 'utf8'));
  const K = json.constants;
  check('runtime.json: version 3; MAX_FRAMES 32, SPR_ENT 8, SPR_FRAME_OFF 6, DIV_WIN $40, DIV_EXT $80, WORLD_RAM $EA00, V_CAM $E100 (first word of V3VARS $E100)',
    json.version === 3 && K.MAX_FRAMES === 32 && K.SPR_ENT === 8 && K.SPR_FRAME_OFF === 6 && K.DIV_WIN === 0x40 && K.DIV_EXT === 0x80 && K.WORLD_RAM === 0xEA00 &&
    K.V_CAM === 0xE100 && K.V3VARS === 0xE100 && K.V3VARS_LEN === 256);
  check('runtime.json: GAME_VARS_BASE $E200, GAME_VARS_LIMIT $E9FF (2,048 bytes); POOL_B $F200 (2,176 bytes, to $FA7F); POOL_A $C080 (3,456), POOL_C $D700 (256): PHASE_POOL_BYTES 5,888',
    K.GAME_VARS_BASE === 0xE200 && K.GAME_VARS_LIMIT === 0xE9FF && K.POOL_B === 0xF200 && K.POOL_B_LEN === 2176 && K.POOL_A === 0xC080 && K.POOL_A_LEN === 3456 && K.POOL_C === 0xD700 &&
    K.POOL_C_LEN === 256 && K.PHASE_POOL_BYTES === 5888 && K.T3 === 0xFA80 && K.STACK_CANARY === 0xFB00);
  check('runtime.json lists RT_SHOW, RT_SHOWF, RT_HIDE, RT_HIT and the constants the linker needs (POOL_A/B/C and lengths, AST layout, FTE_LEN, POOL_FAIL_BORDER)',
    ['RT_SHOW', 'RT_SHOWF', 'RT_HIDE', 'RT_HIT'].every((n) => json.symbols[n] > 0) && ['POOL_A', 'POOL_C', 'POOL_A_LEN', 'POOL_C_LEN', 'AST_FTAB', 'AST_K', 'FTE_LEN', 'POOL_FAIL_BORDER'].every((n) => K[n] !== undefined));
  const m = C.newMachine(rt.dck);
  let seen = false;
  for (let f = 0; f < 400 && !seen; f++) {
    const end = m.frameStart + FRAME_T;
    while (m.tstates < end) { if (m.cpu.pc === S.ENTRY && m.tstates > 0) { seen = true; break; } Z.runZ80(m.cpu, m.bus, 1, m); }
    if (!seen) M.runFrame(m);
  }
  for (let a = 0xC000; a < 0xFB00; a++) m.ram[a] = 0xA5;          // chunk 6 and 7 below the stack: garbage
  for (let a = 0x4000; a < 0x7B00; a++) m.ram[a] = 0x5A;
  const b = C.bootMachine(m, S);
  for (let f = 0; f < 6; f++) M.runFrame(m);
  check('boot completes within 14 frames of the entry', rd16(m, S.V_FRAMES) > 0 && b.bootFrames <= 14, `${b.bootFrames} frames`);
  check('boot zeroes $E000-$F1FF: V3VARS ($E100-$E1BF; $E1C0-$E1FF is the frame cache\'s scratch: the plan leaves its pointers there), V_CAM = 0, GAME_VARS ($E200-$E9FF), WORLD_RAM ($EA00-$F1FF)',
    allEq(m, 0xE100, 0xC0, 0) && allEq(m, 0xE200, 0x800, 0) && allEq(m, 0xEA00, 0x800, 0) && rd16(m, S.V_CAM) === 0 && rd16(m, S.FC_MISS) === 0);
  check('no assets: PHASE_OFF, AST, SPR_TAB (16 x 8), SPR_DRAWN all 0; V_NAST = V_NINST = 0', allEq(m, S.PHASE_OFF, 128, 0) && allEq(m, S.AST, 128, 0) && allEq(m, S.SPR_TAB, 128, 0) && allEq(m, S.SPR_DRAWN, 128, 0) && rd8(m, S.V_NAST) === 0 && rd8(m, S.V_NINST) === 0);
  const f0 = C.dfileOf(m, 0), f1 = C.dfileOf(m, 1);
  check('both display files blank, every cell a space, stack canary set', f0.bitmap.every((v) => v === 0) && f1.bitmap.every((v) => v === 0) && allEq(m, S.CELL_TILE, 768, 32) && rd16(m, S.STACK_CANARY) === 0x5AA5);
}

// ==================================================================================================================
/** The machine's AST / PHASE_OFF / FTAB / slots / copies against the model and the planner. */
function checkAssets(label, game, m) {
  const mdl = new C.Model6(game.spec);
  const bad = [];
  const plan = C.planPool(mdl.assets, mdl.ninstOf(), PIECES);
  const pool = C.poolState(m, S, mdl.assets.length);
  mdl.assets.forEach((a, i) => {
    const rec = S.AST + 16 * i;
    const xmask = a.phases === 8 ? 0xFF : a.phases === 4 ? 0xFE : a.phases === 2 ? 0xFC : 0xF8;
    const want = [a.h, a.wb, xmask, a.phases, ...a.hot, a.nf, mdl.ninstOf()[i]];
    const got = [S.AST_H, S.AST_WB, S.AST_XMASK, S.AST_PHASES, S.AST_HOT, S.AST_HOT + 1, S.AST_HOT + 2, S.AST_HOT + 3, S.AST_NF, S.AST_NINST].map((k) => rd8(m, rec + k));
    if (got.join() !== want.join()) bad.push(`AST[${i}] ${got} != ${want}`);
    if (rd16(m, rec + S.AST_CLEN) !== a.clen) bad.push(`AST_CLEN[${i}]`);
    for (let s = 1; s < 8; s++) {
      const off = rd16(m, S.PHASE_OFF + 16 * i + 2 * s), q = s / a.gran;
      const wantOff = Number.isInteger(q) ? (q - 1) * a.clen : 0;
      if (off !== wantOff) bad.push(`PHASE_OFF[${i}][${s}] ${off} != ${wantOff}`);
    }
    if (pool[i].ftab !== plan.ftab[i]) bad.push(`FTAB[${i}] ${hex(pool[i].ftab)} != plan ${hex(plan.ftab[i])}`);
    if (pool[i].K !== plan.K[i]) bad.push(`K[${i}] ${pool[i].K} != plan ${plan.K[i]}`);
    if (!pool[i].ftab) return;
    const desc = game.img[S.GAME_SPRTAB] | (game.img[S.GAME_SPRTAB + 1] << 8);
    const data = game.img[desc + 8 * i + 2] | (game.img[desc + 8 * i + 3] << 8);
    pool[i].fte.forEach((e, f) => {
      if (e.rom !== data + f * a.h * 2 * a.wb) bad.push(`FTAB[${i}][${f}].rom`);
      if (!e.slot) return;
      if (!plan.slots[i].includes(e.slot)) bad.push(`FTAB[${i}][${f}].slot ${hex(e.slot)} is not a planned slot`);
      for (let s = a.gran; s < 8; s += a.gran) {
        const want2 = C.preShift(a, f, s), at = e.slot + (s / a.gran - 1) * a.clen;
        const got2 = Array.from({ length: want2.length }, (_, k) => rd8(m, at + k));
        if (got2.join() !== want2.join()) { bad.push(`copy [${i}][${f}][${s}] at ${hex(at)} differs`); break; }
      }
    });
    const slots = pool[i].fte.map((e) => e.slot).filter(Boolean);
    if (new Set(slots).size !== slots.length) bad.push(`asset ${i}: two frames share a slot`);
    if (slots.length !== pool[i].K) bad.push(`asset ${i}: ${slots.length} frames cached, K = ${pool[i].K}`);
  });
  mdl.insts.forEach((s, i) => { if (rd8(m, S.SPR_TAB + 8 * i + 1) !== s.asset) bad.push(`SPR_TAB[${i}] asset`); });
  for (let i = mdl.insts.length; i < 16; i++) if (!allEq(m, S.SPR_TAB + 8 * i, 8, 0)) bad.push(`SPR_TAB[${i}] not zero`);
  check(`${label}: AST, PHASE_OFF, FTAB (rom + slot), K and every cached copy equal the JS model / planner / pre-shift`, rd8(m, S.V_NAST) === mdl.assets.length && rd8(m, S.V_NINST) === mdl.insts.length && bad.length === 0, bad.slice(0, 3).join('; '));
  return { plan, pool };
}

console.log('\n2. Descriptor v3: clamps, AST, PHASE_OFF, FTAB');
{
  const r = rng(2);
  const ws = [0, 1, 8, 9, 16, 17, 24, 25, 32, 255], hs = [0, 1, 16, 17, 47, 48, 49, 255], nfs = [0, 1, 2, 31, 32, 33, 255], phs = [0, 1, 2, 3, 4, 7, 8, 255];
  const combos = [];
  for (let k = 0; k < (QUICK ? 16 : 40); k++) combos.push([ws[k % ws.length], hs[(k * 3) % hs.length], nfs[(k * 5) % nfs.length], phs[(k * 7) % phs.length]]);
  for (let g = 0; g < combos.length; g += 4) {
    const set = combos.slice(g, g + 4).map(([w, h, nf, ph]) => C.randomAsset(r, w, h, ph, nf));
    // one instance each (none for the last: an unused asset); the pool must hold them and the test image the art: a large asset gets 1 phase
    // (no slot, nothing built) and only the frames that fit are written (the FTAB pointers are arithmetic: checked anyway)
    set.forEach((a) => {
      const n = C.normAsset(a), fb = n.h * 2 * n.wb;
      if (n.slen > 1200 || n.nf * fb > 2400) { a.phases = 1; a.frames = a.frames.slice(0, Math.max(1, Math.floor(2400 / fb))); }
    });
    const game = C.scriptGame({ assets: set, insts: [0, 1, 2], script: [] });
    checkAssets(`2.${g / 4} widths ${set.map((a) => a.w)} heights ${set.map((a) => a.h)} nframes ${set.map((a) => a.nframes)} phases ${set.map((a) => a.phases)}`, game, C.run(game, 10));
  }
  const g2 = C.scriptGame({ assets: [C.randomAsset(r, 16, 16, 8)], insts: [0, 0, 0], nassetsHeader: 200, script: [] });
  check('sprite_count 200 is read as 8 (the unused descriptors 1..7 cost no pool memory: no instance uses them)', rd8(C.run(g2, 6), S.V_NAST) === 8 && rd16(C.run(g2, 6), S.V_TICKS) > 0);
  const hot = C.randomAsset(r, 24, 30, 4, 2); hot.hot = [3, 2, 9, 11];
  const g3 = C.scriptGame({ assets: [hot, C.randomAsset(r, 32, 40, 2, 1)], insts: [0, 1], script: [] });
  const m3 = C.run(g3, 6);
  check('hot box from the descriptor; hot 0 = (0, 0, 8 wb, h) for a 32 x 40', [0, 1, 2, 3, 16, 17, 18, 19].map((k) => rd8(m3, S.AST + S.AST_HOT + k)).join() === '3,2,9,11,0,0,32,40');
}

// ==================================================================================================================
console.log('\n3. The pool plan and the copies (random asset sets, instance counts)');
for (let t = 0; t < (QUICK ? 4 : 14); t++) {
  const r = rng(300 + t);
  const na = r.int(1, 8);
  const assets = Array.from({ length: na }, () => {
    const w = r.pick([8, 16, 24, 32]), h = r.pick([1, 5, 8, 12, 16, 24, 30]);
    return C.randomAsset(r, w, h, r.pick([1, 2, 4, 8]), Math.min(r.pick([1, 1, 2, 3, 4, 8, 16, 32]), Math.max(1, Math.floor(1200 / (h * w / 4)))));
  });
  const ninst = r.int(0, 16);
  const insts = Array.from({ length: ninst }, () => r.int(0, na - 1));
  const mdl = new C.Model6({ assets, insts });
  const plan = C.planPool(mdl.assets, mdl.ninstOf(), PIECES);
  const game = C.scriptGame({ assets, insts, script: [] });
  if (!plan.ok) {
    const m = C.run(game, 30);
    check(`3.${t} (${na} assets, ${ninst} instances: does not fit, ${plan.miss} bytes over): the boot stops, FC_MISS = ${plan.miss}`, rd16(m, S.FC_MISS) === plan.miss && rd16(m, S.V_TICKS) === 0);
    continue;
  }
  checkAssets(`3.${t} (${na} assets, ${ninst} instances, K ${plan.K.join(',')})`, game, C.run(game, 12));
}

// ==================================================================================================================
console.log('\n4. The reference art set (contract section 1)');
const REF = (r) => [C.randomAsset(r, 16, 24, 4, 16), C.randomAsset(r, 16, 16, 4, 4), C.randomAsset(r, 16, 16, 4, 2), C.randomAsset(r, 8, 8, 8, 4), C.randomAsset(r, 8, 8, 8, 1)];
{
  const r = rng(4);
  const assets = REF(r);
  const insts = [0, 1, 1, 1, 2, 2, 2, 4, 3, 3, 3, 3];
  const mdl = new C.Model6({ assets, insts });
  const plan = C.planPool(mdl.assets, mdl.ninstOf(), PIECES);
  console.log(`  player 16x24 x 16 frames x 4 phases, walker 16x16 x 4 x 4, flyer 16x16 x 2 x 4, coin 8x8 x 4 x 8, shot 8x8 x 1 x 8; 1 + 3 + 3 + 1 + 4 instances:`);
  console.log(`  needs ${C.poolNeed(mdl.assets, mdl.ninstOf())} of ${S.PHASE_POOL_BYTES} bytes at least; K = ${plan.K.join(', ')} (slots: ${mdl.assets.map((a) => a.slen).join(', ')} bytes)`);
  check('the reference set fits with every walker / flyer / coin frame in a slot and at least 4 player frames', plan.ok && plan.K[1] >= 3 && plan.K[2] === 2 && plan.K[3] === 4 && plan.K[0] >= 4, `K ${plan.K}`);
  // run: the player walks through its 16 frames, enemies and coins animate
  const script = [];
  const pos = insts.map((_, i) => ({ x: 20 + 17 * i, y: 30 + 9 * i, dx: 1 + (i % 3), dy: (i % 2) ? 1 : -1 }));
  for (let t = 0; t < (QUICK ? 40 : 120); t++) {
    script.push(pos.map((p, i) => {
      p.x += p.dx; p.y += p.dy; if (p.x < 0 || p.x > 235) p.dx = -p.dx; if (p.y < 0 || p.y > 165) p.dy = -p.dy;
      const nf = mdl.assets[insts[i]].nf;
      const f = i === 0 ? (t >> 2) % 16 : i < 7 ? ((t >> 3) + i) % nf : i === 7 ? 0 : (t >> 1) % 4;
      return op.showf(i, p.x, p.y, f);
    }));
  }
  const game = C.scriptGame({ div: 3, assets, insts, tiles: randomTiles(rng(41), 6), script: [...randomScene(4401, 2, { sprites: 0, tiles: 6 }), ...script] });
  const st = C.observe6(game, (script.length + 2) * 3, { script: game.spec.script });
  check(`the reference game runs: the picture equals the model after every refresh (${st.pictureOk}), frame_div 3, no tearing`, st.pictureBad === 0 && st.pixelBad === 0 && st.writeViolations === 0 && st.flipMismatch === 0, JSON.stringify(st.firstBad));
  const misses = rd16(st.m, S.FC_MISSES);
  console.log(`  ${misses} frames built during play (the player's frames beyond its ${plan.K[0]} slots); tick work max ${Math.max(...st.work)} T`);
  check('only the player misses (every other asset keeps all its frames), the work fits frame_div 3', misses > 0 && Math.max(...st.work) < 3 * FRAME_T, `${misses} misses`);
  checkAssets('4. after the run', game, st.m);
}

// ==================================================================================================================
console.log('\n5. Pool overflow');
{
  const r = rng(5);
  // three 32 x 40 assets at 4 phases, 2 frames each, two instances each: slots of 3 x 40 x 10 = 1,200 bytes; 6 needed: 7,200 + 24 > 5,504
  const assets = [C.randomAsset(r, 32, 40, 4, 2), C.randomAsset(r, 32, 40, 4, 2), C.randomAsset(r, 32, 40, 4, 2)];
  const insts = [0, 0, 1, 1, 2, 2];
  const mdl = new C.Model6({ assets, insts });
  const plan = C.planPool(mdl.assets, mdl.ninstOf(), PIECES);
  const game = C.scriptGame({ assets, insts, script: [[op.show(0, 10, 10)]] });
  // find the entry frame, then replay and track every write from ENTRY on
  const m0 = C.newMachine(game.dck); let n = 0;
  for (; n < 400 && rd16(m0, S.HO_MARK) !== 0x5AA5; n++) M.runFrame(m0);
  const m = C.newMachine(game.dck);
  for (let f = 0; f < n - 1; f++) M.runFrame(m);
  let armed = false, border = -1;
  const writes = new Set();
  const w = m.bus.write; m.bus.write = (a, v) => { if (armed) writes.add(a & 0xFFFF); w(a, v); };
  const o = m.bus.ioWrite; m.bus.ioWrite = (p, v) => { if ((p & 0xFF) === 0xFE) border = v & 7; o(p, v); };
  for (let f = 0; f < 40; f++) {
    const end = m.frameStart + FRAME_T;
    while (m.tstates < end) { if (m.cpu.pc === S.ENTRY) armed = true; if (m.cpu.halted) break; Z.runZ80(m.cpu, m.bus, 1, m); }
    M.runFrame(m);
  }
  const outside = [...writes].filter((a) => a >= 0xC000 && !((a < 0xF200) || (a >= S.POOL_B && a < S.POOL_B + S.POOL_B_LEN) || (a >= 0xFB00 && a < 0xFF00) || a >= 0xFFE0));
  const poolW = [...writes].filter((a) => PIECES.some(([p, l]) => a >= p && a < p + l));
  check(`art that does not fit (planner: ${plan.miss} bytes over): the boot stops with a magenta border (${S.POOL_FAIL_BORDER}), interrupts off, no tick, FC_MISS = ${plan.miss}`,
    !plan.ok && border === S.POOL_FAIL_BORDER && !m.cpu.iff1 && rd16(m, S.V_TICKS) === 0 && rd16(m, S.V_FRAMES) === 0 && rd16(m, S.FC_MISS) === plan.miss, `border ${border}, FC_MISS ${rd16(m, S.FC_MISS)}`);
  check('...and nothing is written outside the boot\'s own regions (no write to T3 $FA80-$FAFF or past a pool piece); pool writes stay inside the pieces',
    outside.length === 0 && writes.size > 1000 && poolW.every((a) => PIECES.some(([p, l]) => a >= p && a < p + l)), `${outside.length} outside, first ${hex(outside[0] ?? 0)}`);
  // the largest slot: 32 x 48 at 8 phases = 7 x 48 x 10 = 3,360 bytes (+ FTAB 4) fits POOL_A (3,456); a second instance needs a second slot: no room
  const big = [C.randomAsset(r, 32, 48, 8, 1)];
  const okGame = C.scriptGame({ assets: big, insts: [0], script: Array.from({ length: 20 }, (_, t) => [op.show(0, 3 + 7 * t, 2 + 5 * t)]) });
  const pOk = C.planPool(new C.Model6(okGame.spec).assets, [1], PIECES);
  const stOk = C.observe6(okGame, 30, { script: okGame.spec.script });
  check('the largest sprite, 32 x 48 at 8 phases (one slot of 3,360 bytes: POOL_A), boots and draws right at every shift', pOk.ok && stOk.pictureBad === 0 && stOk.ticks.length > 20 && rd16(stOk.m, S.FC_MISS) === 0, JSON.stringify(stOk.firstBad));
  const tooBig = C.scriptGame({ assets: [C.randomAsset(r, 32, 48, 8, 2)], insts: [0, 0], script: [] });     // 2 frames, 2 instances: K >= 2
  const pTb = C.planPool(new C.Model6(tooBig.spec).assets, [2], PIECES);
  const mTb = C.run(tooBig, 30);
  // POOL_B's next + a big slot passes $FFFF: the allocator must see the wrap (a 432-byte slot first moves POOL_B's next to $F3B0, then 3,360 bytes)
  const wrap = [C.randomAsset(r, 32, 48, 8, 1), C.randomAsset(r, 16, 24, 4, 2), C.randomAsset(r, 32, 48, 8, 2)];
  const gW = C.scriptGame({ assets: wrap, insts: [0, 1, 2, 2], script: [] });
  const pW = C.planPool(new C.Model6(gW.spec).assets, [1, 1, 2], PIECES);
  const mW = C.run(gW, 30);
  check(`a slot that would carry POOL_B's next past $FFFF does not fit (planner: ${pW.miss} bytes over): FC_MISS equal, the boot stops`, !pW.ok && pW.miss === 6720 && rd16(mW, S.FC_MISS) === pW.miss && rd16(mW, S.V_TICKS) === 0 && rd16(mW, S.STACK_CANARY) === 0x5AA5,
    `FC_MISS ${rd16(mW, S.FC_MISS)}`);
  check('two instances of a 2-frame one (two slots: the second fits no piece) stop the boot, FC_MISS = 3,360 = the planner\'s', !pTb.ok && pTb.miss === 3360 && rd16(mTb, S.FC_MISS) === 3360 && rd16(mTb, S.V_TICKS) === 0);
}

// ==================================================================================================================
console.log('\n6. RT_SHOW / RT_SHOWF / RT_HIDE / RT_HIT against the model');
{
  const r = rng(6);
  const assets = [C.randomAsset(r, 8, 8, 8, 4), C.randomAsset(r, 16, 24, 4, 3), C.randomAsset(r, 24, 7, 2, 2), C.randomAsset(r, 32, 48, 1, 1)];
  assets[1].hot = [2, 3, 10, 18]; assets[2].hot = [0, 0, 0, 5];
  const insts = [0, 1, 2, 3, 1, 0, 2, 3, 0, 1];
  const game = C.scriptGame({ assets, insts, script: [] });
  const m = C.run(game, 8);
  for (let i = 0; i < 400000 && !(m.cpu.pc === S.TICK_LOOP && !m.cpu.halted); i++) Z.runZ80(m.cpu, m.bus, 1, m);
  const mdl = new C.Model6(game.spec);
  let bad = 0, regs = 0, chgBad = 0, first = null, n = 0;
  const vals = [-32768, -300, -1, 0, 1, 7, 100, 143, 144, 168, 176, 184, 191, 192, 223, 224, 225, 232, 239, 240, 247, 248, 249, 255, 256, 1000, 32767];
  for (let k = 0; k < (QUICK ? 1500 : 5000); k++) {
    const i = r.chance(0.08) ? r.pick([10, 11, 15, 16, 200, 255]) : r.int(0, 9);
    const x = r.chance(0.5) ? r.pick(vals) : r.int(-50, 300), y = r.chance(0.5) ? r.pick(vals) : r.int(-50, 250);
    const kind = r.int(0, 9);
    const before = Array.from(m.ram.slice(S.SPR_TAB, S.SPR_TAB + 128)), chgBefore = Array.from(m.ram.slice(S.V_CHG, S.V_CHG + 16));
    let res, expectChange = false;
    if (kind < 4) { res = C.callRoutine(m, S.RT_SHOW, { a: i, bc: x & 0xFFFF, de: y & 0xFFFF }); const s = mdl.insts[i]; const old = s && { ...s }; mdl.show(i, x, y); expectChange = !!s && (!old.visible || old.x !== s.x || old.y !== s.y); }
    else if (kind < 8) { const f = r.chance(0.2) ? r.int(0, 0xFFFF) : r.int(0, 4); res = C.callRoutine(m, S.RT_SHOWF, { a: i, bc: x & 0xFFFF, de: y & 0xFFFF, hl: f }); const s = mdl.insts[i]; const old = s && { ...s }; mdl.show(i, x, y, f); expectChange = !!s && (!old.visible || old.x !== s.x || old.y !== s.y || old.frame !== s.frame); }
    else if (kind < 9) { res = C.callRoutine(m, S.RT_HIDE, { a: i }); if (i < mdl.insts.length) mdl.insts[i].visible = false; }
    else { const j = r.int(0, 11); res = C.callRoutine(m, S.RT_HIT, { a: i, de: j }); if (res.hl !== mdl.hit(i, j)) { bad++; first ??= { k, hit: [i, j], got: res.hl, want: mdl.hit(i, j) }; } }
    n++;
    if (!res.preserved || !res.spOk) regs++;
    const want = new Array(128).fill(0);
    mdl.insts.forEach((s, j) => want.splice(8 * j, 8, s.visible ? 1 : 0, s.asset, s.x & 255, s.x >> 8, s.y & 255, s.y >> 8, s.frame, 0));
    const got = Array.from(m.ram.slice(S.SPR_TAB, S.SPR_TAB + 128));
    if (got.join() !== want.join()) { bad++; first ??= { k, kind, i, x, y, got: got.slice(8 * (i & 15), 8 * (i & 15) + 8), want: want.slice(8 * (i & 15), 8 * (i & 15) + 8) }; }
    const chgAfter = Array.from(m.ram.slice(S.V_CHG, S.V_CHG + 16));
    for (let j = 0; j < 16; j++) {
      const exp = (kind < 8 && j === i && expectChange) ? 2 : chgBefore[j];
      if (chgAfter[j] !== exp) { chgBad++; break; }
    }
    void before;
  }
  check(`${n} random calls (indices incl. >= ninst, coordinates around every clamp, frames up to $FFFF): SPR_TAB (8-byte entries: visible, asset, x, y, frame, 0) equals the model; RT_HIT equals the model`, bad === 0, JSON.stringify(first));
  check('per-asset clamps: x 0..256-w, y 0..192-h (8x8: 248/184, 16x24: 240/168, 24x7: 232/185, 32x48: 224/144); the frame is HL AND $FF', bad === 0);
  check('V_CHG[i] = 2 exactly when SHOW / SHOWF changed visibility, position or frame (RT_SHOW keeps the frame); untouched otherwise', chgBad === 0, `${chgBad} differences`);
  check('the routines clobber AF BC DE HL only (IX, IY, alternates kept) and leave SP', regs === 0, `${regs} violations`);
}

// ==================================================================================================================
const sceneOk = (label, st, nframes) => {
  check(`${label}: picture = model after every refresh (${st.pictureOk}/${nframes}, memory and colours), no write to the shown file, flips right`,
    st.pictureBad === 0 && st.pixelBad === 0 && st.pictureOk >= nframes - 2 && st.writeViolations === 0 && st.flipMismatch === 0 && st.missed === 0 && st.canary === 0x5AA5,
    st.firstBad ? JSON.stringify(st.firstBad) : `${st.pictureOk} ok, ${st.pixelBad} pixel, ${st.writeViolations} writes`);
};
console.log('\n7. The picture: every size, phase count, frame, shift and y offset');
{
  const W = [8, 16, 24, 32], H = [1, 7, 16, 24, 48], P = [8, 4, 2, 1];
  let combos = 0, pass = 0, firstFail = null, cacheMisses = 0;
  const skipped = [];
  for (const w of W) for (const h of H) for (const ph of (QUICK ? [P[(w + h) % 4]] : P)) {
    const r = rng(w * 1000 + h * 10 + ph);
    let nf = 3;
    const a = C.randomAsset(r, w, h, ph, nf), b = C.randomAsset(r, w, h, ph, 2);
    const na = C.normAsset(a);
    const ticks = 18;
    let insts = null;
    for (const ii of [[0, 1, 0], [0, 1], [0]]) if (C.planPool(new C.Model6({ assets: [a, b], insts: ii }).assets, [ii.filter((x) => x === 0).length, ii.includes(1) ? 1 : 0], PIECES).ok) { insts = ii; break; }
    if (!insts) { skipped.push(`${w}x${h}x${ph}`); continue; }
    const script = [];
    for (let t = 0; t < ticks; t++) {
      script.push([
        op.showf(0, 37 + t + 3 * (t >> 3), Math.max(0, Math.min(192 - na.h, 3 * t + 1)), t % 3),               // every shift and y offset, frames 0..2
        ...(insts.length > 1 ? [op.showf(1, 230 - 2 * t, Math.max(0, 140 - 5 * t), (t >> 1) % 4)] : []),    // frame 3 > nframes - 1: clamped to 1
        ...(insts.length > 2 ? [op.showf(2, 255 - t, 191 - t, t)] : []),                                     // pushed against the right / bottom clamp
      ]);
    }
    const game = C.scriptGame({ div: 1, assets: [a, b], insts, tiles: randomTiles(rng(7), 4), map: Array.from({ length: 768 }, (_, i) => (i % 7 ? 32 + (i % 90) : 0x80 | (i % 4))), script });
    const st = C.observe6(game, ticks + 4, { script, untilTicks: ticks });
    combos++;
    cacheMisses += rd16(st.m, S.FC_MISSES);
    if (st.pictureBad === 0 && st.pixelBad === 0 && st.writeViolations === 0 && st.pictureOk >= ticks + 2 && st.ticks.length >= ticks) pass++;
    else firstFail ??= { w, h, ph, ...st.firstBad };
  }
  check(`${combos} size x phase combinations (w 8/16/24/32, h 1/7/16/24/48, phases 8/4/2/1; 3 instances, frames changing, every shift, every y AND 7, both files, over text and tiles): the picture equals the model after every refresh`,
    pass === combos && combos >= (QUICK ? 15 : 80), JSON.stringify(firstFail) + ` (${cacheMisses} cache misses in all)`);
  console.log(`  not run (the art does not fit the pool): ${skipped.join(', ') || 'none'}`);
  // the model's two compositors agree (pre-shift + byte compositor vs pixel by pixel) on random states: the reference is self-consistent
  const r = rng(77);
  let agree = 0;
  for (let k = 0; k < 40; k++) {
    const assets = [C.randomAsset(r, r.pick(W), r.int(1, 48), r.pick(P), r.int(1, 5))];
    const mdl = new C.Model6({ assets, insts: [0, 0, 0] });
    mdl.insts.forEach((_, i) => mdl.show(i, r.int(-10, 260), r.int(-10, 200), r.int(0, 6)));
    const a1 = mdl.render(), a2 = mdl.renderPixels();
    if (C.diffCount(a1.bitmap, a2.bitmap) === 0) agree++;
  }
  check('the JS reference is self-consistent: pre-shift + byte compositor = pixel-by-pixel compositor on 40 random states', agree === 40);
}
{
  const r = rng(71);
  const assets = [C.randomAsset(r, 16, 24, 4, 6), C.randomAsset(r, 8, 8, 8, 3), C.randomAsset(r, 32, 30, 2, 2), C.randomAsset(r, 24, 16, 4, 2), C.randomAsset(r, 16, 16, 8, 1)];
  const insts = Array.from({ length: 16 }, (_, i) => i % 5);
  const nfs = insts.map((a) => C.normAsset(assets[a]).nf);
  for (const div of [1, 2, 3]) {
    const script = C.addWalk(randomScene(710 + div, QUICK ? 30 : 70, { sprites: 0, tiles: 6, textRate: 0.5, tileRate: 0.5 }), 16, rng(720 + div), { frames: nfs });
    const game = C.scriptGame({ div, assets, insts, tiles: randomTiles(rng(73), 6), script });
    const nfr = script.length * div + 4;
    sceneOk(`7.${div} 16 instances of 5 assets (16x24 x 6 frames, 8x8 x 3, 32x30 x 2, 24x16 x 2, 16x16 x 1), random walks, frames, text and tiles, frame_div ${div}`, C.observe6(game, nfr, { script }), nfr);
  }
}

// ==================================================================================================================
console.log('\n8. The frame cache: more frames than slots');
{
  const r = rng(8);
  // a 16 x 24 asset, 4 phases, 32 frames, 3 instances (slots of 432 bytes: about 10 fit) and a 16 x 16 one with 6 frames: both cache mode
  const assets = [C.randomAsset(r, 16, 24, 4, 32), C.randomAsset(r, 16, 16, 8, 12)];
  const insts = [0, 0, 0, 1, 1];
  const mdl = new C.Model6({ assets, insts });
  const plan = C.planPool(mdl.assets, mdl.ninstOf(), PIECES);
  console.log(`  plan: K = ${plan.K.join(', ')} of nframes ${mdl.assets.map((a) => a.nf).join(', ')}`);
  check('the plan puts both assets in cache mode (K < nframes, K >= instances)', plan.ok && plan.K[0] < 32 && plan.K[0] >= 3 && plan.K[1] < 12 && plan.K[1] >= 2, `K ${plan.K}`);
  const script = [];
  for (let t = 0; t < (QUICK ? 20 : 50); t++) {
    script.push([
      op.showf(0, 10 + (t * 3) % 200, 10, t % 32),                                  // a new frame every tick
      op.showf(1, 60 + (t * 5) % 150, 70, (t >> 2) % 32),                            // every 4 ticks
      op.showf(2, 121 + 2 * (t % 3), 130, r.chance(0.6) ? r.int(32, 90) : r.int(0, 31)),   // mostly above 31 (clamped to 31: must stay protected)
      op.showf(3, (t * 7) % 230, 100, (t >> 1) % 12), op.showf(4, 200 - t, 20, (t * 5) % 12),
      ...(t % 9 === 4 ? [op.hide(1)] : []),
    ]);
  }
  const game = C.scriptGame({ div: 3, assets, insts, script });
  const sim = new C.CacheSim(mdl.assets, plan);
  let simBad = 0, firstSim = null, ticksSeen = 0;
  const onTick = (m, n, model) => {                                // after draw_all of tick n: the machine's cache = the simulation's
    sim.draw(model.insts);
    ticksSeen++;
    const pool = C.poolState(m, S, 2);
    for (let k = 0; k < 2; k++) {
      const got = pool[k].fte.map((e, f) => (e.slot ? f : -1)).filter((f) => f >= 0).join();
      const want = [...sim.c[k].cached].sort((x, y) => x - y).join();
      if (got !== want || pool[k].rr !== sim.c[k].rr) { simBad++; firstSim ??= { n, k, got, want, rr: pool[k].rr, simRr: sim.c[k].rr }; }
    }
    if (rd16(m, S.FC_MISSES) !== sim.misses) { simBad++; firstSim ??= { n, misses: rd16(m, S.FC_MISSES), sim: sim.misses }; }
  };
  const st = C.observe6(game, script.length * 3 + 4, { script, onTick, untilTicks: script.length });
  sceneOk('three instances of a 32-frame asset and two of a 12-frame one, all in cache mode, changing frames every tick (misses every tick)', st, script.length * 3 + 4);
  check(`after every tick the cached frames, the round-robin pointer and FC_MISSES equal the simulation of the documented replacement rule (${ticksSeen} ticks, ${sim.misses} misses)`,
    simBad === 0 && ticksSeen >= script.length && sim.misses > script.length, JSON.stringify(firstSim));
  checkAssets('8. after the misses: every cached frame', game, st.m);
  // the protection rule directly: 3 instances, K = 3 slots exactly, all three show distinct frames; a 4th frame shown by one of them must evict the frame no one shows
  const r2 = rng(81);
  const a3 = [C.randomAsset(r2, 32, 40, 4, 6), C.randomAsset(r2, 32, 30, 8, 1), C.randomAsset(r2, 24, 24, 4, 1)];
  const g3 = C.scriptGame({ div: 2, assets: a3, insts: [0, 0, 1, 2], script: [] });
  const p3 = C.planPool(new C.Model6(g3.spec).assets, [2, 1, 1], PIECES);
  const sc3 = [];
  const NT = QUICK ? 10 : 24;
  for (let t = 0; t < NT; t++) sc3.push([op.showf(0, 21 + 8 * t, 10, t % 2 ? 0 : 3), op.showf(1, 101, 100 - t, [1, 2, 4, 5][(t >> 1) % 4]), op.show(2, 30, 140), op.show(3, 200, 60)]);   // x never a multiple of 8
  const g4 = C.scriptGame({ div: 2, assets: a3, insts: [0, 0, 1, 2], script: sc3 });
  const sim4 = new C.CacheSim(new C.Model6(g4.spec).assets, p3);
  let missAt = 0, simAt = 0;
  const st4 = C.observe6(g4, 2 * NT + 4, { script: sc3, untilTicks: NT, onTick: (m, n, model) => { sim4.draw(model.insts); if (n === NT - 1) { missAt = rd16(m, S.FC_MISSES); simAt = sim4.misses; } } });
  check(`K = ${p3.K[0]} slots for the 2 instances of a 6-frame asset (the plan)`, p3.ok && p3.K[0] === 2, `K ${p3.K}`);
  sceneOk('K = the instances: one instance alternates frames 0 / 3 every tick, the other walks 1, 2, 4, 5 (every 2 ticks), overrunning ticks', st4, 2 * NT + 4);
  const changes = NT + Math.floor((NT - 1) / 2);
  check('...the misses equal the simulation and are exactly the frame changes (a victim is never the frame the other instance shows: nothing thrashes)', missAt === simAt && missAt === changes, `${missAt} misses, simulation ${simAt}, ${changes} frame changes`);
}

// ==================================================================================================================
console.log('\n9. erase_cells directly: 1..7 cell rows x 1..5 columns, both files');
{
  const r = rng(9);
  const map = Array.from({ length: 768 }, (_, i) => (i % 5 === 0 ? 0x80 | (i % 7) : 32 + ((i * 7) % 96)));
  const game = C.scriptGame({ tiles: randomTiles(rng(56), 7), map, script: [] });
  const m = C.run(game, 12);
  for (let i = 0; i < 400000 && !(m.cpu.pc === S.TICK_LOOP && !m.cpu.halted); i++) Z.runZ80(m.cpu, m.bus, 1, m);
  const mdl = new C.Model6(game.spec);
  let bad = 0, first = null, regs = 0;
  const seen = new Set();
  for (let k = 0; k < (QUICK ? 1500 : 6000); k++) {
    const hoff = r.chance(0.5) ? 0 : 0x20, ncols = r.int(1, 5), crows = r.int(1, 7);
    const c0 = r.chance(0.3) ? 32 - ncols : r.int(0, 32 - ncols);
    const r0 = r.chance(0.3) ? 24 - crows : r.int(0, 24 - crows), yk = r.int(0, 7);
    m.ram[S.V_HOFF] = hoff;
    for (let a = 0x4000 + hoff * 256; a < 0x5800 + hoff * 256; a++) m.ram[a] = 0xFF;
    const scr = 0x4000 + hoff * 256 + C.rowAddr(8 * r0 + yk) + c0;
    const res = C.callRoutine(m, S.erase_cells, { a: crows << 3 | ncols, de: scr });
    seen.add(`${crows}x${ncols}`);
    if (!res.preserved || !res.spOk) regs++;
    let wrong = 0;
    for (let rr = 0; rr < 24 && !wrong; rr++) for (let c = 0; c < 32 && !wrong; c++) {
      const inside = rr >= r0 && rr < r0 + crows && c >= c0 && c < c0 + ncols, g = mdl.glyph(rr * 32 + c);
      for (let kk = 0; kk < 8; kk++) { const got = m.ram[0x4000 + hoff * 256 + C.rowAddr(rr * 8 + kk) + c]; if (got !== (inside ? g[kk] : 0xFF)) { wrong = 1; first ??= { hoff, ncols, crows, r0, c0, rr, c, kk }; break; } }
    }
    bad += wrong;
  }
  m.ram[S.V_HOFF] = 0;
  check(`random calls with N = cell rows << 3 | columns over all ${seen.size} of 35 shapes (both files, the right and bottom edges, the thirds): exactly the covered cells are redrawn`, bad === 0 && seen.size === 35, JSON.stringify(first));
  check('erase_cells clobbers AF BC DE HL only', regs === 0);
}

// ==================================================================================================================
console.log('\n10. A header with DIV_WIN (bit 6): boots and runs (window mode itself is runtime v3 part 2)');
{
  const r = rng(10);
  const assets = [C.randomAsset(r, 16, 24, 4, 3), C.randomAsset(r, 8, 8, 8, 2)];
  const script = C.addWalk(Array.from({ length: 30 }, () => []), 4, r, { frames: [3, 2, 3, 2] });
  const game = C.scriptGame({ div: 2, divBits: 0xC0, winDesc: 0x8780, assets, insts: [0, 1, 0, 1], script });
  game.img.fill(0x77, 0x8780, 0x87A0);                             // a window_desc full of nonsense: ignored by part 1
  const g2 = { ...game, dck: dckOf(game.img) };
  const st = C.observe6(g2, 64, { script });
  check('frame_div $C2 (DIV_EXT | DIV_WIN | 2) with a window_desc: V_DIV = 2, the 20-byte header does not move the sprite table, the picture is right',
    rd8(st.m, S.V_DIV) === 2 && st.pictureBad === 0 && st.ticks.length > 25 && st.ticks.slice(3).every((t, k) => t.frames - st.ticks[k + 2].frames === 2), JSON.stringify(st.firstBad));
}

finish('runtime v3 part 1');
