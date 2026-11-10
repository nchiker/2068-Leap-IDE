"use strict";
// m3-runtime-perf.mjs -- M3 runtime test, part 5: T-states of runtime v1 (TSRun's clock, 58,688 T per refresh), measured on the real machine:
// the cell renderer, the text routines, the tick overhead with a full screen of text, the sound tick, and a tick of 4 sprites over a
// text-filled screen.  The numbers are printed (they go into the report and docs/ARCADE_RUNTIME_API_V1.md); the checks bound them.
//   node arcade/tests/m3-runtime-perf.mjs
import * as C from './m3-common.mjs';
const { M, Z, FRAME_T, hex, makeChecks, rd8, rd16, op } = C;

const { check, finish } = makeChecks();
const rt = C.runtime();
const S = rt.syms;
console.log('M3 runtime performance (T-states; a refresh is ' + FRAME_T + ' T)\n');
console.log('Sizes: runtime ' + (rt.usage.per[0] + rt.usage.per[1]) + ' of 16384 bytes in DOCK chunks 0-1 (font 768, code ' + (rt.usage.per[0] + rt.usage.per[1] - 768) + ');  RAM chunk 6 uses $C000-$DFFF in full:');
console.log('  ROW_TAB $C000, PHASE_TAB $C200-$CDFF, CELL_TILE $CE00, CELL_ATTR $D100, DIRTY0 $D400, DIRTY1 $D500, TILE_ATTR $D600, GLYPH_TAB $D800-$DFFF; free $D460-$D4FF, $D560-$D5FF, $D680-$D7FF (800 bytes)\n');

function park(game) {
  const m = C.newMachine(game.dck);
  C.bootMachine(m, S);
  for (let f = 0; f < 8; f++) M.runFrame(m);
  for (let i = 0; i < 400000 && !(m.cpu.pc === S.TICK_LOOP && !m.cpu.halted); i++) Z.runZ80(m.cpu, m.bus, 1, m);
  return m;
}
const call = (m, addr, regs) => { const t0 = m.tstates; const r = C.callRoutine(m, addr, regs); m.tstates = t0; return r; };
const g0 = C.scriptGame({ sprites: [{ kind: 'ball' }], tiles: [{ bmp: [1, 2, 4, 8, 16, 32, 64, 128], attr: 0x47 }], script: [] });
const m = park(g0);

// ---- the cell renderer ----
{
  m.ram[S.V_HOFF] = 0;
  const t = call(m, S.draw_cell, { bc: 5 * 32 + 7 }).t;
  const te = call(m, S.erase_row, { hl: S.CELL_TILE + 5 * 32 + 3, de: (0x40 + 5 * 8 / 8 * 0) * 0 }).t;   // placeholder, replaced below
  void te;
  console.log(`draw_cell (attribute + 8 bitmap rows, hidden file): ${t} T`);
  check('draw_cell is under 400 T', t < 400);
  // erase_row: 3 cells (E_NC = 3) and 2 cells
  m.ram[S.E_NC] = 3;
  const e3 = call(m, S.erase_row, { hl: S.CELL_TILE + 5 * 32 + 3, de: 0x4000 | 3 | (5 << 5) }).t;
  m.ram[S.E_NC] = 2;
  const e2 = call(m, S.erase_row, { hl: S.CELL_TILE + 5 * 32 + 3, de: 0x4000 | 3 | (5 << 5) }).t;
  console.log(`erase of a cell (bitmap only, from the cell map): ${Math.round((e3 - e2))} T per cell  (a row of 3 cells ${e3} T, of 2 cells ${e2} T)`);
}

// ---- redraw_dirty: per dirty cell ----
{
  const run = (cells) => {
    m.ram.fill(0, S.DIRTY0, S.DIRTY0 + 96); m.ram.fill(0, S.DIRTY1, S.DIRTY1 + 96);
    for (const i of cells) { m.ram[S.DIRTY0 + (i >> 3)] |= 1 << (i & 7); }
    m.ram[S.V_HIDDEN] = 0; m.ram[S.V_HOFF] = 0;
    return call(m, S.redraw_dirty, {}).t;
  };
  const base = run([]);
  const contiguous = run(Array.from({ length: 64 }, (_, k) => 100 + k));
  const scattered = run(Array.from({ length: 64 }, (_, k) => k * 11 + 3));
  const one = run([300]);
  console.log(`redraw_dirty: clean map ${base} T; one dirty cell ${one} T; 64 contiguous cells ${contiguous} T (${Math.round((contiguous - base) / 64)} T per cell); 64 scattered cells (one per dirty byte) ${scattered} T (${Math.round((scattered - base) / 64)} T per cell)`);
  check('a clean dirty map costs under 2,000 T', base < 2000);
  m.ram.fill(0, S.DIRTY0, S.DIRTY0 + 96);
}

