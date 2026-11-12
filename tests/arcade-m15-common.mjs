"use strict";
// arcade-m15-common.mjs -- shared by tests/arcade-m15-compiler.mjs and tests/arcade-m15-differential.mjs (MUSIC, the language side M3: docs/ARCADE_MUSIC_CONTRACT.md sections 2, 4, 5a, 6).
//   rng, pick, ri                                re-exported from tests/arcade-m9-common.mjs
//   T(tone, vol, mix, noise)                     an effect / pattern record
//   ASSETS15                                     sfx: blip (one channel, 6 refreshes), hiss (one channel with noise, 10), chord (three channels, 8), drone (one channel, 70);
//                                                music: tune (3 patterns with held notes, order 0 1 0 2, loops to 1), jingle (2 patterns, no loop), hold (one pattern of 300 refreshes, loops)
//   songRow(asset, n)                            the registers R0..R10 a song wants on its n-th refresh (n = 0 first), or null when the song has ended (no loop) before it
//   expectChip(assets, sfxOrder, songOrder, events, upTo)
//                                                an INDEPENDENT expectation of the AY registers after refresh `upTo`, from the records (not from any stream): events = [{f, op: 'play' | 'silence' |
//                                                'music' | 'nomusic', i}] made after refresh f.  Written from the contract's sections 2 and 5a in terms of rows (see the function).
//   genProgram15(seed, opts)                     a random program with songs, effects (one channel, noise, three channels), PLAY by name / index / (x), SILENCE, NOMUSIC, ENTER of 1-3 scenes
//   runGeneric(R, res, opts)                     boot the DCK on a stock TS2068 (TSRun), sample at every entry of PROC FRAME, time every RT_PLAY / RT_SILENCE / RT_MUSIC / RT_NOMUSIC call
//   loadRuntime(v)                               arcade/build/v<v>/runtime.json + runtime.bin, or null
//   stripMusic(src), musicWordsIn(src)           the program without its songs (MUSIC declarations, NOMUSIC, PLAY <declared song>), for old-vs-new compiler comparisons; the MUSIC / NOMUSIC words left in the code (outside REM and strings)
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rng, pick, ri } from './arcade-m9-common.mjs';
import { sfxRefreshRegisters } from '../src/lang/arcade/arcade-assets.js';

export { rng, pick, ri };
const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
export const M_ = await import(pathToFileURL(join(ROOT, 'tsrun/machine.js')).href);
export const s16 = (v) => ((v & 0xFFFF) ^ 0x8000) - 0x8000;

export const T = (tone, vol, mix = 6, noise = 0) => ({ tone, vol, mix, noise });
const held = (n, t) => Array.from({ length: n }, () => ({ ...t }));

export const ASSETS15 = {
  tilesets: { ts: { tiles: [{ rows: Array.from({ length: 8 }, () => ({ bits: 0x55, ink: 2, paper: 7 })) }] } },
  sfx: {
    blip: { ticks: Array.from({ length: 6 }, (_, k) => T(120 + 30 * k, 12 - k, k === 3 ? 7 : 6)) },
    hiss: { ticks: Array.from({ length: 10 }, (_, k) => T(900 - 40 * k, 9, k % 3 === 0 ? 1 : 0, 3 + k)) },          // mix bit 0 = tone off, bit 1 = noise off: noise on in every record
    chord: { ticks: held(8, T(400, 10)), ticksB: held(6, T(500, 9)), ticksC: Array.from({ length: 8 }, (_, k) => T(600 + k, 8, k & 1 ? 2 : 0, 9)) },
    drone: { ticks: Array.from({ length: 70 }, (_, k) => T(2000 - 10 * k, 6 + (k % 5), 6)) },
  },
  music: {
    tune: {
      patterns: [
        { ticks: [...held(5, T(300, 12)), ...held(3, T(340, 11))], ticksB: held(8, T(600, 8)), ticksC: [...held(4, T(150, 7)), ...held(4, T(151, 7))] },
        { ticks: held(6, T(280, 13)), ticksB: [T(560, 9), T(560, 9), T(561, 8)], ticksC: held(6, T(140, 6, 0, 12)) },      // (C: tone and noise on: R6 = 12)
        { ticks: [T(250, 10), T(251, 10)], ticksB: [], ticksC: [] },
      ],
      order: [0, 1, 0, 2], loop: 1,
    },
    jingle: { patterns: [{ ticks: [T(500, 14), T(500, 14), T(450, 12)], ticksB: [T(700, 10)] }, { ticks: held(4, T(520, 9)) }], order: [1, 0], loop: null },
    hold: { patterns: [{ ticks: held(300, T(1000, 5)), ticksB: held(300, T(1500, 4)), ticksC: held(300, T(2000, 3)) }], order: [0], loop: 0 },
  },
};

