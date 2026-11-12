#!/usr/bin/env node
"use strict";
// arcade-m15-compiler.mjs -- tests for the LANGUAGE side of MUSIC (slice M3): docs/ARCADE_MUSIC_CONTRACT.md sections 2 (language), 4 (the image), 5a (the runtime as built: RT_MUSIC takes
// HL = the song's address, no song table), 6 (the interpreter) and 11 (the decisions taken by Claude).
//
//   node tests/arcade-m15-compiler.mjs               (ARCADE_QUICK=1: fewer random scripts)
//   ARCADE_M15_OLD=<git ref> ...                     the compiler the byte-identity section compares with (default 237b18a, the tree before M3; ARCADE_M15_GIT = the repository to take it from)
//
// No machine is booted here (tests/arcade-m15-differential.mjs runs the code on the real runtimes). Sections
//   1  parser and checker: MUSIC, PLAY song, NOMUSIC: every message with its text and position, positives and negatives, the name spaces, reserved words, the word table, scan
//   2  code generator on the real v2 runtime: the song images (loop, the pattern pointers in play order, DW 0, every pattern stream) at their labels equal convertMusic's parts; PLAY song and
//      NOMUSIC code; one-channel effects become channel-C streams only in a game with songs; ENTER's reset calls RT_SILENCE only; data sizes; the refusals (v1, a runtime without RT_MUSIC, a
//      missing or broken asset)
//   3  byte identity: every example and fixture (no MUSIC) compiles to exactly the bytes of the compiler before M3, on v2, v3 and v4
//   4  the reference interpreter, hand-computed: songs alone, with a channel-C effect, paused by a three-channel effect, SILENCE, NOMUSIC (at once / at the next refresh), a song replaced or
//      restarted, a song that ends, ENTER (the song plays on), FRAMERATE 30, the clock; against expectChip (tests/arcade-m15-common.mjs: rows of the records, not streams) and against
//      register values written out by hand
//   5  the chip model of the interpreter (arcade-sound.js) against expectChip on random scripts of calls and refreshes
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { check } from '../src/lang/arcade/arcade-check.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile, requiredRuntime, usageLines, CODEGEN_OFF } from '../src/lang/arcade/arcade-compile.js';
import { ARCADE_WORDS, RESERVED, ASSET_KINDS, LIMITS, BATCH11_WORDS } from '../src/lang/arcade/arcade-words.js';
import { scanArcade } from '../src/lang/arcade/arcade-scan.js';
import { convertSfx, convertSfxC, convertMusic, sfxRefreshRegisters, assetTables } from '../src/lang/arcade/arcade-assets.js';
import { createSoundChip, SB_FX, SB_MUS, SB_SYNC } from '../src/lang/arcade/arcade-sound.js';
import { ASSETS15, T, expectChip, songRow, rng, ROOT, stripMusic, musicWordsIn } from './arcade-m15-common.mjs';

const QUICK = !!process.env.ARCADE_QUICK;
let passed = 0, failed = 0, skipped = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const info = (s) => console.log('  INFO  ' + s);
const skip_ = (name, why) => { console.log(`  SKIP  ${name}  (${why})`); skipped++; };
const eq = (name, got, want) => check_(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const same = (a, b) => !!a && !!b && a.length === b.length && Array.from(a).every((v, i) => v === b[i]);

// ── source helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SFX4 = 'SFX blip = "blip"\nSFX hiss = "hiss"\nSFX chord = "chord"\nSFX drone = "drone"\n';
const SONGS = 'MUSIC tune = "tune"\nMUSIC jingle = "jingle"\nMUSIC hold = "hold"\n';
const TOP = `GAME "t"\nFRAMERATE 60\n${SFX4}${SONGS}`;
const game = (frame, init = '', head = TOP, decl = 'DIM t\n') => `${head}${decl}SCENE s\n  PROC INIT()\n${init}  ENDP\n  PROC FRAME()\n    t = t + 1\n${frame}  ENDP\nENDSCENE\n`;
const diag = (src, version = 2) => { const p = parse(src); return [...p.errors, ...check(p.ast, { version })]; };
const errs = (src, v) => diag(src, v).filter((d) => d.severity === 'error');
const warns = (src, v) => diag(src, v).filter((d) => d.severity === 'warning');
const msgs = (l) => l.map((d) => `${d.line}:${d.col} ${d.message}`).join(' | ');
const at = (src, needle, nth = 0) => {
  let from = -1;
  for (let i = 0; i <= nth; i++) { from = src.indexOf(needle, from + 1); if (from < 0) throw new Error(`test bug: "${needle}" #${nth} not in the source`); }
  const before = src.slice(0, from).split('\n');
  return { line: before.length, col: before[before.length - 1].length };
};
const okSrc = (name, src) => { const e = errs(src); check_(name, e.length === 0, msgs(e)); };
const badAt = (name, src, msg, where) => {
  const e = errs(src), hit = e.find((d) => d.message === msg && d.line === where.line && d.col === where.col);
  check_(name, !!hit, hit ? '' : msgs(e) || 'no errors');
};
const warnAt = (name, src, msg, where) => {
  const w = warns(src), hit = w.find((d) => d.message === msg && (!where || (d.line === where.line && d.col === where.col)));
  check_(name, !!hit && errs(src).length === 0, `${msgs(w)} || errors: ${msgs(errs(src))}`);
};

// ── real runtimes ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function loadRt(path) {
  const json = join(ROOT, path);
  if (!existsSync(json)) return null;
  const rt = JSON.parse(readFileSync(json, 'utf8'));
  return { rt, img: new Uint8Array(readFileSync(join(dirname(json), rt.image ?? 'runtime.bin'))) };
}
const RT = { 1: loadRt('arcade/build/v1/runtime.json'), 2: loadRt('arcade/build/v2/runtime.json'), 3: loadRt('arcade/build/v3/runtime.json'), 4: loadRt('arcade/build/v4/runtime.json') };
const cmp = (src, R, assets = ASSETS15) => compile(src, { runtime: R.rt, image: R.img, assets });
const errText = (r) => r.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');

