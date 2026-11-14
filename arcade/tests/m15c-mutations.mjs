"use strict";
// m15c-mutations.mjs -- mutation test of the MUSIC LANGUAGE suites (slice M3, docs/ARCADE_MUSIC_CONTRACT.md sections 2, 4, 6): copies the compiler (src/), the tests and the runtime builds to a
// temporary directory, applies ONE deliberate bug at a time to the new code (the interpreter's chip model arcade-sound.js, the song / NOMUSIC / channel-C code generation in arcade-codegen.js,
// the interpreter's song and clock handling in arcade-interp.js, the new checks in arcade-check.js, the parser's NOMUSIC / PLAY name, the word table) and runs the M3 suites in their quick form;
// a mutation is KILLED when at least one of them fails. (Like m10c-mutations.mjs these break JavaScript, so there is no rebuild. The runtime's own mutations are m15-mutations.mjs.)
//   node arcade/tests/m15c-mutations.mjs [name-fragment]     (about 10-20 s per mutant)
//   node arcade/tests/m15c-mutations.mjs --check             only verifies that every pattern occurs exactly once
//   node arcade/tests/m15c-mutations.mjs --shard=0/4         every fourth mutant (run the shards in parallel)
//   TMPDIR=<dir> to choose where the scratch copy lives.
// A mutant whose name starts with "EQUIVALENT:" changes no behaviour anyone can observe (the name says why); it is expected to survive, is counted separately, and does not fail the run.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const only = args.find((a) => !a.startsWith('--'));
const shardArg = args.find((a) => a.startsWith('--shard='));
const [shardI, shardN] = shardArg ? shardArg.slice(8).split('/').map(Number) : [0, 1];
const TESTS = ['tests/arcade-m15-compiler.mjs', 'tests/arcade-m15-differential.mjs', 'tests/arcade-m10-compiler.mjs'];      // (not arcade-parse.mjs: it reads docs/, which the scratch copy leaves out)