// ── the independent expectation (rows, not streams) ───────────────────────────────────────────────────────────────────────────────
const rowCache = new Map();
/** The rows a song plays in order (one pass), and where the loop starts in them (or -1). */
function songRows(song) {
  if (rowCache.has(song)) return rowCache.get(song);
  const per = song.patterns.map((p) => sfxRefreshRegisters(p));
  const rows = [], starts = [];
  song.order.forEach((p) => { starts.push(rows.length); rows.push(...per[p]); });
  const r = { rows, loopAt: song.loop === null || song.loop === undefined ? -1 : starts[song.loop] };
  rowCache.set(song, r);
  return r;
}
/** The registers the song wants on its n-th refresh (0 = the first), or null when it has ended before (a song without a loop: one refresh after its last row it reads the end). */
export function songRow(song, n) {
  const { rows, loopAt } = songRows(song);
  if (n < rows.length) return rows[n];
  if (loopAt < 0) return null;
  return rows[loopAt + ((n - rows.length) % (rows.length - loopAt))];
}
/**
 * The registers after refresh `upTo`, from the records alone. Rules (contract sections 2, 5a): a song plays row n on the n-th refresh after its PLAY; a three-channel effect owns all eleven registers for
 * its N refreshes and holds the song (its row counter stops); a one-channel effect (always channel C in a game with songs) puts its record on R4, R5, R10 (R6 when it uses noise) and the bits $24 of
 * R7 over the song for its N refreshes; on the refresh after its last record it ends and the song's registers come back (the song steps in that same refresh). With no song the volumes no effect
 * holds are 0 (a call that leaves nothing playing silences them at once, a call made while a song or a request is pending at the next refresh, which this function shows as "after the next refresh").
 * A song without a loop ends one refresh after its last row: its volumes go to 0, its other registers stay.  The machine starts with every register 0.
 */
