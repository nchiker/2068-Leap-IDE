"use strict";
// m5-mutations.mjs -- mutation test of the M5 test suite: copies arcade/ (runtime v2, tools, tests; v1/v0 for the helpers) to a temporary directory,
// applies one deliberate bug at a time to the tile operations (tileops.asm), the boot / header code that reads the map table (boot.asm, video.asm) or
// layout.inc, rebuilds and runs the M5 tests (the unit test in its quick form, M5_QUICK=1); a mutation is KILLED when at least one test fails.
//   node arcade/tests/m5-mutations.mjs [name-fragment]      (about 5-25 s per mutant)
//   node arcade/tests/m5-mutations.mjs --check              only verifies that every pattern occurs exactly once
//   node arcade/tests/m5-mutations.mjs --shard=0/3          every third mutant (run the three shards in parallel)
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
const checkOnly = args.includes('--check');
const only = args.find((a) => !a.startsWith('--'));
const shardArg = args.find((a) => a.startsWith('--shard='));      // --shard=i/n: run every n-th mutant starting at i (parallel runs)
const [shardI, shardN] = shardArg ? shardArg.slice(8).split('/').map(Number) : [0, 1];
const TESTS = ['m5-runtime.mjs', 'm5-runtime-pic.mjs', 'm5-runtime-regs.mjs', 'm5-runtime-mem.mjs'];