const SD = 'src/lang/arcade/arcade-sound.js', IN = 'src/lang/arcade/arcade-interp.js', CG = 'src/lang/arcade/arcade-codegen.js', CK = 'src/lang/arcade/arcade-check.js';
const PA = 'src/lang/arcade/arcade-parse.js', WO = 'src/lang/arcade/arcade-words.js';
const E = (file, from, to) => ({ file, from, to });
const MUTANTS = [
  // ---- the interpreter's chip (arcade-sound.js) ----
  ['chip: a noisy channel-C effect does not own R6', [E(SD, '5: [4, 5, 6, 10] };', '5: [4, 5, 10] };')]],
  ['chip: the channel-C bits of R7 are $04 only', [E(SD, 'const C_BITS = 0x24;', 'const C_BITS = 0x04;')]],
  ['EQUIVALENT: chip: SYNC with a song ignores the shared R7 (MUS_OWN[7] = 2 only while a channel-C effect is set up, and every SYNC made then -- the posted one before its first entry -- is followed in the same refresh by that first entry, which writes R7 merged: the final R7 is the same)', [E(SD, 'chip[r] = own[r] === 2 ? (mus[r] & ~C_BITS & 0xFF) | (chip[7] & C_BITS) : mus[r];', 'chip[r] = mus[r];')]],
  ['chip: SYNC without a song zeroes the effect\'s volume too', [E(SD, '} else for (let r = 8; r <= 10; r++) if (own[r] === 0) chip[r] = 0;', '} else for (let r = 8; r <= 10; r++) chip[r] = 0;')]],
  ['chip: calls never post (always sync at once)', [E(SD, 'const syncOrPost = () => { if (song || pending) pending = true; else sync(); };', 'const syncOrPost = () => { sync(); };')]],
  ['chip: an effect\'s end keeps its ownership', [E(SD, 'const fxEnd = () => { fx = null; own = ownFor(0); sync(); };', 'const fxEnd = () => { fx = null; sync(); };')]],
  ['chip: a channel-C R7 replaces the song\'s bits', [E(SD, 'if (fx.type >= 4 && r === 7) v = (v & C_BITS) | (chip[7] & ~C_BITS & 0xFF);', '')]],
  ['chip: a wait holds one refresh more', [E(SD, 'if (x >= 0x80) { g.wait = x - 0x80; return; }', 'if (x >= 0x80) { g.wait = x - 0x7F; return; }')]],
  ['chip: the loop goes to order position 0', [E(SD, '          g.ord = g.s.loop;', '          g.ord = 0;')]],
  ['chip: a song that ends leaves its volumes up', [E(SD, 'if (g.s.loop === 0xFF) { song = null; sync(); return; }', 'if (g.s.loop === 0xFF) { song = null; return; }')]],
  ['chip: a three-channel effect does not pause the song', [E(SD, 'if (song && !(fx && fx.type < 4)) songStep();', 'if (song) songStep();')]],
  ['chip: the song writes the shared R7 whole', [E(SD, 'chip[r] = own[r] === 2 ? (v & ~C_BITS & 0xFF) | (chip[7] & C_BITS) : v;', 'chip[r] = v;')]],
  ['chip: the song writes the effect\'s registers', [E(SD, '        mus[r] = v;\n        if (own[r] === 1) continue;', '        mus[r] = v;')]],
  ['EQUIVALENT: chip: RT_MUSIC does not copy the chip into the song\'s shadow (the copy only spares WRITES: before the song\'s first item every SYNC that reads the shadow is followed in the same refresh by that item, which writes all eleven registers; the model keeps states, not writes)', [E(SD, '      mus = chip.slice();', '      mus = new Array(11).fill(0);')]],
  ['chip: NOMUSIC during an effect syncs at once', [E(SD, '      if (fx || pending || posted) pending = true; else sync();', '      sync();')]],
  // (code review fix: RT_PLAY / RT_SILENCE post the effect while a song plays; the next refresh installs it)
  ['chip: PLAY during a song installs the effect at once (not posted)', [E(SD, '      if (song) { posted = { i, bytes, type }; return; }', '')]],
  ['chip: a posted effect is never installed', [E(SD, '        fx = p.type ? { index: p.i, bytes: p.bytes, type: p.type, pos: p.type === 1 ? 0 : 4 } : null;', '        fx = null;')]],
  ['chip: SILENCE during a song stops the effect at once (not posted)', [E(SD, 'posted = null; if (song) { posted = { type: 0 }; return; } fx = null;', 'posted = null; fx = null;')]],
  ['chip: type 5 (noise) read as type 4', [E(SD, "bytes[3] === 4 ? 4 + (bytes[2] ? 1 : 0) : 1;", "bytes[3] === 4 ? 4 : 1;")]],
  ['chip: the request flag is never cleared', [E(SD, 'if (pending) { pending = false; sync(); }', 'if (pending) { sync(); }')]],
  ['chip: the next pattern starts one refresh late', [E(SD, '        g.pat = g.s.order[g.ord]; g.at = 0;\n        continue;', '        g.pat = g.s.order[g.ord]; g.at = 0;\n        return;')]],
  ['EQUIVALENT: chip: RT_PLAY of an index past 8 effects plays (a game has at most 8 SFX: the checker and the generator refuse a 9th)', [E(SD, 'if (i < 0 || i >= Math.min(effects.length, 8)) return;', 'if (i < 0 || i >= effects.length) return;')]],
  // ---- the interpreter (arcade-interp.js) ----
  ['interp: SILENCE stops the song too', [E(IN, "case 'Silence': sfx.active = false; playCall(); if (chip) chip.silence(); return null;", "case 'Silence': sfx.active = false; playCall(); if (chip) { chip.silence(); chip.nomusic(); } return null;")]],
  ['interp: ENTER stops the song', [E(IN, 'sfx.active = false; playCall(); if (chip) chip.silence();                                 // SILENCE (the song plays on)', 'sfx.active = false; playCall(); if (chip) { chip.silence(); chip.nomusic(); }')]],
  ['interp: one-channel effects not on channel C in a game with songs', [E(IN, 'c.channels === 1 ? convertSfxC(as).bytes : c.bytes);', 'c.bytes);')]],
  ['interp: RT_MUSIC not placed at its refresh', [E(IN, "          if (clock) soundTo(musicClock());\n          chip.music(k); lastSong = k;", "          if (clock) musicClock();\n          chip.music(k); lastSong = k;")]],
  ['interp: RT_PLAY not placed at its refresh', [E(IN, 'if (chip) { if (clock) soundTo(sfx.t0); chip.play(i); sfx.at = soundAt; }', 'if (chip) { chip.play(i); sfx.at = soundAt; }')]],
  ['interp: RT_NOMUSIC not placed at its refresh', [E(IN, 'if (chip) { if (clock) soundTo(musicClock()); chip.nomusic(); }', 'if (chip) { if (clock) musicClock(); chip.nomusic(); }')]],
  ['interp: the snapshot is not run to the sample', [E(IN, '      if (clock) soundTo(clock.sample(tick));\n', '')]],
  ['interp: one refresh short between ticks', [E(IN, 'if (chip) for (let k = 0; k < n; k++) { chip.refresh(); soundAt++; }', 'if (chip) for (let k = 1; k < n; k++) { chip.refresh(); soundAt++; }')]],
  ['interp: music.index not updated', [E(IN, 'chip.music(k); lastSong = k;', 'chip.music(k);')]],
  ['interp: songs by index too (PLAY expr reaches a song)', [E(IN, "if (v >= sfxNames.length) { if (clock) ++playN; return null; }", "if (v >= sfxNames.length) { if (chip && v - sfxNames.length < songNames.length) { chip.music(v - sfxNames.length); lastSong = v - sfxNames.length; } if (clock) ++playN; return null; }")]],
  ['EQUIVALENT: interp: NOMUSIC of a game without songs not counted for the clock (the count is read only by music(), which a game without songs never asks)', [E(IN, '} else if (clock) musicN++;', '}')]],
  // ---- the code generator ----
  ['codegen: every order entry points at pattern 0', [E(CG, 'for (const k of sg.order) e.dw(L(`song$${i}$${k}`));', 'for (const k of sg.order) e.dw(L(`song$${i}$0`));')]],
  ['codegen: no DW 0 after the order list', [E(CG, '        e.dw(0);\n        sg.patterns.forEach', '        sg.patterns.forEach')]],
  ['codegen: the loop byte is always $FF', [E(CG, 'e.label(`song$${i}`); e.db(sg.loop);', 'e.label(`song$${i}`); e.db(0xFF);')]],
  ['codegen: PLAY song always starts song 0', [E(CG, "e.ld('hl', L(`song$${songIndex.get(up(s.sfx.name))}`));", "e.ld('hl', L('song$0'));")]],
  ['codegen: NOMUSIC calls RT_SILENCE', [E(CG, "case 'NoMusic': e.call(need('RT_NOMUSIC')); return;", "case 'NoMusic': e.call(need('RT_SILENCE')); return;")]],
  ['codegen: one-channel effects stay 4-byte records with songs', [E(CG, 'if (hasSongs && c.channels === 1) c = convertSfxC(asset);', 'if (false && c.channels === 1) c = convertSfxC(asset);')]],
  ['codegen: channel-C effects in every v2 game', [E(CG, 'const hasSongs = v2 && songKeys.size > 0;', 'const hasSongs = v2;')]],
  ['codegen: dataBytes.music one byte off', [E(CG, 'dataSize.music = songList.reduce((n, sg) => n + sg.bytes, 0);', 'dataSize.music = songList.reduce((n, sg) => n + sg.bytes, 1);')]],
  ['EQUIVALENT: codegen: the scans read a song name as an index expression (the generation itself still emits LD HL,song: the three scans only collect calls and the variables an expression reads, and a song name read as a variable can at most mark an implicit FOR local of that name for clearing -- a few bytes, no behaviour)', [E(CG, '&& !songKeys.has(up(s.sfx.name)));', ');')]],
  ['codegen: a missing song asset not reported', [E(CG, 'if (asset === undefined) { err(a, `song asset "${a.asset}" is not in the project`); continue; }', 'if (asset === undefined) continue;')]],
  ['EQUIVALENT: codegen: the 9th song is accepted (the checker refuses a 9th MUSIC first: compile() never reaches the generator with one)', [E(CG, 'if (songList.length >= MAX_SONGS) { err(a,', 'if (songList.length > MAX_SONGS) { err(a,')]],
  // ---- the checker, the parser, the word table ----
  ['check: 9 songs allowed', [E(CK, "if (kind === 'music' && ++songNo > LIMITS.maxSongs)", "if (kind === 'music' && ++songNo > LIMITS.maxSongs + 1)")]],
  ['check: a name that is both an SFX and a MUSIC is accepted', [E(CK, "if (this.assets.has(`sfx:${key}`)) { this.assets.get(`sfx:${key}`).used = true; this.err(", "if (false) { this.assets.get(`sfx:${key}`).used = true; this.err(")]],
  ['check: no "MUSIC never used" warning', [E(CK, "a.kind === 'sprite' || a.kind === 'sfx' || a.kind === 'music' || a.kind === 'model') this.warn", "a.kind === 'sprite' || a.kind === 'sfx' || a.kind === 'model') this.warn")]],
  ['check: the NOMUSIC warning in every game', [E(CK, "if (![...this.assets.values()].some((a) => a.kind === 'music')) this.warn(s, 'NOMUSIC does nothing", "if (true) this.warn(s, 'NOMUSIC does nothing")]],
  ['check: a PLAYed song stays "never used"', [E(CK, '      if (song) {\n        song.used = true;', '      if (song) {\n        void 0;')]],
  ['parse: NOMUSIC takes an argument silently', [E(PA, "if (!isEnd(a) && !isBlockWord(a)) this.fail(a, 'NOMUSIC takes nothing", "if (false) this.fail(a, 'NOMUSIC takes nothing")]],
  ['parse: PLAY of a word that names an asset fails', [E(PA, "if (a.type === 'keyword' && BATCH11_WORDS.has(a.value) && (isEnd(this.peek(1))", "if (false && (isEnd(this.peek(1))")]],
  ['words: MUSIC is no asset kind', [E(WO, ", MAP: 'map', MUSIC: 'music', MODEL: 'model' });", ", MAP: 'map', MODEL: 'model' });")]],
];

