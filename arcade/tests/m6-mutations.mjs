"use strict";
// m6-mutations.mjs -- mutation test of the runtime v3 part 1 suites: copies arcade/ (all runtimes, tools, tests) to a temporary directory, applies one
// deliberate bug at a time to the new / changed v3 code (assets.asm: the plan, the builder, the cache; main.asm: draw_all; sprite.asm: the blitters
// and the erase; api.asm: RT_SHOW / RT_SHOWF / RT_HIDE; skip.asm; text.asm: hit_box; boot.asm; layout.inc), rebuilds and runs the m6 suites in their
// quick form (M6_QUICK=1); a mutation is KILLED when at least one suite fails.
//   node arcade/tests/m6-mutations.mjs [name-fragment]      (about 15-30 s per mutant)
//   node arcade/tests/m6-mutations.mjs --check              only verifies that every pattern occurs exactly once
//   node arcade/tests/m6-mutations.mjs --shard=0/3          every third mutant (run the shards in parallel)
import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = join(HERE, '..');
const TSRUN = join(ARCADE, '../tsrun');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const only = args.find((a) => !a.startsWith('--'));
const shardArg = args.find((a) => a.startsWith('--shard='));
const [shardI, shardN] = shardArg ? shardArg.slice(8).split('/').map(Number) : [0, 1];
const TESTS = ['m6-runtime.mjs', 'm6-runtime-pic.mjs', 'm6-runtime-mem.mjs', 'm6-runtime-regs.mjs'];

