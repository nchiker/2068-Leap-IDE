"use strict";
// m12-mutations.mjs -- mutation test of m12-runtime-table.mjs (bankable tables, slice T1): copies arcade/ (all runtimes, tools, tests) to a temporary directory, applies one deliberate
// bug at a time to the NEW code (RT_TABLELOAD / tabload_run / tabload_one, appended to tileops.asm in v2, scroll.asm in v3 and ray.asm in v4), rebuilds and runs m12 on that runtime only
// (M12_VERSIONS); a mutation is KILLED when the test fails.  Every mutant must be killed (or be listed as equivalent below, with the reason).  A pattern that does not occur exactly
// once is reported, not run.
//   node arcade/tests/m12-mutations.mjs [name-fragment] [--shard=i/n] [--versions=2,3]     (about 5 s per mutant; --shard splits the list for parallel runs)
//   node arcade/tests/m12-mutations.mjs --check               only verify that every pattern occurs once
import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = join(HERE, '..');
const TSRUN = join(ARCADE, '../tsrun');
const args = process.argv.slice(2);
const check = args.includes('--check');
const only = args.find((a) => !a.startsWith('--'));
const shard = (args.find((a) => a.startsWith('--shard=')) ?? '').slice(8).split('/').map(Number);
const versions = (args.find((a) => a.startsWith('--versions=')) ?? '').slice(11).split(',').filter(Boolean).map(Number);

// A mutant: [name, version, edits]; an edit replaces `from` (found exactly once in runtime/v<version>/<file>) with `to`.  The new code is the same text in the three runtimes; only the file differs.
const E = (file, from, to) => ({ file, from, to });
const NOP = (n) => Array(n).fill('    nop').join('\n');
const FILE = { 2: 'tileops.asm', 3: 'scroll.asm', 4: 'ray.asm' };
const MUTANTS = [];
const add = (name, v, ...edits) => MUTANTS.push([name, v, edits]);
/** The same mutant for each runtime (edits given as [from, to] pairs on the shared text). */
const all = (name, ...pairs) => { for (const v of [2, 3, 4]) add(`v${v} ${name}`, v, ...pairs.map(([f, t]) => E(FILE[v], f, t))); };