if (checkOnly) {
  let bad = 0;
  for (const [name, edits] of MUTANTS) for (const e of edits) {
    if (!existsSync(join(ROOT, e.file))) { console.log(`  ?? ${name}: ${e.file} does not exist`); bad++; continue; }
    const src = readFileSync(join(ROOT, e.file), 'utf8');
    const n = src.split(e.from).length - 1;
    if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad++; }
  }
  console.log(`${MUTANTS.length} mutants, ${bad} bad patterns`);
  process.exit(bad ? 1 : 0);
}

// The unmutated suites must pass first, else every "kill" would be the suite's own failure.
if (!only && shardI === 0 || args.includes('--baseline')) {
  for (const t of TESTS) {
    const r = spawnSync('node', [join(ROOT, t)], { encoding: 'utf8', timeout: 900000, env: { ...process.env, ARCADE_QUICK: '1' }, cwd: ROOT });
    if (r.status !== 0 || r.error) { console.log(`  BASELINE FAILS: ${t} fails without any mutation; fix it before trusting the kills`); process.exit(2); }
  }
}
const tmp = mkdtempSync(join(tmpdir(), 'm15cmut-'));
let killed = 0;
const survived = [], equivalent = [], broken = [];
try {
  for (const [mi, [name, edits]] of MUTANTS.entries()) {
    if (only && !name.includes(only)) continue;
    if (mi % shardN !== shardI) continue;
    const root = join(tmp, 'root');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, 'arcade/build'), { recursive: true });
    cpSync(join(ROOT, 'src'), join(root, 'src'), { recursive: true });
    cpSync(join(ROOT, 'tests'), join(root, 'tests'), { recursive: true });
    for (const d of ['examples', 'tests', 'runtime', 'tools']) cpSync(join(ROOT, 'arcade', d), join(root, 'arcade', d), { recursive: true });
    for (const v of ['v1', 'v2', 'v3', 'v4']) for (const f of ['runtime.json', 'runtime.bin']) { if (!existsSync(join(ROOT, 'arcade/build', v, f))) continue; mkdirSync(join(root, 'arcade/build', v), { recursive: true }); cpSync(join(ROOT, 'arcade/build', v, f), join(root, 'arcade/build', v, f)); }
    symlinkSync(join(ROOT, 'tsrun'), join(root, 'tsrun'));
    let bad = false;
    for (const e of edits) {
      const p = join(root, e.file);
      const src = readFileSync(p, 'utf8');
      const n = src.split(e.from).length - 1;
      if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad = true; break; }
      writeFileSync(p, src.replace(e.from, () => e.to));
    }
    if (bad) { broken.push(name); continue; }
    let failedBy = null;
    for (const t of TESTS) {
      // (the compiler suite's byte-identity section extracts the old compiler with git archive from the real repository)
      const r = spawnSync('node', [join(root, t)], { encoding: 'utf8', timeout: 900000, env: { ...process.env, ARCADE_QUICK: '1', ARCADE_M15_GIT: ROOT }, cwd: root });
      const out = (r.stdout ?? '') + (r.stderr ?? '');
      if (r.status !== 0 || r.error) { failedBy = t.replace('tests/', '') + ': ' + ((out.match(/FAIL  .*/g) ?? [out.split('\n').filter(Boolean).pop()])[0] ?? '').slice(0, 110); break; }
    }
    if (failedBy) { killed++; console.log(`  killed       ${name}  <- ${failedBy}`); }
    else if (name.startsWith('EQUIVALENT:')) { equivalent.push(name); console.log(`  equivalent   ${name}  (survived, as expected)`); }
    else { survived.push(name); console.log(`  SURVIVED     ${name}`); }
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
const ran = killed + survived.length + equivalent.length + broken.length;
console.log(`\n${ran} mutants run: ${killed} killed, ${equivalent.length} equivalent (expected to survive), ${survived.length} survived${broken.length ? `, ${broken.length} with a bad pattern` : ''}`);
for (const s of survived) console.log('  survivor: ' + s);
process.exit(survived.length || broken.length ? 1 : 0);
