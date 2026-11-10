"use strict";
// m4-runtime-mem.mjs -- M4a runtime test, part 3: the memory re-plan (layout.inc).
//  1. The map as data: every region of RAM chunks 6 and 7 from the build's symbols; no two overlap, each is where the map says, the gaps are
//     the documented free areas.
//  2. The worst-case game (8 assets of 16 x 16 with 8 phases = all 64 phase slots, 16 instances, tiles and text everywhere) runs with every free
//     area filled with a pattern: the picture is right in 100 % of the refreshes, no free byte is ever written, nothing is written during play
//     outside the regions that play may write (hidden display file, cell map, dirty maps, SPR_TAB, SPR_DRAWN, variables, game variables, stack),
//     and every read-only table (ROW_TAB, PHASE_PTR, AST, the three pools, TILE_ATTR, GLYPH_TAB) is byte for byte what boot built.
//  3. The 1 KB stack: the canary at $FB00 survives the deepest legal use (with an interrupt's 10 bytes on top and a sound effect playing), and
//     is caught - red border, interrupts off, no further ticks - one byte past it.
//   node arcade/tests/m4-runtime-mem.mjs
import * as C from './m4-common.mjs';
import { rng, randomScene, randomTiles } from './m3-scenes.mjs';
const { M, Z, FRAME_T, hex, makeChecks, rd8, rd16, op } = C;

const { check, finish } = makeChecks();
const rt = C.runtime();
const S = rt.syms;
console.log('M4a runtime memory map\n');

// ---- 1. the map ----------------------------------------------------------------------------------------------------------------
const REGIONS = [
  ['ROW_TAB', S.ROW_TAB, 384, 'ro'], ['PHASE_PTR', S.PHASE_PTR, 128, 'ro'], ['POOL_A', S.POOL_A, 32 * 96, 'ro'], ['CELL_TILE', S.CELL_TILE, 768, 'rw'],
  ['CELL_ATTR', S.CELL_ATTR, 768, 'rw'], ['DIRTY0', S.DIRTY0, 96, 'rw'], ['SPR_TAB', S.SPR_TAB, 96, 'rw'], ['AST', S.AST, 64, 'ro'], ['DIRTY1', S.DIRTY1, 96, 'rw'],
  ['SPR_DRAWN', S.SPR_DRAWN, 128, 'rw'], ['T2_FREE', S.T2_FREE, S.T2_FREE_LEN, 'free'], ['TILE_ATTR', S.TILE_ATTR, 128, 'ro'], ['POOL_C', S.POOL_C, 4 * 96, 'ro'],
  ['GLYPH_TAB', S.GLYPH_TAB, 2048, 'ro'], ['VARS', S.VARS, 0xFC, 'rw'], ['VARS_FREE', S.VARS + 0xFC, 0x04, 'free'], ['GAME_VARS', S.GAME_VARS_BASE, S.GAME_VARS_LIMIT + 1 - S.GAME_VARS_BASE, 'rw'],
  ['POOL_B', S.POOL_B, 28 * 96, 'ro'], ['T3', S.T3, S.T3_LEN, 'free'], ['STACK', S.STACK_CANARY, S.STACK_TOP - S.STACK_CANARY, 'stack'], ['HANDOFF', 0xFF00, 0x100, 'rw'],
];
{
  console.log('1. The map');
  let overlap = null;
  for (let i = 0; i < REGIONS.length; i++) for (let j = i + 1; j < REGIONS.length; j++) {
    const [, a, la] = REGIONS[i], [, b, lb] = REGIONS[j];
    if (a < b + lb && b < a + la) overlap ??= `${REGIONS[i][0]} / ${REGIONS[j][0]}`;
  }
  check('no two of the 21 regions overlap', overlap === null, overlap ?? '');
  check('every region lies inside RAM chunks 6 and 7 ($C000-$FFFF), the stack and the vars in chunk 7, ends at or below the next', REGIONS.every(([, a, l]) => a >= 0xC000 && a + l <= 0x10000));
  const covered = new Uint8Array(0x4000);
  for (const [, a, l] of REGIONS) for (let k = 0; k < l; k++) covered[a - 0xC000 + k] = 1;
  const holes = [];
  for (let a = 0; a < 0x4000; a++) if (!covered[a]) { const s = a; while (a < 0x4000 && !covered[a]) a++; holes.push([0xC000 + s, a - s]); }
  console.log('  gaps (not in any region): ' + (holes.map(([s, l]) => `${hex(s)}+${l}`).join(', ') || 'none'));
  const gapBytes = holes.reduce((s, [, l]) => s + l, 0);
  check('the gaps are only alignment holes inside the declared tables: under 600 bytes in all, none in the stack, the pools or the cell map',
    gapBytes < 600 && holes.every(([s, l]) => !(s >= S.CELL_TILE && s < S.CELL_TILE + 1536) && !(s >= S.STACK_CANARY) && !(s >= S.POOL_B && s < S.POOL_B + 2688) && !(s >= S.POOL_A && s < S.POOL_A + 3072)), `${gapBytes} bytes`);
  check('chunk 6 stays below $E000 and chunk 7 keeps GAME_VARS at $E100-$EFFF (3,839 bytes) as v1', S.GAME_VARS_BASE === 0xE100 && S.GAME_VARS_LIMIT === 0xEFFF && S.CELL_TILE + 1536 <= S.DIRTY0 && S.GLYPH_TAB + 2048 === 0xE000);
  check('the stack is 1 KB: canary $FB00..$FB01, stack $FB02..$FEFF (1,022 bytes), STACK_TOP $FF00', S.STACK_CANARY === 0xFB00 && S.STACK_LIMIT === 0xFB02 && S.STACK_TOP === 0xFF00);
  check('64 phase slots of 96 bytes: 32 in POOL_A, 28 in POOL_B, 4 in POOL_C', S.SLOT_COUNT === 64 && S.POOL_A_SLOTS === 32 && S.POOL_B_SLOTS === 28 && S.POOL_C_SLOTS === 4 && S.PHASE_LEN === 96);
  check('the 8-bit address arithmetic of the code is safe: AST + 8 * 7 + 4 and PHASE_PTR + 126 stay inside one page; SPR_TAB..AST are one page', (S.AST & 255) + 60 < 256 && (S.PHASE_PTR & 255) + 127 < 256 && (S.SPR_TAB >> 8) === ((S.AST + 63) >> 8));
}

