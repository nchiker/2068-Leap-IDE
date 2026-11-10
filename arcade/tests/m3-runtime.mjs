"use strict";
// m3-runtime.mjs -- milestone M3 runtime test, part 1: Leap Arcade runtime v1 on a stock TS2068 (TSRun): boot state, the game header v1,
// and the picture: the cell map (text and tiles) under moving sprites, compared after EVERY refresh with a JavaScript model, memory
// byte for byte AND on screen as colours; no tearing; sprite erase; tiles changed every tick; overruns.
//   node arcade/tests/m3-runtime.mjs
// Companions: m3-runtime-text.mjs (every routine called directly, vs the model), m3-runtime-sound.mjs, m3-runtime-regs.mjs,
// m3-runtime-perf.mjs (T-states).
import { printUsage } from '../tools/build-runtime-v1.mjs';
import * as C from './m3-common.mjs';
import { rng, randomScene, randomTiles } from './m3-scenes.mjs';
const { M, Z, FRAME_T, FIRST_PIXEL_T, hex, makeChecks, rd8, rd16, op, Model, FONT } = C;

const { check, finish } = makeChecks();
const rt = C.runtime();
console.log('M3 runtime test: Leap Arcade runtime v1 on a stock TS2068 (TSRun)\n');
printUsage(rt.usage, rt.dck);
console.log('');

const sameBytes = (m, from, expect) => { for (let i = 0; i < expect.length; i++) if (m.ram[from + i] !== expect[i]) return false; return true; };
const allEq = (m, from, n, v) => { for (let i = 0; i < n; i++) if (m.ram[from + i] !== v) return false; return true; };

// ==================================================================================================================
// 1. Boot state (the placeholder game), with the stale RAM of a real hand-off
// ==================================================================================================================
console.log('1. Boot state (placeholder game; chunk 6 and the display files are filled with garbage when the cartridge starts)');
{
  const S = rt.syms;
  const m = C.newMachine(rt.dck);
  // stop at the cartridge entry (every instruction), poison the RAM the runtime must initialise, then let it boot
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
  for (let a = 0x4000; a < 0x7B00; a++) m.ram[a] = 0x5A;          // both display files: garbage
  for (let i = 0; i < 16; i++) m.ay.regs[i] = 0xFF;                // the stock ROM wrote to the AY: garbage
  const b = C.bootMachine(m, S);
  for (let f = 0; f < 6; f++) M.runFrame(m);
  check('boot completes (V_FRAMES counts) within 14 frames of the entry', rd16(m, S.V_FRAMES) > 0 && b.bootFrames <= 14, `${b.bootFrames} frames`);
  check('every cell is a font space (32) with attribute $38 (paper 7, ink 0)', allEq(m, S.CELL_TILE, 768, 32) && allEq(m, S.CELL_ATTR, 768, 0x38));
  check('both dirty maps are empty (both files already hold the blank cells)', allEq(m, S.DIRTY0, 96, 0) && allEq(m, S.DIRTY1, 96, 0));
  const f0 = C.dfileOf(m, 0), f1 = C.dfileOf(m, 1);
  check('display file 1: all pixels 0, all attributes $38', f0.bitmap.every((v) => v === 0) && f0.attrs.every((v) => v === 0x38));
  check('display file 2: all pixels 0, all attributes $38', f1.bitmap.every((v) => v === 0) && f1.attrs.every((v) => v === 0x38));
  const px = C.shownColours(m);
  check('the screen shows a blank white page (colour 7 everywhere)', px && px.every((v) => v === 7));
  check('glyph table (8 planes of 256): codes 0..31 blank, 32..127 = the font (96 x 8), 128..255 (tiles) blank, 2048 bytes in all',
    [...Array(32).keys()].every((v) => C.glyphOfValue(m, S, v).every((b) => b === 0)) && FONT.every((g, k) => C.glyphOfValue(m, S, 32 + k).join() === g.join()) &&
    [...Array(128).keys()].every((t) => C.glyphOfValue(m, S, 128 + t).every((b) => b === 0)));
  check('TILE_ATTR: 128 x $38; the byte after it untouched (0)', allEq(m, S.TILE_ATTR, 128, 0x38) && rd8(m, S.TILE_ATTR + 128) === 0);
  check('chunk 6 is cleared above the tables (stale $A5 gone): $D460..$D4FF and $D680..$D7FF are 0', allEq(m, 0xD460, 0xA0, 0) && allEq(m, 0xD680, 0x180, 0));
  check('text state: attribute $38, cursor 0,0; sound idle', rd8(m, S.V_TEXT_ATTR) === 0x38 && rd8(m, S.V_CUR_ROW) === 0 && rd8(m, S.V_CUR_COL) === 0 && rd8(m, S.V_SFX_ACTIVE) === 0);
  check('AY: all 16 registers 0 (as the Leap cartridge leaves them), AY_SHADOW 0, channel A volume 0',
    Array.from({ length: 16 }, (_, i) => m.ay.regs[i]).every((v) => v === 0) && allEq(m, S.AY_SHADOW, 16, 0) && m.ay.regs[8] === 0);
  check('hand-off and play mapping unchanged from v0 ($F4 = $33, IM 1, $FF bits 6-7 = 0)', m.portF4 === 0x33 && m.cpu.im === 1 && (m.portFF & 0xC0) === 0);
  check('ISR is exactly 46 bytes ($0038..$0065) and the NMI vector $0066 follows it', S.ISR === 0x38 && S.ISR_END === 0x66 && S.NMI === 0x66, `${hex(S.ISR)}..${hex(S.ISR_END)}`);
}