// =================================================================================================================
// 1. Parser and checker
// =================================================================================================================
console.log('1. Parser and checker: MUSIC name = "asset", PLAY song, NOMUSIC (contract section 2)');
{
  okSrc('a game with 4 effects and 3 songs: PLAY of each song and each effect by name, NOMUSIC, SILENCE, PLAY by index', game('    PLAY tune\n    PLAY jingle\n    PLAY hold\n    PLAY blip\n    PLAY hiss\n    PLAY chord\n    PLAY drone\n    NOMUSIC\n    SILENCE\n    PLAY t MOD 4\n'));
  okSrc('MUSIC only (no SFX): PLAY song and NOMUSIC', game('    PLAY tune\n    NOMUSIC\n', '', `GAME "t"\n${SONGS}`));
  okSrc('PLAY song in PROC INIT, in a PROC, after ENTER in another scene', `${TOP}DIM t\nPROC go()\n  PLAY jingle\nENDP\nSCENE a\n  PROC INIT()\n    PLAY tune\n  ENDP\n  PROC FRAME()\n    CALL go()\n    PLAY hold\n    ENTER b\n  ENDP\nENDSCENE\nSCENE b\n  PROC INIT()\n    NOMUSIC\n  ENDP\n  PROC FRAME()\n    t = t + 1\n    ENTER a\n  ENDP\nENDSCENE\n`);
  okSrc('a song name may be a reserved word that may name an asset (MUSIC world, SFX music, PLAY music)', game('    PLAY world\n    PLAY music\n', '', 'GAME "t"\nMUSIC world = "tune"\nSFX music = "blip"\n'));
  okSrc('an asset string that is the word "music" (MUSIC m = "music")', game('    PLAY m\n', '', 'GAME "t"\nMUSIC m = "music"\n'));
  // the limit
  const eight = `GAME "t"\n${Array.from({ length: 8 }, (_, i) => `MUSIC m${i} = "tune"\n`).join('')}`;
  okSrc('8 songs are allowed', game(Array.from({ length: 8 }, (_, i) => `    PLAY m${i}\n`).join(''), '', eight));
  const nine = `${eight}MUSIC m8 = "tune"\nMUSIC m9 = "tune"\n`;
  const nineSrc = game(Array.from({ length: 10 }, (_, i) => `    PLAY m${i}\n`).join(''), '', nine);
  badAt('the 9th MUSIC: "too many songs (at most 8)" at its name', nineSrc, 'too many songs (at most 8)', { line: at(nineSrc, 'MUSIC m8').line, col: 6 });
  badAt('... and the 10th too', nineSrc, 'too many songs (at most 8)', { line: at(nineSrc, 'MUSIC m9').line, col: 6 });
  check_('... exactly two such errors', errs(nineSrc).filter((d) => d.message === 'too many songs (at most 8)').length === 2, msgs(errs(nineSrc)));
  // a repeated name is not a new song: 8 songs and a ninth of an existing name give the duplicate error and no "too many songs"
  const eightDup = game(Array.from({ length: 8 }, (_, i) => `    PLAY m${i}\n`).join(''), '', `${eight}MUSIC m0 = "jingle"\n`);
  check_('8 songs plus a second MUSIC m0: "m0 is already declared" and no "too many songs"', errs(eightDup).some((d) => /^'m0' is already declared/.test(d.message)) && !errs(eightDup).some((d) => /too many songs/.test(d.message)), msgs(errs(eightDup)));
  check_('... and a genuine ninth song after the duplicate still gets "too many songs" (once)', (() => { const s9 = game('', '', `${eight}MUSIC m0 = "jingle"\nMUSIC m8 = "tune"\n`); return errs(s9).filter((d) => d.message === 'too many songs (at most 8)').length === 1; })());
  // declarations
  const inScene = `GAME "t"\nSCENE s\n  MUSIC q = "tune"\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n`;
  badAt('MUSIC inside a SCENE: "MUSIC must be at the top level, outside any SCENE"', inScene, 'MUSIC must be at the top level, outside any SCENE', { line: 3, col: 2 });
  const inProc = game('    MUSIC q = "tune"\n');
  check_('MUSIC inside a PROC is an error on that line', errs(inProc).some((d) => d.line === at(inProc, 'MUSIC q').line), msgs(errs(inProc)));
  const dup = game('    PLAY tune\n', '', `${TOP}MUSIC tune = "jingle"\n`);
  badAt('two MUSIC of one name: "\'tune\' is already declared (line N)" at the second', dup, `'tune' is already declared (line ${at(dup, 'MUSIC tune').line})`, { line: at(dup, 'MUSIC tune', 1).line, col: 6 });
  const noQuote = 'GAME "t"\nMUSIC tune = tune\n';
  check_('MUSIC name = asset without quotes: the declaration message of the other kinds', errs(noQuote).some((d) => d.message === 'expected the asset name in quotes, e.g. MUSIC tune = "tune"'), msgs(errs(noQuote)));
  const pool = 'GAME "t"\nMUSIC tune(2) = "tune"\n';
  check_('MUSIC name(n): only a SPRITE has a pool size', errs(pool).some((d) => d.message === 'only a SPRITE can have a pool size: MUSIC tune = "..."'), msgs(errs(pool)));
  // name spaces (decision: a name that is both an SFX and a MUSIC is an error only where PLAY names it)
  const both = game('    PLAY bo\n', '', `GAME "t"\nSFX bo = "blip"\nMUSIC bo = "tune"\n`);
  badAt('DECISION: PLAY of a name that is both an SFX and a MUSIC: the error at the name', both, "'bo' is both an SFX and a MUSIC: PLAY cannot tell which to start; rename one of them", { line: at(both, 'PLAY bo').line, col: at(both, 'PLAY bo').col + 5 });
  okSrc('... the two declarations alone are legal (separate name spaces, as for every two kinds)', game('    t = 1\n', '', `GAME "t"\nSFX bo = "blip"\nMUSIC bo = "tune"\n`).replace(/^/, ''));
  check_('... and give no "never used" warning once PLAY has named the pair', !warns(both).some((d) => /never used/.test(d.message)), msgs(warns(both)));
  okSrc('a MUSIC, a PROC, a variable and a SPRITE of one name (asset name spaces)', `GAME "t"\nMUSIC lock = "tune"\nSPRITE lock = "orb"\nDIM lock\nSCENE s\n  PROC INIT()\n    PLAY lock\n    SHOW lock AT 1, 1\n    lock = 2\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n`);
  const varSong = game('    PLAY tune\n    tune = 4\n', '', TOP, 'DIM t, tune\n');
  okSrc('PLAY tune with a variable tune too: the song (an asset name wins, as for SFX)', varSong);
  const paren = game('    PLAY (tune)\n');
  badAt('PLAY (tune): an index expression, and tune is a MUSIC: "\'tune\' is a MUSIC, not a variable"', paren, "'tune' is a MUSIC, not a variable", { line: at(paren, '(tune)').line, col: at(paren, '(tune)').col + 1 });
  const show = game('    SHOW tune AT 1, 1\n', '', `${TOP}SPRITE ship = "orb"\n`);
  badAt('SHOW tune: "\'tune\' is a MUSIC, not a SPRITE"', show, "'tune' is a MUSIC, not a SPRITE", { line: at(show, 'SHOW tune').line, col: at(show, 'SHOW tune').col + 5 });
  const arith = game('    t = tune + 1\n');
  badAt('a song in an expression: "\'tune\' is a MUSIC, not a variable"', arith, "'tune' is a MUSIC, not a variable", { line: at(arith, 'tune + 1').line, col: at(arith, 'tune + 1').col });
  const idx0 = game('    PLAY 0\n', '', `GAME "t"\n${SONGS}`);
  badAt('songs have no index form: PLAY 0 in a game with songs and no SFX is "there are no sound effects"', idx0, 'PLAY 0: there are no sound effects (declare one with SFX name = "asset")', { line: at(idx0, 'PLAY 0').line, col: at(idx0, 'PLAY 0').col + 5 });
  const idx4 = game('    PLAY 4\n');
  badAt('PLAY 4 with 4 SFX and 3 songs: "there are only 4 sound effects (0..3)" (songs do not count)', idx4, 'PLAY 4: there are only 4 sound effects (0..3)', { line: at(idx4, 'PLAY 4').line, col: at(idx4, 'PLAY 4').col + 5 });
  const unknown = game('    PLAY nosuch\n');
  check_('PLAY of an undeclared name: the old message', errs(unknown).some((d) => d.message === '\'nosuch\' is not a declared SFX: add SFX nosuch = "..."'), msgs(errs(unknown)));
  // NOMUSIC
  const nm3 = game('    NOMUSIC 3\n');
  badAt('NOMUSIC 3: "NOMUSIC takes nothing: write NOMUSIC alone (PLAY name starts a song)" at the 3', nm3, 'NOMUSIC takes nothing: write NOMUSIC alone (PLAY name starts a song)', { line: at(nm3, 'NOMUSIC 3').line, col: at(nm3, 'NOMUSIC 3').col + 8 });
  const nmTune = game('    NOMUSIC tune\n');
  check_('NOMUSIC tune: the same message', errs(nmTune).some((d) => d.message === 'NOMUSIC takes nothing: write NOMUSIC alone (PLAY name starts a song)'), msgs(errs(nmTune)));
  okSrc('NOMUSIC then another statement after a colon, and NOMUSIC before ENDIF on one line', game('    NOMUSIC : t = 2\n    IF t = 3 THEN NOMUSIC ENDIF\n'));
  const nmNoSongs = game('    NOMUSIC\n', '', 'GAME "t"\n');
  warnAt('NOMUSIC in a game without MUSIC: a warning "NOMUSIC does nothing in a game without MUSIC (no song can be playing)"', nmNoSongs, 'NOMUSIC does nothing in a game without MUSIC (no song can be playing)', at(nmNoSongs, 'NOMUSIC'));
  check_('... no such warning in a game with MUSIC', !warns(game('    NOMUSIC\n    PLAY tune\n', '', `GAME "t"\n${SONGS}`)).some((d) => /NOMUSIC does nothing/.test(d.message)));
  // reserved
  const dimMusic = 'GAME "t"\nDIM music, nomusic\n';
  check_('DIM music / nomusic: "\'music\' is a reserved word and cannot be used as a variable name" (and nomusic)', errs(dimMusic).filter((d) => /is a reserved word and cannot be used as a variable name/.test(d.message)).length === 2, msgs(errs(dimMusic)));
  // warnings
  const unused = game('    PLAY tune\n', '', `GAME "t"\n${SONGS}`);
  warnAt('a MUSIC never PLAYed: "MUSIC \'jingle\' is never used" at its name', unused, "MUSIC 'jingle' is never used", { line: at(unused, 'MUSIC jingle').line, col: 6 });
  check_('... a PLAYed one gives no warning', !warns(unused).some((d) => d.message === "MUSIC 'tune' is never used"), msgs(warns(unused)));
  check_('PLAY by a run-time index uses every SFX but no MUSIC', (() => { const w = warns(game('    PLAY t MOD 4\n')); return !w.some((d) => /SFX '/.test(d.message)) && w.filter((d) => /MUSIC '/.test(d.message)).length === 3; })());
  // the word table, the asset kinds, the scan
  check_('MUSIC and NOMUSIC are reserved words with Help entries (class game, one-line syntax, a description)', ['MUSIC', 'NOMUSIC'].every((w) => RESERVED.has(w) && ARCADE_WORDS.get(w)?.cls === 'game' && /\S/.test(ARCADE_WORDS.get(w).desc) && !/\n/.test(ARCADE_WORDS.get(w).syntax)));
  check_('the syntax lines: MUSIC name = "asset", NOMUSIC, and PLAY lists the song form', ARCADE_WORDS.get('MUSIC').syntax === 'MUSIC name = "asset"' && ARCADE_WORDS.get('NOMUSIC').syntax === 'NOMUSIC' && /PLAY song/.test(ARCADE_WORDS.get('PLAY').syntax));
  check_('SILENCE says the song plays on', /song plays on/.test(ARCADE_WORDS.get('SILENCE').desc));
  check_('ASSET_KINDS.MUSIC = "music", LIMITS.maxSongs = 8, MUSIC / NOMUSIC may name an asset (BATCH11_WORDS)', ASSET_KINDS.MUSIC === 'music' && LIMITS.maxSongs === 8 && BATCH11_WORDS.has('MUSIC') && BATCH11_WORDS.has('NOMUSIC'));
  const sc = scanArcade(`${TOP}SCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n`);
  eq('scanArcade lists the songs among the assets (kind MUSIC, declaration order, line)', sc.assets.filter((a) => a.kind === 'MUSIC').map((a) => [a.name, a.asset, a.line]), [['tune', 'tune', 7], ['jingle', 'jingle', 8], ['hold', 'hold', 9]]);
  eq('requiredRuntime of a game with songs: v2 (the least the language needs)', requiredRuntime(game('    PLAY tune\n'), ASSETS15).version, 2);
  const tabs = assetTables({ music: { a: 1 } });
  check_('assetTables: a project with only "music" is a named table (not sprites), music kept', tabs.music.a === 1 && Object.keys(tabs.sprites).length === 0);
  check_('assetTables of the old shapes has an empty music table', Object.keys(assetTables({ sprites: {} }).music).length === 0 && Object.keys(assetTables({ x: {} }).music).length === 0);
}