all('RT_TABLELOAD: the window starts at $41 ($40 not banked)', ['RT_TABLELOAD:\n    ld a,h\n    sub BANK_LO\n', 'RT_TABLELOAD:\n    ld a,h\n    sub BANK_LO+1\n']);
all('RT_TABLELOAD: the window starts at $3F ($3F banked)', ['RT_TABLELOAD:\n    ld a,h\n    sub BANK_LO\n', 'RT_TABLELOAD:\n    ld a,h\n    sub BANK_LO-1\n']);
all('RT_TABLELOAD: the window ends at $7E ($7F not banked)', ['    cp BANK_HI-BANK_LO\n    jr nc,tabload_run', '    cp BANK_HI-BANK_LO-1\n    jr nc,tabload_run']);
all('RT_TABLELOAD: the window ends at $80 ($80 banked)', ['    cp BANK_HI-BANK_LO\n    jr nc,tabload_run', '    cp BANK_HI-BANK_LO+1\n    jr nc,tabload_run']);
all('RT_TABLELOAD: the test looks at D, not H', ['RT_TABLELOAD:\n    ld a,h', 'RT_TABLELOAD:\n    ld a,d']);
all('RT_TABLELOAD: the test inverted (a mapped record goes through the window)', ['    jr nc,tabload_run           ; a mapped record', '    jr c,tabload_run            ; a mapped record']);
all('RT_TABLELOAD: every record goes through the window', ['    jr nc,tabload_run           ; a mapped record', NOP(2) + '                          ; a mapped record']);
all('RT_TABLELOAD: the window is never mapped', ['    call bank_on\n    call tabload_run\n    jp bank_off', NOP(3) + '\n    call tabload_run\n    jp bank_off']);
all('RT_TABLELOAD: the window is never unmapped', ['    call tabload_run\n    jp bank_off', '    call tabload_run\n    ret']);
all('RT_TABLELOAD: the window is unmapped before the runs (jp bank_off first)', ['    call bank_on\n    call tabload_run\n    jp bank_off', '    call bank_on\n    call bank_off\n    jp tabload_run']);
all('RT_TABLELOAD: the zero-run guard is gone (0 runs = 256)', ['    or a\n    ret z\ntabload_one:', NOP(2) + '\ntabload_one:']);
all('RT_TABLELOAD: the run count is read one too small (the last run is lost)', ['    or a\n    ret z\ntabload_one:', '    dec a\n    ret z\ntabload_one:']);
all('RT_TABLELOAD: only one run is copied', ['    dec a                       ; nothing', '    xor a                       ; nothing']);
all('RT_TABLELOAD: the run count is not decremented (runs forever / too long)', ['    dec a                       ; nothing', NOP(1) + '                          ; nothing']);
all('RT_TABLELOAD: dst bytes swapped', ['    ld e,(hl)\n    inc hl\n    ld d,(hl)\n    inc hl                      ; DE = dst', '    ld d,(hl)\n    inc hl\n    ld e,(hl)\n    inc hl                      ; DE = dst']);
all('RT_TABLELOAD: len bytes swapped', ['    ld c,(hl)\n    inc hl\n    ld b,(hl)\n    inc hl                      ; BC = len', '    ld b,(hl)\n    inc hl\n    ld c,(hl)\n    inc hl                      ; BC = len']);
all('RT_TABLELOAD: the high byte of len is ignored', ['    ld b,(hl)\n    inc hl                      ; BC = len', '    ld b,0\n    inc hl                      ; BC = len']);
all('RT_TABLELOAD: len is one more', ['    inc hl                      ; BC = len\n    ldir', '    inc hl                      ; BC = len\n    inc bc\n    ldir']);
all('RT_TABLELOAD: len is one less', ['    inc hl                      ; BC = len\n    ldir', '    inc hl                      ; BC = len\n    dec bc\n    ldir']);
all('RT_TABLELOAD: LDI instead of LDIR (one byte per run)', ['    ldir                        ; HL', '    ldi                         ; HL']);
all('RT_TABLELOAD: LDDR instead of LDIR', ['    ldir                        ; HL', '    lddr                        ; HL']);
all('RT_TABLELOAD: the source pointer is not advanced past len (the next run is read from its last byte)', ['    ld b,(hl)\n    inc hl                      ; BC = len', '    ld b,(hl)\n    nop                         ; BC = len']);
all('RT_TABLELOAD: the source pointer is not advanced past dst', ['    ld d,(hl)\n    inc hl                      ; DE = dst', '    ld d,(hl)\n    nop                         ; DE = dst']);
all('RT_TABLELOAD: the first run count byte is not skipped', ['tabload_run:\n    ld a,(hl)\n    inc hl\n', 'tabload_run:\n    ld a,(hl)\n    nop\n']);
all('RT_TABLELOAD: interrupts are disabled around the copy', ['tabload_one:\n    ld e,(hl)', 'tabload_one:\n    di\n    ld e,(hl)'], ['    dec a                       ; nothing', '    ei\n    dec a                       ; nothing']);
all('RT_TABLELOAD: clobbers IX', ['tabload_run:\n    ld a,(hl)\n    inc hl\n', 'tabload_run:\n    ld ix,$1234\n    ld a,(hl)\n    inc hl\n']);
all('RT_TABLELOAD: clobbers IY', ['tabload_run:\n    ld a,(hl)\n    inc hl\n', 'tabload_run:\n    ld iy,$1234\n    ld a,(hl)\n    inc hl\n']);
all('RT_TABLELOAD: swaps the alternate registers (EXX)', ['tabload_one:\n    ld e,(hl)', 'tabload_one:\n    exx\n    ld e,(hl)']);
all('RT_TABLELOAD: swaps AF and AF\'', ['tabload_run:\n    ld a,(hl)\n    inc hl\n', 'tabload_run:\n    ex af,af\'\n    ld a,(hl)\n    inc hl\n']);
all('RT_TABLELOAD: writes a byte past the last destination (a stray write)', ['    ldir                        ; HL', '    ldir\n    ld (de),a                   ; HL']);
all('RT_TABLELOAD: a write to the window while it is mapped', ['tabload_one:\n    ld e,(hl)', 'tabload_one:\n    ld (hl),a\n    ld e,(hl)']);
all('RT_TABLELOAD: unbalanced stack (pushes a word it never pops)', ['tabload_run:\n    ld a,(hl)\n    inc hl\n', 'tabload_run:\n    push af\n    ld a,(hl)\n    inc hl\n']);

