"use strict";
// m4-mutations.mjs -- mutation test of the M4a test suite: copies arcade/ (runtime v2, tools, tests; v1 for the helpers) to a temporary directory,
// applies one deliberate bug at a time to the v2 runtime sources, rebuilds and runs the M4a tests; a mutation is KILLED when at least one test fails.
// Every mutant must be killed.  (The sound and text routines are copies of v1's and are covered by m3-mutations.mjs; a few are repeated here to show
// that the v2 tests see them too.)
//   node arcade/tests/m4-mutations.mjs [name-fragment] [--shard=i/n]       (about 15-25 s per mutant; --shard=i/n runs mutants i, i + n, i + 2n ... (0-based i) for parallel runs)
//   node arcade/tests/m4-mutations.mjs --check               only verify that every pattern occurs exactly once
//   TMPDIR=<dir> to choose where the scratch copy lives.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = join(HERE, '..');
const TSRUN = join(ARCADE, '../tsrun');
const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith('--'));
const shardArg = args.find((a) => a.startsWith('--shard='));
const [shardI, shardN] = shardArg ? shardArg.slice(8).split('/').map(Number) : [0, 1];
const TESTS = ['m4-runtime.mjs', 'm4-runtime-api.mjs', 'm4-runtime-skip.mjs', 'm4-runtime-mem.mjs', 'm4-runtime-regs.mjs'];

