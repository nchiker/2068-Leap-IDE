"use strict";
// sc-runtime-ink.mjs -- the v2 runtime build with classic-scene sprite ink (arcade/tools/build-runtime-v2ink.mjs, -DSPRITE_INK): smoke test on TSRun.
// One 16 x 16 sprite is shown at aligned and shifted positions over a background of known, varied attributes.  Checks (the model is written from the
// table layout in spritecol.asm's header, not from the Z80): the attribute file the machine shows equals the background with the covered cells recoloured,
// (attr AND $F8) OR ink, where the table says so; after the sprite moves or hides the cells are back; with the setter off (or never called) nothing changes;
// the setter's effect on its variables; the memory budget and that the unused scratch bytes of T2_FREE are never written.
//   node arcade/tests/sc-runtime-ink.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntimeInk, assembleGameInk, linkGame, dckOf } from '../tools/build-runtime-v2ink.mjs';
import { RUNTIME_DIR } from '../tools/build-runtime-v2.mjs';
import * as C from './m4-common.mjs';
import { rng } from './m3-scenes.mjs';
const { M, op, newMachine, bootMachine, callRoutine, makeChecks, rd8, rd16, hex, SCRIPT, assetBytes, encodeScript } = C;

const { check, finish } = makeChecks();
const rt = buildRuntimeInk();
const S = rt.syms;
const HERE = dirname(fileURLToPath(import.meta.url));
console.log('Runtime v2 ink build: classic-scene sprite ink\n');

// ---- 1. build facts ----------------------------------------------------------------------------------------------------------
const dflt = JSON.parse(readFileSync(join(HERE, '../dist/v2/runtime.json'), 'utf8'));
check('the ink build exports RT_SPRITEINK and says variant "ink", version 2', S.RT_SPRITEINK > 0 && rt.json.variant === 'ink' && rt.json.version === 2 && dflt.variant === undefined);
check('the default v2 symbols RT_FINEMODE .. are all present in the ink build', Object.keys(dflt.symbols).every((k) => rt.json.symbols[k] !== undefined));
const free = 0x4000 - S.RT_END, freeDefault = 0x4000 - dflt.symbols.RT_END;
console.log(`  RT_END ${hex(S.RT_END, 4)}: ${free} bytes free in the two runtime chunks (default build: RT_END ${hex(dflt.symbols.RT_END, 4)}, ${freeDefault} free; the ink build adds ${freeDefault - free})`);
check('the ink build still fits the 16 KB of DOCK chunks 0-1 (RT_END <= $4000)', free > 0);

// ---- 2. the test game ---------------------------------------------------------------------------------------------------------
const w16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
const R = rng(2468);
const asset = C.randomAsset(R, 16, 16, 8);
const PHASE_TICKS = 12;
const POS = [null, [24, 32], [37, 45], [50, 18], null, [30, 40], [33, 43], [232, 176], [1, 1], [100, 100]];   // null = hidden
// phase 0 paints the background: every row of the screen gets its own ink / paper / bright
const paint = [];
for (let row = 0; row < 24; row++) paint.push(op.ink(row % 8), op.paper((row * 3 + 1) % 8), op.bright(row % 2), op.at(row, 0), op.prints(' '.repeat(32)));
const script = [];
POS.forEach((p, k) => {
  for (let t = 0; t < PHASE_TICKS; t++) {
    const o = [];
    if (k === 0 && t === 0) o.push(...paint);
    if (p) o.push(op.show(0, p[0], p[1])); else o.push(op.hide(0));
    script.push(o);
  }
});
let asmCache = null;
function gameImage() {
  const g = (asmCache ??= assembleGameInk(join(RUNTIME_DIR, 'test_script.asm'), { name: 'script2ink' }));
  const img = linkGame(rt.img, g.bytes);
  const put = (a, bytes) => { img.set(bytes, a); };
  img[0x8004] = 1; img[0x8005] = 1;
  const bytes = assetBytes(asset);
  put(SCRIPT.SPRDATA, bytes);
  put(SCRIPT.SPRTAB, [asset.w, asset.h, ...w16(SCRIPT.SPRDATA), 0, 0, asset.phases, 0]);
  put(SCRIPT.INST, [1, 0]);
  put(0x8006, w16(SCRIPT.SPRTAB));
  put(0x8008, [0, 0, 0, 0, 0, 0, ...w16(SCRIPT.INST)]);
  img.fill(0, SCRIPT.BASE, SCRIPT.END);
  put(SCRIPT.BASE, encodeScript(script));
  return dckOf(img);
}
const dck = gameImage();