export function expectChip(assets, sfxOrder, songOrder, events, upTo) {
  const ev = [...events].sort((a, b) => a.f - b.f);
  let regs = new Array(11).fill(0);
  let song = null;            // {asset, n (rows played), last (the row the song last wanted; at its PLAY the chip as it was)}
  let fx = null;              // {asset, three, noise, N, j (records played), rows}
  let pend = false;           // a request a call posted: the next refresh first gives the registers back
  /** is register r the effect's? (R7 with a one-channel effect is shared: its bits $24) */
  const owned = (r) => !!fx && (fx.three || r === 4 || r === 5 || r === 10 || (r === 6 && fx.noise));
  const quiet = () => { for (const r of [8, 9, 10]) if (!owned(r)) regs[r] = 0; };
  const giveBack = () => {
    if (!song) { quiet(); return; }
    for (let r = 0; r <= 10; r++) {
      if (owned(r)) continue;
      regs[r] = r === 7 && fx ? (song.last[7] & 0xDB) | (regs[7] & 0x24) : song.last[r];
    }
  };
  const call = (x) => {
    const busy = !!song || pend;
    if (x.op === 'play') {
      const name = sfxOrder[x.i];
      if (name === undefined) return;                                 // past the table: nothing at all
      const asset = assets.sfx[name], three = !!(asset.ticksB?.length || asset.ticksC?.length);
      const rows = three ? sfxRefreshRegisters(asset) : null;
      fx = { asset, three, noise: !three && asset.ticks.some((t) => ((t.mix ?? 0) & 2) === 0), N: three ? rows.length : asset.ticks.length, j: 0, rows };
      if (busy) pend = true; else quiet();
    } else if (x.op === 'silence') { fx = null; if (busy) pend = true; else quiet(); }
    else if (x.op === 'music') song = { asset: assets.music[songOrder[x.i]], n: 0, last: regs.slice() };
    else if (x.op === 'nomusic') { if (!song) return; song = null; if (fx || pend) pend = true; else quiet(); }
  };
  const refresh = () => {
    if (pend) { pend = false; giveBack(); }
    if (fx) {
      if (fx.j >= fx.N) { fx = null; giveBack(); }                    // the refresh after its last record: it ends, the song's registers (or silence) come back
      else {
        const k = fx.j++;
        if (fx.three) regs = fx.rows[k].slice();
        else {
          const t = fx.asset.ticks[k], mix = t.mix ?? 0;
          regs[4] = t.tone & 255; regs[5] = t.tone >> 8; regs[10] = t.vol ?? 0;
          if (fx.noise) regs[6] = t.noise ?? 0;
          regs[7] = (regs[7] & 0xDB) | ((mix & 1) << 2) | (((mix >> 1) & 1) << 5);
        }
      }
    }
    if (song && !(fx && fx.three)) {                                  // a three-channel effect holds the song where it is
      const row = songRow(song.asset, song.n++);
      if (row === null) { song = null; quiet(); return; }               // a song without a loop: its volumes go to 0, the rest stays
      song.last = row;
      for (let r = 0; r <= 10; r++) if (!owned(r)) regs[r] = r === 7 && fx ? (row[7] & 0xDB) | (regs[7] & 0x24) : row[r];
    }
  };
  let e = 0;
  for (let f = 0; f <= upTo; f++) {
    if (f > 0) refresh();
    while (e < ev.length && ev[e].f === f) call(ev[e++]);
  }
  return regs;
}

// ── the random program generator ─────────────────────────────────────────────────────────────────────────────────────────────────
const SFX_DECL = 'SFX blip = "blip"\nSFX hiss = "hiss"\nSFX chord = "chord"\nSFX drone = "drone"\n';
const SONG_DECL = 'MUSIC tune = "tune"\nMUSIC jingle = "jingle"\nMUSIC hold = "hold"\n';
/**
 * A random program: 1-3 scenes, each FRAME counting t and drawing r = RND(k) every tick; sound statements guarded by r or by t: PLAY of an effect by name, by index (r MOD 6: 4 and 5 are past
 * the table), PLAY (x), PLAY of a song (also the one that plays: a restart), SILENCE, NOMUSIC, two statements in one tick, PLAY in INIT, ENTER to another scene (the song plays on). PRINT of t
 * keeps the cell map busy. opts.framerate fixes FRAMERATE (else 60, 30 or 20).
 */
export function genProgram15(seed, opts = {}) {
  const r = rng(seed * 7919 + 15);
  const fr = opts.framerate ?? pick(r, [60, 60, 30, 20]);
  const nsc = opts.scenes ?? pick(r, [1, 1, 2, 3]);
  const songs = ['tune', 'jingle', 'hold'], effects = ['blip', 'hiss', 'chord', 'drone'];
  const op = () => {
    const k = ri(r, 0, 13);
    if (k <= 3) return `PLAY ${pick(r, effects)}`;
    if (k <= 6) return `PLAY ${pick(r, songs)}`;
    if (k === 7) return 'SILENCE';
    if (k === 8) return 'NOMUSIC';
    if (k === 9) return 'PLAY r MOD 6';
    if (k === 10) return 'PLAY (x)';
    if (k === 11) return `PLAY ${pick(r, songs)}\n      PLAY ${pick(r, effects)}`;
    if (k === 12) return `PLAY ${pick(r, effects)}\n      NOMUSIC`;
    return `SILENCE\n      PLAY ${pick(r, songs)}`;
  };
  const scenes = [];
  for (let s = 0; s < nsc; s++) {
    const name = `s${s}`, guards = [];
    const n = ri(r, 2, 5), mod = ri(r, 3, 12);
    for (let g = 0; g < n; g++) guards.push(`    IF r = ${ri(r, 0, mod - 1)} THEN\n      ${op()}\n    ENDIF`);
    if (r() < 0.5) guards.push(`    IF t = ${ri(r, 2, 15)} THEN\n      ${op()}\n    ENDIF`);
    if (nsc > 1) guards.push(`    IF t >= ${ri(r, 8, 30)} THEN\n      t = 0\n      ENTER s${(s + 1 + ri(r, 0, nsc - 2)) % nsc}\n    ENDIF`);
    const init = r() < 0.6 ? `    ${op()}\n` : '';
    scenes.push(`SCENE ${name}\n  PROC INIT()\n${init}  ENDP\n  PROC FRAME()\n    t = t + 1\n    x = (t * 3) MOD 5\n    r = RND(${mod})\n${guards.join('\n')}\n    PRINT AT 0, 0; t; " "\n  ENDP\nENDSCENE\n`);
  }
  const src = `GAME "m15"\nFRAMERATE ${fr}\n${SFX_DECL}${SONG_DECL}DIM t, r, x\n${scenes.join('')}`;
  return { seed, src, framerate: fr, scenes: nsc };
}

