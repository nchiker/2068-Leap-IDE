#!/usr/bin/env node
"use strict";
// music-stream.mjs -- the song encoder (convertMusic, convertPattern) and the channel-C effect encoder (convertSfxC) of arcade-assets.js
// (docs/ARCADE_MUSIC_CONTRACT.md sections 3 and 4) against an INDEPENDENT model: the expected chip registers per refresh are computed here from the
// records (not with sfxRefreshRegisters), the images are decoded by a player written from the contract's rules (waits, $FF, the order list, the loop).
//   node tests/music-stream.mjs [songs (default 3000)]
import { convertMusic, convertPattern, convertSfxC, MAX_PATTERNS, MAX_ORDER, MAX_PATTERN_TICKS, MUSIC_NO_LOOP, SFX_TYPE_C } from '../src/lang/arcade/arcade-assets.js';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else { fail++; console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`); } };
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

// ---- a seeded generator --------------------------------------------------------------------------------------------------
let seed = 20261112;
const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (a) => a[int(0, a.length - 1)];

// ---- the expected registers, from the records ---------------------------------------------------------------------------
const SILENT = { tone: 0, vol: 0, noise: 0, mix: 7 };
function expectRegs(pattern) {
  const ch = [pattern.ticks ?? [], pattern.ticksB ?? [], pattern.ticksC ?? []];
  const L = Math.max(...ch.map((c) => c.length));
  const out = [];
  for (let r = 0; r < L; r++) {
    const rec = ch.map((c) => ({ ...SILENT, ...(r < c.length ? c[r] : SILENT) }));
    const R = new Array(11).fill(0);
    let noise = null;
    rec.forEach((t, c) => {
      R[2 * c] = t.tone % 256; R[2 * c + 1] = Math.floor(t.tone / 256); R[8 + c] = t.vol;
      if (t.mix & 1) R[7] += 1 << c;
      if (t.mix & 2) R[7] += 8 << c; else if (noise === null) noise = t.noise;
    });
    R[6] = noise ?? rec[0].noise;
    out.push(R);
  }
  return out;
}

// ---- the independent player: lays the song out, then plays refresh by refresh -------------------------------------------------
/** -> the chip register arrays of `n` refreshes (null once the song has ended), as the runtime would leave them. */
function playSong(c, n) {
  // layout: song at 0: loop, order pointers, 0; patterns after it (each at its own address)
  const mem = [], at = [];
  let a = 1 + 2 * (c.order.length + 1);
  c.patterns.forEach((p) => { at.push(a); a += p.bytes.length; });
  mem.push(c.loop);
  c.order.forEach((p) => mem.push(at[p] & 255, at[p] >> 8));
  mem.push(0, 0);
  c.patterns.forEach((p) => mem.push(...p.bytes));
  const word = (x) => mem[x] | (mem[x + 1] << 8);
  const chip = new Array(11).fill(0);
  let ord = 1, ptr = word(1), wait = 0, on = true;
  const out = [];
  for (let r = 0; r < n; r++) {
    if (!on) { out.push(null); continue; }
    if (wait > 0) { wait--; out.push(chip.slice()); continue; }
    for (;;) {
      const b = mem[ptr++];
      if (b === 0xFF) {                                      // the end of a pattern: the next order entry, in the same refresh
        ord += 2;
        let p = word(ord);
        if (p === 0) {
          if (mem[0] === MUSIC_NO_LOOP) { on = false; break; }
          ord = 1 + 2 * mem[0]; p = word(ord);
        }
        ptr = p;
        continue;
      }
      if (b >= 0x80) { wait = b - 0x80; break; }            // this refresh and b - $80 more with no change
      let last = -1;
      for (let k = 0; k < b; k++) {
        const reg = mem[ptr++], v = mem[ptr++];
        if (reg <= last || reg > 10) throw new Error(`pairs not ascending / bad register ${reg}`);
        last = reg; chip[reg] = v;
      }
      break;
    }
    out.push(on ? chip.slice() : null);
  }
  return out;
}

/** The expected registers of `n` refreshes straight from the asset (the order, then the loop, or null after the end). */
function expectSong(asset, n) {
  const per = asset.patterns.map(expectRegs), out = [];
  let pos = 0, i = 0;
  while (out.length < n) {
    if (pos >= asset.order.length) {
      if (asset.loop === null || asset.loop === undefined) { while (out.length < n) out.push(null); break; }
      pos = asset.loop;
    }
    const regs = per[asset.order[pos]];
    out.push(regs[i]);
    if (++i >= regs.length) { i = 0; pos++; }
  }
  return out;
}

// ---- random assets ------------------------------------------------------------------------------------------------------
function randTrack(len, still = false) {
  const t = [];
  let cur = { tone: int(1, 3000), vol: int(0, 15), noise: int(0, 31), mix: pick([0, 1, 2, 3, 4, 6, 7]) };
  for (let i = 0; i < len; i++) {
    if (!still && rnd() < pick([0.05, 0.3, 0.9])) cur = { tone: rnd() < 0.5 ? cur.tone : int(1, 4095), vol: rnd() < 0.5 ? cur.vol : int(0, 15), noise: rnd() < 0.7 ? cur.noise : int(0, 31), mix: rnd() < 0.8 ? cur.mix : pick([0, 1, 2, 3, 4, 6, 7]) };
    if (cur.vol === 15 && cur.tone >= 3840) cur = { ...cur, vol: 14 };
    t.push({ ...cur });
  }
  return t;
}
function randPattern() {
  const L = pick([1, 2, 5, 16, 48, 130, 300, int(1, 600)]);
  const still = rnd() < 0.1;                                        // held notes: long waits
  const p = { ticks: randTrack(rnd() < 0.1 ? int(0, L) : L, still) };
  if (rnd() < 0.85) p.ticksB = randTrack(rnd() < 0.3 ? int(0, L) : L, still);
  if (rnd() < 0.85) p.ticksC = randTrack(rnd() < 0.3 ? int(0, L) : L, still);
  if (!p.ticks.length && !(p.ticksB?.length) && !(p.ticksC?.length)) p.ticks = randTrack(1);
  return p;
}
function randSong() {
  const np = int(1, rnd() < 0.05 ? MAX_PATTERNS : 6), patterns = Array.from({ length: np }, randPattern);
  const order = Array.from({ length: int(1, rnd() < 0.05 ? MAX_ORDER : 10) }, () => int(0, np - 1));
  return { patterns, order, loop: rnd() < 0.3 ? null : int(0, order.length - 1) };
}

// ---- 1. random songs: the image plays exactly the expected registers ---------------------------------------------------------
const N = Number(process.argv[2] ?? 3000);
let bad = 0, firstBad = '', items = 0, waits = 0, maxWait = 0, refreshTotal = 0;
for (let s = 0; s < N; s++) {
  const asset = randSong(), c = convertMusic(asset);
  const total = c.refreshes, n = total + (asset.loop === null ? 40 : int(1, 2 * total));
  const got = playSong(c, n), exp = expectSong(asset, n);
  refreshTotal += n;
  for (let r = 0; r < n; r++) {
    const g = got[r], e = exp[r];
    if ((g === null) !== (e === null) || (g && g.join() !== e.join())) { bad++; firstBad ||= `song ${s}, refresh ${r}: got ${g} expected ${e}`; break; }
  }
  // the form of each pattern's stream
  c.patterns.forEach((p, i) => {
    const b = p.bytes;
    if (b[0] !== 11 || b[b.length - 1] !== 0xFF) { bad++; firstBad ||= `song ${s} pattern ${i}: does not start with 11 pairs or end with $FF`; }
    for (let k = 0; k < b.length - 1;) { const x = b[k]; items++; if (x >= 0x80) { waits++; maxWait = Math.max(maxWait, x - 0x7F); k++; } else k += 1 + 2 * x; }
    if (p.refreshes !== Math.max(asset.patterns[i].ticks?.length ?? 0, asset.patterns[i].ticksB?.length ?? 0, asset.patterns[i].ticksC?.length ?? 0)) { bad++; firstBad ||= `song ${s} pattern ${i}: refreshes ${p.refreshes}`; }
  });
  const size = 1 + 2 * (asset.order.length + 1) + c.patterns.reduce((x, p) => x + p.bytes.length, 0);
  if (c.bytes !== size) { bad++; firstBad ||= `song ${s}: bytes ${c.bytes} expected ${size}`; }
}
check(`${N} random songs (1-32 patterns, 1-64 order entries, loops and ends): the image played by the independent player gives the expected registers on every refresh (${refreshTotal} refreshes)`,
  bad === 0, firstBad);
check(`waits used and bounded: ${waits} wait items of ${items}, the longest ${maxWait} refreshes (<= 127)`, waits > 0 && maxWait === 127);

// ---- 2. hand cases ------------------------------------------------------------------------------------------------------
{
  const held = { ticks: Array.from({ length: 300 }, () => ({ tone: 500, vol: 10, noise: 0, mix: 6 })) };
  const p = convertPattern(held);
  check('a note held for 300 refreshes: 11 pairs, then waits of 127, 127, 45 (one byte each), then $FF: 27 bytes',
    p.bytes.length === 27 && p.bytes[23] === 0xFE && p.bytes[24] === 0xFE && p.bytes[25] === 0x80 + 44 && p.bytes[26] === 0xFF, [...p.bytes.slice(23)].join(','));
  const one = convertPattern({ ticks: [{ tone: 1, vol: 1, noise: 0, mix: 6 }] });
  check('a one-refresh pattern: 11 pairs and $FF (24 bytes)', one.bytes.length === 24 && one.refreshes === 1);
  const c = convertMusic({ patterns: [held], order: [0, 0, 0], loop: null });
  check('a pattern used three times is stored once: 1 + 2 x 4 + 27 bytes', c.bytes === 36 && c.loop === MUSIC_NO_LOOP);
  const two = convertMusic({ patterns: [held, { ticks: [{ tone: 9, vol: 3, mix: 6 }] }], order: [1, 0], loop: 1 });
  const g = playSong(two, 1 + 300 + 300 + 5), e = expectSong({ patterns: [held, { ticks: [{ tone: 9, vol: 3, mix: 6 }] }], order: [1, 0], loop: 1 }, 606);
  check('a loop to order position 1 repeats only that pattern', g.every((x, i) => x.join() === e[i].join()) && g[605].join() === g[301].join());
}

// ---- 3. limits and messages ---------------------------------------------------------------------------------------------
{
  const p = { ticks: [{ tone: 100, vol: 5, mix: 6 }] };
  check('no patterns', throws(() => convertMusic({ patterns: [], order: [0] }), /no "patterns"/));
  check(`more than ${MAX_PATTERNS} patterns`, throws(() => convertMusic({ patterns: Array(MAX_PATTERNS + 1).fill(p), order: [0] }), /at most 32/));
  check('an empty order list', throws(() => convertMusic({ patterns: [p], order: [] }), /empty "order"/));
  check(`more than ${MAX_ORDER} order entries`, throws(() => convertMusic({ patterns: [p], order: Array(MAX_ORDER + 1).fill(0) }), /at most 64/));
  check('an order entry past the patterns', throws(() => convertMusic({ patterns: [p], order: [0, 1] }), /order entry 1 is 1: a pattern index 0..0/));
  check('a loop outside the order list', throws(() => convertMusic({ patterns: [p], order: [0], loop: 1 }), /loop is 1/));
  check('an empty pattern', throws(() => convertMusic({ patterns: [{ ticks: [] }], order: [0] }), /pattern 0 is empty/));
  check(`a pattern longer than ${MAX_PATTERN_TICKS}`, throws(() => convertPattern({ ticks: Array(MAX_PATTERN_TICKS + 1).fill(p.ticks[0]) }), /at most 1800/));
  check('an unstorable record names its pattern', throws(() => convertMusic({ patterns: [p, { ticks: [{ tone: 4000, vol: 15 }] }], order: [1] }), /pattern 1: channel A tick 0: tone 4000 with volume 15/));
  check('ticks as a non-array', throws(() => convertMusic({ patterns: [{ ticks: 3 }], order: [0] }), /pattern 0/));
}

// ---- 4. channel-C effects ------------------------------------------------------------------------------------------------
{
  let cbad = 0, cfirst = '';
  for (let s = 0; s < 1000; s++) {
    const ticks = randTrack(int(0, 120)), c = convertSfxC({ ticks }), b = c.bytes;
    const noise = ticks.some((t) => (t.mix & 2) === 0) ? 1 : 0;
    if (b[0] || b[1] || b[2] !== noise || b[3] !== SFX_TYPE_C || b[b.length - 1] !== 0xFF) { cbad++; cfirst ||= `effect ${s}: header ${[...b.slice(0, 4)]}`; continue; }
    const regs = new Map();
    let k = 4;
    for (let r = 0; r < ticks.length; r++) {
      const n = b[k++];
      let last = -1;
      for (let j = 0; j < n; j++) {
        const reg = b[k++], v = b[k++];
        if (reg <= last || ![4, 5, 6, 7, 10].includes(reg) || (reg === 6 && !noise) || (reg === 7 && (v & ~0x24))) { cbad++; cfirst ||= `effect ${s} refresh ${r}: pair ${reg},${v}`; }
        last = reg; regs.set(reg, v);
      }
      if (r === 0 && n !== (noise ? 5 : 4)) { cbad++; cfirst ||= `effect ${s}: the first entry has ${n} pairs`; }
      const t = ticks[r], want = [[4, t.tone % 256], [5, t.tone >> 8], [7, ((t.mix & 1) << 2) | ((t.mix & 2) << 4)], [10, t.vol], ...(noise ? [[6, t.noise]] : [])];
      for (const [reg, v] of want) if (regs.get(reg) !== v) { cbad++; cfirst ||= `effect ${s} refresh ${r}: R${reg} = ${regs.get(reg)}, expected ${v}`; break; }
    }
    if (k !== b.length - 1) { cbad++; cfirst ||= `effect ${s}: ${b.length - 1 - k} bytes left over`; }
  }
  check('1,000 random one-channel effects as channel-C streams: header 0, 0, noise, 4; every refresh gives tone C, volume C, R7 bits 2 / 5 (nothing else) and R6 only with noise; $FF', cbad === 0, cfirst);
  check('convertSfxC refuses a three-channel effect', throws(() => convertSfxC({ ticks: [{ tone: 1 }], ticksB: [{ tone: 2 }] }), /one-channel/));
  check('an empty effect: header and $FF', convertSfxC({ ticks: [] }).bytes.join() === '0,0,0,4,255');
}

console.log(`${fail ? 'FAIL' : 'PASS'}: music streams (${pass} checks passed, ${fail} failed)`);
process.exitCode = fail ? 1 : 0;
