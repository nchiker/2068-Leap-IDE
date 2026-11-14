"use strict";
// m3-runtime-text.mjs -- M3 runtime test, part 2: every text, tile and collision routine of runtime v1 called DIRECTLY on the booted machine
// (the main loop parked at its wait), its effect on the cell map, the cursor, the text attribute and the dirty maps compared with the
// JavaScript model after EVERY call; then the frame loop runs and both display files are compared with the model's rendering.
// RT_HIT is compared with a JavaScript box test over thousands of position pairs and several hot-box tables.
//   node arcade/tests/m3-runtime-text.mjs
import * as C from './m3-common.mjs';
import { rng, randomTiles } from './m3-scenes.mjs';
const { M, Z, hex, makeChecks, rd8, rd16, Model, int16 } = C;

const { check, finish } = makeChecks();
const rt = C.runtime();
const S = rt.syms;
console.log('M3 runtime text / tiles / collision: direct calls vs the JavaScript model\n');

/** Boot a game and park the main loop at its wait (TICK_LOOP) so a routine can be called from outside. */
function park(game, video = false) {
  const m = C.newMachine(game.dck, { video });
  C.bootMachine(m, S);
  for (let f = 0; f < 8; f++) M.runFrame(m);
  settle(m);
  return m;
}
function settle(m) {
  for (let i = 0; i < 400000; i++) {
    if (m.cpu.pc === S.TICK_LOOP && !m.cpu.halted) return;
    Z.runZ80(m.cpu, m.bus, 1, m);
  }
  throw new Error('main loop did not reach its wait');
}
function runFramesSettled(m, n) {
  for (let f = 0; f < n; f++) M.runFrame(m);
  for (let f = 0; f < 120 && !(allZero(S.DIRTY0, 96) && allZero(S.DIRTY1, 96)); f++) M.runFrame(m);   // until both files have drawn everything
  settle(m);
}

const TILES = randomTiles(rng(301), 12);
const spec = { div: 1, sprites: [{ kind: 'ball' }, { kind: 'box' }, { kind: 'ball', hot: [2, 3, 12, 10] }, { kind: 'box', hot: [0, 0, 0, 5] }], tiles: TILES, script: [] };
const game = C.scriptGame(spec);
const m = park(game, true);                                    // the main machine's screen is read (shownColours)
const model = new Model(spec);
let pres = true, spOk = true, calls = 0;
let dirtyExp = new Uint8Array(96);                       // expected dirty bits (never consumed while the machine is parked)

function call(addr, regs, apply) {
  const before = { tile: model.tile.slice(), attr: model.attr.slice() };
  const t0 = m.tstates;
  const r = C.callRoutine(m, addr, regs);
  m.tstates = t0;                                        // a direct call takes no machine time (the frame clock stays where it was)
  apply?.();
  pres &&= r.preserved; spOk &&= r.spOk; calls++;
  for (let i = 0; i < 768; i++) if (model.tile[i] !== before.tile[i] || model.attr[i] !== before.attr[i]) dirtyExp[i >> 3] |= 1 << (i & 7);
  return r;
}
function stateBad() {
  const bad = [];
  for (let i = 0; i < 768; i++) {
    if (rd8(m, S.CELL_TILE + i) !== model.tile[i]) bad.push(['tile', i, rd8(m, S.CELL_TILE + i), model.tile[i]]);
    if (rd8(m, S.CELL_ATTR + i) !== model.attr[i]) bad.push(['attr', i, rd8(m, S.CELL_ATTR + i), model.attr[i]]);
    if (bad.length > 2) break;
  }
  if (rd8(m, S.V_CUR_ROW) !== model.row || rd8(m, S.V_CUR_COL) !== model.col) bad.push(['cursor', rd8(m, S.V_CUR_ROW), rd8(m, S.V_CUR_COL), model.row, model.col]);
  if (rd8(m, S.V_TEXT_ATTR) !== model.textAttr) bad.push(['textAttr', rd8(m, S.V_TEXT_ATTR), model.textAttr]);
  for (let i = 0; i < 96; i++) if (rd8(m, S.DIRTY0 + i) !== dirtyExp[i] || rd8(m, S.DIRTY1 + i) !== dirtyExp[i]) { bad.push(['dirty', i, rd8(m, S.DIRTY0 + i), rd8(m, S.DIRTY1 + i), dirtyExp[i]]); break; }
  return bad;
}
const R = rng(2024);
const STR = 0xE800;                                      // a string buffer in the compiled-variable area (the test game does not use it)
const putStr = (codes) => { m.ram[STR] = codes.length; codes.forEach((c, k) => { m.ram[STR + 1 + k] = c; }); };