// ── the machine ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function loadRuntime(v) {
  const json = join(ROOT, `arcade/build/v${v}/runtime.json`);
  if (!existsSync(json)) return null;
  const rt = JSON.parse(readFileSync(json, 'utf8'));
  return { rt, img: new Uint8Array(readFileSync(join(dirname(json), rt.image ?? 'runtime.bin'))), v };
}

/**
 * Boot the DCK and run until `ticks` + 1 samples: a sample is taken when PROC FRAME is entered (sample k = the state after tick k, sample 0 after INIT), with V_FRAMES then (S[k]).
 * Every entry of RT_PLAY / RT_SILENCE (plays[t]) and RT_MUSIC / RT_NOMUSIC (musics[t]) during tick t (0 = INIT) records V_FRAMES; calls before the first INIT (the boot) are dropped.
 * `straddle` is the first tick in which one of those calls was cut by a frame interrupt (V_FRAMES at its return differs from its entry): the call is then not atomic and the
 * model cannot place it, so a comparison of sound stops there.  Sample fields: vars, cells, attrs, cursor, textAttr, border, sfxActive (V_SFX_ACTIVE), ay (AY_SHADOW R0..R10), chip (the AY's R0..R10).
 */
export function runGeneric(R, res, { ticks, onRefresh = null } = {}) {
  const SYM = { ...R.rt.symbols, ...(R.rt.constants ?? {}) };
  const m = M_.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
  const must = (e) => { if (e) throw new Error(e); };
  const ROMDIR = join(ROOT, 'tsrun/roms');
  must(M_.setHomeRom(m, readFileSync(join(ROMDIR, 'ts2068-0.rom'))));
  must(M_.setExRom(m, readFileSync(join(ROMDIR, 'ts2068-1.rom'))));
  must(M_.insertDock(m, res.dck));
  M_.resetMachine(m);
  const rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
  const snap = () => ({
    vars: Object.fromEntries(Object.entries(res.map.vars).map(([k, a]) => [k, s16(rd16(a))])),
    cells: m.ram.slice(SYM.CELL_TILE, SYM.CELL_TILE + 768), attrs: m.ram.slice(SYM.CELL_ATTR, SYM.CELL_ATTR + 768),
    cursor: { row: m.ram[SYM.V_CUR_ROW], col: m.ram[SYM.V_CUR_COL] }, textAttr: m.ram[SYM.V_TEXT_ATTR], border: m.ram[SYM.V_BORDER],
    sfxActive: m.ram[SYM.V_SFX_ACTIVE], ay: Array.from(m.ram.slice(SYM.AY_SHADOW, SYM.AY_SHADOW + 11)), chip: Array.from({ length: 11 }, (_, k) => m.ay.regs[k]),
  });
  const out = { snaps: [], S: [], plays: [[]], musics: [[]], straddle: null, error: null, machine: m, calls: [], returns: 0 };
  for (let f = 0; f < 400 && rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE; f++) M_.runFrame(m);
  if (rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE) { out.error = 'the runtime did not boot'; return out; }
  const fe = res.map.entries.frame, ie = res.map.entries.init;
  const SOUND = new Map([[SYM.RT_PLAY, 'plays'], [SYM.RT_SILENCE, 'plays'], [SYM.RT_MUSIC, 'musics'], [SYM.RT_NOMUSIC, 'musics']]);
  const NAMES = new Map([[SYM.RT_PLAY, 'play'], [SYM.RT_SILENCE, 'silence'], [SYM.RT_MUSIC, 'music'], [SYM.RT_NOMUSIC, 'nomusic']]);
  let cur = -1, open = [];
  const origRead = m.bus.read;
  m.bus.read = function (a) {
    if (m.cpu.pc === a) {
      if (a === ie && cur < 0) { cur = 0; out.plays[0] = []; out.musics[0] = []; }
      else if (a === fe && cur >= 0 && out.snaps.length < ticks + 1) {
        out.S[out.snaps.length] = rd16(SYM.V_FRAMES); out.snaps.push(snap());
        cur = out.snaps.length; out.plays[cur] = []; out.musics[cur] = [];
      } else if (SOUND.has(a) && cur >= 0) {
        const f0 = rd16(SYM.V_FRAMES);
        out[SOUND.get(a)][cur].push(f0);
        out.calls.push({ t: cur, f: f0, op: NAMES.get(a), a: m.cpu.a, hl: (m.cpu.h << 8) | m.cpu.l, flags: m.ram[SYM.V_SFX_ACTIVE] });
        open.push({ ret: rd16(m.cpu.sp), sp: m.cpu.sp, f0, t: cur });
      } else if (open.length) {
        const o = open[open.length - 1];
        if (a === o.ret && m.cpu.sp === ((o.sp + 2) & 0xFFFF)) { open.pop(); out.returns++; if (rd16(SYM.V_FRAMES) !== o.f0 && out.straddle === null) out.straddle = o.t; }
      }
    }
    return origRead.call(this, a);
  };
  const div = res.memory[0x8004] & 0x3F;
  const maxFrames = 400 + (ticks + 3) * Math.max(div, 4) * 6;
  for (let f = 0; f < maxFrames && out.snaps.length < ticks + 1; f++) { M_.runFrame(m); if (onRefresh) onRefresh(m, SYM); }
  if (out.snaps.length < ticks + 1) out.error = `only ${out.snaps.length} of ${ticks + 1} samples (PROC FRAME entered ${out.snaps.length} times)`;
  return out;
}