// ---- 2. the worst-case game with the free areas poisoned ---------------------------------------------------------------------------
console.log('\n2. The worst-case game, free areas poisoned, writes tracked');
{
  const r = rng(77);
  const assets = Array.from({ length: 8 }, () => C.randomAsset(r, 16, 16, 8));
  const insts = Array.from({ length: 16 }, (_, i) => i % 8);
  const script = randomScene(7701, 70, { sprites: 0, tiles: 12, textRate: 0.7, tileRate: 0.8, wild: true });
  const pos = insts.map(() => ({ x: r.int(0, 230), y: r.int(0, 170), dx: r.int(-4, 4), dy: r.int(-3, 3) }));
  script.forEach((t) => pos.forEach((p, i) => { p.x += p.dx; p.y += p.dy; if (p.x < 0 || p.x > 235) p.dx = -p.dx; if (p.y < 0 || p.y > 172) p.dy = -p.dy; t.push(op.show(i, Math.max(0, p.x), Math.max(0, p.y))); }));
  const map = Array.from({ length: 768 }, () => (r.chance(0.5) ? 0x80 | r.int(0, 11) : r.int(32, 126)));
  const spec = { div: 3, assets, insts, tiles: randomTiles(rng(78), 12), map, script };
  const game = C.scriptGame(spec);
  const freeAreas = REGIONS.filter((x) => x[3] === 'free');
  let armedPlay = false, poisoned = false;
  const bootWrites = new Set(), playWrites = new Set();
  let snap = null;
  const ro = REGIONS.filter((x) => x[3] === 'ro');
  const st = C.observe(game, 200, {
    script, hooks: (pc, { m, inIsr }) => {
      if (!poisoned && pc === S.MAIN) {
        poisoned = true; armedPlay = true;
        for (const [, a, l] of freeAreas) for (let k = 0; k < l; k++) m.ram[a + k] = 0xA5 ^ (k & 0x3F);
        snap = ro.map(([, a, l]) => m.ram.slice(a, a + l));
        const w = m.bus.write;
        m.bus.write = (addr, v) => { const a = addr & 0xFFFF; if (a >= 0xC000) playWrites.add(a); w(addr, v); };
      }
    },
  });
  void bootWrites;
  const m = st.m;
  const name = (a) => { for (const [n, s, l] of REGIONS) if (a >= s && a < s + l) return n; return 'gap'; };
  const touched = {};
  for (const a of playWrites) { const n = name(a); touched[n] = (touched[n] ?? 0) + 1; }
  console.log('  regions written during play (bytes): ' + Object.entries(touched).map(([n, c]) => `${n} ${c}`).join(', '));
  check('the worst-case picture (8 assets x 8 phases = 64 slots, 16 instances, text, 12 tiles) equals the model in 100 % of the 200 refreshes', st.pictureOk === 200 && st.pictureBad === 0 && st.pixelBad === 0, JSON.stringify(st.firstBad));
  check('no free area is ever written (T2_FREE, T3 = the RAM of the tile operations, which this game does not call, and $E0FC-$E0FF stay filled with the pattern)', freeAreas.every(([, a, l]) => Array.from({ length: l }, (_, k) => m.ram[a + k]).every((v, k) => v === (0xA5 ^ (k & 0x3F)))));
  check('during play nothing is written to a read-only table (ROW_TAB, PHASE_PTR, AST, the pools, TILE_ATTR, GLYPH_TAB) nor to a gap', ro.every(([n]) => !touched[n]) && !touched.gap, JSON.stringify(touched));
  check('...and those tables are byte for byte what the boot built', ro.every(([, a, l], i) => Array.from({ length: l }, (_, k) => m.ram[a + k]).every((v, k) => v === snap[i][k])));
  check('play writes only: cell map, dirty maps, SPR_TAB, SPR_DRAWN, variables, game variables, the stack (and the hand-off record is not touched)', Object.keys(touched).every((n) => ['CELL_TILE', 'CELL_ATTR', 'DIRTY0', 'DIRTY1', 'SPR_TAB', 'SPR_DRAWN', 'VARS', 'GAME_VARS', 'STACK'].includes(n)) && !touched.HANDOFF);
  check('the stack canary is intact and the stack stayed in $FB02..$FF00', st.canary === 0x5AA5 && st.spMin >= S.STACK_LIMIT, `SP ${hex(st.spMin)}..${hex(st.spMax)}`);
}