// the ink table: a word table at $EA00 (page-aligned), asset 0's 81 bytes after it.  Cell (class, dr, dc): ink or $08 (leave alone).
const TABLE = 0xEA00, GRIDS = 0xEA10;
const gridByte = (cls, dr, dc) => {
  const nc = cls >= 3 ? 3 : 2, nr = cls % 3 ? 3 : 2;            // a 16 x 16 sprite covers 2 columns when aligned (x class 0) else 3, likewise the rows
  if (dc >= nc || dr >= nr) return 0x08;                         // spritecol.asm always reads 3 columns: the columns past the covered ones must be "leave alone"
  return (cls + dr + 2 * dc) % 4 === 3 ? 0x08 : 1 + ((cls * 5 + dr * 3 + dc) % 7);
};
function plantTable(m) {
  m.ram[TABLE] = GRIDS & 0xFF; m.ram[TABLE + 1] = GRIDS >> 8;
  for (let cls = 0; cls < 9; cls++) for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) m.ram[GRIDS + cls * 9 + dr * 3 + dc] = gridByte(cls, dr, dc);
}
const cls3 = (v) => (v === 0 ? 0 : v < 4 ? 1 : 2);
/** The attribute file expected with the sprite at (x, y): the background with the covered cells recoloured. */
function expected(bg, pos) {
  const out = bg.slice();
  if (!pos) return out;
  const [x, y] = pos;
  const cls = 3 * cls3(x & 7) + cls3(y & 7);
  for (let r = y >> 3; r <= (y + 15) >> 3; r++) for (let c = x >> 3; c <= (x + 15) >> 3; c++) {
    const g = gridByte(cls, r - (y >> 3), c - (x >> 3));
    if (!(g & 8)) out[r * 32 + c] = (bg[r * 32 + c] & 0xF8) | g;
  }
  return out;
}

/** Run the game; mode 'on' (setter called), 'off' (called with A = 0) or 'never' (not called).  Returns the shown attribute file at the end of each phase. */
function run(mode) {
  const m = newMachine(dck);
  bootMachine(m, S);
  const poisonAt = [2, ...Array.from({ length: 23 }, (_, k) => 9 + k)];
  poisonAt.forEach((o, k) => { m.ram[S.T2_FREE + o] = 0xA5 ^ k; });
  plantTable(m);
  let setter = null;
  if (mode !== 'never') {
    setter = callRoutine(m, S.RT_SPRITEINK, { a: mode === 'on' ? 0x5A : 0, hl: TABLE + 0x37 });   // any non-zero A is on; L is ignored
  }
  const shots = [];
  const shown = () => m.ram.slice((m.portFF & 1) ? 0x7800 : 0x5800, ((m.portFF & 1) ? 0x7800 : 0x5800) + 768);
  const files = () => [m.ram.slice(0x5800, 0x5800 + 768), m.ram.slice(0x7800, 0x7800 + 768)];
  let phase = 0, ticksSeen = rd16(m, S.V_TICKS);
  const base = ticksSeen;
  for (let f = 0; f < PHASE_TICKS * POS.length * 4 && phase < POS.length; f++) {
    M.runFrame(m);
    const t = rd16(m, S.V_TICKS) - base;
    if (t >= phase * PHASE_TICKS + PHASE_TICKS - 3) { shots.push({ shown: shown(), files: files() }); phase++; }
  }
  const spare = poisonAt.every((o, k) => m.ram[S.T2_FREE + o] === (0xA5 ^ k));
  return { m, shots, setter, spare, on: rd8(m, S.SC_ON), inkh: rd8(m, S.SC_INKH) };
}