// ==================================================================================================================
// 2. The game header v1: pointers of 0, clamps
// ==================================================================================================================
console.log('\n2. Game header v1');
{
  const S = rt.syms;
  const run = (g, frames = 40) => { const m = C.newMachine(g.dck); C.bootMachine(m, S); for (let f = 0; f < frames; f++) M.runFrame(m); return m; };
  // 2a. a v0-style header (the three new pointers 0): text works, tiles read as blank, play is ignored
  const g0 = C.scriptGame({ sprites: [{ kind: 'ball' }], script: [[op.at(1, 1), op.prints('NO TILESET'), op.tile(5, 3, 3), op.play(0), op.tileat(3, 3)]] });
  let m = run(g0);
  check('tileset_ptr, sfx_table and map_ptr all 0: the machine runs, tile glyphs are blank with BG_ATTR, play is ignored',
    rd16(m, S.V_TICKS) > 10 && rd8(m, S.V_SFX_ACTIVE) === 0 && [...Array(128).keys()].every((t) => C.glyphOfValue(m, S, 128 + t).every((b) => b === 0)) && rd8(m, S.CELL_TILE + 3 * 32 + 3) === 0x85 && rd8(m, S.CELL_ATTR + 3 * 32 + 3) === 0x38);
  // 2b. tile count above 128 is clamped to 128 (the 129th tile must not land in $E000: the runtime variables)
  const r = rng(77);
  const tiles = randomTiles(r, 200);
  const g1 = C.scriptGame({ sprites: [{ kind: 'ball' }], tiles, tilesetCount: 255, script: [[op.tile(127, 0, 0), op.tile(0, 0, 1)]] });
  m = run(g1);
  const t127 = tiles[127];
  check('tile count 255 is read as 128: tile 127 is complete, TILE_ATTR[127] right, nothing written beyond ($D680 = 0, GLYPH_TAB end = $DFFF)',
    C.glyphOfValue(m, S, 255).join() === t127.bmp.join() && rd8(m, S.TILE_ATTR + 127) === t127.attr && rd8(m, S.TILE_ATTR + 128) === 0, '');
  check('...and the runtime variables were not overwritten: the game still ticks, canary intact', rd16(m, S.V_TICKS) > 10 && rd16(m, S.STACK_CANARY) === 0x5AA5 && rd8(m, S.V_SPRN) === 1);
  // 2c. tile count 0, a tileset with 1 tile
  const g2 = C.scriptGame({ tiles: [{ bmp: [1, 2, 3, 4, 5, 6, 7, 8], attr: 0x47 }], script: [[op.tile(0, 5, 5), op.tile(1, 5, 6)]] });
  m = run(g2);
  check('one tile defined: tile 0 drawn with its attribute; tile 1 (undefined) is blank with BG_ATTR',
    rd8(m, S.CELL_ATTR + 5 * 32 + 5) === 0x47 && rd8(m, S.CELL_ATTR + 5 * 32 + 6) === 0x38 && C.glyphOfValue(m, S, 128).join() === '1,2,3,4,5,6,7,8' && C.glyphOfValue(m, S, 129).every((b) => b === 0));
  // 2d. a map: copied at boot, tile cells take their tile's attribute, font cells BG_ATTR; both files get it
  const map = new Array(768).fill(0).map((_, i) => (i % 7 === 0 ? 0x80 | (i % 3) : 32 + (i % 90)));
  const gm = C.scriptGame({ tiles: randomTiles(rng(3), 3), map, script: [] });
  m = run(gm, 30);
  const mdl = new Model(gm.spec);
  const exp = mdl.render(null);
  check('the map is copied to CELL_TILE; attributes come from the tiles / BG_ATTR', sameBytes(m, S.CELL_TILE, mdl.tile) && sameBytes(m, S.CELL_ATTR, mdl.attr));
  const d0 = C.dfileOf(m, 0), d1 = C.dfileOf(m, 1);
  check('both display files show the map after the first two ticks (bitmap and attributes equal the model)',
    C.diffCount(d0.bitmap, exp.bitmap) + C.diffCount(d0.attrs, exp.attrs) + C.diffCount(d1.bitmap, exp.bitmap) + C.diffCount(d1.attrs, exp.attrs) === 0);
  check('...and no cell is left dirty', allEq(m, S.DIRTY0, 96, 0) && allEq(m, S.DIRTY1, 96, 0));
  // 2e. sprite_count above 4 is still clamped (v0 rule), hot boxes read
  const g7 = C.scriptGame({ sprites: [{ kind: 'ball' }, { kind: 'box' }, { kind: 'ball' }, { kind: 'box' }], spriteCountHeader: 7, script: [] });
  m = run(g7, 20);
  check('sprite_count 7 is clamped to 4; hot box defaults (0,0,16,height) in SPR_HOT', rd8(m, S.V_SPRN) === 4 && sameBytes(m, S.SPR_HOT, [0, 0, 16, 16, 0, 0, 16, 12, 0, 0, 16, 16, 0, 0, 16, 12]));
  const gh = C.scriptGame({ sprites: [{ kind: 'ball', hot: [2, 3, 12, 10] }, { kind: 'box', hot: [255, 1, 0, 200] }], script: [] });
  m = run(gh, 10);
  check('hot boxes from the descriptors are read as given', sameBytes(m, S.SPR_HOT, [2, 3, 12, 10, 255, 1, 0, 200]));
}