// =================================================================================================================
// 2. The code generator on the real v2 runtime
// =================================================================================================================
console.log('\n2. Code generator (v2): the song image, PLAY song / NOMUSIC, channel-C effects, the refusals');
if (!RT[2]) skip_('every code generator check', 'arcade/build/v2/runtime.json does not exist');
else {
  const R = RT[2], S = R.rt.symbols;
  const src = game('    IF t = 2 THEN PLAY jingle ENDIF\n    IF t = 3 THEN NOMUSIC ENDIF\n    IF t = 4 THEN PLAY blip ENDIF\n    IF t = 5 THEN PLAY hiss ENDIF\n    IF t = 6 THEN PLAY chord ENDIF\n    IF t = 7 THEN PLAY drone ENDIF\n    IF t = 8 THEN PLAY hold ENDIF\n', '    PLAY tune\n');
  const res = cmp(src, R);
  if (!check_('the game compiles', res.errors.length === 0, errText(res))) process.exit(1);
  const mem = res.memory, songs = res.gen.symbols.songs;
  const rd16 = (a) => mem[a] | (mem[a + 1] << 8);
  eq('symbols.songs names the three songs (upper case)', Object.keys(songs ?? {}), ['TUNE', 'JINGLE', 'HOLD']);
  let total = 0, okAll = true, why = '';
  for (const [i, name] of ['tune', 'jingle', 'hold'].entries()) {
    const c = convertMusic(ASSETS15.music[name]), a = songs[name.toUpperCase()];
    total += c.bytes;
    const loop = mem[a], ptrs = c.order.map((_, k) => rd16(a + 1 + 2 * k)), end = rd16(a + 1 + 2 * c.order.length);
    const pat0 = a + 1 + 2 * (c.order.length + 1);
    const patAt = []; let p = pat0; c.patterns.forEach((pt) => { patAt.push(p); p += pt.bytes.length; });
    const fails = [];
    if (loop !== c.loop) fails.push(`loop ${loop}`);
    if (end !== 0) fails.push('no DW 0 after the order list');
    c.order.forEach((k, j) => { if (ptrs[j] !== patAt[k]) fails.push(`order ${j} -> ${ptrs[j].toString(16)} want ${patAt[k].toString(16)}`); });
    c.patterns.forEach((pt, k) => { if (!same(mem.slice(patAt[k], patAt[k] + pt.bytes.length), pt.bytes)) fails.push(`pattern ${k} bytes`); });
    if (p - a !== c.bytes) fails.push(`size ${p - a} want ${c.bytes}`);
    if (fails.length) { okAll = false; why += `${name}: ${fails.join(', ')}; `; }
    void i;
  }
  check_('each song = loop byte, DW pattern pointers in play order (each pointing at that pattern\'s stream), DW 0, then every pattern stream once, bytes of convertMusic', okAll, why);
  check_('tune loops to order position 1 (byte 1), jingle has no loop ($FF), hold loops to 0', mem[songs.TUNE] === 1 && mem[songs.JINGLE] === 0xFF && mem[songs.HOLD] === 0);
  eq('usage.data.music = the songs\' bytes (convertMusic\'s byte counts added)', res.usage.data.music, total);
  check_('usageLines reports the songs', usageLines(res.usage).some((l) => l === `music: ${total} bytes of songs (mapped: the frame interrupt plays them)`), usageLines(res.usage).join(' / '));
  check_('the songs live in the mapped game area (below $C000)', Object.values(songs).every((a) => a >= 0x8000 && a + 100 < 0xC000));
  // the code of PLAY song / NOMUSIC
  const code = res.gen.code, base = res.gen.base;
  const count = (seq) => { let n = 0; for (let i = 0; i + seq.length <= code.length; i++) if (seq.every((b, k) => code[i + k] === b)) n++; return n; };
  const ldhl = (a) => [0x21, a & 255, a >> 8], call = (a) => [0xCD, a & 255, a >> 8];
  // Compiler size pass (docs/ARCADE_COMPILER_SIZE_CONTRACT.md F5): a CALL that is the last instruction of its PROC (`CALL x / RET`, no label between) is `JP x`. PLAY tune is
  // INIT's only statement, so it is `LD HL,song / JP RT_MUSIC`; PLAY jingle / PLAY hold sit in an IF (a label follows the call) and keep the CALL.
  const jp = (a) => [0xC3, a & 255, a >> 8];
  const callAny = (seq, a) => count([...seq, ...call(a)]) + count([...seq, ...jp(a)]);
  check_('PLAY tune (in INIT) is LD HL,song / CALL RT_MUSIC (JP RT_MUSIC when it is the last statement of the PROC): once for tune, once for jingle, once for hold', ['TUNE', 'JINGLE', 'HOLD'].every((k) => callAny(ldhl(songs[k]), S.RT_MUSIC) === 1));
  check_('... tune is the tail jump LD HL,song / JP RT_MUSIC, jingle and hold are CALLs (an IF ... ENDIF label follows them)', count([...ldhl(songs.TUNE), ...jp(S.RT_MUSIC)]) === 1 && count([...ldhl(songs.JINGLE), ...call(S.RT_MUSIC)]) === 1 && count([...ldhl(songs.HOLD), ...call(S.RT_MUSIC)]) === 1);
  check_('RT_MUSIC is called exactly three times (CALL or tail JP), RT_NOMUSIC exactly once (the one NOMUSIC)', count(call(S.RT_MUSIC)) + count(jp(S.RT_MUSIC)) === 3 && count(call(S.RT_NOMUSIC)) + count(jp(S.RT_NOMUSIC)) === 1, `${count(call(S.RT_MUSIC)) + count(jp(S.RT_MUSIC))} / ${count(call(S.RT_NOMUSIC)) + count(jp(S.RT_NOMUSIC))}`);
  {
    const ro = compile(src, { runtime: R.rt, image: R.img, assets: ASSETS15, ...CODEGEN_OFF }), co = ro.gen.code;
    const cnt = (seq) => { let n = 0; for (let i = 0; i + seq.length <= co.length; i++) if (seq.every((b, k) => co[i + k] === b)) n++; return n; };
    const sg = ro.gen.symbols.songs;
    check_('CODEGEN_OFF: PLAY tune is LD HL,song / CALL RT_MUSIC once for tune, jingle and hold (CALL RT_MUSIC three times, no JP), CALL RT_NOMUSIC once', ro.errors.length === 0 && ['TUNE', 'JINGLE', 'HOLD'].every((k) => cnt([...ldhl(sg[k]), ...call(S.RT_MUSIC)]) === 1) && cnt(call(S.RT_MUSIC)) === 3 && cnt(jp(S.RT_MUSIC)) === 0 && cnt(call(S.RT_NOMUSIC)) === 1, errText(ro));
  }
  void base;
  // the effects: channel C in a game with songs
  const tabAt = rd16(0x8000 + 10), n = mem[tabAt];
  const effAt = (i) => rd16(tabAt + 1 + 2 * i);
  check_('the sfx table has the four effects', n === 4);
  const bytesOf = (i, len) => mem.slice(effAt(i), effAt(i) + len);
  const wantC = ['blip', 'hiss', 'drone'].map((nm) => convertSfxC(ASSETS15.sfx[nm]).bytes);
  check_('with songs, blip, hiss and drone (one channel) are channel-C streams: the bytes of convertSfxC (header 0, 0, noise, 4)', same(bytesOf(0, wantC[0].length), wantC[0]) && same(bytesOf(1, wantC[1].length), wantC[1]) && same(bytesOf(3, wantC[2].length), wantC[2]));
  check_('... blip has no noise (byte 2 = 0), hiss has noise (byte 2 = 1)', mem[effAt(0) + 2] === 0 && mem[effAt(0) + 3] === 4 && mem[effAt(1) + 2] === 1 && mem[effAt(1) + 3] === 4);
  const chordB = convertSfx(ASSETS15.sfx.chord).bytes;
  check_('... the three-channel chord is unchanged (convertSfx, header 0, 0, 0, 3)', same(bytesOf(2, chordB.length), chordB) && mem[effAt(2) + 3] === 3);
  const dataSfx = ['blip', 'hiss', 'drone'].reduce((s, nm) => s + convertSfxC(ASSETS15.sfx[nm]).bytes.length, 0) + chordB.length + 1 + 2 * 4;
  eq('usage.data.sfx counts the channel-C images', res.usage.data.sfx, dataSfx);
  // without songs: the same effects are 4-byte records
  const noSongs = cmp(game('    IF t = 4 THEN PLAY blip ENDIF\n    IF t = 6 THEN PLAY chord ENDIF\n    IF t = 5 THEN PLAY hiss ENDIF\n    IF t = 7 THEN PLAY drone ENDIF\n', '', `GAME "t"\nFRAMERATE 60\n${SFX4}`), R);
  if (check_('the same effects in a game without MUSIC compile', noSongs.errors.length === 0, errText(noSongs))) {
    const m2 = noSongs.memory, r2 = (a) => m2[a] | (m2[a + 1] << 8), t2 = r2(0x8000 + 10);
    const ok1 = ['blip', 'hiss', null, 'drone'].every((nm, i) => nm === null || same(m2.slice(r2(t2 + 1 + 2 * i), r2(t2 + 1 + 2 * i) + convertSfx(ASSETS15.sfx[nm]).bytes.length), convertSfx(ASSETS15.sfx[nm]).bytes));
    check_('... without songs every one-channel effect is the old 4-byte records (convertSfx), no music data, no symbols.songs', ok1 && noSongs.usage.data.music === undefined && noSongs.gen.symbols.songs === undefined && !usageLines(noSongs.usage).some((l) => /^music:/.test(l)));
  }
  // NOMUSIC alone in a game without songs: RT_NOMUSIC is still called (it does nothing there)
  const nmOnly = cmp(game('    NOMUSIC\n', '', 'GAME "t"\n'), R);
  check_('NOMUSIC in a game without MUSIC compiles to CALL RT_NOMUSIC (JP RT_NOMUSIC: it is the last statement of FRAME) (with the checker\'s warning)', nmOnly.errors.length === 0 && (() => { const c = nmOnly.gen.code; for (let i = 0; i + 3 <= c.length; i++) if ((c[i] === 0xCD || c[i] === 0xC3) && c[i + 1] === (S.RT_NOMUSIC & 255) && c[i + 2] === S.RT_NOMUSIC >> 8) return true; return false; })() && nmOnly.warnings.some((w) => /NOMUSIC does nothing/.test(w.message)), errText(nmOnly));
  // ENTER keeps the song: the reset calls RT_SILENCE, never RT_NOMUSIC
  const ent = cmp(`${TOP}DIM t\nSCENE a\n  PROC INIT()\n    PLAY tune\n  ENDP\n  PROC FRAME()\n    ENTER b\n  ENDP\nENDSCENE\nSCENE b\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    t = t + 1\n    ENTER a\n  ENDP\nENDSCENE\n`, R);
  if (check_('a two-scene game with a song compiles', ent.errors.length === 0, errText(ent))) {
    const c = ent.gen.code, has = (a) => { for (let i = 0; i + 3 <= c.length; i++) if (c[i] === 0xCD && c[i + 1] === (a & 255) && c[i + 2] === a >> 8) return true; return false; };
    check_('... ENTER\'s reset calls RT_SILENCE and nothing calls RT_NOMUSIC (the song plays on across the switch)', has(S.RT_SILENCE) && !has(S.RT_NOMUSIC));
  }
  // PLAY song where the name is also a variable: the song
  const vs = cmp(game('    PLAY tune\n    tune = 4\n', '', TOP, 'DIM t, tune\n'), R);
  check_('PLAY tune with a variable tune: LD HL,song / CALL RT_MUSIC (the variable is not read)', vs.errors.length === 0 && (() => { const c = vs.gen.code, a = vs.gen.symbols.songs.TUNE; for (let i = 0; i + 6 <= c.length; i++) if (c[i] === 0x21 && c[i + 1] === (a & 255) && c[i + 2] === a >> 8 && c[i + 3] === 0xCD && c[i + 4] === (S.RT_MUSIC & 255)) return true; return false; })(), errText(vs));
  // a pattern no order entry names is still stored
  const extra = { ...ASSETS15, music: { ...ASSETS15.music, odd: { patterns: [{ ticks: [T(100, 5)] }, { ticks: [T(200, 6), T(201, 6)] }], order: [1, 1], loop: null } } };
  const ro = cmp(game('    PLAY odd\n', '', 'GAME "t"\nMUSIC odd = "odd"\n'), R, extra);
  if (check_('a song whose order list never names pattern 0 compiles', ro.errors.length === 0, errText(ro))) {
    const c = convertMusic(extra.music.odd), a = ro.gen.symbols.songs.ODD, m = ro.memory, rd = (x) => m[x] | (m[x + 1] << 8);
    check_('... pattern 0 is stored too, both pointers point at pattern 1 (after pattern 0), and the size is convertMusic\'s', ro.usage.data.music === c.bytes && rd(a + 1) === rd(a + 3) && rd(a + 1) === a + 1 + 6 + c.patterns[0].bytes.length);
  }
  // refusals
  const miss = cmp(game('    PLAY zz\n', '', 'GAME "t"\nMUSIC zz = "nosuch"\n'), R);
  check_('a song asset that is not in the project: "song asset "nosuch" is not in the project" at the declaration', miss.errors.some((e) => e.message === 'song asset "nosuch" is not in the project' && e.line === 2), errText(miss));
  check_('... and no cascade: PLAY zz is not read as a variable', miss.errors.length === 1, errText(miss));
  const broken = cmp(game('    PLAY bad\n', '', 'GAME "t"\nMUSIC bad = "bad"\n'), R, { music: { bad: { patterns: [{ ticks: [T(1, 1)] }], order: [], loop: null } } });
  check_('a broken song (empty order list): "song "bad": the song has an empty "order" list"', broken.errors.some((e) => e.message === 'song "bad": the song has an empty "order" list'), errText(broken));
  const loopBad = cmp(game('    PLAY bad\n', '', 'GAME "t"\nMUSIC bad = "bad"\n'), R, { music: { bad: { patterns: [{ ticks: [T(1, 1)] }], order: [0], loop: 3 } } });
  check_('a song whose loop is outside the order list: convertMusic\'s message', loopBad.errors.some((e) => /^song "bad": the song's loop is 3/.test(e.message)), errText(loopBad));
  const noRt = { rt: JSON.parse(JSON.stringify(R.rt)), img: R.img };
  delete noRt.rt.symbols.RT_MUSIC; delete noRt.rt.symbols.RT_NOMUSIC;
  const old = cmp(game('    PLAY tune\n    NOMUSIC\n', '', `GAME "t"\nMUSIC tune = "tune"\n`), noRt);
  check_('a runtime build without RT_MUSIC: "MUSIC needs RT_MUSIC and RT_NOMUSIC, which this runtime does not provide: rebuild the runtime (this build predates music)"', old.errors.some((e) => e.message === 'MUSIC needs RT_MUSIC and RT_NOMUSIC, which this runtime does not provide: rebuild the runtime (this build predates music)'), errText(old));
  check_('... and its NOMUSIC: "NOMUSIC needs RT_NOMUSIC, which this runtime does not provide: rebuild the runtime (this build predates music)"', old.errors.some((e) => e.message === 'NOMUSIC needs RT_NOMUSIC, which this runtime does not provide: rebuild the runtime (this build predates music)'), errText(old));
  if (RT[1]) {
    const v1 = cmp(game('    PLAY tune\n    NOMUSIC\n', '', `GAME "t"\nMUSIC tune = "tune"\n`), RT[1]);
    check_('a v1 runtime: "MUSIC is not supported yet in M3 (build with --runtime v2)" and the same for NOMUSIC', v1.errors.some((e) => e.message === 'MUSIC is not supported yet in M3 (build with --runtime v2)') && v1.errors.some((e) => e.message === 'NOMUSIC is not supported yet in M3 (build with --runtime v2)'), errText(v1));
  } else skip_('the v1 refusal', 'arcade/build/v1/runtime.json does not exist');
  // v3 and v4: the same image
  for (const v of [3, 4]) {
    if (!RT[v]) { skip_(`v${v}: the song image`, `arcade/build/v${v}/runtime.json does not exist`); continue; }
    const r = cmp(src, RT[v]);
    if (!check_(`v${v}: the same game compiles`, r.errors.length === 0, errText(r))) continue;
    const a = r.gen.symbols.songs.TUNE, c = convertMusic(ASSETS15.music.tune), m = r.memory;
    check_(`v${v}: tune's patterns are stored after its order list as on v2, and RT_MUSIC is called three times (CALL, or the tail JP)`, same(m.slice(a + 1 + 2 * (c.order.length + 1), a + c.bytes), [...c.patterns.flatMap((p) => [...p.bytes])]) && (() => { let k = 0; const cd = r.gen.code, x = RT[v].rt.symbols.RT_MUSIC; for (let i = 0; i + 3 <= cd.length; i++) if ((cd[i] === 0xCD || cd[i] === 0xC3) && cd[i + 1] === (x & 255) && cd[i + 2] === x >> 8) k++; return k === 3; })());
  }
}

// =================================================================================================================
// 3. Byte identity: games without MUSIC compile to the bytes of the compiler before M3
// =================================================================================================================
console.log('\n3. Byte identity: every example and fixture (no MUSIC) against the compiler before M3 (the new compiler with CODEGEN_OFF: the compiler size pass deliberately changes the default build\'s bytes)');
{
  const ref = process.env.ARCADE_M15_OLD ?? '237b18a';
  let tmp = null, oldCompile = null;
  try {
    tmp = mkdtempSync(join(tmpdir(), 'm15old-'));
    execFileSync('sh', ['-c', `git -C "${process.env.ARCADE_M15_GIT ?? ROOT}" archive ${ref} src | tar -x -C "${tmp}"`], { stdio: 'ignore' });      // (ARCADE_M15_GIT: the repository, when this copy of the tests runs outside it: the mutation runs)
    ({ compile: oldCompile } = await import(pathToFileURL(join(tmp, 'src/lang/arcade/arcade-compile.js')).href));
  } catch (e) { oldCompile = null; info(`the compiler of ${ref} could not be extracted (${e.message.split('\n')[0]})`); }
  if (!oldCompile) skip_('byte identity', `git archive ${ref} failed`);
  else {
    const progs = [];
    for (const dir of ['arcade/examples', 'arcade/tests/fixtures']) for (const f of readdirSync(join(ROOT, dir))) {
      if (!f.endsWith('.arc')) continue;
      const base = f.replace(/\.arc$/, '');
      const assets = [`${base}.assets.json`, `${base.replace(/-.*$/, '')}.assets.json`].map((a) => join(ROOT, dir, a)).find((p) => existsSync(p)) ?? join(ROOT, 'arcade/examples', `${base.replace(/-.*$/, '')}.assets.json`);
      progs.push({ src: join(dir, f), assets: existsSync(assets) ? assets : null });
    }
    let n = 0, bad = '', songGames = 0, strayBad = '', nd = 0, smaller = 0, badD = '';
    for (const p of progs) {
      const full = readFileSync(join(ROOT, p.src), 'utf8'), assets = p.assets ? JSON.parse(readFileSync(p.assets, 'utf8')) : {};
      // an example with songs (slice M5) is compared on its text without them: the old compiler cannot build MUSIC, and every other word of the game is the same
      const hasSongs = /^\s*MUSIC\s/im.test(full), text = hasSongs ? stripMusic(full) : full;
      if (hasSongs) {
        songGames++;
        const left = musicWordsIn(text), Rq = RT[requiredRuntime(text, assets).version] ?? RT[2], w = compile(text, { runtime: Rq.rt, image: Rq.img, assets });
        if (left.length || w.errors.length || w.warnings.length) strayBad += `${p.src}: ${left.length ? left.join(' ') + ' left; ' : ''}${w.errors.length ? 'errors ' + errText(w) + '; ' : ''}${w.warnings.length ? 'warnings ' + w.warnings.map((x) => x.message).join(' | ') + '; ' : ''}`;
      }
      for (const v of [2, 3, 4]) {
        if (!RT[v]) continue;
        const a = oldCompile(text, { runtime: RT[v].rt, image: RT[v].img, assets }), b = compile(text, { runtime: RT[v].rt, image: RT[v].img, assets, ...CODEGEN_OFF }), d = compile(text, { runtime: RT[v].rt, image: RT[v].img, assets });
        if (a.errors.length || b.errors.length) { if (a.errors.length !== b.errors.length) bad += `${p.src} v${v}: errors ${a.errors.length} vs ${b.errors.length}; `; continue; }
        nd++;
        // the default build: no errors either, a DCK, and no more code than the old compiler's
        if (d.errors.length === 0 && !!d.dck && d.gen.code.length <= a.gen.code.length) { if (d.gen.code.length < a.gen.code.length) smaller++; } else badD += `${p.src} v${v}; `;
        n++;
        if (!same(a.dck, b.dck)) bad += `${p.src} v${v}: DCK differs; `;
      }
    }
    check_(`${n} builds (every example and fixture that compiles, on v2 / v3 / v4; the examples with songs on their text without MUSIC, NOMUSIC and PLAY <song>) give a DCK byte-identical to the compiler of ${ref} (CODEGEN_OFF)`, bad === '' && n >= 15, bad || `${n} builds`);
    check_(`the default build of the same ${nd} programs compiles with no errors, gives a DCK and never has more code than the compiler of ${ref}; most have less`, badD === '' && nd === n && smaller >= n / 2, badD || `${smaller} of ${nd} smaller`);
    check_(`stripMusic of each of the ${songGames} examples with songs leaves no MUSIC / NOMUSIC word in the code and compiles (on the runtime it needs) with no errors and no warnings`, songGames >= 4 && strayBad === '', strayBad || `${songGames} examples`);
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}

// =================================================================================================================
// 4. The reference interpreter, hand-computed
// =================================================================================================================
console.log('\n4. The reference interpreter: songs and the shared chip (contract sections 2, 5a, 6)');
const SFX_ORDER = ['blip', 'hiss', 'chord', 'drone'], SONG_ORDER = ['tune', 'jingle', 'hold'];
const run = (src, ticks, extra = {}) => interpret(parse(src).ast, { version: 2, ticks, assets: ASSETS15, ...extra });
/** the calls of a hand program as expectChip events: FRAMERATE 60 so tick t = refresh t (INIT at 0) */
const evs = (list) => list.map(([f, op, name]) => ({ f, op, i: op === 'play' ? SFX_ORDER.indexOf(name) : op === 'music' ? SONG_ORDER.indexOf(name) : undefined }));
const regsSeries = (r) => [r.init.ay.regs, ...r.ticks.map((t) => t.ay.regs)];
/** every tick's registers against expectChip */
function againstExpect(name, src, ticks, events, extra = {}) {
  const r = run(src, ticks, extra), div = r.frameDiv;
  let bad = '';
  regsSeries(r).forEach((regs, t) => { const want = expectChip(ASSETS15, SFX_ORDER, SONG_ORDER, evs(events), t * div); if (!bad && JSON.stringify(regs) !== JSON.stringify(want)) bad = `tick ${t}: ${JSON.stringify(regs)} want ${JSON.stringify(want)}`; });
  check_(`${name}: ${ticks + 1} snapshots equal to expectChip`, bad === '', bad);
  return r;
}
{
  // a song alone
  const tuneRows = (n) => songRow(ASSETS15.music.tune, n);
  const r1 = againstExpect('tune alone, PLAYed in INIT', game('', '    PLAY tune\n'), 60, [[0, 'music', 'tune']]);
  eq('... after INIT nothing has sounded yet (V_SFX_ACTIVE = SB_MUS, every register 0)', [r1.init.ay.flags, r1.init.ay.regs], [SB_MUS, new Array(11).fill(0)]);
  eq('... tick 1 = the first row of pattern 0 written out: A tone 300 vol 12, B 600 vol 8, C 150 vol 7, mixer tones on / noise off ($38), noise 0', r1.ticks[0].ay.regs, [44, 1, 88, 2, 150, 0, 0, 0x38, 12, 8, 7]);
  eq('... tick 6 = row 5: A 340 vol 11 (the held notes changed)', r1.ticks[5].ay.regs, [84, 1, 88, 2, 151, 0, 0, 0x38, 11, 8, 7]);
  eq('... tick 9 = pattern 1 (order 1): A 280 vol 13, B 560 vol 9, C 140 vol 6 with noise 12 (mix 2: C noise on => R7 $18)', r1.ticks[8].ay.regs, [24, 1, 48, 2, 140, 0, 12, 0x18, 13, 9, 6]);
  const L = 8 + 6 + 8 + 2;      // one pass of the order list: 24 refreshes, then the loop to order 1 (row 8)
  eq('... the loop: tick 25 equals row 8 (order position 1), tick 31 equals row 14 (order 2 = pattern 0)', [r1.ticks[24].ay.regs, r1.ticks[30].ay.regs], [tuneRows(8), tuneRows(14)]);
  check_('... the song stays active (music.active, index 0) and V_SFX_ACTIVE = SB_MUS on every tick', r1.ticks.every((t) => t.music.active && t.music.index === 0 && t.ay.flags === SB_MUS) && L === 24);
  // jingle ends
  const r2 = againstExpect('jingle (no loop): 7 rows, then it ends', game('', '    PLAY jingle\n'), 12, [[0, 'music', 'jingle']]);
  eq('... tick 7 is its last row (A 450 vol 12, B 700 vol 10 only in its first row... B silent padding)', r2.ticks[6].ay.regs, songRow(ASSETS15.music.jingle, 6));
  eq('... tick 8: the song has ended: the volumes 0, the tones as they were, V_SFX_ACTIVE 0, music.active false', [r2.ticks[7].ay.regs.slice(8), r2.ticks[7].ay.regs.slice(0, 8), r2.ticks[7].ay.flags, r2.ticks[7].music.active], [[0, 0, 0], songRow(ASSETS15.music.jingle, 6).slice(0, 8), 0, false]);
  // a channel-C effect over a song
  const r3 = againstExpect('tune, then PLAY blip at tick 3 (channel C borrowed for 6 refreshes, the song plays on A and B)', game('    IF t = 3 THEN PLAY blip ENDIF\n', '    PLAY tune\n'), 20, [[0, 'music', 'tune'], [3, 'play', 'blip']]);
  // (code review fix: while a song plays RT_PLAY posts the effect, SB_NEW, and the next refresh installs it)
  eq('... right after the PLAY (tick 3) the effect is posted, not yet installed: V_SFX_ACTIVE = SB_MUS | SB_NEW = 10', r3.ticks[2].ay.flags, SB_MUS | 8);
  const b0 = ASSETS15.sfx.blip.ticks[0];
  eq('... tick 4: R4 R5 R10 are blip\'s first record (tone 120, vol 12), R7 = the song\'s bits outside $24 with blip\'s (tone on, noise off: $20), A and B are the song\'s row 3', r3.ticks[3].ay.regs, [...tuneRows(3).slice(0, 4), b0.tone & 255, b0.tone >> 8, tuneRows(3)[6], (tuneRows(3)[7] & 0xDB) | 0x20, tuneRows(3)[8], tuneRows(3)[9], b0.vol]);
  eq('... tick 4..9: V_SFX_ACTIVE = 3 (effect and song); tick 10: the effect is over and C is the song\'s again (= row 9)', [r3.ticks.slice(3, 9).map((t) => t.ay.flags), r3.ticks[9].ay.regs], [[3, 3, 3, 3, 3, 3], tuneRows(9)]);
  check_('... sfx.active for 6 ticks, rec 0..5 (the record each refresh output)', JSON.stringify(r3.ticks.slice(3, 10).map((t) => [t.sfx.active, t.sfx.rec])) === JSON.stringify([[true, 0], [true, 1], [true, 2], [true, 3], [true, 4], [true, 5], [false, -1]]));
  // a channel-C effect with noise: R6 is the effect's
  const r3b = againstExpect('tune, then PLAY hiss (noise: R6 borrowed too)', game('    IF t = 9 THEN PLAY hiss ENDIF\n', '    PLAY tune\n'), 24, [[0, 'music', 'tune'], [9, 'play', 'hiss']]);
  check_('... while hiss plays R6 is its noise (3 + k), not the song\'s 12', r3b.ticks.slice(9, 19).every((t, k) => t.ay.regs[6] === 3 + k));
  // a three-channel effect pauses the song
  const r4 = againstExpect('tune, then PLAY chord at tick 5: the song pauses for 8 refreshes and resumes where it was', game('    IF t = 5 THEN PLAY chord ENDIF\n', '    PLAY tune\n'), 30, [[0, 'music', 'tune'], [5, 'play', 'chord']]);
  const chordRows = sfxRefreshRegisters(ASSETS15.sfx.chord);
  eq('... ticks 6..13 are chord\'s rows (all eleven registers)', r4.ticks.slice(5, 13).map((t) => t.ay.regs), chordRows);
  eq('... tick 14: chord has ended and the song resumes with row 5 (it had played rows 0..4)', r4.ticks[13].ay.regs, tuneRows(5));
  // SILENCE during a channel-C effect over a song, NOMUSIC with and without an effect
  const r5 = againstExpect('tune + drone, SILENCE at tick 6 (the song gets C back at the next refresh)', game('    IF t = 3 THEN PLAY drone ENDIF\n    IF t = 6 THEN SILENCE ENDIF\n', '    PLAY tune\n'), 12, [[0, 'music', 'tune'], [3, 'play', 'drone'], [6, 'silence'], ]);
  eq('... tick 6 (the SILENCE): posted, the effect still on until the next refresh: V_SFX_ACTIVE = SB_FX | SB_MUS | SB_NEW; tick 7 = the song\'s row 6', [r5.ticks[5].ay.flags, r5.ticks[6].ay.regs], [SB_FX | SB_MUS | 8, tuneRows(6)]);
  const r6 = againstExpect('tune, NOMUSIC at tick 4 with nothing else playing: the volumes go to 0 AT ONCE', game('    IF t = 4 THEN NOMUSIC ENDIF\n', '    PLAY tune\n'), 8, [[0, 'music', 'tune'], [4, 'nomusic']]);
  eq('... tick 4: volumes 0, tones of row 3 kept, V_SFX_ACTIVE 0', [r6.ticks[3].ay.regs, r6.ticks[3].ay.flags], [[...tuneRows(3).slice(0, 8), 0, 0, 0], 0]);
  const r7 = againstExpect('tune + drone, NOMUSIC at tick 5: the effect plays on; A and B go quiet at the next refresh', game('    IF t = 3 THEN PLAY drone ENDIF\n    IF t = 5 THEN NOMUSIC ENDIF\n', '    PLAY tune\n'), 12, [[0, 'music', 'tune'], [3, 'play', 'drone'], [5, 'nomusic']]);
  eq('... tick 5: still sounding, V_SFX_ACTIVE = SB_FX | SB_SYNC; tick 6: R8 = R9 = 0, R10 = drone\'s volume', [r7.ticks[4].ay.flags, r7.ticks[4].ay.regs[8] > 0, r7.ticks[5].ay.regs[8], r7.ticks[5].ay.regs[9], r7.ticks[5].ay.regs[10]], [SB_FX | SB_SYNC, true, 0, 0, ASSETS15.sfx.drone.ticks[2].vol]);
  // songs replacing songs, restart
  const r8 = againstExpect('PLAY tune at 0, PLAY hold at 4, PLAY tune again at 9 (a restart from row 0)', game('    IF t = 4 THEN PLAY hold ENDIF\n    IF t = 9 THEN PLAY tune ENDIF\n', '    PLAY tune\n'), 14, [[0, 'music', 'tune'], [4, 'music', 'hold'], [9, 'music', 'tune']]);
  eq('... tick 5 = hold\'s row 0, tick 10 = tune\'s row 0, music.index follows (0, 2, 0)', [r8.ticks[4].ay.regs, r8.ticks[9].ay.regs, r8.ticks[2].music.index, r8.ticks[4].music.index, r8.ticks[9].music.index], [songRow(ASSETS15.music.hold, 0), tuneRows(0), 0, 2, 0]);
  const r8b = againstExpect('PLAY tune while tune plays (tick 6) restarts it', game('    IF t = 6 THEN PLAY tune ENDIF\n', '    PLAY tune\n'), 10, [[0, 'music', 'tune'], [6, 'music', 'tune']]);
  eq('... tick 7 = row 0 again', r8b.ticks[6].ay.regs, tuneRows(0));
  // hold: one pattern of 300 identical refreshes = wait items longer than 127
  againstExpect('hold: 300 refreshes of one held chord (waits of 127 + 127 + 45), looping', game('', '    PLAY hold\n'), 620, [[0, 'music', 'hold']]);
  // ENTER: the song plays on, the effect stops
  const ent = `${TOP}DIM t\nSCENE a\n  PROC INIT()\n    PLAY tune\n  ENDP\n  PROC FRAME()\n    t = t + 1\n    IF t = 2 THEN PLAY drone ENDIF\n    IF t = 4 THEN ENTER b ENDIF\n  ENDP\nENDSCENE\nSCENE b\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    t = t + 1\n  ENDP\nENDSCENE\n`;
  const r9 = againstExpect('ENTER at tick 4: the reset stops the effect (SILENCE), the song plays on', ent, 12, [[0, 'music', 'tune'], [2, 'play', 'drone'], [4, 'silence']]);
  check_('... after the switch the song is still active and its registers follow its rows (tick 6 = row 5)', r9.ticks[5].music.active && r9.ticks[5].scene === 1 && JSON.stringify(r9.ticks[5].ay.regs) === JSON.stringify(tuneRows(5)));
  // FRAMERATE 30: two refreshes a tick
  const fr30 = game('    IF t = 2 THEN PLAY blip ENDIF\n', '    PLAY tune\n', TOP.replace('FRAMERATE 60', 'FRAMERATE 30'));
  const r10 = interpret(parse(fr30).ast, { version: 2, ticks: 12, assets: ASSETS15 });
  let bad10 = '';
  [r10.init, ...r10.ticks].forEach((rec, t) => { const want = expectChip(ASSETS15, SFX_ORDER, SONG_ORDER, evs([[0, 'music', 'tune'], [4, 'play', 'blip']]), 2 * t); if (!bad10 && JSON.stringify(rec.ay.regs) !== JSON.stringify(want)) bad10 = `tick ${t}`; });
  check_('FRAMERATE 30: two refreshes between ticks (tick t sees refresh 2t; the PLAY of tick 2 is made after refresh 4)', bad10 === '' && r10.frameDiv === 2, bad10);
  // PLAY by index stays an effect index in a game with songs; past the table nothing
  const r11 = againstExpect('PLAY t MOD 6 at tick 1 (effect 1 = hiss) and PLAY 5 (past the table: nothing) at tick 2', game('    IF t = 1 THEN PLAY t MOD 6 ENDIF\n    IF t = 2 THEN PLAY t + 3 ENDIF\n', '    PLAY tune\n'), 14, [[0, 'music', 'tune'], [1, 'play', 'hiss']]);
  check_('... the index played hiss (sfx.index 1) and the PLAY past the table left it alone', r11.ticks[1].sfx.index === 1 && r11.ticks[1].sfx.active);
  // the clock: calls placed at the refreshes the machine showed
  const clockSrc = game('    IF t = 3 THEN PLAY blip ENDIF\n    IF t = 5 THEN NOMUSIC ENDIF\n', '    PLAY tune\n');
  const clock = { play: (t, n) => ({ 3: 21 })[t] ?? 0, music: (t, n) => ({ 0: 10, 5: 30 })[t] ?? 0, sample: (t) => 11 + 4 * t };      // (calls of tick t lie between the samples of t - 1 and t)
  const rc = run(clockSrc, 8, { clock });
  let badC = '';
  [rc.init, ...rc.ticks].forEach((rec, t) => { const want = expectChip(ASSETS15, SFX_ORDER, SONG_ORDER, [{ f: 10, op: 'music', i: 0 }, { f: 21, op: 'play', i: 0 }, { f: 30, op: 'nomusic' }], 11 + 4 * t); if (!badC && JSON.stringify(rec.ay.regs) !== JSON.stringify(want)) badC = `tick ${t}: ${rec.ay.regs} want ${want}`; });
  check_('with opts.clock: the song starts after refresh 10, blip after 21, NOMUSIC after 30, samples at 11 + 4t: every snapshot equals expectChip at those refreshes', badC === '', badC);
  let threw = '';
  try { run(clockSrc, 2, { clock: { play: () => 0, sample: () => 0 } }); } catch (e) { threw = e.message; }
  eq('a clock with no music(): the interpreter refuses ("interp: unsupported PLAY of a song or NOMUSIC with a clock that has no music(tick, n)")', threw, 'interp: unsupported PLAY of a song or NOMUSIC with a clock that has no music(tick, n)');
  // a game without songs keeps the old records
  const plain = run(game('    IF t = 2 THEN PLAY blip ENDIF\n', '', `GAME "t"\nFRAMERATE 60\n${SFX4}`), 6);
  check_('a game without MUSIC: no `music` or `ay` key in any record, the old sfx model (blip active for 6 refreshes)', [plain.init, ...plain.ticks].every((t) => !('music' in t) && !('ay' in t)) && plain.ticks[2].sfx.active && plain.ticks[2].sfx.rec === 0 && !('songNames' in plain));
  const nmPlain = run(game('    NOMUSIC\n', '', 'GAME "t"\n'), 3, { clock: { play: () => 0, sample: () => 0 } });
  check_('NOMUSIC in a game without songs runs under a clock that has no music() (nothing to place)', nmPlain.ticks.length === 3);
  eq('songNames in the result (declaration order)', run(game('', '    PLAY tune\n'), 1).songNames, ['tune', 'jingle', 'hold']);
}

// =================================================================================================================
// 5. The chip model against expectChip on random scripts
// =================================================================================================================
console.log('\n5. arcade-sound.js (the interpreter\'s chip) against expectChip (rows of the records) on random scripts');
{
  const imgs = SFX_ORDER.map((n) => { const c = convertSfx(ASSETS15.sfx[n]); return c.channels === 1 ? convertSfxC(ASSETS15.sfx[n]).bytes : c.bytes; });
  const songs = SONG_ORDER.map((n) => convertMusic(ASSETS15.music[n]));
  const N = QUICK ? 120 : 400, LEN = 300;
  let bad = '', calls = 0, cover = { cOverSong: 0, paused: 0, pend: 0, ended: 0 };
  for (let seed = 1; seed <= N && !bad; seed++) {
    const r = rng(seed * 31 + 5), events = [];
    for (let f = 0; f < LEN; f++) while (r() < 0.07) {
      const k = Math.floor(r() * 6);
      events.push(k <= 1 ? { f, op: 'play', i: Math.floor(r() * 6) } : k === 2 ? { f, op: 'silence' } : k === 3 ? { f, op: 'music', i: Math.floor(r() * 3) } : k === 4 ? { f, op: 'nomusic' } : { f, op: 'play', i: Math.floor(r() * 4) });
    }
    calls += events.length;
    const chip = createSoundChip(imgs, songs);
    let e = 0;
    for (let f = 0; f < LEN && !bad; f++) {
      if (f > 0) chip.refresh();
      while (e < events.length && events[e].f === f) { const x = events[e++]; if (x.op === 'play') chip.play(x.i); else if (x.op === 'silence') chip.silence(); else if (x.op === 'music') chip.music(x.i); else chip.nomusic(); }
      const want = expectChip(ASSETS15, SFX_ORDER, SONG_ORDER, events, f), fl = chip.flags();
      if (JSON.stringify(want) !== JSON.stringify(chip.regs())) bad = `seed ${seed} refresh ${f}: ${chip.regs()} want ${want}`;
      if ((fl & 3) === 3 && chip.effect() !== 2) cover.cOverSong++;
      if ((fl & 3) === 3 && chip.effect() === 2) cover.paused++;
      if (fl & SB_SYNC) cover.pend++;
    }
  }
  info(`${N} scripts x ${LEN} refreshes, ${calls} calls; refreshes with a channel-C effect over a song ${cover.cOverSong}, with the song paused by chord ${cover.paused}, with a request pending ${cover.pend}`);
  check_(`${N} random scripts: the chip after every call and refresh equals expectChip`, bad === '' && cover.cOverSong > 100 && cover.paused > 50 && cover.pend > 10, bad);
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? ` (${skipped} skipped)` : ''}`);
process.exit(failed === 0 ? 0 : 1);