// ---- the dirty maps start empty (the machine was parked after the idle ticks) ----
check('start: the dirty maps are empty and the cursor is at 0,0', stateBad().length === 0);

// ---- RT_AT ----
{
  let bad = 0, first = null;
  for (const b of [0, 1, 5, 22, 23, 24, 25, 100, 255]) for (const c of [0, 1, 17, 30, 31, 32, 33, 128, 255]) {
    call(S.RT_AT, { bc: (b << 8) | c }, () => model.apply(C.op.at(b, c)));
    if (rd8(m, S.V_CUR_ROW) !== Math.min(b, 23) || rd8(m, S.V_CUR_COL) !== Math.min(c, 31)) { bad++; first ??= { b, c }; }
  }
  check('RT_AT: row and column are clamped to 23 / 31 (81 combinations incl. 24, 32, 255)', bad === 0, first ? JSON.stringify(first) : '');
}

// ---- RT_INK / RT_PAPER / RT_BRIGHT ----
{
  let bad = 0;
  for (let a = 0; a < 256; a++) {
    for (const [name, addr] of [['ink', S.RT_INK], ['paper', S.RT_PAPER], ['bright', S.RT_BRIGHT]]) {
      call(addr, { a }, () => model.apply(C.op[name](a)));
      if (rd8(m, S.V_TEXT_ATTR) !== model.textAttr) bad++;
    }
  }
  check('RT_INK / RT_PAPER / RT_BRIGHT for A = 0..255 (ink and paper AND 7, bright = bit 0): the attribute byte equals the model, other bits kept', bad === 0, `${bad} wrong`);
  call(S.RT_INK, { a: 3 }, () => model.apply(C.op.ink(3))); call(S.RT_PAPER, { a: 5 }, () => model.apply(C.op.paper(5))); call(S.RT_BRIGHT, { a: 1 }, () => model.apply(C.op.bright(1)));
  check('ink 3, paper 5, bright 1 = %01101011 ($6B)', rd8(m, S.V_TEXT_ATTR) === 0x6B, hex(rd8(m, S.V_TEXT_ATTR), 2));
}

// ---- RT_PRINTC: every code, with wrapping ----
{
  let bad = 0;
  call(S.RT_AT, { bc: 0 }, () => model.apply(C.op.at(0, 0)));
  for (let c = 0; c < 256; c++) {
    if (c % 5 === 0) { call(S.RT_PAPER, { a: c % 8 }, () => model.apply(C.op.paper(c % 8))); call(S.RT_INK, { a: (c >> 3) % 8 }, () => model.apply(C.op.ink((c >> 3) % 8))); }
    call(S.RT_PRINTC, { a: c }, () => model.apply(C.op.printc(c)));
    if (stateBad().length) { bad++; break; }
  }
  check('RT_PRINTC: all 256 codes (>= 128 print as AND $7F, 0..31 blank) with the current attribute; 256 characters wrap rows and row 24 wraps to row 0', bad === 0);
  call(S.RT_AT, { bc: (23 << 8) | 31 }, () => model.apply(C.op.at(23, 31)));
  call(S.RT_PRINTC, { a: 65 }, () => model.apply(C.op.printc(65)));
  check('printing in the last cell (23,31) wraps the cursor to 0,0 (no scrolling)', rd8(m, S.V_CUR_ROW) === 0 && rd8(m, S.V_CUR_COL) === 0 && stateBad().length === 0);
  call(S.RT_AT, { bc: (4 << 8) | 31 }, () => model.apply(C.op.at(4, 31)));
  call(S.RT_PRINTC, { a: 66 }, () => model.apply(C.op.printc(66)));
  check('printing in column 31 moves to column 0 of the next row', rd8(m, S.V_CUR_ROW) === 5 && rd8(m, S.V_CUR_COL) === 0);
}