// ==================================================================================================================
// 3. The picture: random scenes, compared after every refresh
// ==================================================================================================================
function sceneChecks(label, spec, nTicks, nframes, st, { expectOneTickPerRefresh = true, div = 1 } = {}) {
  const S = rt.syms;
  console.log(`\n${label}`);
  check(`the picture on screen equals the model (cells, then masked sprites) in 100 % of the ${nframes} refreshes (memory: bitmap + attributes)`,
    st.pictureOk === nframes && st.pictureBad === 0, st.firstBad ? JSON.stringify(st.firstBad) : `${st.pictureOk}/${nframes}`);
  check('...and as colours on the screen (ink / paper / bright of every pixel, 100 % of refreshes)', st.pixelBad === 0, `${st.pixelBad} frames differ`);
  check('no tearing: no instruction ever writes the displayed display file', st.writeViolations === 0, `${st.writeViolations} writes`);
  check('every flip request is honoured at the next interrupt and nowhere else; frame counter exact', st.flipMismatch === 0 && st.shadowBad === 0 && st.missed === 0,
    `${st.flipMismatch} flip mismatches, ${st.missed} frames off`);
  check('the flip (OUT $FF) executes before the first pixel line', st.flipWrites.length > 0 && Math.max(...st.flipWrites) < FIRST_PIXEL_T, `latest ${Math.max(...st.flipWrites)} T`);
  check('IM 1 and interrupts enabled whenever a tick starts', st.imBad === 0 && st.work.length > 0, `${st.imBad} violations`);
  check('stack canary intact; SP within $F002..$FF00', st.canary === 0x5AA5 && st.spMin >= S.STACK_CANARY + 2 && st.spMax <= S.STACK_TOP, `SP ${hex(st.spMin)}..${hex(st.spMax)}`);
  check('ticks are never skipped: V_TICKS counts 0, 1, 2, ...', st.ticks.every((t, k) => t.n === k), `${st.ticks.length} ticks`);
  if (expectOneTickPerRefresh) check(`one tick every ${div} refresh${div > 1 ? 'es' : ''} (the work fits)`, st.ticks.slice(2).every((t, k) => t.frames - st.ticks[k + 1].frames === div),
    `gaps ${[...new Set(st.ticks.slice(2).map((t, k) => t.frames - st.ticks[k + 1].frames))].join(',')}`);
  void spec; void nTicks;
}