const E = (file, from, to) => ({ file, from, to });
const A = 'assets.asm', MA = 'main.asm', SP = 'sprite.asm', AP = 'api.asm', SK = 'skip.asm';
const MUTANTS = [
  // ---- the plan (assets.asm) ----
  ['plan: pool_alloc misses the carry past $FFFF (a POOL_B slot wraps)', [E(A, '    jr c,.no                    ; past $FFFF', '    nop\n    nop                         ; past $FFFF')]],
  ['plan: pool_alloc accepts a block that ends one byte past the piece', [E(A, '    or a\n    sbc hl,de                   ; carry: the new next is past the end', '    scf\n    sbc hl,de                   ; carry: the new next is past the end')]],
  ['plan: the minimum slots ignore the instance count (K0 = nframes)', [E(A, '    ld a,(ix+AST_NINST)\n    cp (ix+AST_NF)\n    jr c,.mkn', '    ld a,(ix+AST_NF)\n    cp (ix+AST_NF)\n    jr c,.mkn')]],
  ['plan: no extra slots (step 3 skipped)', [E(A, '    jr nc,.exnext               ; every frame has its slot', '    jr .exnext                  ; every frame has its slot')]],
  ['plan: a failed minimum slot is not counted (FC_MISS too small, the boot goes on)', [E(A, '    jr nc,.mkok\n    call pp_miss', '    jr nc,.mkok\n    nop\n    nop\n    nop')]],
  ['plan: pp_assign writes the slot over the rom pointer (+ 4 K instead of + 4 K + 2)', [E(A, '    add a,2                     ; + 4 K + 2: the slot word of frame K', '    add a,0                     ; + 4 K + 2: the slot word of frame K')]],
  ['plan: FTAB rom pointers step h x wb instead of h x 2 wb', [E(A, '    ld a,(ix+AST_WB)\n    add a,a\n.fs:', '    ld a,(ix+AST_WB)\n    nop\n.fs:')]],
  ['plan: an unused asset gets an FTAB (pp_asset ignores the instance count)', [E(A, '    ld a,(ix+AST_NINST)\n    or a                        ; (clears the carry)', '    ld a,1\n    or a                        ; (clears the carry)')]],
  // ---- read_desc ----
  ['desc: width 24 is read as 32 (cp 25 -> cp 24)', [E(A, '    cp 25\n', '    cp 24\n')]],
  ['desc: a height above 48 is read as 47', [E(A, '    cp MAX_H+1\n    jr c,.h2\n    ld a,MAX_H', '    cp MAX_H+1\n    jr c,.h2\n    ld a,MAX_H-1')]],
  ['desc: nframes 0 is not read as 1', [E(A, '    ld a,(ix+SD_NFRAMES)        ; frames 1..32 (0 = 1)\n    or a\n    jr nz,.f1\n    inc a', '    ld a,(ix+SD_NFRAMES)        ; frames 1..32 (0 = 1)\n    or a\n    jr nz,.f1\n    nop')]],
  ['desc: CLEN = h x 2 wb (the extra byte of a shifted copy forgotten)', [E(A, '    ld a,(iy+AST_WB)\n    inc a\n    add a,a\n.cl:', '    ld a,(iy+AST_WB)\n    nop\n    add a,a\n.cl:')]],
  ['desc: PHASE_OFF steps g instead of 2 g bytes', [E(A, '    inc a                       ; g = bits between two phases\n    add a,a', '    inc a                       ; g = bits between two phases\n    nop')]],
  // ---- build_frame ----
  ['build: the extra mask byte of a 16-wide row is 0 instead of $FF', [E(A, '        ELSEIF wb == 2\n        ld h,$FF', '        ELSEIF wb == 2\n        ld h,$00')]],
  ['build: the image shift does not clear the carry (ink enters from the mask)', [E(A, '        ENDIF\n        or a\n        rr b\n        rr c', '        ENDIF\n        nop\n        rr b\n        rr c')]],
  ['build: the next source row is 2 wb + 2 bytes on', [E(A, '        ld de,2*wb\n        add iy,de               ; the next source row', '        ld de,2*wb+2\n        add iy,de               ; the next source row')]],
  ['build: the copies are packed with stride 2 (wb + 1) instead of CLEN', [E(A, '        ld de,(BF_CLEN)\n.ph:', '        ld de,2*(wb+1)\n.ph:')]],
  // ---- fc_miss ----
  ['cache: the victim may be a frame a visible instance shows (no protection)', [E(A, '    jr nz,.nx                   ; shown by an instance', '    nop\n    nop                         ; shown by an instance')]],
  ['cache: the round-robin pointer is not advanced', [E(A, '.rr:\n    ld (ix+AST_RR),a', '.rr:\n    nop\n    nop\n    nop')]],
  ['cache: the victim keeps its slot (two frames share it)', [E(A, '    ld d,(hl)                   ; take its slot\n    ld (hl),0\n    dec hl\n    ld e,(hl)\n    ld (hl),0', '    ld d,(hl)                   ; take its slot\n    nop\n    dec hl\n    ld e,(hl)\n    nop')]],
  ['cache: the protected frames are not clamped to nframes - 1', [E(A, '    cp (ix+AST_NF)\n    jr c,.pc', '    cp (ix+AST_NF)\n    jr .pc')]],
  // ---- draw_all (main.asm) ----
  ['draw: the frame is not clamped to nframes - 1', [E(MA, '    cp (hl)\n    jr c,.fok', '    cp (hl)\n    jr .fok')]],
  ['draw: a 24-wide aligned sprite takes the 32-wide game-image blitter', [E(MA, '    cp 3\n    jr nz,.r4\n    call blitr3', '    cp 3\n    jr .r4\n    call blitr3')]],
  ['draw: the record counts one cell row too few', [E(MA, '    and $38\n    add a,8\n    or b', '    and $38\n    add a,0\n    or b')]],
  ['draw: PHASE_OFF is indexed from the AST record (the offset is not subtracted)', [E(MA, '    sub (AST&$FF)-(PHASE_OFF&$FF)\n', '    nop\n    nop\n')]],
  ['draw: V_CHG is never paid (the skip never finds a candidate)', [E(MA, '    jr z,.paid\n    dec a\n    ld (de),a', '    jr z,.paid\n    nop\n    nop')]],
  ['draw: the screen address takes the third from bit 3 only', [E(MA, '    and $18\n    or h\n    ld h,a\n    ld a,(V_HBASE)', '    and $08\n    or h\n    ld h,a\n    ld a,(V_HBASE)')]],
  ['draw: a 16-wide shifted sprite takes the 8-wide pair blitter', [E(MA, '    PHASE_ADD\n    call blitp3                 ; 16 wide', '    PHASE_ADD\n    call blitp2                 ; 16 wide')]],
  ['draw: a miss with a found slot skips the PHASE_OFF add (jumps past .slot)', [E(MA, '    ld a,h\n    or l\n    jr nz,.slot\n    jr .done', '    ld a,h\n    or l\n    jr nz,.done\n    jr .done')]],
  // ---- blitters and erase (sprite.asm) ----
  ['blit: the group loop treats "exactly 8 rows left" as more', [E(SP, '        jr c,.last              ; 1..7 rows left: the last group\n        jr z,.last8', '        jr c,.last              ; 1..7 rows left: the last group\n        nop\n        nop')]],
  ['blit: ADJUST_DE goes back 7 instead of 8', [E(SP, '        ld a,d\n        sub 8\n        ld d,a\n1:', '        ld a,d\n        sub 7\n        ld d,a\n1:')]],
  ['blit: the wide (looped) blitters run 7 rows for a whole group', [E(SP, 'blk:\n        ld a,8', 'blk:\n        ld a,7')]],
  ['blit: a pair at an even address combines mask and image with OR', [E(SP, '    MACRO BYTE_OPS\n        ld a,(de)\n        and (hl)', '    MACRO BYTE_OPS\n        ld a,(de)\n        or (hl)')]],
  ['erase: a big erase moves on 32 - cols instead of 33 - cols', [E(SP, '        ld (E_NR),a\n        ERASE_FIX cols\n        ld a,l\n        add a,33-cols', '        ld (E_NR),a\n        ERASE_FIX cols\n        ld a,l\n        add a,32-cols')]],
  ['erase: 4 and 5 columns take the small path (the column test misses bit 2)', [E(SP, '    and $24\n    jp nz,erase_big', '    and $20\n    jp nz,erase_big')]],
  ['erase: the big path erases one cell row too few', [E(SP, '    and 7\n    ld (E_NR),a                 ; cell rows, 1..7', '    and 7\n    dec a\n    ld (E_NR),a                 ; cell rows, 1..7')]],
  // ---- RT_SHOW / RT_SHOWF / RT_HIDE (api.asm), hit_box (text.asm) ----
  ['show: y max is 191 - h', [E(AP, '    ld a,192\n    sub (hl)', '    ld a,191\n    sub (hl)')]],
  ['show: x max is 255 - 8 wb (CPL instead of NEG)', [E(AP, '    add a,a\n    neg\n    ld h,a                      ; H = x max', '    add a,a\n    cpl\n    ld h,a                      ; H = x max')]],
  ['show: RT_SHOW resets the frame to 0', [E(AP, '    ld l,(hl)                   ; L = the frame the instance has', '    ld l,0                      ; L = the frame the instance has')]],
  ['show: a frame-only change is not seen (nothing redrawn, V_CHG kept)', [E(AP, '    cp e\n    ret z                       ; visible at this position with this frame already', '    nop\n    ret                         ; visible at this position with this frame already')]],
  ['show: x 256 or more is clamped to 0 instead of the maximum', [E(AP, '    ld a,b\n    or a\n    ld a,h\n    jr nz,.xs', '    ld a,b\n    or a\n    ld a,0\n    jr nz,.xs')]],
  ['hide: RT_HIDE indexes 4-byte entries', [E(AP, 'RT_HIDE:\n    ld hl,V_NINST\n    cp (hl)\n    ret nc\n    add a,a', 'RT_HIDE:\n    ld hl,V_NINST\n    cp (hl)\n    ret nc\n    nop')]],
  ['hit: hit_box indexes 8-byte AST records', [E('text.asm', '    add a,a\n    add a,a                     ; 16 * asset (AST_LEN)', '    add a,a\n    nop                         ; 16 * asset (AST_LEN)')]],
  // ---- skip.asm ----
  ['skip: the new box of a changed instance is one column narrow (cx1 = cx0 + wb - 1)', [E(SK, '    add a,c\n    ld c,a                      ; cx1', '    add a,c\n    dec a\n    ld c,a                      ; cx1')]],
  ['skip: the record rectangle has one cell row too few', [E(SK, '    and 7\n    dec a\n    ld e,a                      ; E = cell rows - 1', '    and 7\n    dec a\n    dec a\n    ld e,a                      ; E = cell rows - 1')]],
  ['skip: the instance scan steps 6-byte entries', [E(SK, 'sk_entptr:\n    add a,a\n    add a,a\n    add a,a', 'sk_entptr:\n    add a,a\n    add a,a\n    nop')]],
  // ---- boot / layout ----
  ['boot: frame_div keeps bit 6 (a DIV_WIN header has the wrong divisor)', [E('boot.asm', '    and $3F ', '    and $7F ')]],
  ['boot: only $E000-$EFFF is zeroed (WORLD_RAM keeps stale RAM)', [E('layout.inc', 'VARS_CLEAR_LEN  EQU $1200', 'VARS_CLEAR_LEN  EQU $1000')]],
];

