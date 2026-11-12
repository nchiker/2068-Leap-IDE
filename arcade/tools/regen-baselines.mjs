"use strict";
// regen-baselines.mjs -- regenerate the hash baselines of arcade/tests/fixtures (batch1-, batch2-, batch3-baseline.json). Two modes.
//
//   node arcade/tools/regen-baselines.mjs [--old <git ref>]
//     DEFAULT (a RUNTIME change moved the RT_* / variable addresses that compiled games embed): every baseline program is compiled by a PREVIOUS compiler
//     (the src/ of a git ref, default HEAD) and by the working-tree compiler; the two must agree byte for byte, and only then are the hashes rewritten.
//     batch2 / batch3: against the real runtimes in arcade/build (DCK, game area, code length). batch1: against its stand-in runtime (game area, code length),
//     the same compile tests/arcade-m5.mjs section 8 makes. It keeps the guarantee "programs that use none of the new words compile to the same bytes".
//     (Build the runtimes first: node arcade/tools/build-runtime-v2.mjs, v3.)
//
//   node arcade/tools/regen-baselines.mjs --accept-codegen-change <git ref>
//     ACCEPT A CODE-GENERATION CHANGE (docs/ARCADE_COMPILER_SIZE_CONTRACT.md sections 3, 7 and 8): the new compiler gives different bytes on purpose, and
//     the guard is BEHAVIOUR instead of bytes.  Every program of the three baselines is compiled by the OLD compiler (src/ of <ref>) and by the NEW one
//     (the working tree) against the same real runtime (arcade/build/v<n>, n = the record's `runtime`; batch1's v0 / v1 records run on v2, see below).
//     BOTH builds are run on the REAL runtime (the cartridge on a stock TS2068 in TSRun, tests/arcade-m5-harness.mjs) for --ticks ticks (default 300) with the
//     SAME input, and EACH must equal the reference interpreter driven by THAT run's own recorded clock (the differential suites' comparison: `interpFor(src,
//     assets, got)` gives the interpreter the run's refreshes, its RANDOMISE seeds and its sound calls' refreshes; `diffRecords` compares, every tick, the
//     variables and arrays by name, the sprites, the 768 cells and attributes, cursor, text attribute and border, and, for a game with songs, the sound
//     (compareSoundRun: V_SFX_ACTIVE, AY shadow, chip).  Why not old against new: a faster build ends a tick in another refresh and a game that seeds RND from the
//     frame counter (blockfall-v1) then plays other pieces; that is timing, not behaviour, and the interpreter is told the clock.)  Old against new directly, and
//     the slot layout (hidden slots may go: only named variables are compared), are printed as INFO lines.  Only if both builds of every program equal the
//     interpreter on every tick are the records rewritten: the new hashes /
//     byte counts go in, the old ones are kept as prevSha256 / prevBytes (batch1) or prevDckSha256 / prevAreaSha256 / prevBytes / prevDckBytes (batch2 / 3)
//     and `acceptedFrom` says the ref.  If any program differs the tool prints where (program, tick, first field), rewrites nothing and exits 1.
//     Condition (a) of the contract -- the full `node arcade/tests/run-all.mjs` and the game suites pass with the new compiler except the hash checks --
//     is NOT checked here: it is the caller's job (a reminder is printed).
//   Options:  --ticks <n>        ticks to run each game (default 300; at least 300 for an acceptance)
//             --fixtures <dir>   read and write <dir>/batchN-baseline.json instead of arcade/tests/fixtures (the programs' sources stay the repo's)
//             --dry-run          compare and report, write nothing
//             --only <text>      only the programs whose src contains <text> (never writes: for looking at one program)
//   Environment (NEGATIVE CONTROL, proves a behaviour change is refused): REGEN_PERTURB=ret makes the new compiler's PROC FRAME return at once (patched in the
//             image and the DCK); REGEN_PERTURB=<n> (a number) flips bit 0 of the code byte n bytes after the entry of PROC FRAME.
//
// THE INPUT (the same for old and new, a function of the tick only, fixed seed): segments of 3..10 ticks (a 32-bit LCG, seed 0xC0DE1234, one stream per game).
// In each segment player 1's stick and player 2's stick each take one of 15 values: neutral, the four directions (1 up, 2 down, 4 left, 8 right: V2 stick
// bits), the four diagonals, and each of those with FIRE (16) added half of the time that fire is drawn; and each key the program reads (every character
// in a KEYDOWN / KEYPRESS call of the source, plus SPACE, ENTER) is held with probability 1/4.  Ticks 1..4 hold nothing.  So title screens are passed
// (fire / space / enter are held in about a quarter of the segments each), movement and every key-driven branch are exercised.  The tool also reports, per
// program, on how many ticks the state moved (a run in which nothing happens would prove nothing).
//
// batch1 programs (batch1-baseline.json) are hashed against a STAND-IN runtime (no real runtime to run on).  Their behaviour is run on the real runtime v2
// (the one with the batch 1 routines): a record for runtime 0 or 1 compiles for v2 as well (a program that uses no later feature means the same there).
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);
const accept = args.includes('--accept-codegen-change');
const ref = accept ? opt('--accept-codegen-change') : (opt('--old') ?? 'HEAD');
if (!ref || ref.startsWith('--')) { console.error('usage: regen-baselines.mjs [--old <ref>] | --accept-codegen-change <ref> [--ticks n] [--fixtures dir] [--dry-run]'); process.exit(2); }
const FIX = opt('--fixtures') ? resolve(process.cwd(), opt('--fixtures')) : join(ROOT, 'arcade/tests/fixtures');
const TICKS = Number(opt('--ticks') ?? 300);
const ONLY = opt('--only');
const DRY = args.includes('--dry-run') || ONLY !== null;
const PERTURB = process.env.REGEN_PERTURB ?? null;
const sha = (b) => createHash('sha256').update(b).digest('hex');