{ // 3a. text + four sprites + tiles, frame_div 1
  const spec = { div: 1, sprites: [{ kind: 'ball' }, { kind: 'box' }, { kind: 'ball' }, { kind: 'box' }], tiles: randomTiles(rng(11), 8) };
  spec.script = randomScene(101, 200, { sprites: 4, tiles: 8, textRate: 0.55, tileRate: 0.6, wild: true, hits: true });
  const game = C.scriptGame(spec);
  const st = C.observe(game, 190, { script: spec.script });
  sceneChecks('3a. Text, tiles and 4 moving sprites (random stress scene, frame_div 1, 190 refreshes)', spec, 200, 190, st, { expectOneTickPerRefresh: false });
  const overlap = st.snapshots.filter(Boolean).length;
  void overlap;
  check('the game\'s HIT / TILEAT results equal the model (every call of the scene)', st.gameLog.length > 100 && st.gameLog.length === st.modelLog.length && st.gameLog.every((v, k) => v === st.modelLog[k]),
    `${st.gameLog.length} results`);
  const peak = Math.max(...st.work);
  console.log(`  tick work (ISR excluded) avg ${C.avg(st.work).toFixed(0)}  max ${peak} T`);
}

{ // 3b. sprites over a FULL screen of text, frame_div 1: the erase must restore every character
  const r = rng(5);
  const fill = [];
  for (let row = 0; row < 24; row++) fill.push(op.at(row, 0), op.prints('0123456789ABCDEFGHIJKLMNOPQRSTU'.slice(0, 31)), op.printc(65 + (row % 26)));
  const ticks = [fill.slice(0, 24 * 3 / 2 * 1), fill.slice(36)];
  const walk = [];
  for (let t = 0; t < 120; t++) walk.push([0, 1, 2, 3].map((i) => op.show(i, (7 * t + 61 * i) % 230 + (i & 1), (3 * t + 40 * i) % 170 + i)));
  const hide = [[op.hide(0), op.hide(1), op.hide(2), op.hide(3)], [], [], []];
  const script = [...ticks, ...walk, ...hide];
  const spec = { div: 1, sprites: [{ kind: 'ball' }, { kind: 'box' }, { kind: 'ball' }, { kind: 'box' }], script };
  void r;
  const game = C.scriptGame(spec);
  const st = C.observe(game, 190, { script });
  sceneChecks('3b. 4 sprites sweeping over a screen full of text, then hidden (frame_div 1)', spec, script.length, 190, st, { expectOneTickPerRefresh: false });
  check('the whole script ran (the sprites are hidden and the picture settled)', st.ticks.length >= script.length + 3, `${st.ticks.length} ticks of ${script.length}`);
  // after the sprites are hidden both files equal the cells alone
  const m = st.m, S = rt.syms;
  const cellsOnly = st.model.render(null);
  const d0 = C.dfileOf(m, 0), d1 = C.dfileOf(m, 1);
  check('after hide, BOTH display files equal the text alone: the erase restored every character exactly (no trace of any sprite)',
    C.diffCount(d0.bitmap, cellsOnly.bitmap) + C.diffCount(d0.attrs, cellsOnly.attrs) === 0 && C.diffCount(d1.bitmap, cellsOnly.bitmap) + C.diffCount(d1.attrs, cellsOnly.attrs) === 0);
  check('...and the dirty maps are empty at rest', allEq(m, S.DIRTY0, 96, 0) && allEq(m, S.DIRTY1, 96, 0));
}

{ // 3c. tiles changed every tick, frame_div 2
  const tiles = randomTiles(rng(21), 16);
  const r = rng(22);
  const map = Array.from({ length: 768 }, () => (r.chance(0.6) ? 0x80 | r.int(0, 15) : r.int(32, 126)));
  const script = randomScene(103, 200, { sprites: 3, tiles: 16, textRate: 0.3, tileRate: 1, tileBurst: 6, hits: true });
  const spec = { div: 2, sprites: [{ kind: 'ball' }, { kind: 'box' }, { kind: 'ball' }], tiles, map, script };
  const game = C.scriptGame(spec);
  const st = C.observe(game, 380, { script });
  sceneChecks('3c. A full screen map of tiles and text; 1-6 tiles changed every tick, text, 3 sprites (frame_div 2)', spec, 200, 380, st, { div: 2, expectOneTickPerRefresh: false });
  check('the game\'s HIT / TILEAT results equal the model', st.gameLog.length === st.modelLog.length && st.gameLog.every((v, k) => v === st.modelLog[k]), `${st.gameLog.length} results`);
}

