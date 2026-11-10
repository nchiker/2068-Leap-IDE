"use strict";
// m8-mutations.mjs -- mutation test of the runtime v4 suites: copies arcade/ (runtimes, tools, tests) into a scratch directory under arcade/build/, applies
// one deliberate bug at a time to the ray code (ray.asm, raybb.asm, the RST run switches in boot.asm, the ray branches of main / api / text / assets),
// rebuilds and runs the m8 suites in their quick form (M8_QUICK=1); a mutation is KILLED when at least one suite fails.
//   node arcade/tests/m8-mutations.mjs [name-fragment]      (about 10-25 s per mutant)
//   node arcade/tests/m8-mutations.mjs --check              only verifies that every pattern occurs exactly once
//   node arcade/tests/m8-mutations.mjs --shard=0/4          every fourth mutant (run the shards in parallel)
import { cpSync, readFileSync, writeFileSync, symlinkSync, rmSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = join(HERE, '..');
const TSRUN = join(ARCADE, '../tsrun');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const only = args.find((a) => !a.startsWith('--'));
const shardArg = args.find((a) => a.startsWith('--shard='));
const [shardI, shardN] = shardArg ? shardArg.slice(8).split('/').map(Number) : [0, 1];
const TESTS = ['m8-runtime-api.mjs', 'm8-runtime-mem.mjs', 'm8-runtime.mjs', 'm8-runtime-regs.mjs'];

const E = (file, from, to) => ({ file, from, to });
const RA = 'ray.asm', BB = 'raybb.asm';
const MUTANTS = [
  // ---- boot: ray_check, the map, the tables, the patterns, the attributes ----
  ['check: colw 8 accepted', [E(RA, '    cp 4\n    ret nz                      ; colw 2 or 4', '    cp 4\n    nop                         ; colw 2 or 4')]],
  ['check: map_w 33 accepted', [E(RA, '    cp 32-4+1\n    ret nc                      ; map_w 4..32', '    cp 32-4+2\n    ret nc                      ; map_w 4..32')]],
  ['check: DIV_VIEW alone is enough', [E(RA, 'ray_check:\n    ld a,(GAME_DIV)\n    and DIV_EXT|DIV_VIEW\n    cp DIV_EXT|DIV_VIEW', 'ray_check:\n    ld a,(GAME_DIV)\n    and DIV_VIEW\n    cp DIV_VIEW')]],
  ['map: values above 4 not clamped', [E(RA, '    cp 5\n    jr c,.v\n    ld a,4\n.v:', '    cp 5\n    jr .v\n    ld a,4\n.v:')]],
  ['map: the next row starts map_w + 1 cells on (32 - map_w - 1)', [E(RA, '    ld a,32\n    sub c\n    ld l,a', '    ld a,31\n    sub c\n    ld l,a')]],
  ['map: the ring of column 31 is not forced', [E(RA, '    ld a,l\n    add a,31\n    ld l,a\n    ld a,(hl)\n    or a\n    jr nz,.c2\n    ld (hl),1', '    ld a,l\n    add a,31\n    ld l,a\n    ld a,(hl)\n    or a\n    jr .c2\n    ld (hl),1')]],
  ['map: a short list leaves the rest 0 (the array is filled with 0)', [E(RA, '    ld bc,32*32-1\n    ld (hl),1', '    ld bc,32*32-1\n    ld (hl),0')]],
  ['tables: RECIP restoring division keeps the remainder (no subtract)', [E(RA, '    ld h,a                      ; remainder -= n\n    ld a,l\n    sub c\n    ld l,a', '    nop                         ; remainder -= n\n    ld a,l\n    nop\n    ld l,a')]],
  ['tables: HGT[0..32] = 47', [E(RA, '    ld (hl),VIEW_HH\n    ldir', '    ld (hl),VIEW_HH-1\n    ldir')]],
  ['tables: inc_div does not decrement q', [E(RA, '.w:\n    bit 7,h\n    jr z,.ok\n    dec de                      ; q -= 1', '.w:\n    bit 7,h\n    jr z,.ok\n    inc de                      ; q -= 1')]],
  ['patterns: colw 2 masks start at $F0', [E(RA, '    ld c,$F0\n    jr z,.m\n    ld c,$C0', '    ld c,$F0\n    jr z,.m\n    ld c,$F0')]],
  ['attrs: the bottom half gets attr_top', [E(RA, '    call .half\n    ld a,(ix+4)', '    call .half\n    ld a,(ix+3)')]],
  // ---- the tick ----
  ['tick: the window\'s dirty bytes are not masked (cells drawn into the window)', [E(RA, 'ray_tick:\n    call ray_mask_dirty', 'ray_tick:\n    nop\n    nop\n    nop')]],
  ['tick: 11 rows masked', [E(RA, '    ld l,VIEW_CY*4+1\n    ld b,12', '    ld l,VIEW_CY*4+1\n    ld b,11')]],
  ['render: IY not restored', [E(RA, '    pop af\n    ex af,af\'\n    pop iy\n    pop ix\n    ret', '    pop af\n    ex af,af\'\n    pop hl\n    pop ix\n    ret')]],
  // ---- setup ----
  ['setup: plane x = +mulP(sin)', [E(RA, '    call mul_p\n    call neg_hl\n    ld (R_PLX),hl', '    call mul_p\n    nop\n    nop\n    nop\n    ld (R_PLX),hl')]],
  ['setup: no half step for the first ray (x)', [E(RA, '    ld de,(R_STX)\n    sra d\n    rr e\n    add hl,de\n    ld (R_RDX),hl', '    ld de,(R_STX)\n    sra d\n    rr e\n    nop\n    ld (R_RDX),hl')]],
  ['setup: positive multiplier = frac (not 256 - frac)', [E(RA, '    ld a,(R_PX)                 ; multipliers: negative direction = frac, positive = 256 - frac (0 means 256)\n    ld (R_MXN),a\n    neg', '    ld a,(R_PX)                 ; multipliers: negative direction = frac, positive = 256 - frac (0 means 256)\n    ld (R_MXN),a\n    nop\n    nop')]],
  ['setup: stepOf without the N / 2 rounding', [E(RA, '    rra                         ; N / 2 (carry was 0 from ADD HL,HL: |p| < 32768)\n    ld e,a', '    rra                         ; N / 2 (carry was 0 from ADD HL,HL: |p| < 32768)\n    xor a\n    ld e,a')]],
  ['setup: the cast position is not clamped into the array (a viewer on the ring casts out)', [E(RA, '    ld hl,(RV_Y)\n    call clamp_in', '    ld hl,(RV_Y)\n    nop\n    nop\n    nop')]],
  ['setup: the viewer\'s row ignores bit 3 of y (row AND 7)', [E(RA, '    ld a,l\n    and $03\n    add a,MAP_RAM>>8\n    ld d,a\n    ld (R_MAP0),de', '    xor a\n    nop\n    add a,MAP_RAM>>8\n    ld d,a\n    ld (R_MAP0),de')]],
  ['setup: billboard cos without rounding (C >> 4)', [E(RA, 'fx8:\n    ld de,8', 'fx8:\n    ld de,0')]],
  // ---- axis, multiplies, DDA ----
  // EQUIVALENT: the clamp is defensive: a ray's component is cos - plane + k step with |cos| <= 4096 and |plane| <= 2368, and over every angle and ray
  // of both widths the largest |component| is 4,745 (enumerated in m8-runtime.mjs's comment); 8,192 is never reached.
  ['EQUIVALENT axis: the clamp at 8191 missing', [E(RA, '.e0:\n    cp $20\n    jr c,.e0r', '.e0:\n    cp $20\n    jr .e0r')]],
  ['axis: e = 1 path shifts R twice', [E(RA, '.e1:\n    add hl,hl\n    RLOOK\n    add hl,hl\n    jr .d', '.e1:\n    add hl,hl\n    RLOOK\n    add hl,hl\n    add hl,hl\n    jr .d')]],
  ['axis: RLOOK takes the odd entry (no RES 0,L)', [E(RA, '        res 0,l\n        ld a,h\n        add a,RAY_RECIP>>8', '        set 0,l\n        ld a,h\n        add a,RAY_RECIP>>8')]],
  ['axis: v = 0 steps (first distance 0)', [E(RA, '.zero:\n    ld de,32767\n    ld hl,65535', '.zero:\n    ld de,32767\n    ld hl,0')]],
  ['gen_mul: m = 0 of a negative direction reads as 256', [E(RA, '    dec c\n    jr nz,.zero', '    dec c\n    nop\n    nop')]],
  ['axis: the big path computes e = 7 like e = 8 (no halving)', [E(RA, '    jr z,.b0                    ; e = 8: the product itself\n    jr c,.br                    ; e = 7: / 2', '    jr z,.b0                    ; e = 8: the product itself\n    jr c,.b0                    ; e = 7: / 2')]],
  ['axis: the big path does not saturate', [E(RA, '.b0:\n    ld a,b\n    or a\n    jr nz,.sat', '.b0:\n    ld a,b\n    or a\n    nop\n    nop')]],
  ['ray_one: the step delta is not capped at 32,767 (x)', [E(RA, '.xc:\n    bit 7,d                     ; the step delta: min(D, 32767)\n    jr z,.xd', '.xc:\n    bit 7,d                     ; the step delta: min(D, 32767)\n    jr .xd')]],
  ['gen_mul: a zero bit shifts with RR H (the carry of the previous RR L)', [E(RA, '    ld (hl),$3C\n.rl:', '    ld (hl),$1C\n.rl:')]],
  ['gen_mul: never regenerated when only the kind changes', [E(RA, '    ld a,c\n    cp (hl)\n    ret z                       ; unchanged', '    ld a,c\n    cp a\n    ret z                       ; unchanged')]],
  ['DDA: ties go to x', [E(RA, '    sbc a,d\n    jr nc,dda_y', '    sbc a,d\n    jr c,dda_y_t\n    jr dda_x_t\ndda_y_t:\n    jr dda_y\ndda_x_t:')]],
  ['DDA: the y step does not carry into H', [E(RA, '    jr nc,dda_yn\nDDA_YC:', '    jr dda_yn\nDDA_YC:')]],
  ['dda_patch: y negative keeps INC H', [E(RA, '    ld (hl),$D6                 ; SUB n\n    ld a,$25                    ; DEC H', '    ld (hl),$D6                 ; SUB n\n    ld a,$24                    ; DEC H')]],
  ['ray_one: the quadrant is never re-patched', [E(RA, '    cp (hl)\n    call nz,dda_patch', '    cp (hl)\n    nop\n    nop\n    nop')]],
  // ---- hit, composer, chain ----
  ['hit: perp = sd (no - delta) for x hits', [E(RA, '    ld bc,(R_DX)\n    or a\n    sbc hl,bc                   ; the perpendicular distance', '    ld bc,0\n    or a\n    sbc hl,bc                   ; the perpendicular distance')]],
  ['hit: the pattern ignores the side', [E(RA, '    dec a\n    add a,a\n    add a,c\n    and 7\n    ld c,a                      ; C = the pattern index', '    dec a\n    add a,a\n    nop\n    and 7\n    ld c,a                      ; C = the pattern index')]],
  // EQUIVALENT: defensive: rays stop inside the 32 x 32 array (its ring is never 0) from a cast position in cells 1..30, so perp < 43 cells (11,008),
  // perp >> 3 < 1,376: the clamp at 1,535 never applies.
  ['EQUIVALENT hit: no clamp of the height index', [E(RA, '    cp RAY_HGT_LEN>>8\n    jr c,.in\n    ld hl,RAY_HGT_LEN-1\n.in:\n    ld a,l', '    cp RAY_HGT_LEN>>8\n    jr .in\n    ld hl,RAY_HGT_LEN-1\n.in:\n    ld a,l')]],
  ['compose: 4-ray sort misses one exchange', [E(RA, '    CAS c,e\n    CAS c,d', '    CAS c,e\n    nop')]],
  ['compose: 2-ray columns never swapped', [E(RA, '    ld a,b\n    cp c\n    jr nc,.sorted\n    ld (hl),b', '    ld a,b\n    cp c\n    jr .sorted\n    ld (hl),b')]],
  ['compose: equal thresholds are not merged', [E(RA, '        cp d\n        jr z,1F                 ; the same threshold as the previous key', '        cp d\n        nop\n        nop                     ; the same threshold as the previous key')]],
  ['compose: an odd unit gets RST_EVEN', [E(RA, '        bit 2,d\n        ld (hl),RST_E_OP\n        jr z,1F\n        ld (hl),RST_O_OP', '        bit 2,d\n        ld (hl),RST_E_OP\n        jr 1F\n        ld (hl),RST_O_OP')]],
  ['compose: the odd-row accumulator ignores the key\'s pattern', [E(RA, '        ld a,c\n        xor (hl)\n        ld c,a\n    ENDM', '        ld a,c\n        nop\n        ld c,a\n    ENDM')]],
  ['compose: h = 48 makes a threshold (unit 48 patched)', [E(RA, '        cp VIEW_HH*4\n        jr z,1F                 ; h = 48: no threshold', '        cp VIEW_HH*4+1\n        jr z,1F                 ; h = 48: no threshold')]],
  ['compose: the upper pointer starts at the lower row', [E(RA, '    ld a,e\n    add a,UBL0\n    ld e,a\n    ld a,(R_UBH)', '    ld a,e\n    add a,LBL0\n    ld e,a\n    ld a,(R_UBH)')]],
  ['RST_ODD restores LD (HL),B', [E('boot.asm', '    ld (hl),$71                 ; LD (HL),C', '    ld (hl),$70                 ; LD (HL),C')]],
  ['RST_EVEN does not restore its unit', [E('boot.asm', '    dec hl\n    ld (hl),$70                 ; LD (HL),B: the unit\'s first byte again', '    dec hl\n    nop\n    nop                         ; LD (HL),B: the unit\'s first byte again')]],
  // ---- billboards ----
  ['bb: the 1/4-cell cull at 32', [E(BB, '    ld a,l\n    cp 64\n    ret c                       ; closer than 1/4 cell', '    ld a,l\n    cp 32\n    ret c                       ; closer than 1/4 cell')]],
  ['bb: an instance outside the map in x is drawn', [E(BB, '    ld hl,(VD_XMAX)\n    or a\n    sbc hl,de\n    ret c                       ; x outside the map', '    ld hl,(VD_XMAX)\n    or a\n    sbc hl,de\n    nop                         ; x outside the map')]],
  ['bb: ty = T(dy, cs) + T(dx, sn)', [E(BB, '    pop hl\n    or a\n    sbc hl,de                   ; HL = ty', '    pop hl\n    or a\n    add hl,de                   ; HL = ty')]],
  ['bb: wpx without the hpx >> 5 term', [E(BB, '    ld c,a\n    srl a\n    srl a\n    add a,c\n    add a,b\n    ld (iy+BR_WPX),a', '    ld c,a\n    srl a\n    srl a\n    ld a,c\n    add a,b\n    ld (iy+BR_WPX),a')]],
  // EQUIVALENT: a column needs |xc - sxc| < wpx / 2 <= 83 with xc in 1..127, so |sxc - 64| < 147: any limit from 147 to 255 culls only billboards with no
  // column (nothing drawn, BB_TAB 'not drawn' either way).
  ['EQUIVALENT bb: the screen offset limit 192 is 255', [E(BB, '    cp 192\n    ret nc                      ; off >= 192: not drawn', '    cp 255\n    ret nc                      ; off >= 192: not drawn')]],
  ['bb: the BB_TAB column not clamped at 127', [E(BB, '    cp 128\n    jr c,.cset\n    ld a,127', '    cp 128\n    jr .cset\n    ld a,127')]],
  ['bb: the sort is not stable (equal depths swapped)', [E(BB, '    sbc hl,de                   ; depth[j - 1] - depth[key]: carry when depth[j - 1] < depth[key] (both 64..32767)\n    pop hl\n    jr nc,.place',
    '    sbc hl,de                   ; depth[j - 1] - depth[key]: carry when depth[j - 1] < depth[key] (both 64..32767)\n    pop hl\n    jr z,.swp\n    jr nc,.place\n.swp:')]],
  ['bb: equal depth draws over the wall', [E(BB, '    sbc hl,de\n    jp nc,.next                 ; hidden by the wall (equal: the wall wins)', '    sbc hl,de\n    jp z,.dvis\n    jp nc,.next                 ; hidden by the wall (equal: the wall wins)\n.dvis:')]],
  ['bb: the image bit is read from the mask byte (+ wb missing)', [E(BB, '    ld a,(R_T0+15)              ; mo + wb\n    add a,e', '    ld a,0                      ; mo + wb\n    add a,e')]],
  ['bb: the source bit is u AND 7 (not 7 - u AND 7)', [E(BB, '    and 7\n    xor 7\n    add a,a\n    add a,a\n    add a,a\n    add a,$46', '    and 7\n    nop\n    add a,a\n    add a,a\n    add a,a\n    add a,$46')]],
  ['bb: K not patched (the row restarts one byte right)', [E(BB, '    ld de,BT_F                  ; fraction only\n    ld a,b\n    ld (BT_F_K+1),a', '    ld de,BT_F                  ; fraction only\n    ld a,b\n    nop\n    nop\n    nop')]],
  ['bb: the first row\'s source v0 ignores the rows above the window', [E(BB, '    neg\n    ld c,a                      ; k0 = -top', '    neg\n    ld c,0                      ; k0 = -top')]],
  ['bb: the u accumulator starts at 0 (k0 ignored)', [E(BB, '    call mul8x16c\n    ld h,l\n    ld l,c\n    push hl', '    call mul8x16c\n    ld hl,0\n    nop\n    push hl')]],
  ['bb: BB_TAB depth not written', [E(BB, '    ld a,(R_T0+13)\n    ld (hl),a\n    inc l\n    ld a,(R_T0+14)', '    ld a,(R_T0+13)\n    nop\n    inc l\n    ld a,(R_T0+14)')]],
  ['bb: the RAM tail with the fraction does not add the integer step', [E(RA, '    add ix,de\n    exx\n    add ix,de\n    exx\n    dec b', '    add ix,de\n    exx\n    nop\n    nop\n    exx\n    dec b')]],
  ['layout: the row code buffer 1,024 bytes with the distances right after it (the widest code overwrites them)', [
    E('layout.inc', 'RAY_BCODE_LEN   EQU $0500', 'RAY_BCODE_LEN   EQU $0400'), E('layout.inc', 'RAY_DISTL       EQU $F700', 'RAY_DISTL       EQU $F600'),
    E('layout.inc', 'RAY_DISTH       EQU $F740', 'RAY_DISTH       EQU $F640'), E(BB, '    ASSERT RAY_BCODE_LEN >= 64*16+16*3+5 && ', '    ASSERT ')]],
  // ---- the routines ----
  // EQUIVALENT: CP 128 instead of CP 129 differs only for a = 128, which the mutant negates: NEG of 128 is 128 (two's complement), the same angle.
  ['EQUIVALENT COSA: a = 128 folds through NEG (the fold uses CP 128)', [E(BB, 'cos_q:\n    cp 129', 'cos_q:\n    cp 128')]],
  ['SINA = C[a + 64]', [E(BB, 'RT_SINA:\n    ld a,l\n    add a,192', 'RT_SINA:\n    ld a,l\n    add a,64')]],
  ['FXMUL: the 32-bit negate misses the carry into the top word', [E(BB, '    inc h\n    jr nz,.r\n    inc de\n.r:', '    inc h\n    jr nz,.r\n    nop\n.r:')]],
  ['WALL: y 32..255 reads the map (no bound)', [E(BB, '    ld a,d\n    cp 32\n    jr nc,.one\n    call map_addr', '    ld a,d\n    cp 128\n    jr nc,.one\n    call map_addr')]],
  ['SETWALL: type 5 accepted', [E(BB, '    ld a,l\n    cp 5\n    ret nc\n    ld c,a                      ; C = type', '    ld a,l\n    cp 6\n    ret nc\n    ld c,a                      ; C = type')]],
  ['SETWALL: a 0 on the ring is written', [E(BB, '    ld a,h                      ; type 0 on the array\'s ring: ignored\n    or a\n    ret z', '    ld a,h                      ; type 0 on the array\'s ring: ignored\n    or a\n    jr .w')]],
  ['SETWALL: x is checked against map_h', [E(BB, '    ld hl,(RA_X)\n    ld a,(VD_MAPW)', '    ld hl,(RA_X)\n    ld a,(VD_MAPH)')]],
  ['VIEW: x is not clamped to the map', [E(BB, '    push de\n    ld de,(VD_XMAX)\n    call clamp_hl', '    push de\n    ld de,$7FFF\n    call clamp_hl')]],
  ['show_ray: the frame is not stored', [E(BB, '    inc l\n    pop de\n    ld (hl),e\n    ret', '    inc l\n    pop de\n    nop\n    ret')]],
  ['HIT: R = 2 h', [E(BB, '    ld a,(hl)\n    add a,a\n    add a,a\n    ld (de),a\n    scf', '    ld a,(hl)\n    add a,a\n    nop\n    ld (de),a\n    scf')]],
  ['HIT: |d| <= Ra + Rb hits (touching squares)', [E(BB, '    call c,neg_hl\n    or a\n    sbc hl,bc\n    ret', '    call c,neg_hl\n    scf\n    sbc hl,bc\n    ret')]],
  // ---- the branches into the ray code ----
  ['main: no ray branch (the v3 tick in ray mode)', [E('main.asm', '    jp nz,ray_tick', '    nop\n    nop\n    nop')]],
  ['api: show_f has no ray branch (positions clamped)', [E('api.asm', '    jr nz,show_w                ; ray mode', '    nop\n    nop                         ; ray mode')]],
  ['assets: ray mode plans the phase pool (no ray_assets)', [E('assets.asm', '    or a\n    jp nz,ray_assets', '    or a\n    nop\n    nop\n    nop')]],
];

const fileOf = (f) => join(ARCADE, 'runtime/v4', f);
if (checkOnly) {
  let bad = 0;
  for (const [name, edits] of MUTANTS) for (const e of edits) {
    const n = readFileSync(fileOf(e.file), 'utf8').split(e.from).length - 1;
    if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad++; }
  }
  console.log(`${MUTANTS.length} mutants, ${bad} bad patterns`);
  process.exit(bad ? 1 : 0);
}