// ---- 3. setter on ------------------------------------------------------------------------------------------------------------
const on = run('on');
check('the setter with A = $5A stores SC_ON = 1 and the table page (L ignored)', on.on === 1 && on.inkh === TABLE >> 8);
check('RT_SPRITEINK preserves IX, IY and the alternate registers', on.setter.preserved !== false, JSON.stringify(on.setter.preserved));
check(`all ${POS.length} phases were sampled`, on.shots.length === POS.length, String(on.shots.length));
const bg = on.shots[0].shown;
check('phase 0 (nothing shown): the background has a varied attribute file', new Set(bg).size > 8, `${new Set(bg).size} distinct attributes`);
on.shots.forEach((s, k) => {
  const p = POS[k];
  const label = p ? `sprite at (${p[0]}, ${p[1]}) [x class ${cls3(p[0] & 7)}, y class ${cls3(p[1] & 7)}]` : (k === 0 ? 'nothing shown' : 'sprite hidden again');
  const exp = expected(bg, p);
  let diff = 0, first = '';
  for (let i = 0; i < 768; i++) if (s.shown[i] !== exp[i]) { diff++; first ||= `cell ${i} (row ${i >> 5}, col ${i & 31}): ${hex(s.shown[i], 2)} expected ${hex(exp[i], 2)}`; }
  check(`phase ${k}, ${label}: attribute file = background with the covered cells recoloured, restored elsewhere`, diff === 0, diff ? `${diff} cells differ, first ${first}` : '');
  if (p && k > 0) {
    const recoloured = exp.filter((v, i) => v !== bg[i]).length;
    check(`phase ${k}: some cells did change (${recoloured}), and both display files agree`, recoloured > 0 && s.files[0].every((v, i) => v === s.files[1][i]));
  }
});
// moved: the old position's cells are back (phase 5 -> 6 moved by 3 pixels)
{
  const old = expected(bg, POS[5]), now = on.shots[6].shown;
  const back = old.map((v, i) => (v !== bg[i] && expected(bg, POS[6])[i] === bg[i] ? i : -1)).filter((i) => i >= 0);
  check(`moving (30,40) -> (33,43): the ${back.length} cells only the old position covered are back to the background`, back.length > 0 && back.every((i) => now[i] === bg[i]));
}
check('the unused scratch bytes of T2_FREE were never written (setter on)', on.spare);

// ---- 4. setter off / never called -------------------------------------------------------------------------------------------
for (const mode of ['off', 'never']) {
  const r = run(mode);
  const same = r.shots.every((s) => s.shown.every((v, i) => v === r.shots[0].shown[i]));
  check(`setter ${mode}: ${r.shots.length} phases, the attribute file never changes with the sprite (the sprite writes no attributes)`, r.shots.length === POS.length && same);
  check(`setter ${mode}: SC_ON is ${mode === 'off' ? 'written 0' : 'cleared by the boot'}, scratch untouched`, r.on === 0 && r.spare, `SC_ON ${r.on}`);
}

// ---- 5. the same picture as the default build (bitmap) ----------------------------------------------------------------------
console.log(`\nMemory: RT_END ${hex(S.RT_END, 4)}, ${free} bytes free after RT_END; spritecol module ${rt.usage.mods.find((m) => m.name === 'sc').size} bytes; T2_FREE bytes used: +0, +1, +3..+8 (SC_ON, SC_INKH, SC_SH, SC_A16, SC_H, SC_T, SC_NR, SC_N)`);
finish('sc-runtime-ink');