const filtered = MUTANTS.filter(([, v]) => versions.length === 0 || versions.includes(v));

if (check) {
  let bad = 0;
  for (const [name, v, edits] of MUTANTS) for (const e of edits) {
    const src = readFileSync(join(ARCADE, `runtime/v${v}`, e.file), 'utf8');
    const n = src.split(e.from).length - 1;
    if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in v${v}/${e.file}`); bad++; }
  }
  console.log(`${bad === 0 ? 'PASS' : 'FAIL'}: m12-mutations --check (${MUTANTS.length} mutants, ${bad} patterns not found exactly once)`);
  process.exit(bad ? 1 : 0);
}

const tmp = mkdtempSync(join(tmpdir(), 'm12mut-'));
let killed = 0; const survived = [], broken = []; let ran = 0;
try {
  for (const [mi, [name, v, edits]] of filtered.entries()) {
    if (only && !name.includes(only)) continue;
    if (shard.length === 2 && mi % shard[1] !== shard[0]) continue;
    const root = join(tmp, 'root');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, 'arcade'), { recursive: true });
    for (const d of ['runtime', 'tools', 'tests']) cpSync(join(ARCADE, d), join(root, 'arcade', d), { recursive: true });
    symlinkSync(TSRUN, join(root, 'tsrun'));
    symlinkSync(join(ARCADE, '../src'), join(root, 'src'));
    let bad = false;
    for (const e of edits) {
      const p = join(root, `arcade/runtime/v${v}`, e.file);
      const src = readFileSync(p, 'utf8');
      const n = src.split(e.from).length - 1;
      if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in v${v}/${e.file}`); bad = true; break; }
      writeFileSync(p, src.replace(e.from, () => e.to));
    }
    if (bad) { broken.push(name); continue; }
    ran++;
    const r = spawnSync('node', [join(root, 'arcade/tests/m12-runtime-table.mjs')], { encoding: 'utf8', timeout: 300000, env: { ...process.env, M12_VERSIONS: String(v) } });
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    if (/sjasmplus failed/.test(out)) { console.log(out.split('\n').filter((l) => /error/.test(l)).slice(0, 3).join('\n')); console.log(`  BUILD ERROR  ${name}`); broken.push(name); }
    else if (r.status !== 0 || r.signal) { killed++; console.log(`  killed       ${name}  <- ${((out.match(/FAIL  .*/g) ?? [out.split('\n').filter(Boolean).pop()])[0] ?? '').slice(0, 110)}`); }
    else { survived.push(name); console.log(`  SURVIVED     ${name}`); }
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log(`\n${survived.length === 0 && broken.length === 0 ? 'PASS' : 'FAIL'}: mutation test (${killed} killed of ${ran} run, ${survived.length} survived, ${broken.length} not run)`);
if (survived.length) console.log('survivors: ' + survived.join('; '));
process.exitCode = survived.length || broken.length ? 1 : 0;