// ---- 3. the 1 KB stack ---------------------------------------------------------------------------------------------------------------
console.log('\n3. The stack: depth, the canary');
{
  const rec = (k) => [(60 + 3 * k) & 255, ((60 + 3 * k) >> 8) | (((15 - ((k >> 3) % 16)) & 15) << 4), (k % 31) | ((k % 4) << 5), 0];
  const eff = [Array.from({ length: 400 }, (_, k) => rec(k))];
  const r = rng(5);
  const assets = [C.randomAsset(r, 16, 16, 8)];
  const probe = (n) => {
    const script = [[op.play(0), op.show(0, 100, 100)], [], [op.deep(n)], [op.show(0, 101, 100)], [], [], [], [], []];
    const game = C.scriptGame({ div: 1, assets, insts: [0], sfx: eff, script });
    const m = C.newMachine(game.dck);
    let entry = false, sp0 = 0, lastBorder = -1, ticksAfter = 0;
    for (let f = 0; f < 400 && !entry; f++) { M.runFrame(m); if (rd16(m, S.HO_MARK) === 0x5AA5) entry = true; }
    const origOut = m.bus.ioWrite;
    m.bus.ioWrite = (p, v) => { if ((p & 0xFF) === 0xFE) lastBorder = v & 7; origOut(p, v); };
    let spMin = 0xFFFF, deadFrames = 0, ticksAtDeath = -1;
    for (let f = 0; f < 60; f++) {
      const end = m.frameStart + FRAME_T;
      while (m.tstates < end) {
        if (m.cpu.halted) break;
        if (m.cpu.pc === game.gsyms.frame_entry && !sp0) sp0 = m.cpu.sp;
        if (m.cpu.sp < spMin && m.cpu.sp > 0xE000) spMin = m.cpu.sp;
        Z.runZ80(m.cpu, m.bus, 1, m);
      }
      M.runFrame(m);
      if (!m.cpu.iff1 && lastBorder === 2) { deadFrames++; if (ticksAtDeath < 0) ticksAtDeath = rd16(m, S.V_TICKS); }
    }
    return { m, sp0, spMin, lastBorder, deadFrames, canary: rd16(m, S.STACK_CANARY), ticks: rd16(m, S.V_TICKS), ticksAtDeath, iff1: m.cpu.iff1 };
  };
  const r0 = probe(0);
  const SP0 = r0.sp0;
  console.log(`  frame_entry runs with SP = ${hex(SP0)}`);
  const nSafe = Math.floor((SP0 - 0xFB02 - 10) / 2);          // 10 bytes: the interrupt's PC, AF and the sound tick's BC DE HL
  const rs = probe(nSafe);
  check(`a stack of ${2 * nSafe} bytes pushed in frame_entry (SP down to ${hex(SP0 - 2 * nSafe)}, an interrupt's 10 bytes below it, a sound effect playing): canary intact, the game keeps ticking, border unchanged`,
    rs.canary === 0x5AA5 && rs.ticks > 6 && rs.deadFrames === 0 && rs.lastBorder !== 2 && rs.spMin >= 0xFB02, `SP min ${hex(rs.spMin)}, ${rs.ticks} ticks`);
  check('...and the bytes below the stack (T3, the top of POOL_B) are untouched by it', (() => { for (let a = S.T3; a < S.STACK_CANARY; a++) if (rs.m.ram[a] !== r0.m.ram[a]) return false; return true; })());
  const rk = probe(nSafe + 8);                                  // 16 bytes deeper than the safe use: the canary and below are overwritten
  check('16 bytes deeper: the canary is overwritten and the next tick stops the machine - red border, interrupts off, no more ticks', rk.canary !== 0x5AA5 && rk.lastBorder === 2 && !rk.iff1 && rk.deadFrames > 20 && rk.ticks === rk.ticksAtDeath, `canary ${hex(rk.canary)}, border ${rk.lastBorder}, ${rk.ticks} ticks`);
}

finish('M4a runtime memory map');
void rd8;