const tmp = mkdtempSync(join(tmpdir(), 'regen-'));
try {
  execFileSync('sh', ['-c', `git -C "${ROOT}" archive ${ref} src | tar -x -C "${tmp}"`]);
  const { compile: oldCompile } = await import(pathToFileURL(join(tmp, 'src/lang/arcade/arcade-compile.js')).href);
  const { compile: newCompile0 } = await import(pathToFileURL(join(ROOT, 'src/lang/arcade/arcade-compile.js')).href);
  const newCompile = PERTURB === null ? newCompile0 : (src, o) => perturb(newCompile0(src, o));
  const load = (v) => { const rt = JSON.parse(readFileSync(join(ROOT, `arcade/build/${v}/runtime.json`))); return { rt, image: new Uint8Array(readFileSync(join(ROOT, `arcade/build/${v}/runtime.bin`))) }; };
  // stand-in runtime of batch1 (a copy of tests/arcade-m5.mjs section 8's fakeRuntime)
  const fnv = (s) => { let h = 0x811C9DC5; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h; };
  const NAMES = ['RT_SHOW', 'RT_HIDE', 'RT_HIT', 'RT_KEYDOWN', 'RT_AT', 'RT_PRINTS', 'RT_PRINTN', 'RT_PRINTC', 'RT_INK', 'RT_PAPER', 'RT_BRIGHT', 'RT_CLS', 'RT_TILE', 'RT_TILEAT', 'RT_PLAY', 'RT_SILENCE', 'RT_MUL', 'RT_DIV', 'RT_MOD', 'RT_RND', 'RT_STICK', 'V_CUR_ROW', 'V_CUR_COL', 'V_TICKS'];
  const fake = (version) => ({ rt: { version, symbols: Object.fromEntries(NAMES.map((n) => [n, 0xC000 + (fnv(n) % 0x2000)])), constants: { GAME_BASE: 0x8000, GAME_VARS_BASE: 0xE100, GAME_VARS_LIMIT: 0xEFFF, MAX_SPRITES: version >= 2 ? 16 : 4, MAX_ASSETS: 8 } }, image: new Uint8Array(65536) });

  /** REGEN_PERTURB: damage the new compiler's result (image and DCK) so that the game behaves differently (the negative control). */
  function perturb(r) {
    if (!r.memory || !r.map?.entries?.frame) return r;
    const at = r.map.entries.frame + (PERTURB === 'ret' ? 0 : Number(PERTURB));
    const patch = (buf, off) => { buf[off] = PERTURB === 'ret' ? 0xC9 : buf[off] ^ 1; };
    const win = r.memory.slice(at - 12, at + 12);                                  // locate the same bytes in the DCK (the image's chunk of the cartridge)
    let d = -1;
    for (let i = 0; i + 24 <= r.dck.length && d < 0; i++) { let j = 0; while (j < 24 && r.dck[i + j] === win[j]) j++; if (j === 24) d = i + 12; }
    if (d < 0) throw new Error('perturb: cannot find the frame entry in the DCK');
    r.memory = Uint8Array.from(r.memory); r.dck = Uint8Array.from(r.dck);
    patch(r.memory, at); patch(r.dck, d);
    return r;
  }

  const H = accept ? await import(pathToFileURL(join(ROOT, 'tests/arcade-m5-harness.mjs')).href) : null;

  // ---- the deterministic input ----
  const STICKS = [0, 0, 1, 2, 4, 8, 5, 6, 9, 10, 16, 17, 18, 20, 24];
  function inputFor(src, ticks) {
    const keys = new Set([' ', '\r']);
    for (const m of src.matchAll(/KEY(?:DOWN|PRESS)\s*\(\s*"(.)"/gi)) keys.add(m[1].toUpperCase());
    const keyList = [...keys].sort();
    let x = 0xC0DE1234 >>> 0;
    const rnd = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x >>> 8; };
    const segs = []; let t = 0;
    while (t < ticks + 12) {
      const len = 3 + (rnd() % 8);
      const held = keyList.filter(() => rnd() % 4 === 0);
      segs.push({ end: (t += len), s1: STICKS[rnd() % STICKS.length], s2: STICKS[rnd() % STICKS.length], held });
    }
    const seg = (k) => (k <= 4 ? { s1: 0, s2: 0, held: [] } : segs.find((s) => k <= s.end));
    return { stick: (k) => { const g = seg(k); return [0, g.s1, g.s2]; }, keys: (k) => seg(k).held, keyList };
  }

  // ---- state comparison ----
  const KEYS = ['vars', 'arrays', 'sprites', 'cells', 'attrs', 'cursor', 'textAttr', 'border', 'sfxActive', 'ay', 'chip'];
  function firstDiff(a, b) {
    for (const k of KEYS) {
      const x = a[k], y = b[k];
      if (x?.buffer || y?.buffer) { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return `${k}[${i}] (row ${(i / 32) | 0}, col ${i % 32}): old ${x[i]}, new ${y[i]}`; continue; }
      const jx = JSON.stringify(x), jy = JSON.stringify(y);
      if (jx === jy) continue;
      if (x && typeof x === 'object' && !Array.isArray(x)) for (const n of Object.keys(x)) if (JSON.stringify(x[n]) !== JSON.stringify(y?.[n])) return `${k}.${n}: old ${JSON.stringify(x[n])}, new ${JSON.stringify(y?.[n])}`;
      if (Array.isArray(x)) for (let i = 0; i < x.length; i++) if (JSON.stringify(x[i]) !== JSON.stringify(y?.[i])) return `${k}[${i}]: old ${JSON.stringify(x[i])}, new ${JSON.stringify(y?.[i])}`;
      return `${k}: old ${jx}, new ${jy}`;
    }
    return null;
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  const files = ['batch1', 'batch2', 'batch3'];
  const bases = {};
  let bad = 0, programs = 0, changed = 0, moved = 0;
  // accept mode: all or nothing (a failure anywhere rewrites no file)
  const write = (f) => {
    const base = bases[f];
    for (const { e, upd, prev, diffs } of base.pending ?? []) {
      if (accept) { if (diffs) { Object.assign(e, prev); Object.assign(e, upd); e.acceptedFrom = ref; } } else Object.assign(e, upd);
    }
    delete base.pending;
    writeFileSync(join(FIX, `${f}-baseline.json`), JSON.stringify(base, null, 1) + '\n');
  };
  const rows = [];
  for (const f of files) {
    const p = join(FIX, `${f}-baseline.json`);
    const base = bases[f] = JSON.parse(readFileSync(p));
    for (const e of base.programs) {
      if (ONLY !== null && !e.src.includes(ONLY)) continue;
      programs++;
      const src = readFileSync(join(ROOT, e.src), 'utf8'), assets = JSON.parse(readFileSync(join(ROOT, e.assets), 'utf8'));
      const label = `${f} ${e.src} (runtime ${e.runtime})`;
      const R = f === 'batch1' ? fake(e.runtime) : load('v' + e.runtime);
      const a = oldCompile(src, { runtime: R.rt, image: R.image, assets }), b = newCompile(src, { runtime: R.rt, image: R.image, assets });
      if (a.errors.length || b.errors.length) { console.log('compile errors', label, a.errors[0]?.message, '|', b.errors[0]?.message); bad++; continue; }
      const area = (r) => sha(r.memory.slice(0x8000, 0xC000));
      const ha = f === 'batch1' ? [area(a), a.gen.code.length] : [sha(a.dck), area(a), a.gen.code.length];
      const hb = f === 'batch1' ? [area(b), b.gen.code.length] : [sha(b.dck), area(b), b.gen.code.length];
      if (!accept) {
        if (!same(ha, hb)) { console.log('THE WORKING-TREE COMPILER DIFFERS from', ref, 'for', label); bad++; continue; }
      } else {
        // the old compiler should reproduce the record it is being compared with (a ref other than the one that made the baseline is worth a word, not a stop)
        const cur = f === 'batch1' ? [e.sha256, e.bytes] : [e.dckSha256, e.areaSha256, e.bytes];
        if (!same(cur, ha) && !(e.acceptedFrom && same(cur, hb))) console.log(`note: ${label}: the old compiler (${ref}) does not give the hash in the file (the file is from another compiler)`);
        // behaviour: the real runtime (batch1: v2)
        const RR = H.real(f === 'batch1' ? 2 : e.runtime);
        if (!RR.ok) { console.log(`${label}: the real runtime v${f === 'batch1' ? 2 : e.runtime} is not built (${RR.why})`); bad++; continue; }
        const ra = f === 'batch1' ? oldCompile(src, { runtime: RR.rt, image: RR.img, assets }) : a;
        const rb = f === 'batch1' ? newCompile(src, { runtime: RR.rt, image: RR.img, assets }) : b;
        if (ra.errors.length || rb.errors.length) { console.log('compile errors on the real runtime', label, ra.errors[0]?.message, '|', rb.errors[0]?.message); bad++; continue; }
        const inp = inputFor(src, TICKS);
        const keysI = (t, c) => inp.keys(t).includes(c), hasSongs = /^\s*MUSIC\s/im.test(src);
        // THE GUARD: each build, run on the real runtime with the input, must equal the reference interpreter driven by THAT run's own recorded clock (the refreshes at which the run
        // sampled, the RANDOMISE seeds it took, the sound calls' refreshes): the differential suites' comparison (tests/arcade-m5-harness.mjs interpFor + diffRecords; for a game with
        // songs compareSoundRun).  A faster build may finish a tick in another refresh and seed RND from another frame counter: that is timing, and the interpreter is told it.
        const verify = (res) => {
          const got = H.runReal(res, { ticks: TICKS, stick: inp.stick, keys: inp.keys, R: RR });
          if (got.error) return { got, d: 'the run failed: ' + got.error };
          const mk = (n, extra = {}) => H.interpFor(src, assets, got, { version: RR.rt.version })(n, { keys: keysI, stick: inp.stick, ...extra });
          let want;
          try { want = mk(TICKS); } catch (err) { return { got, d: 'the interpreter failed: ' + err.message }; }
          // (sprites only on v2: v3's SPR_TAB holds window-relative positions, not comparable with the interpreter's records)
          let d = H.diffRecords(got.ticks, want, { sprites: RR.rt.version === 2, straddle: got.straddle });
          if (!d && hasSongs) { const sw = H.compareSoundRun(got, TICKS, (clock, n) => mk(n, { clock }), []); if (sw.d) d = 'sound: ' + sw.d; }
          return { got, d };
        };
        const va = verify(ra), vb = verify(rb), ga = va.got, gb = vb.got;
        const verdict = (va.d ? `the OLD build differs from the interpreter: ${va.d}` : '') + (va.d && vb.d ? ' | ' : '') + (vb.d ? `the NEW build differs from the interpreter: ${vb.d}` : '') || null;
        // INFO only: the two builds against each other (they may differ in timing: RANDOMISE from the frame counter, a tick ending in another refresh) and the slot layout (hidden slots)
        let direct = 'not compared';
        if (!ga.error && !gb.error) { direct = 'identical on every tick'; for (let i = 0; i < TICKS; i++) { const dd = firstDiff(ga.ticks[i], gb.ticks[i]); if (dd) { direct = `first difference at tick ${i + 1}: ${dd}`; break; } } }
        const layout = same(ra.map.vars, rb.map.vars) && same(ra.map.arrays ?? {}, rb.map.arrays ?? {});
        let mv = 0;
        if (!gb.error) for (let i = 1; i < gb.ticks.length; i++) if (firstDiff(gb.ticks[i - 1], gb.ticks[i])) mv++;
        const tOld = gb.ticks.length, rep = `${label}: ${verdict ?? `old and new both equal the interpreter on ${tOld} ticks`}; state moved on ${mv}/${Math.max(tOld - 1, 0)} ticks; old code ${ra.gen.code.length} B, new ${rb.gen.code.length} B`;
        rows.push(rep);
        console.log((verdict ? 'FAIL ' : 'ok   ') + rep);
        console.log(`  info: old against new directly: ${direct}; slot layout ${layout ? 'identical' : 'differs (hidden slots), named variables and arrays compared by name'}`);
        if (verdict) { bad++; continue; }
        if (mv === 0) console.log(`warning: ${label}: the state never changed in ${TICKS} ticks (the input did not move this game)`);
        else moved++;
      }
      // the record (rewritten only if nothing failed anywhere: see below)
      const upd = f === 'batch1'
        ? { sha256: hb[0], bytes: hb[1] }
        : { dckSha256: hb[0], areaSha256: hb[1], dckBytes: b.dck.length, bytes: hb[2] };
      const prev = f === 'batch1'
        ? { prevSha256: e.sha256, prevBytes: e.bytes }
        : { prevDckSha256: e.dckSha256, prevAreaSha256: e.areaSha256, prevDckBytes: e.dckBytes, prevBytes: e.bytes };
      const diffs = Object.keys(upd).some((k) => e[k] !== upd[k]);
      if (diffs) changed++;
      (base.pending ??= []).push({ e, upd, prev, diffs });
    }
    if (!accept && !bad && !DRY) write(f);                       // default mode: a file at a time, as it always did
  }
  if (accept && !bad && !DRY) for (const f of files) write(f);
  if (accept) {
    console.log(`\n${programs} program(s) from ${files.join(', ')}: ${bad ? bad + ' FAILED' : `old and new builds of all ran ${TICKS} ticks on the real runtime equal to the interpreter on every tick (${moved} of them with a moving state); ${changed} record(s) changed`}`);
    if (bad) console.log('nothing was rewritten');
    else if (DRY) console.log('dry run: nothing was written');
    else console.log(`records rewritten in ${FIX} (prev* fields keep the old hashes, acceptedFrom = ${ref})`);
    console.log('REMINDER: condition (a) of docs/ARCADE_COMPILER_SIZE_CONTRACT.md section 8 is not checked here: run `node arcade/tests/run-all.mjs` and the game suites with the new compiler (all must pass except the hash-baseline checks), then run tests/arcade-m5.mjs section 8 and the batch 2 / 3 checks again after this rewrite.');
  } else console.log(bad ? `FAILED (${bad})` : `baselines regenerated (${changed} hash(es) changed)`);
  process.exitCode = bad ? 1 : 0;                  // (not process.exit(): the finally below must remove the temporary copy of the old compiler)
} finally { rmSync(tmp, { recursive: true, force: true }); }