if (checkOnly) {
  let bad = 0;
  for (const [name, edits] of MUTANTS) for (const e of edits) {
    const src = readFileSync(join(ARCADE, 'runtime/v3', e.file), 'utf8');
    const n = src.split(e.from).length - 1;
    if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad++; }
  }
  console.log(`${MUTANTS.length} mutants, ${bad} bad patterns`);
  process.exit(bad ? 1 : 0);
}

const tmp = mkdtempSync(join(tmpdir(), 'm6mut-'));
let killed = 0;
const survived = [], broken = [];
try {
  for (const [mi, [name, edits]] of MUTANTS.entries()) {
    if (only && !name.includes(only)) continue;
    if (mi % shardN !== shardI) continue;
    const root = join(tmp, 'root');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, 'arcade'), { recursive: true });
    for (const d of ['runtime', 'tools', 'tests']) cpSync(join(ARCADE, d), join(root, 'arcade', d), { recursive: true });
    mkdirSync(join(root, 'arcade/build/v3'), { recursive: true });
    symlinkSync(TSRUN, join(root, 'tsrun'));
    let bad = false;
    for (const e of edits) {
      const p = join(root, 'arcade/runtime/v3', e.file);
      const src = readFileSync(p, 'utf8');
      const n = src.split(e.from).length - 1;
      if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad = true; break; }
      writeFileSync(p, src.replace(e.from, () => e.to));
    }
    if (bad) { broken.push(name); continue; }
    let failedBy = null, buildErr = false;
    for (const t of TESTS) {
      const r = spawnSync('node', [join(root, 'arcade/tests', t)], { encoding: 'utf8', timeout: 600000, env: { ...process.env, M6_QUICK: '1' } });
      const out = (r.stdout ?? '') + (r.stderr ?? '');
      if (/sjasmplus failed/.test(out)) { buildErr = true; console.log(out.split('\n').filter((l) => /error/.test(l)).slice(0, 3).join('\n')); break; }
      if (r.status !== 0 || r.error) { failedBy = t + ': ' + ((out.match(/FAIL  .*/g) ?? [out.split('\n').filter(Boolean).pop()])[0] ?? '').slice(0, 110); break; }
    }
    if (buildErr) { console.log(`  BUILD ERROR  ${name}`); broken.push(name); }
    else if (failedBy) { killed++; console.log(`  killed       ${name}  <- ${failedBy}`); }
    else { survived.push(name); console.log(`  SURVIVED     ${name}`); }
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
const expectedSurvivors = survived.filter((n) => n.includes('EQUIVALENT'));
const real = survived.filter((n) => !n.includes('EQUIVALENT'));
console.log(`\n${real.length === 0 && broken.length === 0 ? 'PASS' : 'FAIL'}: mutation test (${killed} killed, ${real.length} survived, ${expectedSurvivors.length} equivalent mutant${expectedSurvivors.length === 1 ? '' : 's'} survived as expected, ${broken.length} not run)`);
if (real.length) console.log('survivors: ' + real.join('; '));
process.exitCode = real.length || broken.length ? 1 : 0;