// ---- text routines ----
{
  const mm = park(C.scriptGame({ sprites: [], script: [] }));
  const r0 = call(mm, S.RT_AT, { bc: 0 }).t;
  // unchanged cell, changed cell
  call(mm, S.RT_AT, { bc: 0 }); call(mm, S.RT_PRINTC, { a: 65 });
  call(mm, S.RT_AT, { bc: 0 });
  const same = call(mm, S.RT_PRINTC, { a: 65 }).t;
  call(mm, S.RT_AT, { bc: 0 });
  const chg = call(mm, S.RT_PRINTC, { a: 66 }).t;
  mm.ram[S.STR ?? 0xE800] = 31;
  const STR = 0xE800;
  const str = Array.from({ length: 31 }, (_, k) => 48 + (k % 40));
  mm.ram[STR] = 31; str.forEach((c, k) => { mm.ram[STR + 1 + k] = c; });
  call(mm, S.RT_AT, { bc: 3 << 8 });
  call(mm, S.RT_PRINTS, { hl: STR });
  call(mm, S.RT_AT, { bc: 3 << 8 });
  const ps = call(mm, S.RT_PRINTS, { hl: STR }).t;                 // unchanged
  str.forEach((c, k) => { mm.ram[STR + 1 + k] = 65 + (k % 26); });
  call(mm, S.RT_AT, { bc: 3 << 8 });
  const psc = call(mm, S.RT_PRINTS, { hl: STR }).t;                // changed
  call(mm, S.RT_AT, { bc: 5 << 8 });
  const pn = call(mm, S.RT_PRINTN, { hl: 12345 }).t;
  const pn2 = call(mm, S.RT_PRINTN, { hl: (-7) & 0xFFFF }).t;
  const tile = call(mm, S.RT_TILE, { a: 0, bc: (9 << 8) | 9 }).t;
  const tile2 = call(mm, S.RT_TILE, { a: 0, bc: (9 << 8) | 9 }).t;
  const tat = call(mm, S.RT_TILEAT, { bc: (9 << 8) | 9 }).t;
  const cls = call(mm, S.RT_CLS, {}).t;
  const cls2 = call(mm, S.RT_CLS, {}).t;
  const hit = call(mm, S.RT_HIT, { a: 0, de: 0 }).t;
  console.log(`RT_AT ${r0} T;  RT_PRINTC: unchanged cell ${same} T, changed cell ${chg} T;  RT_PRINTS 31 chars: unchanged ${ps} T (${Math.round(ps / 31)} T per character), changed ${psc} T (${Math.round(psc / 31)} T per character)`);
  console.log(`RT_PRINTN(12345) ${pn} T; RT_PRINTN(-7) ${pn2} T; RT_TILE changed ${tile} T, unchanged ${tile2} T; RT_TILEAT ${tat} T; RT_CLS: changing the screen ${cls} T, already clear ${cls2} T; RT_HIT (one sprite, same index) ${hit} T`);
  check('a text character costs under 700 T (changed) in the main thread; the redraw is paid by the frame loop', psc / 31 < 700);
}

// ---- tick overhead with a full screen of text, nothing changing ----
const fill = [];
for (let row = 0; row < 24; row++) fill.push(op.at(row, 0), op.prints('0123456789ABCDEFGHIJKLMNOPQRSTU'), op.printc(65 + (row % 26)));
const quiet = C.scriptGame({ sprites: [], script: [fill, [], [], []] });
{
  const st = C.observe(quiet, 40, { script: null, checkPicture: false });
  const w = st.work.slice(6);
  console.log(`\ntick overhead with a full screen of text and nothing changing (0 sprites, ISR excluded): ${Math.min(...w)}..${Math.max(...w)} T (the dirty-map scan, the loop, the interpreter's END op)`);
  check('the idle tick overhead is under 2,500 T', Math.max(...w) < 2500);
  const first = st.work.slice(0, 3);
  console.log(`  printing the whole screen at once (768 characters in one tick): that tick ${first[0]} T, the next tick (the other file) ${first[1]} T`);
}

// ---- 4 sprites over a text-filled screen ----
function sprites4(label, posOf, ticks = 40) {
  const walk = [];
  for (let t = 0; t < ticks; t++) walk.push([0, 1, 2, 3].map((i) => { const [x, y] = posOf(t, i); return op.show(i, x, y); }));
  const script = [fill, [], [], ...walk];
  const game = C.scriptGame({ sprites: [{ kind: 'ball' }, { kind: 'box' }, { kind: 'ball' }, { kind: 'box' }], script });
  const st = C.observe(game, ticks + 8, { script: null, checkPicture: false });
  const w = st.work.slice(8, 8 + ticks - 6), e = st.eraseT.slice(8, 8 + ticks - 6), d = st.drawT.slice(8, 8 + ticks - 6), r = st.redrawT.slice(8, 8 + ticks - 6);
  const mx = Math.max(...w);
  console.log(`${label}: tick work avg ${C.avg(w).toFixed(0)}, max ${mx} T (${(100 * mx / FRAME_T).toFixed(1)} % of a refresh);  erase_all ${Math.round(C.avg(e))}, redraw_dirty ${Math.round(C.avg(r))}, draw_all ${Math.round(C.avg(d))} T`);
  return { w, mx, st };
}
const worst = sprites4('4 sprites over a full screen of text, moving every tick, worst alignment (x,y not multiples of 8: 9 cells each)', (t, i) => [3 + ((t * 5 + 60 * i) % 200), 3 + ((t * 3 + 37 * i) % 150)]);
const aligned = sprites4('4 sprites, positions multiples of 8 (4 cells each)', (t, i) => [8 * ((t + 5 * i) % 28), 8 * ((t + 4 * i) % 20)]);
const still = sprites4('4 sprites that stay where they are (the erase and draw still happen every tick)', (t, i) => [30 + 50 * i, 20 + 30 * i]);
check('a tick of 4 sprites over a full screen of text fits in one refresh at frame_div 1, worst alignment', worst.mx < FRAME_T, `max ${worst.mx} T of ${FRAME_T}`);
check('...and leaves room for the game: at least 25 % of the refresh free', worst.mx < 0.75 * FRAME_T, `${(100 * worst.mx / FRAME_T).toFixed(1)} %`);
void aligned; void still;

finish('M3 runtime perf');