{ // 3d. overrun: every 5th tick burns ~80,000 T on top of text and sprites
  const script = randomScene(104, 120, { sprites: 2, tiles: 6, textRate: 0.6, tileRate: 0.8 });
  for (let t = 4; t < script.length; t += 5) script[t].push(op.burn());
  const spec = { div: 1, sprites: [{ kind: 'ball' }, { kind: 'box' }], tiles: randomTiles(rng(31), 6), script };
  const game = C.scriptGame(spec);
  const st = C.observe(game, 300, { script });
  sceneChecks('3d. frame_entry overruns a refresh (BURN) while text, tiles and sprites change', spec, 120, 300, st, { expectOneTickPerRefresh: false });
  check('the overruns happened: interrupts during the work flipped nothing, and were skipped cleanly', st.skippedFlips > 5 && Math.max(...st.work) > FRAME_T, `${st.skippedFlips} flips skipped, longest work ${Math.max(...st.work)} T`);
}

{ // 3e. CLS storms and wide text: big redraws that take several refreshes; picture still equals the last complete snapshot
  const script = randomScene(105, 90, { sprites: 4, tiles: 4, textRate: 0.9, tileRate: 0.3, clsEvery: 9, maxText: 31 });
  const spec = { div: 1, sprites: [{ kind: 'ball' }, { kind: 'box' }, { kind: 'ball' }, { kind: 'box' }], tiles: randomTiles(rng(41), 4), script };
  const game = C.scriptGame(spec);
  const st = C.observe(game, 330, { script });
  sceneChecks('3e. CLS every 9th tick plus long strings and 4 sprites (ticks may take several refreshes)', spec, 90, 330, st, { expectOneTickPerRefresh: false });
  check('the long ticks happened (some tick took more than one refresh)', Math.max(...st.work) > FRAME_T / 2, `longest ${Math.max(...st.work)} T`);
}

{ // 3f. a typical game tick: 4 moving sprites, a score of up to 8 characters and 2 tiles changing per tick, over a text-filled screen
  const fill = [];
  for (let row = 0; row < 24; row++) fill.push(op.at(row, 0), op.prints('0123456789ABCDEFGHIJKLMNOPQRSTU'), op.printc(65 + (row % 26)));
  const r = rng(9);
  const walk = [];
  for (let t = 0; t < 120; t++) {
    const ops = [op.at(0, 24), op.ink(t % 7), op.prints('SCORE ' + String(100 + t * 7)), op.tile(t % 6, r.int(1, 22), r.int(0, 31)), op.tile((t + 3) % 6, r.int(1, 22), r.int(0, 31))];
    for (let i = 0; i < 4; i++) ops.push(op.show(i, (7 * t + 61 * i) % 230 + (i & 1), (3 * t + 40 * i) % 170 + i));
    walk.push(ops);
  }
  const script = [fill, [], [], ...walk];
  const spec = { div: 1, sprites: [{ kind: 'ball' }, { kind: 'box' }, { kind: 'ball' }, { kind: 'box' }], tiles: randomTiles(rng(51), 6), script };
  const game = C.scriptGame(spec);
  const st = C.observe(game, 150, { script });
  sceneChecks('3f. A typical game tick: 4 moving sprites + a score + 2 tiles per tick over a full screen of text (frame_div 1)', spec, script.length, 150, st, { expectOneTickPerRefresh: false });
  const steady = st.work.slice(6, 120), over = st.work.slice(6, 120).filter((w) => w > FRAME_T).length;
  console.log(`  steady tick work (ISR excluded): avg ${C.avg(steady).toFixed(0)}  max ${Math.max(...steady)} T (${(100 * Math.max(...steady) / FRAME_T).toFixed(1)} % of a refresh);  erase_all avg ${Math.round(C.avg(st.eraseT.slice(6, 120)))}, redraw_dirty avg ${Math.round(C.avg(st.redrawT.slice(6, 120)))}, draw_all avg ${Math.round(C.avg(st.drawT.slice(6, 120)))} T`);
  const gaps = st.ticks.slice(8, 120).map((t, k) => t.frames - st.ticks[k + 7].frames);
  check('in steady state every tick fits in one refresh: ticks are exactly 1 refresh apart (frame_div 1)', over === 0 && gaps.every((g) => g === 1), `${over} ticks over ${FRAME_T} T; gaps ${[...new Set(gaps)].join(',')}`);
}

finish('M3 runtime');