const E = (file, from, to) => ({ file, from, to });
const T = 'tileops.asm';
const MUTANTS = [
  // ---- clipping ----
  ['clip: a length shorter than the room is not used (count = room)', [E(T, '    cp b\n    jr nc,.start                ; length >= room\n    ld b,e', '    cp b\n    jr .start                   ; length >= room\n    ld b,e')]],
  ['clip: position >= limit is not rejected', [E(T, '    cp c\n    jr nc,.empty                ; position >= limit', '    cp c\n    nop\n    nop                         ; position >= limit')]],
  ['clip: a zero length is accepted', [E(T, '    or e\n    jr z,.empty                 ; length 0', '    or e\n    nop\n    nop                         ; length 0')]],
  ['clip: a negative position ending exactly at the limit is cut to limit - 1', [E(T, '    cp c\n    jr c,.ok                    ; end < limit', '    cp c\n    jr z,.ok                    ; end < limit')]],
  ['clip: the end of a negative-position rectangle is not tested for zero (an empty rectangle fills one cell)', [E(T, '    or l\n    jr z,.empty                 ; end = 0', '    or l\n    nop\n    nop                         ; end = 0')]],
  ['clip: position >= 256 is not rejected', [E(T, '    or a\n    jr nz,.empty                ; position >= 256', '    or a\n    nop\n    nop                         ; position >= 256')]],
  ['clip: a length of 256 or more is read by its low byte only', [E(T, '    or a\n    jr nz,.start                ; length >= 256: the room', '    or a\n    nop\n    nop                         ; length >= 256: the room')]],
  ['clip: an end of 256 or more is read by its low byte only', [E(T, '    or a\n    jr nz,.lim                  ; end >= 256', '    or a\n    nop\n    nop                         ; end >= 256')]],
  // ---- COPY geometry ----
  ['copy: the difference high byte is ignored (a destination 256 + d cells away is taken for d)', [E(T, 'delta_axis:\n    ld a,h\n    or a\n    jr z,.pos\n    inc a', 'delta_axis:\n    ld a,h\n    or a\n    jr .pos\n    inc a')]],
  ['copy: |difference| = limit is accepted (delta_axis boundary) -- EQUIVALENT: adjust_axis finds the range empty anyway', [E(T, '    add a,c                     ; carry when difference >= -limit; zero then when it is exactly -limit\n    jr nc,.big\n    jr z,.big', '    add a,c                     ; carry when difference >= -limit; zero then when it is exactly -limit\n    jr nc,.big\n    nop\n    nop')]],
  ['copy: the destination is not clipped on the right (room ignores the difference)', [E(T, '    ld a,c\n    sub d\n    sub e                       ; room = limit - difference - first', '    ld a,c\n    sub e\n    sub e                       ; room = limit - difference - first')]],
  ['copy: the source cut on the left of a negative difference is wrong (gap)', [E(T, '    cp e\n    jr c,.keepn\n    jr z,.keepn\n    sub e\n    ld d,a                      ; D = cells cut off the front', '    cp e\n    jr c,.keepn\n    jr z,.keepn\n    ld d,a                      ; D = cells cut off the front')]],
  ['copy: moving down visits the rows top to bottom (a row is read after it was written)', [E(T, '    ld a,$FF\n    ld (TO_RSTEP),a\n    ld a,(TO_NY)\n    ld b,a\n    ld a,(TO_SYC)\n    add a,b\n    dec a\n    ld (TO_SYC),a', '    ld a,1\n    ld (TO_RSTEP),a')]],
  ['copy: the same-row case does not use the row buffer', [E(T, '    ld a,(TO_DYS)\n    or a\n    jr nz,.direct\n    ex de,hl', '    ld a,(TO_DYS)\n    or a\n    jr .direct\n    ex de,hl')]],
  ['copy: the row buffer copy leaves out the attributes', [E(T, '    inc h\n    inc h\n    inc h\n    ld a,(TO_NX)\n    ld c,a\n    ld b,0\n    ld de,TO_BUFA\n    ldir', '    inc h\n    inc h\n    inc h\n    ld a,(TO_NX)\n    ld c,a\n    ld b,0\n    ld de,TO_BUFA\n    nop\n    nop')]],
  ['copy: the buffered attribute offset is the map\'s ($0300)', [E(T, '    ld hl,TO_BUFA-TO_BUFT\n    ld (TO_SOFF),hl', '    ld hl,$0300\n    ld (TO_SOFF),hl')]],
  ['copy: whole-byte loop: the source attribute pointer forgets to undo the eight INC E', [E(T, '        ld a,e\n        sub 8\n        ld e,a                  ; (mod 256: correct even when the eight INC E wrapped)', '        ld a,e\n        sub 7\n        ld e,a                  ; (mod 256: correct even when the eight INC E wrapped)')]],
  ['copy: copying onto itself is not detected (harmless: the result is the same, the dirty bits too) -- EQUIVALENT, expected to survive', [E(T, '    or b\n    ret z                       ; copy onto itself', '    or b\n    nop                         ; copy onto itself')]],
  // ---- the groups and the dirty marking ----
  ['slot (COPY): the cell is written before it is compared (nothing is ever dirty)', [E(T, '        ld a,(de)\n        cp (hl)\n        ld (hl),a\n        jr z,$+4\n        set k,mreg\n        inc e\n        inc l', '        ld a,(de)\n        ld (hl),a\n        cp (hl)\n        jr z,$+4\n        set k,mreg\n        inc e\n        inc l')]],
  ['slot (FILL): compares with the attribute register instead of the value', [E(T, '        ld a,(hl)\n        cp d\n        ld (hl),d\n        jr z,$+4\n        set k,mreg\n        inc l\n    ENDM\n    MACRO SLOT_FILLA', '        ld a,(hl)\n        cp e\n        ld (hl),d\n        jr z,$+4\n        set k,mreg\n        inc l\n    ENDM\n    MACRO SLOT_FILLA')]],
  ['slot (FILL attribute): the attribute is not written', [E(T, '        ld a,(hl)\n        cp e\n        ld (hl),e\n        jr z,$+4\n        set k,mreg\n        inc l\n    ENDM\n    MACRO SLOT_COPY', '        ld a,(hl)\n        cp e\n        nop\n        jr z,$+4\n        set k,mreg\n        inc l\n    ENDM\n    MACRO SLOT_COPY')]],
  ['slot (LOADMAP): the source does not advance', [E(T, '        ld a,(de)\n        inc de\n        cp (hl)', '        ld a,(de)\n        nop\n        cp (hl)')]],
  ['slot (LOADMAP attribute): a font cell gets attribute 0', [E(T, '1:      ld a,BG_ATTR\n2:      ld e,a', '1:      ld a,0\n2:      ld e,a')]],
  ['slot (LOADMAP attribute): the tile index keeps bit 7 (reads the wrong table entry)', [E(T, '        jr z,1F\n        and $7F\n        ld e,a', '        jr z,1F\n        nop\n        nop\n        ld e,a')]],
  ['slot (LOADMAP attribute): the new attribute is never stored', [E(T, '        cp (hl)\n        ld (hl),e\n        jr z,3F', '        cp (hl)\n        nop\n        jr z,3F')]],
  ['whole-byte FILL: the attribute pointer is off by one (SUB 7)', [E(T, '        EIGHT SLOT_FILL, c\n        ld a,l\n        sub 8', '        EIGHT SLOT_FILL, c\n        ld a,l\n        sub 7')]],
  ['whole-byte loop: the attribute mask register is not cleared (B keeps the last mask)', [E(T, '.fl:\n        ld bc,0                 ; C = the mask of the cell bytes, B = the mask of the attributes', '.fl:\n        ld c,0                  ; C = the mask of the cell bytes, B = the mask of the attributes')]],
  ['whole-byte loop: the two masks are not combined (the attribute mask is dropped)', [E(T, '        ld a,b\n        or c\n        exx\n        jr z,.fz', '        ld a,c\n        or c\n        exx\n        jr z,.fz')]],
  ['MARK: only the first file\'s dirty map is written', [E(T, '        ld (hl),a\n        inc h                   ; DIRTY1\n        ld a,c\n        or (hl)\n        ld (hl),a\n        dec h\n1:      inc l', '        ld (hl),a\n1:      inc l')]],
  ['whole-byte loop: the dirty byte does not advance', [E(T, '.fz:    inc l\n        dec b', '.fz:    nop\n        dec b')]],
  ['walk_setup: the head\'s shift has the wrong sign (c0 + cells)', [E(T, '    ld a,e\n    sub b\n    ld l,a\n    ld (TO_HSC),hl\n    ld b,0', '    ld a,e\n    add a,b\n    ld l,a\n    ld (TO_HSC),hl\n    ld b,0')]],
  ['walk_setup: the whole bytes are counted before the head is taken off', [E(T, '    ld a,b\n    sub e\n    ld b,a                      ; B = cells left after the head', '    ld a,b\n    nop\n    ld b,a                      ; B = cells left after the head')]],
  ['walk_setup: the tail\'s shift is 7 - cells', [E(T, '    ld a,8\n    sub d\n    ld l,a                      ; shift = 8 - tail cells', '    ld a,7\n    sub d\n    ld l,a                      ; shift = 8 - tail cells')]],
  ['mask_done: the alignment shifts once too few', [E(T, '    ld a,(TO_GT)\n    ld b,a\n    ld a,c\n.sh:', '    ld a,(TO_GT)\n    dec a\n    ld b,a\n    ld a,c\n.sh:')]],
  ['alternate registers: LOAD_ALT restores them in the wrong order', [E(T, '        exx\n        pop bc\n        pop de\n        pop hl\n        exx', '        exx\n        pop de\n        pop bc\n        pop hl\n        exx')]],
  ['alternate registers: neither saved nor restored (the caller\'s alternate set is clobbered)', [E(T, '    MACRO SAVE_ALT\n        exx\n        push hl\n        push de\n        push bc\n        exx\n    ENDM', '    MACRO SAVE_ALT\n        exx\n        exx\n    ENDM'), E(T, '    MACRO LOAD_ALT\n        exx\n        pop bc\n        pop de\n        pop hl\n        exx\n    ENDM', '    MACRO LOAD_ALT\n        exx\n        exx\n    ENDM')]],
  // ---- RT_FILL / FILLC ----
  ['RT_FILL: the attribute is the tile number instead of TILE_ATTR[tile]', [E(T, '    ld h,TILE_ATTR>>8           ; TILE_ATTR is page aligned\n    ld a,(hl)\n    ld (TO_A),a', '    ld h,TILE_ATTR>>8           ; TILE_ATTR is page aligned\n    ld a,l\n    ld (TO_A),a')]],
  ['RT_FILL: the tile is not made a game tile (bit 7 not set)', [E(T, '    ld a,l\n    or $80\n    ld (TO_V),a', '    ld a,l\n    or $00\n    ld (TO_V),a')]],
  ['RT_FILL: the tile number is not masked to 0..127', [E(T, 'RT_FILL:\n    ld a,(RA_V)\n    and $7F', 'RT_FILL:\n    ld a,(RA_V)\n    and $FF')]],
  ['RT_FILLC: the attribute is BG_ATTR instead of the text attribute', [E(T, '    ld a,(V_TEXT_ATTR)\n    ld (TO_A),a', '    ld a,BG_ATTR\n    ld (TO_A),a')]],
  ['RT_FILLC: the character is not masked to 0..127 (a tile would appear)', [E(T, 'RT_FILLC:\n    ld a,(RA_V)\n    and $7F', 'RT_FILLC:\n    ld a,(RA_V)\n    and $FF')]],
  // ---- LOADMAP and the header ----
  ['LOADMAP: a map cut on the left starts at the wrong source column (x not negated)', [E(T, '    jr z,.sx\n    sub l                       ; x < 0', '    jr z,.sx\n    ld a,l                      ; x < 0')]],
  ['LOADMAP: a map cut at the top starts at the wrong source row (the product is dropped)', [E(T, '    add hl,hl\n    rlca\n    jr nc,.mn\n    add hl,de\n.mn:', '    add hl,hl\n    rlca\n    jr nc,.mn\n    nop\n.mn:')]],
  ['LOADMAP: the next source row advances by the clipped width', [E(T, '    ld hl,(TO_SROW)\n    ld a,(TO_MW)\n    ld e,a', '    ld hl,(TO_SROW)\n    ld a,(TO_NX)\n    ld e,a')]],
  ['LOADMAP: an index >= the map count is accepted', [E(T, '    ld hl,V_NMAP\n    cp (hl)\n    ret nc', '    ld hl,V_NMAP\n    cp (hl)\n    nop')]],
  ['LOADMAP: the index is not doubled for the table', [E(T, '    ret nc\n    add a,a\n    ld hl,(V_MAPTAB)', '    ret nc\n    nop\n    ld hl,(V_MAPTAB)')]],
  ['LOADMAP: a map of height 0 is read -- EQUIVALENT: clip_axis finds a zero length empty anyway', [E(T, '    ld a,(hl)\n    or a\n    ret z                       ; height 0', '    ld a,(hl)\n    or a\n    nop                         ; height 0')]],
  ['maps_boot: a count of 65 is not clamped to 64', [E(T, '    cp MAX_MAPS+1\n    jr c,.cnt\n    ld a,MAX_MAPS', '    cp MAX_MAPS+2\n    jr c,.cnt\n    ld a,MAX_MAPS')]],
  ['maps_boot: the extension flag is ignored (an old header\'s $8010 is taken for a table)', [E(T, '    bit 7,a\n    jr z,.none\n    ld hl,(GAME_MAPTAB)', '    bit 6,a\n    jr z,.none\n    ld hl,(GAME_MAPTAB)')]],
  ['maps_boot: map 0 is not loaded (only the table is read)', [E(T, '    ld de,0\n    call RT_LOADMAPPTR          ; (a map-table entry may point into the bank window)\n    scf\n    ret', '    ld de,0\n    or a\n    ret')]],
  ['boot: frame_div keeps bit 7 (the extension flag is read as part of the divisor)', [E('boot.asm', '    and $7F                     ; bit 7 (DIV_EXT)', '    and $FF                     ; bit 7 (DIV_EXT)')]],
  ['boot: V_BORDER is not initialised', [E('boot.asm', '    ld a,BORDER_COLOUR\n    ld (V_BORDER),a', '    ld a,BORDER_COLOUR\n    nop\n    nop\n    nop')]],
  ['cells_init: the old map_ptr is also loaded over a table\'s map 0', [E('video.asm', '    call maps_boot\n    ret c', '    call maps_boot\n    nop')]],
  // ---- BORDER, RANDOMISE ----
  ['RT_BORDER: the colour is not masked', [E(T, 'RT_BORDER:\n    and 7', 'RT_BORDER:\n    and $1F')]],
  ['RT_BORDER: V_BORDER is not updated', [E(T, '    and 7\n    ld (V_BORDER),a\n    out (PORT_ULA),a', '    and 7\n    nop\n    nop\n    nop\n    out (PORT_ULA),a')]],
  ['RT_RANDOMISE: seed 0 from the frame counter may leave the seed 0', [E(T, '    or l\n    jr nz,.set\n    inc l\n.set:', '    or l\n    jr nz,.set\n    nop\n.set:')]],
  ['RT_RANDOMISE: HL = 0 reads the tick counter instead of the frame counter', [E(T, '    ld hl,(V_FRAMES)\n    ld a,h', '    ld hl,(V_TICKS)\n    ld a,h')]],
  ['RT_RANDOMISE: a non-zero seed is replaced by 1', [E(T, '    or l\n    jr nz,.set\n    ld hl,(V_FRAMES)', '    or l\n    jr nz,.one\n    ld hl,(V_FRAMES)')], ],
];
// (the last mutant above needs a label; its edit list is completed here)
MUTANTS[MUTANTS.length - 1][1].push(E(T, '.set:\n    ld (RT_SEED),hl\n    ret', '    jr .set\n.one:\n    ld hl,1\n.set:\n    ld (RT_SEED),hl\n    ret'));

if (checkOnly) {
  let bad = 0;
  for (const [name, edits] of MUTANTS) for (const e of edits) {
    const src = readFileSync(join(ARCADE, 'runtime/v2', e.file), 'utf8');
    const n = src.split(e.from).length - 1;
    if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad++; }
  }
  console.log(`${MUTANTS.length} mutants, ${bad} bad patterns`);
  process.exit(bad ? 1 : 0);
}

const tmp = mkdtempSync(join(tmpdir(), 'm5mut-'));
let killed = 0;
const survived = [], broken = [];
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
      const r = spawnSync('node', [join(root, 'arcade/tests', t)], { encoding: 'utf8', timeout: 600000, env: { ...process.env, M5_QUICK: '1' } });
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