/** The xorshift RND of the runtime (tests/arcade-m5-harness.mjs XS), as a generator function for the interpreter. */
export function runtimeRnd(seed) {
  let x = seed;
  return () => { if (x === 0) x = 1; x = (x ^ (x << 7)) & 0xFFFF; x ^= x >> 9; x = (x ^ (x << 8)) & 0xFFFF; return x & 0x7FFF; };
}

// ── the program without its songs ────────────────────────────────────────────────────────────────────────────────────────────────
/** Split one source line into its statements at ':' outside strings; a REM runs to the end of the line.  Returns {parts: [text], rem} (rem = the trailing REM statement, which is kept as it is). */
function statementsOf(line) {
  const parts = [];
  let cur = '', inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) { cur += c; if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; cur += c; continue; }
    if (c === ':') { parts.push(cur); cur = ''; continue; }
    if (cur.trim() === '' && /^REM\b/i.test(line.slice(i))) { cur += line.slice(i); break; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}
/**
 * The program without its songs: every `MUSIC name = "asset"` declaration, every `NOMUSIC` and every `PLAY <declared song>` statement is removed (the line is left empty, so line numbers stay).
 * A statement is recognised at the start of a line or after ':' (so `INK 1 : PLAY stones` loses only the PLAY).  Anything else that names a song or NOMUSIC (after THEN or ELSE on one line, as a
 * variable-like use, in PLAY (x)) is refused loudly (throws), never left in.
 */