const E = (file, from, to) => ({ file, from, to });
const MUTANTS = [
  // ---- the blitters and the group loop ----
  ['blit: first group has one row too few (INC A lost)', [E('sprite.asm', '        and 7\n        inc a                   ; k1 = 8 - (y AND 7)', '        and 7\n        nop                     ; k1 = 8 - (y AND 7)')]],
  ['blit: next cell row 7 instead of 8 (ADJUST_DE)', [E('sprite.asm', '        ld a,d\n        sub 8\n        ld d,a\n1:', '        ld a,d\n        sub 7\n        ld d,a\n1:')]],
  ['blit: ROW3 steps back only once', [E('sprite.asm', '        BYTE_OP\n        dec e\n        dec e\n        inc d                   ; one pixel row down', '        BYTE_OP\n        dec e\n        nop\n        inc d                   ; one pixel row down')]],
  ['blit: mask applied with OR', [E('sprite.asm', '        and (hl)                ; keep the background where the mask is 1', '        or (hl)                 ; keep the background where the mask is 1')]],
  ['blit: whole last group dropped (JP run -> RET)', [E('sprite.asm', '        jp run                  ; the last group: 1..8 rows', '        ret                     ; the last group: 1..8 rows')]],
  ['blit: the 8-row middle group runs 7 rows', [E('sprite.asm', '        sub 8\n        ld (V_H),a\n        call blk                ; a whole group of 8 rows', '        sub 8\n        ld (V_H),a\n        ld a,7\n        call run\n        nop                     ; a whole group of 8 rows')]],
  // ---- draw_all ----
  ['draw: x not rounded to the phase granularity', [E('main.asm', '    ld a,c\n    and l                       ; x rounded down', '    ld a,c\n    and $FF                     ; x rounded down')]],
  ['draw: an aligned sprite gets one byte too many (JR Z -> JR NZ)', [E('main.asm', '    ld a,h\n    jr z,.wb                    ; aligned: WB bytes, else one more', '    ld a,h\n    jr nz,.wb                   ; aligned: WB bytes, else one more')]],
  ['draw: phase pointer ignores the shift', [E('main.asm', '    ld a,l\n    add a,a\n    add a,h\n    add a,PHASE_PTR&$FF', '    ld a,l\n    add a,h\n    add a,PHASE_PTR&$FF')]],
  ['draw: the record forgets the height', [E('main.asm', '    ld a,(V_H)\n    or c\n    ld (hl),a\n    pop hl', '    ld a,c\n    or c\n    ld (hl),a\n    pop hl')]],
  ['draw: the hidden file offset is dropped from the screen address', [E('main.asm', '    ld a,(V_HOFF)\n    or d\n    ld d,a                      ; DE = the screen address of the first byte of the first row', '    ld a,0\n    or d\n    ld d,a                      ; DE = the screen address of the first byte of the first row')]],
  // ---- erase ----
  ['erase: next cell row advances 32 - cols instead of 33 - cols', [E('sprite.asm', '        add a,33-cols', '        add a,32-cols')]],
  ['erase: one cell row too few (the DEC A of the height)', [E('sprite.asm', '    and 7\n    add a,c\n    dec a\n    rrca\n    rrca\n    rrca\n    and 3\n    ld c,a                      ; C = cell rows - 1', '    and 7\n    add a,c\n    rrca\n    rrca\n    rrca\n    and 3\n    ld c,a                      ; C = cell rows - 1')]],
  ['erase: a marked record ($81) is erased too', [E('main.asm', '        dec a\n        jr nz,.skip             ; 0 = nothing drawn', '        or a\n        jr z,.skip              ; 0 = nothing drawn')]],
  // ---- boot: assets, phases, clamps ----
  ['assets: the mask chain shifts in 0 instead of 1', [E('assets.asm', '.row:\n    scf\n    rr (hl)                     ; m0', '.row:\n    or a\n    rr (hl)                     ; m0')]],
  ['assets: a shifted copy keeps only the unshifted width', [E('assets.asm', '    jr z,.wb\n    inc a                       ; one more byte when not byte aligned', '    jr z,.wb\n    nop                         ; one more byte when not byte aligned')]],
  ['assets: phases 4 are read as 2', [E('assets.asm', '    cp 4\n    jr c,.pdone\n    ld b,4', '    cp 5\n    jr c,.pdone\n    ld b,4')]],
  ['assets: ninst 17 allowed (clamp at 17)', [E('assets.asm', '    cp MAX_SPRITES+1\n    jr c,.n\n    ld a,MAX_SPRITES', '    cp MAX_SPRITES+2\n    jr c,.n\n    ld a,MAX_SPRITES+1')]],
  ['assets: an asset index beyond the table is not clamped', [E('assets.asm', '    ld a,c\n    dec a                       ; asset index >= count: the last asset', '    ld a,c\n    nop                         ; asset index >= count: the last asset')]],
  ['assets: sprite_count above 8 is not clamped', [E('assets.asm', '    ld a,MAX_ASSETS             ; more assets than the pool has slots for: read as 8', '    nop                         ; more assets than the pool has slots for: read as 8')]],
  ['assets: width 9..16 read as 8', [E('assets.asm', '    cp 9\n    ld a,1\n    jr c,.w8\n    inc a', '    cp 17\n    ld a,1\n    jr c,.w8\n    inc a')]],
  ['assets: the instance table never sets the asset byte', [E('assets.asm', '.aok:\n    ld (de),a', '.aok:\n    nop')]],
  // ---- API ----
  ['RT_SHOW: x clamp 240', [E('layout.inc', 'SPR_XMAX        EQU 239', 'SPR_XMAX        EQU 240')]],
  ['RT_SHOW: forgets V_CHG', [E('api.asm', '    ld h,V_CHG>>8\n    ld (hl),2\n    ret\n\n; clamp_hl', '    ld h,V_CHG>>8\n    nop\n    ret\n\n; clamp_hl')]],
  ['RT_SHOW: a same-position call still counts as a change', [E('api.asm', '    cp c\n    ret z                       ; visible at this position already', '    cp c\n    jr z,.write                 ; visible at this position already')]],
  ['RT_HIDE: leaves the instance visible', [E('api.asm', '    ld (hl),0                   ; (V_CHG is not touched', '    nop                         ; (V_CHG is not touched')]],
  ['RT_HIDE: also sets V_CHG (the model says it must not)', [E('api.asm', '    ld (hl),0                   ; (V_CHG is not touched: a hidden instance is never a skip candidate, and RT_SHOW sets it when it shows the instance again)\n    ret', '    ld (hl),0\n    ld a,e\n    add a,V_CHG&$FF\n    ld l,a\n    ld h,V_CHG>>8\n    ld (hl),2\n    ret')]],
  ['RT_HIT: the asset hot box offset is off by one', [E('text.asm', '    add a,(AST&$FF)+AST_HOT     ;', '    add a,(AST&$FF)+AST_HOT+1   ;')]],
  ['RT_HIT: index >= ninst accepted', [E('text.asm', '    ld hl,V_NINST\n    cp (hl)\n    ret nc                      ; index >= ninst (carry clear)', '    ld hl,V_NINST\n    cp (hl)\n    nop                         ; index >= ninst (carry clear)')]],
  // ---- keyboard ----
  ['RT_KEYDOWN: the Z key is in the wrong place', [E('keys.asm', '    DB $2C, $01                                 ; Y (5,4) Z (0,1)', '    DB $2C, $02                                 ; Y (5,4) Z (0,1)')]],
  ['RT_KEYDOWN: tests the wrong bit (one rotation too many)', [E('keys.asm', '    ld a,b\n    inc e\n.rot:', '    ld a,b\n    inc e\n    inc e\n.rot:')]],
  ['RT_KEYDOWN: CAPS SHIFT code 1 unmapped', [E('keys.asm', '    DB $00                                      ; 1  CAPS SHIFT  (row 0, bit 0)', '    DB $FF                                      ; 1  CAPS SHIFT  (row 0, bit 0)')]],
  ['RT_KEYDOWN: V_KEYS written to the wrong row', [E('keys.asm', '    ld a,d\n    add a,V_KEYS&$FF', '    ld a,e\n    add a,V_KEYS&$FF')]],
  // ---- memory, stack ----
  ['boot: the canary is written two bytes high', [E('boot.asm', '    ld (STACK_CANARY),hl        ; guards', '    ld (STACK_CANARY+2),hl      ; guards')]],
  ['layout: stack 2 KB (canary $FA00)', [E('layout.inc', 'STACK_CANARY    EQU $FB00', 'STACK_CANARY    EQU $FA00')]],
  ['layout: one slot too many in POOL_B', [E('layout.inc', 'POOL_B_SLOTS    EQU 28', 'POOL_B_SLOTS    EQU 29')]],
  ['boot: SPR_DRAWN is not cleared with the rest of chunk 6 (clear starts above it)', [E('layout.inc', 'CHUNK6_CLEAR    EQU CELL_TILE   ; boot clears', 'CHUNK6_CLEAR    EQU TILE_ATTR   ; boot clears')]],
  // ---- the frame loop and the skip ----
  ['frame loop: erase BEFORE frame_entry (v1 order) with a stale analysis', [E('main.asm', 'SKIP_CALL:\n    call skip_analysis\n    call erase_all', 'SKIP_CALL:\n    call skip_analysis\n    nop\n    nop\n    nop')]],
  ['draw_all: the owed ticks are never paid (no instance ever becomes static)', [E('main.asm', '    jr z,.paid\n    dec (hl)', '    jr z,.paid\n    nop')]],
  ['skip: the dirty-cell check is off', [E('skip.asm', '    call sk_dirty               ; carry = a cell of the instance is dirty\n    jr c,.nextb', '    or a                        ; carry = a cell of the instance is dirty\n    jr c,.nextb')]],
  ['skip: "changed" instances count as candidates', [E('skip.asm', '    ld a,c\n    or a\n    jr nz,.kind1                ; changed since it was drawn', '    ld a,c\n    or a\n    jr nz,.kind1x               ; changed since it was drawn\n.kind1x:')]],
  ['skip: the old position of a changed instance is ignored', [E('skip.asm', '.kind1:\n    ld a,d\n    or a\n    jr z,.noold', '.kind1:\n    ld a,d\n    xor a\n    jr z,.noold')]],
  ['skip: rectangles are compared wrongly (the last test uses the bottom edge of i)', [E('skip.asm', '    inc l\n    ld a,d                      ; i.cy0 > j.cy1\n    cp (hl)', '    inc l\n    ld a,e                      ; i.cy0 > j.cy1\n    cp (hl)')]],
  ['skip: a candidate does not give up its own slot (it meets itself)', [E('skip.asm', '    ld b,(hl)\n    ld (hl),255\n    inc l\n    ld c,(hl)', '    ld b,(hl)\n    nop\n    nop\n    inc l\n    ld c,(hl)')]],
  ['skip: the mark is not cleared by draw_all', [E('main.asm', '    res 7,(hl)\n    jp .next', '    nop\n    nop\n    jp .next')]],
  ['skip: the mark test of draw_all looks at the wrong record', [E('main.asm', '    ld a,(V_RBASE)              ; a marked instance: clear the mark, draw nothing\n    add a,b', '    ld a,(V_RBASE)              ; a marked instance: clear the mark, draw nothing\n    add a,0')]],
  ['skip: marks go to the record of the displayed file', [E('skip.asm', 'sk_recptr:\n    add a,a\n    add a,a\n    ld l,a\n    ld a,(V_HIDDEN)', 'sk_recptr:\n    add a,a\n    add a,a\n    ld l,a\n    ld a,(V_HIDDEN)\n    xor 1')]],
  ['skip: the dirty check reads the other file\'s map', [E('skip.asm', '    ld a,(V_HIDDEN)\n    add a,DIRTY0>>8\n    ld h,a\n    ld l,b', '    ld a,(V_HIDDEN)\n    xor 1\n    add a,DIRTY0>>8\n    ld h,a\n    ld l,b')]],
  ['skip: the join of a changed instance forgets to widen by 2 cells (rows)', [E('skip.asm', '.r0lo:\n    ld e,d\n    inc e\n    inc e\n    ld d,a', '.r0lo:\n    ld e,d\n    ld d,a')]],
  // ---- shared v1 code the v2 pictures depend on ----
  ['mark_dirty marks only file 1', [E('text.asm', '    inc h                       ; DIRTY1 = DIRTY0 + $100\n    pop af\n    or (hl)\n    ld (hl),a\n    ret', '    pop af\n    ret')]],
  ['sound tick forgets to preserve DE', [E('sound.asm', '    push bc\n    push de\n    push hl\n    cp 1<<SB_SYNC', '    push bc\n    push hl\n    cp 1<<SB_SYNC'), E('sound.asm', '.out:\n    pop hl\n    pop de\n    pop bc', '.out:\n    pop hl\n    pop bc')]],
  ['RT_STICK without DI', [E('api.asm', '    di                          ; v1:', '    nop                         ; v1:')]],
];