// ---- RT_PRINTS ----
{
  let bad = 0, first = null;
  for (let t = 0; t < 400; t++) {
    const len = t < 45 ? t : R.int(0, 40);
    const codes = Array.from({ length: len }, () => R.int(0, 255));
    putStr(codes);
    call(S.RT_AT, { bc: (R.int(0, 23) << 8) | R.int(0, 31) }, null);
    // keep the model in step with the AT just called (row/col read back from the machine)
    model.row = rd8(m, S.V_CUR_ROW); model.col = rd8(m, S.V_CUR_COL);
    if (R.chance(0.3)) { const a = R.int(0, 7); call(S.RT_PAPER, { a }, () => model.apply(C.op.paper(a))); const k = R.int(0, 7); call(S.RT_INK, { a: k }, () => model.apply(C.op.ink(k))); }
    call(S.RT_PRINTS, { hl: STR }, () => model.apply(C.op.prints(codes.length > 31 ? codes.slice(0, 31) : codes)));
    const b = stateBad();
    if (b.length) { bad++; first ??= { t, len, b: b[0] }; }
  }
  check('RT_PRINTS: 400 strings of length 0..40 (above 31 is read as 31) at random cursors, random codes: cells, attributes, cursor, dirty bits all equal the model', bad === 0, first ? JSON.stringify(first) : '');
}

// ---- RT_PRINTN ----
{
  const values = [-32768, -32767, -1, 0, 1, 9, 10, 11, 99, 100, 101, 999, 1000, 1001, 9999, 10000, 10001, 32767, 32766, -10, -100, -1000, -10000, -9999, 20000, 30000, -30000];
  for (let i = 0; i < 1500; i++) values.push(R.int(-32768, 32767));
  let bad = 0, first = null;
  for (const v of values) {
    call(S.RT_AT, { bc: (R.int(0, 23) << 8) | R.int(0, 12) }, null);
    model.row = rd8(m, S.V_CUR_ROW); model.col = rd8(m, S.V_CUR_COL);
    call(S.RT_PRINTN, { hl: v & 0xFFFF }, () => model.apply(C.op.printn(v)));
    const b = stateBad();
    if (b.length) { bad++; first ??= { v, b: b[0] }; }
  }
  check(`RT_PRINTN: ${values.length} values incl. -32768, 0, 9, 10, 99, 100, 999, 1000, 9999, 10000, 32767 and random: decimal digits, '-', no padding, cursor`, bad === 0, first ? JSON.stringify(first) : '');
  call(S.RT_AT, { bc: 0 }, () => model.apply(C.op.at(0, 0)));
  call(S.RT_CLS, {}, () => model.apply(C.op.cls()));
  call(S.RT_PRINTN, { hl: 0x8000 }, () => model.apply(C.op.printn(-32768)));
  const s = Array.from({ length: 6 }, (_, i) => String.fromCharCode(rd8(m, S.CELL_TILE + i))).join('');
  check('RT_PRINTN(-32768) prints "-32768" in cells 0..5 and the cursor is at 0,6', s === '-32768' && rd8(m, S.V_CUR_COL) === 6, JSON.stringify(s));
}

// ---- RT_TILE / RT_TILEAT ----
{
  let bad = 0, first = null;
  for (let t = 0; t < 3000; t++) {
    const tile = t < 300 ? t % 256 : R.int(0, 255);
    const row = R.chance(0.1) ? R.int(24, 255) : R.int(0, 23), col = R.chance(0.1) ? R.int(32, 255) : R.int(0, 31);
    call(S.RT_TILE, { a: tile, bc: (row << 8) | col }, () => model.apply(C.op.tile(tile, row, col)));
    const b = stateBad();
    if (b.length) { bad++; first ??= { tile, row, col, b: b[0] }; }
    if (bad) break;
  }
  check('RT_TILE: 3000 sets (tile 0..255 AND $7F, rows to 255, columns to 255; out of range ignored): cell value, tile attribute, dirty bits equal the model', bad === 0, first ? JSON.stringify(first) : '');
  let bad2 = 0, first2 = null;
  for (let row = 0; row < 26; row++) for (let col = 0; col < 34; col++) {
    const r = call(S.RT_TILEAT, { bc: (row << 8) | col }, null);
    const want = model.tileAt(row, col) & 0xFFFF;
    if (r.hl !== want) { bad2++; first2 ??= { row, col, got: r.hl, want }; }
  }
  check('RT_TILEAT: 26 x 34 reads (incl. out of range and font cells): the tile index, or -1 ($FFFF)', bad2 === 0, first2 ? JSON.stringify(first2) : '');
  // identical set: no dirty
  const t0 = model.tileAt(7, 7);
  call(S.RT_TILE, { a: 3, bc: (7 << 8) | 7 }, () => model.apply(C.op.tile(3, 7, 7)));
  runFramesSettled(m, 8); dirtyExp = new Uint8Array(96);           // the loop draws everything in both files and clears the dirty bits
  call(S.RT_TILE, { a: 3, bc: (7 << 8) | 7 }, () => model.apply(C.op.tile(3, 7, 7)));
  check('setting a cell to what it already holds marks nothing dirty', allZero(S.DIRTY0, 96) && allZero(S.DIRTY1, 96), `${Array.from(m.ram.slice(S.DIRTY0, S.DIRTY0 + 96)).findIndex((v) => v)}`);
  void t0;
}
function allZero(a, n) { for (let i = 0; i < n; i++) if (m.ram[a + i] !== 0) return false; return true; }