// the unmutated suites must pass in their quick form first (else every mutant would count as killed)
for (const t of TESTS) {
  const r = spawnSync('node', [join(HERE, t)], { encoding: 'utf8', timeout: 600000, env: { ...process.env, M8_QUICK: '1' } });
  if (r.status !== 0) { console.log(`the unmutated ${t} fails in its quick form: no mutation run\n` + ((r.stdout ?? '') + (r.stderr ?? '')).split('\n').filter((l) => /FAIL/.test(l)).join('\n')); process.exit(1); }
}
const tmp = join(ARCADE, 'build', `m8mut-${process.pid}`);
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
    mkdirSync(join(root, 'arcade/build/v4'), { recursive: true });
    symlinkSync(TSRUN, join(root, 'tsrun'));
    let bad = false;
    for (const e of edits) {
      const p = join(root, 'arcade/runtime/v4', e.file);
      const src = readFileSync(p, 'utf8');
      const n = src.split(e.from).length - 1;
      if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad = true; break; }
      writeFileSync(p, src.replace(e.from, () => e.to));
    }
    if (bad) { broken.push(name); continue; }
    let failedBy = null, buildErr = false;
    for (const t of TESTS) {
      const r = spawnSync('node', [join(root, 'arcade/tests', t)], { encoding: 'utf8', timeout: 600000, env: { ...process.env, M8_QUICK: '1' } });
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