if (args.includes('--check')) {                                                    // patterns only: each must be found exactly once
  let bad = 0;
  for (const [name, edits] of MUTANTS) for (const e of edits) {
    const n = readFileSync(join(ARCADE, 'runtime/v2', e.file), 'utf8').split(e.from).length - 1;
    if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad++; }
  }
  console.log(`${bad ? 'FAIL' : 'PASS'}: m4-mutations --check (${MUTANTS.length} mutants, ${bad} bad patterns)`);
  process.exit(bad ? 1 : 0);
}
const tmp = mkdtempSync(join(tmpdir(), 'm4mut-'));
let killed = 0, survived = [], broken = [];
try {
  for (const [mi, [name, edits]] of MUTANTS.entries()) {
    if (only && !name.includes(only)) continue;
    if (mi % shardN !== shardI) continue;
    const root = join(tmp, 'root');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, 'arcade'), { recursive: true });
    for (const d of ['runtime/v2', 'runtime/v1', 'runtime/v0', 'tools', 'tests']) cpSync(join(ARCADE, d), join(root, 'arcade', d), { recursive: true });
    mkdirSync(join(root, 'arcade/build/v2'), { recursive: true });
    symlinkSync(TSRUN, join(root, 'tsrun'));
    let bad = false;
    for (const e of edits) {
      const p = join(root, 'arcade/runtime/v2', e.file);
      const src = readFileSync(p, 'utf8');
      const n = src.split(e.from).length - 1;
      if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad = true; break; }
      writeFileSync(p, src.replace(e.from, () => e.to));
    }
    if (bad) { broken.push(name); continue; }
    let failedBy = null, buildErr = false;
    for (const t of TESTS) {
      const r = spawnSync('node', [join(root, 'arcade/tests', t)], { encoding: 'utf8', timeout: 300000 });
      const out = (r.stdout ?? '') + (r.stderr ?? '');
      if (/sjasmplus failed/.test(out)) { buildErr = true; console.log(out.split('\n').filter((l) => /error/.test(l)).slice(0, 3).join('\n')); break; }
      if (r.status !== 0) { failedBy = t + ': ' + ((out.match(/FAIL  .*/g) ?? [out.split('\n').filter(Boolean).pop()])[0] ?? '').slice(0, 110); break; }
    }
    if (buildErr) { console.log(`  BUILD ERROR  ${name}`); broken.push(name); }
    else if (failedBy) { killed++; console.log(`  killed       ${name}  <- ${failedBy}`); }
    else { survived.push(name); console.log(`  SURVIVED     ${name}`); }
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log(`\n${survived.length === 0 && broken.length === 0 ? 'PASS' : 'FAIL'}: mutation test (${killed} killed, ${survived.length} survived, ${broken.length} not run)`);
if (survived.length) console.log('survivors: ' + survived.join('; '));
process.exitCode = survived.length || broken.length ? 1 : 0;