// ---- RT_CLS ----
{
  let bad = 0;
  for (const paper of [0, 3, 7, 5]) for (const ink of [0, 6]) for (const br of [0, 1]) {
    call(S.RT_PAPER, { a: paper }, () => model.apply(C.op.paper(paper))); call(S.RT_INK, { a: ink }, () => model.apply(C.op.ink(ink))); call(S.RT_BRIGHT, { a: br }, () => model.apply(C.op.bright(br)));
    call(S.RT_PRINTS, { hl: (putStr([72, 73]), STR) }, () => model.apply(C.op.prints([72, 73])));
    call(S.RT_CLS, {}, () => model.apply(C.op.cls()));
    if (stateBad().length || rd8(m, S.CELL_ATTR) !== ((paper << 3) & 0x38) || rd8(m, S.CELL_TILE + 767) !== 32 || rd8(m, S.V_CUR_ROW) || rd8(m, S.V_CUR_COL)) bad++;
  }
  check('RT_CLS: all cells = space with attribute = the text attribute\'s paper (ink 0, no bright), cursor 0,0; 16 combinations incl. tiles on screen', bad === 0, `${bad} wrong`);
  runFramesSettled(m, 14); dirtyExp = new Uint8Array(96);
  call(S.RT_CLS, {}, () => model.apply(C.op.cls()));
  check('RT_CLS on an already clear screen marks nothing dirty (no redraw)', allZero(S.DIRTY0, 96) && allZero(S.DIRTY1, 96));
}

check(`all ${calls} calls: IX, IY and the alternate set preserved, SP back to its value`, pres && spOk);

// ---- the frame loop draws what the model says ----
{
  // a fresh scene of mixed text and tiles via direct calls, then let the loop run and compare both display files
  call(S.RT_CLS, {}, () => model.apply(C.op.cls()));
  for (let t = 0; t < 600; t++) {
    const k = R.int(0, 3);
    if (k === 0) { const row = R.int(0, 23), col = R.int(0, 31); call(S.RT_TILE, { a: R.int(0, 11), bc: (row << 8) | col }, null); const tt = rd8(m, S.CELL_TILE + row * 32 + col) & 0x7F; model.tileSet(tt, row, col); }
    else { const cs = Array.from({ length: R.int(1, 20) }, () => R.int(32, 126)); putStr(cs); const row = R.int(0, 23), col = R.int(0, 31); call(S.RT_AT, { bc: (row << 8) | col }, () => model.apply(C.op.at(row, col))); const pa = R.int(0, 7); call(S.RT_PAPER, { a: pa }, () => model.apply(C.op.paper(pa))); call(S.RT_PRINTS, { hl: STR }, () => model.apply(C.op.prints(cs))); }
  }
  check('the cell map still equals the model after 600 mixed calls', stateBad().length === 0);
  runFramesSettled(m, 14);
  const exp = model.render(null);
  const d0 = C.dfileOf(m, 0), d1 = C.dfileOf(m, 1);
  const e0 = C.diffCount(d0.bitmap, exp.bitmap) + C.diffCount(d0.attrs, exp.attrs), e1 = C.diffCount(d1.bitmap, exp.bitmap) + C.diffCount(d1.attrs, exp.attrs);
  check('after the loop has run: BOTH display files equal the rendering of the cell map (font glyphs and tiles, bitmap and attributes)', e0 === 0 && e1 === 0, `file 1 ${e0} bytes off, file 2 ${e1}`);
  check('...and both dirty maps are empty again', allZero(S.DIRTY0, 96) && allZero(S.DIRTY1, 96));
  const px = C.shownColours(m);
  const dispBit = m.portFF & 1;
  check('...and the screen shows it (colours)', px !== null && C.diffCount(px, C.colourPlane(dispBit ? d1 : d0)) === 0);
  dirtyExp = new Uint8Array(96);
}