export function stripMusic(src) {
  const songs = new Set([...src.matchAll(/^[ \t]*MUSIC[ \t]+([A-Za-z][A-Za-z0-9]*)[ \t]*=/gim)].map((m) => m[1].toUpperCase()));
  const out = src.split('\n').map((line, n) => {
    if (/^[ \t]*MUSIC\b/i.test(line)) {
      if (!/^[ \t]*MUSIC[ \t]+[A-Za-z][A-Za-z0-9]*[ \t]*=[ \t]*"[^"]*"[ \t]*(\bREM\b.*)?$/i.test(line)) throw new Error(`stripMusic: line ${n + 1}: a MUSIC line it does not understand: ${line.trim()}`);
      return '';
    }
    if (/^[ \t]*REM\b/i.test(line)) return line;
    const parts = statementsOf(line), keep = [];
    for (const p of parts) {
      const t = p.trim();
      if (/^NOMUSIC$/i.test(t)) continue;
      const m = /^PLAY[ \t]+([A-Za-z][A-Za-z0-9]*)$/i.exec(t);
      if (m && songs.has(m[1].toUpperCase())) continue;
      keep.push(p);
    }
    const rest = keep.join(':');
    const left = musicWordsIn(rest);
    if (left.length) throw new Error(`stripMusic: line ${n + 1}: ${left.join(' ')} in a place it does not understand: ${line.trim()}`);
    for (const s of songs) if (new RegExp(`\\bPLAY\\b[^"]*\\b${s}\\b`, 'i').test(rest.replace(/"[^"]*"/g, '""').replace(/\bREM\b.*$/i, ''))) throw new Error(`stripMusic: line ${n + 1}: PLAY of song ${s} in a place it does not understand: ${line.trim()}`);
    return keep.length === 0 && parts.length > 0 && parts.some((p) => p.trim() !== '') ? '' : rest;
  });
  return out.join('\n');
}
/** The MUSIC / NOMUSIC words in the code of `src` (not in REM text or strings). */
export function musicWordsIn(src) {
  const found = [];
  for (const line of src.split('\n')) {
    if (/^[ \t]*REM\b/i.test(line)) continue;
    for (const p of statementsOf(line)) {
      if (/^[ \t]*REM\b/i.test(p)) continue;
      const code = p.replace(/"[^"]*"/g, '""');
      for (const m of code.matchAll(/\b(MUSIC|NOMUSIC)\b/gi)) found.push(m[1].toUpperCase());
    }
  }
  return found;
}

// ── sound at song level on a real runtime, for the suites that run a game with songs (docs/ARCADE_MUSIC_CONTRACT.md 5a, 6a) ───────────────────────────────────────────────
//   createSoundRecorder(m, SYM, res)   hooks nothing itself: the suite's bus.read hook calls rec.fetch(a) for EVERY fetch (it times the entry of RT_PLAY / RT_SILENCE / RT_MUSIC / RT_NOMUSIC by V_FRAMES, and
//                                      watches each call's return: V_FRAMES changed between entry and return = the call was cut by a frame interrupt, `rec.cuts`, `rec.straddle` = the first such tick) and rec.sample()
//                                      when it takes a sample at the entry of PROC FRAME (sample k = after tick k, 0 = after INIT; calls made after sample k belong to tick k + 1, those before sample 0 to INIT)
//   soundOf(m, SYM)                    {sfxActive, ay, chip} of the machine now (V_SFX_ACTIVE, AY_SHADOW R0..R10, the AY's R0..R10)
//   clockOf(rec)                       the interpreter's opts.clock {play, music, sample} from the recorded timings
//   compareSound(pairs)                pairs [{at, g: {sfxActive, ay, chip}, w: interpreter record}]: the level of tests/arcade-m15-differential.mjs (V_SFX_ACTIVE all bits = w.ay.flags, AY_SHADOW R0..R10 = w.ay.regs,
//                                      the chip = AY_SHADOW), every pair, exactly; returns {d (first difference or null), stats {compared, song, effect, cOver, paused, calls}}
//   soundCoverage(stats, need)         text, and ok when every count named in `need` (['song', 'cOver', ...]) is > 0 (and some samples were compared)
export function createSoundRecorder(m, SYM, res) {
  const rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
  const ie = res.map.entries.init;
  const KIND = new Map([[SYM.RT_PLAY, ['plays', 'play']], [SYM.RT_SILENCE, ['plays', 'silence']], [SYM.RT_MUSIC, ['musics', 'music']], [SYM.RT_NOMUSIC, ['musics', 'nomusic']]]);
  KIND.delete(undefined);
  const rec = { plays: [[]], musics: [[]], S: [], calls: [], cuts: [], straddle: null, cur: -1, returns: 0 };
  let open = [];
  rec.fetch = (a) => {
    if (m.cpu.pc !== a) return;
    if (a === ie && rec.cur < 0) { rec.cur = 0; rec.plays[0] = []; rec.musics[0] = []; return; }
    if (rec.cur < 0) return;
    const k = KIND.get(a);
    if (k) {
      const f0 = rd16(SYM.V_FRAMES);
      rec[k[0]][rec.cur].push(f0);
      rec.calls.push({ t: rec.cur, f: f0, op: k[1] });
      open.push({ ret: rd16(m.cpu.sp), sp: m.cpu.sp, f0, t: rec.cur, op: k[1] });
    } else if (open.length) {
      const o = open[open.length - 1];
      if (a === o.ret && m.cpu.sp === ((o.sp + 2) & 0xFFFF)) {
        open.pop(); rec.returns++;
        if (rd16(SYM.V_FRAMES) !== o.f0) { rec.cuts.push(`tick ${o.t} ${o.op}: entered at refresh ${o.f0}, returned at ${rd16(SYM.V_FRAMES)}`); rec.straddle ??= o.t; }
      }
    }
  };
  rec.sample = () => { rec.S.push(rd16(SYM.V_FRAMES)); rec.cur = rec.S.length; rec.plays[rec.cur] = []; rec.musics[rec.cur] = []; };
  return rec;
}
export function soundOf(m, SYM) {
  return { sfxActive: m.ram[SYM.V_SFX_ACTIVE], ay: Array.from(m.ram.slice(SYM.AY_SHADOW, SYM.AY_SHADOW + 11)), chip: Array.from({ length: 11 }, (_, k) => m.ay.regs[k]) };
}
export const clockOf = (rec) => ({ play: (t, n) => rec.plays[t]?.[n - 1] ?? 0, music: (t, n) => rec.musics[t]?.[n - 1] ?? 0, sample: (t) => rec.S[t] });
export function compareSound(pairs) {
  const stats = { compared: 0, song: 0, effect: 0, cOver: 0, paused: 0 };
  let d = null;
  for (const { at, g, w } of pairs) {
    if (!w.ay) return { d: `${at}: the interpreter's record has no \`ay\` (the game has no songs, or the interpreter ran without a clock model)`, stats };
    stats.compared++;
    if (g.sfxActive !== w.ay.flags) { d ??= `${at}: V_SFX_ACTIVE = ${g.sfxActive}, interpreter ${w.ay.flags}`; break; }
    if (JSON.stringify(g.ay) !== JSON.stringify(w.ay.regs)) { d ??= `${at}: AY_SHADOW = ${g.ay}, interpreter ${w.ay.regs}`; break; }
    if (JSON.stringify(g.chip) !== JSON.stringify(g.ay)) { d ??= `${at}: the chip ${g.chip} differs from AY_SHADOW ${g.ay}`; break; }
    const fl = g.sfxActive;
    if (fl & 2) stats.song++;
    if (fl & 1) stats.effect++;
    if ((fl & 3) === 3) stats.cOver++;      // (every effect of the examples is one-channel: a channel-C stream over the song)
  }
  return { d, stats };
}
export function soundCoverage(stats, need, cuts = []) {
  const text = `${stats.compared} samples compared, ${stats.song} with a song playing, ${stats.effect} with an effect, ${stats.cOver} with a channel-C effect over a song${cuts.length ? `; a call was cut by a frame interrupt, so sound was compared up to it only (${cuts[0]})` : ''}`;
  return { text, ok: stats.compared > 0 && need.every((k) => stats[k] > 0) };
}