// ---- RT_HIT ----
console.log('\nRT_HIT');
{
  const tables = [
    { name: 'default + hot (2,3,12,10) + empty width', sprites: [{ kind: 'ball' }, { kind: 'box' }, { kind: 'ball', hot: [2, 3, 12, 10] }, { kind: 'box', hot: [0, 0, 0, 5] }] },
    { name: 'big offsets, zero height, 1x1, thin', sprites: [{ kind: 'ball', hot: [255, 255, 255, 255] }, { kind: 'box', hot: [0, 0, 16, 0] }, { kind: 'ball', hot: [1, 1, 1, 1] }, { kind: 'box', hot: [7, 0, 1, 16] }] },
    { name: 'three sprites only (index 3 does not exist)', sprites: [{ kind: 'ball', hot: [4, 4, 8, 8] }, { kind: 'box' }, { kind: 'box', hot: [0, 6, 16, 6] }] },
  ];
  let total = 0, bad = 0, first = null, hits = 0, touching = 0, pres2 = true;
  for (const tb of tables) {
    const g = C.scriptGame({ sprites: tb.sprites, script: [] });
    const mm = park(g);
    const md = new Model({ sprites: tb.sprites });
    const n = tb.sprites.length;
    for (let t = 0; t < 4000; t++) {
      // random state of all sprites; a and b close to each other half of the time so the borders are exercised
      for (let i = 0; i < n; i++) {
        const s = md.sprites[i];
        s.visible = R.chance(0.9);
        s.x = R.int(0, 239); s.y = R.int(0, 176);
      }
      const a = R.int(0, 5), b = R.int(0, 5);
      if (a < n && b < n && R.chance(0.6)) {
        const A = md.sprites[a], B = md.sprites[b];
        const near = (v, hi) => clamp(v + R.int(-18, 18), hi);
        B.x = near(A.x, 239); B.y = near(A.y, 176);
        if (R.chance(0.3)) { const ba = md.box(a); if (ba) { B.x = clamp(ba.x1 - md.sprites[b].hot[0] + R.int(-1, 1), 239); } }
      }
      for (let i = 0; i < 4; i++) {
        const s = md.sprites[i] ?? { visible: false, x: 0, y: 0 }, e = S.SPR_TAB + i * 6;
        mm.ram[e] = s.visible ? 1 : 0; mm.ram[e + 1] = 0;
        mm.ram[e + 2] = s.x & 255; mm.ram[e + 3] = s.x >> 8; mm.ram[e + 4] = s.y & 255; mm.ram[e + 5] = s.y >> 8;
      }
      const t0 = mm.tstates;
      const r = C.callRoutine(mm, S.RT_HIT, { a, de: b });
      mm.tstates = t0;
      pres2 &&= r.preserved && r.spOk;
      const want = a < n && b < n ? md.hit(a, b) : 0;
      total++;
      if (want) hits++;
      if (a < n && b < n) { const A = md.box(a), B = md.box(b); if (A && B && (A.x0 === B.x1 || B.x0 === A.x1 || A.y0 === B.y1 || B.y0 === A.y1)) touching++; }
      if (r.hl !== want) { bad++; first ??= { table: tb.name, a, b, A: md.sprites[a], B: md.sprites[b], got: r.hl, want }; }
    }
  }
  check(`RT_HIT equals the JavaScript box test in ${total} random pairs (3 hot-box tables; hidden, nonexistent and empty boxes included)`, bad === 0, first ? JSON.stringify(first) : `${hits} hits, ${total - hits} misses`);
  check('...the sample includes many hits and many edge-touching pairs (touching boxes do not hit)', hits > 800 && touching > 100, `${hits} hits, ${touching} touching`);
  check('RT_HIT preserves IX, IY and the alternates and leaves SP unchanged', pres2);
}
function clamp(v, hi) { return v < 0 ? 0 : v > hi ? hi : v; }

void int16; void rd16;
finish('M3 runtime text');
