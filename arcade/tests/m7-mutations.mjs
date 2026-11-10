"use strict";
// m7-mutations.mjs -- mutation test of the runtime v3 part 2 suites: copies arcade/ (all runtimes, tools, tests) to a temporary directory, applies one
// deliberate bug at a time to the new code (scroll.asm: the boot and its RLE decoder, the repaint, the row loops, the attribute pass, the dirty mask,
// the sprites in window mode, ring repair, RT_CAMERA, the collision routines, SHOW / HIT in window mode; the window branches of main.asm, api.asm,
// text.asm), rebuilds and runs the m7 suites in their quick form (M7_QUICK=1); a mutation is KILLED when at least one suite fails.
//   node arcade/tests/m7-mutations.mjs [name-fragment]      (about 10-40 s per mutant)
//   node arcade/tests/m7-mutations.mjs --check              only verifies that every pattern occurs exactly once
//   node arcade/tests/m7-mutations.mjs --shard=0/4          every fourth mutant (run the shards in parallel)
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
const TESTS = ['m7-runtime-api.mjs', 'm7-runtime-mem.mjs', 'm7-runtime-regs.mjs', 'm7-runtime.mjs'];

const E = (file, from, to) => ({ file, from, to });
const SC = 'scroll.asm';
const MUTANTS = [
  // ---- window_boot ----
  ['boot: cx 9 accepted', [E(SC, '    cp 9\n    ret nc                      ; cx 0..8', '    cp 10\n    ret nc                      ; cx 0..8')]],
  ['boot: the rows need not add up to 16', [E(SC, '    cp 16\n    ret nz                      ; the rows must add up to 16', '    cp 16\n    nop                         ; the rows must add up to 16')]],
  ['boot: a ratio-2 band does not halve cam_max', [E(SC, '    jr z,.c1\n    srl h\n    rr l\n.c1:', '    jr z,.c1\n    nop\n    nop\n    nop\n    nop\n.c1:')]],
  ['boot: cam_max is always the descriptor\'s (not clamped)', [E(SC, '    pop hl\n    jr c,.c2\n    ex de,hl\n.c2:', '    pop hl\n    jr .c2\n    ex de,hl\n.c2:\n    ex de,hl')]],
  ['boot: RLE does not stop at 2,048 bytes', [E(SC, '    jr z,.rd                    ; 2,048 bytes written: the rest of the list is ignored', '    nop\n    nop                         ; 2,048 bytes written: the rest of the list is ignored')]],
  ['boot: RLE takes count - 1 bytes per pair', [E(SC, '    ld b,a\n    inc hl\n    ld c,(hl)\n    inc hl\n.rr:', '    ld b,a\n    inc hl\n    ld c,(hl)\n    inc hl\n    dec b\n    jr z,.rp\n.rr:')]],
  ['boot: the tile rows copy is 255 bytes', [E(SC, '    ld de,W_TROWS\n    ld bc,256', '    ld de,W_TROWS\n    ld bc,255')]],
  ['boot: the flags go to the attribute page (inc d missing)', [E(SC, '    inc d                       ; W_FLAGT = W_ATTRT + $100', '    nop                         ; W_FLAGT = W_ATTRT + $100')]],
  ['boot: dirty byte 3 masked like byte 0 (no CPL)', [E(SC, '    ld (W_DMASK0),a\n    cpl', '    ld (W_DMASK0),a\n    nop')]],
  ['boot: the attribute caches start at 0 instead of $FF', [E(SC, '.ac:\n    ld (hl),$FF', '.ac:\n    ld (hl),$00')]],
  ['boot: the attribute base ignores cx', [E(SC, '    ld a,(W_CX)\n    ld e,a\n    ld d,DATTR0>>8', '    xor a\n    ld e,a\n    ld d,DATTR0>>8')]],
  // ---- window_repaint and the row loops ----
  ['repaint: ratio 2 is not doubled', [E(SC, '    jr c,.sh\n    add hl,hl\n    ret', '    jr c,.sh\n    nop\n    ret')]],
  ['repaint: ratio 1/4 shifts once', [E(SC, '    cp 2\n    ret z\n    srl h\n    rr l\n    ret', '    cp 2\n    ret z\n    nop\n    nop\n    ret')]],
  ['repaint: a fixed band moves with the camera', [E(SC, '    or a\n    jr nz,.r\n    ld h,a\n    ld l,a\n    ret', '    or a\n    jr nz,.r\n    nop\n    nop\n    ret')]],
  ['repaint: the LTAB page is 2p, not 2(p - 1)', [E(SC, '    jr z,.p0\n    dec a\n    add a,a', '    jr z,.p0\n    nop\n    add a,a')]],
  ['repaint: the right table is the left one (no INC D)', [E(SC, '    ld d,h\n    inc d                       ; D = RTAB[p]', '    ld d,h\n    nop                         ; D = RTAB[p]')]],
  ['repaint: a downward cell does not start at row 7 (OR 7 missing, phase <> 0)', [E(SC, '    ld l,e\n    ld a,(ix+SCK*2+2)\n    or 7', '    ld l,e\n    ld a,(ix+SCK*2+2)\n    or 0')]],
  ['repaint: phase-0 downward cells do not start at row 7', [E(SC, '    ld a,(ix+SCK*2+1)\n    or 7', '    ld a,(ix+SCK*2+1)\n    or 0')]],
  ['repaint: the next window row in a new third adds 7 to the high byte', [E(SC, '    ld a,b\n    add a,8\n    ld b,a\n1:\n    ENDM', '    ld a,b\n    add a,7\n    ld b,a\n1:\n    ENDM')]],
  ['repaint: the next window row is 31 bytes on', [E(SC, '    ld a,c\n    add a,9\n    ld c,a', '    ld a,c\n    add a,8\n    ld c,a')]],
  ['repaint: the phase-0 rows step the world 127 bytes', [E(SC, '    SC_NEXTROW\n    ld de,128\n    add ix,de\n    ld a,(W_CR)', '    SC_NEXTROW\n    ld de,127\n    add ix,de\n    ld a,(W_CR)')]],
  ['repaint: the hidden file is ignored for the bitmap (draws into file 1 always)', [E(SC, '    ld hl,(W_BMBASE)\n    add a,h', '    ld hl,(W_BMBASE)\n    nop')]],
  ['repaint: IX is not saved', [E(SC, 'window_repaint:\n    push ix', 'window_repaint:\n    nop\n    nop'), E(SC, '    jp nz,.band\n    pop ix', '    jp nz,.band\n    nop\n    nop')]],
  ['repaint: the attribute pass every tick (cache not consulted)', [E(SC, '    ld a,(W_C0)\n    cp (hl)\n    jr z,.noat', '    ld a,(W_C0)\n    cp (hl)\n    nop\n    nop')]],
  ['repaint: one attribute cache for both files', [E(SC, '    ld a,(V_HIDDEN)\n    add a,a\n    add a,a\n    add a,W_AC&$FF', '    xor a\n    add a,a\n    add a,a\n    add a,W_AC&$FF')]],
  ['repaint: the next band\'s attributes start rows x 16 bytes on', [E(SC, '    add hl,hl\n    add hl,hl                   ; rows * 32', '    add hl,hl\n    nop                         ; rows * 32')]],
  ['repaint: the next band\'s world rows start rows x 64 bytes on', [E(SC, '    add hl,hl\n    add hl,hl                   ; rows * 128', '    add hl,hl\n    nop                         ; rows * 128')]],
  ['attr: the world row steps 128 - 24', [E(SC, '    add a,128-23', '    add a,128-24')]],
  ['attr: the attribute row steps 32 - 24', [E(SC, '    add a,32-23', '    add a,32-24')]],
  ['attr: the attribute of the next tile (m[c+1])', [E(SC, '    ld b,W_ATTRT>>8\n.row:\n    DUP 23\n    ld c,(hl)\n    inc l\n    ld a,(bc)', '    ld b,W_ATTRT>>8\n.row:\n    DUP 23\n    inc l\n    ld c,(hl)\n    ld a,(bc)')]],
  // ---- the dirty mask and the tick ----
  ['mask: dirty byte 2 of a window row is not cleared', [E(SC, '    inc l\n    ld (hl),b\n    inc l\n    ld (hl),b\n    inc l\n    ld a,(hl)\n    and e', '    inc l\n    ld (hl),b\n    inc l\n    nop\n    inc l\n    ld a,(hl)\n    and e')]],
  ['mask: 15 window rows', [E(SC, '    ld b,0\n    ld d,16', '    ld b,0\n    ld d,15')]],
  ['tick: no ring repair', [E(SC, '    call ring_repair\n    jp TICK_COUNT', '    nop\n    nop\n    nop\n    jp TICK_COUNT')]],
  // ---- sprites in window mode ----
  ['draw: x is not rounded to the phase granularity', [E(SC, '    ld a,(de)\n    and l                       ; rounded down to the phase granularity', '    ld a,l\n    nop                         ; rounded down to the phase granularity')]],
  ['draw: the camera is not subtracted', [E(SC, '    ex de,hl\n    or a\n    sbc hl,de\n    ld a,(W_WX0)', '    ex de,hl\n    or a\n    nop\n    nop\n    ld a,(W_WX0)')]],
  // EQUIVALENT: the test sx <= 256 - w is redundant with the window test that follows: sx + w - 1 is computed in 8 bits, so for a footprint past the
  // right screen edge it wraps to 0..w - 2; such a footprint can start inside the window (sx <= 8 cx + 191) only when 8 cx > sx - 192 >= 64 - w, i.e.
  // cx >= 5, and then the wrapped right edge (<= 30) is left of the window (8 cx >= 40): culled either way.  Kept in the code for clarity (26 T a sprite).
  ['EQUIVALENT draw: a footprint past the right screen edge is drawn (culled by the window test)', [E(SC, '    neg\n    cp e\n    jp c,wd_next', '    neg\n    cp e\n    nop\n    nop\n    nop')]],
  ['draw: a footprint past the bottom screen edge is drawn', [E(SC, '    ld hl,W_SY\n    cp (hl)\n    jp c,wd_next', '    ld hl,W_SY\n    cp (hl)\n    nop\n    nop\n    nop')]],
  ['draw: a footprint that ends above the window is drawn (culling missing)', [E(SC, '    ld a,(W_SY1)\n    cp c\n    jp c,wd_next', '    ld a,(W_SY1)\n    cp c\n    nop\n    nop\n    nop')]],
  ['draw: a footprint crossing the right window edge gets no ring record', [E(SC, '    ld a,d\n    inc l                       ; W_SX1 (HL was W_SY)\n    cp (hl)\n    jr c,.ring', '    ld a,d\n    inc l                       ; W_SX1 (HL was W_SY)\n    cp (hl)\n    nop\n    nop')]],
  ['draw: the ring record\'s c1 is c0', [E(SC, '    inc e\n    inc l\n    inc l\n    ld a,(hl)                   ; c1 = (sx + w - 1) >> 3', '    inc e\n    nop\n    nop\n    ld a,(hl)                   ; c1 = (sx + w - 1) >> 3')]],
  ['draw: the frame is not clamped', [E(SC, '    ld a,(W_FR)                 ; the frame, clamped to nframes - 1\n    cp (hl)\n    jr c,.fok', '    ld a,(W_FR)                 ; the frame, clamped to nframes - 1\n    cp (hl)\n    jr .fok')]],
  ['draw: a 16-wide aligned sprite takes the 24-wide game-image blitter', [E(SC, '    cp 2\n    jr nz,.r3\n    call blitr2', '    cp 2\n    jr nz,.r3\n    call blitr3')]],
  ['draw: PHASE_OFF indexed from the AST record', [E(SC, '    ld a,(W_AREC)\n    sub (AST&$FF)-(PHASE_OFF&$FF)', '    ld a,(W_AREC)\n    nop\n    nop')]],
  ['draw: a miss builds the frame of asset 0', [E(SC, '    ld a,(W_AREC)\n    sub AST&$FF\n    rrca', '    xor a\n    nop\n    nop\n    rrca')]],
  ['draw: sy takes 8 cx', [E(SC, '    ld a,(W_WY0)                ; sy = y + 8 cy', '    ld a,(W_WX0)                ; sy = y + 8 cy')]],
  // ---- ring repair ----
  ['ring: the window\'s last row counts as outside', [E(SC, '    sub b\n    cp 16\n    jr c,rr_inrow', '    sub b\n    cp 15\n    jr c,rr_inrow')]],
  ['ring: the column right of the window counts as inside', [E(SC, '    add a,24\n    ld b,a\n    ld a,(W_RC1)', '    add a,25\n    ld b,a\n    ld a,(W_RC1)')]],
  ['ring: the cell index of rows 16-23 loses bit 4', [E(SC, '    ld a,b\n    and 3\n    ld b,a\n.cell:', '    ld a,b\n    and 1\n    ld b,a\n.cell:')]],
  ['ring: the last column of a run is skipped', [E(SC, '    sub d\n    inc a\n    ld e,a                      ; E = cells', '    sub d\n    nop\n    ld e,a                      ; E = cells')]],
  ['ring: the left part ends at cx (a window cell drawn from the cell map)', [E(SC, '    ld a,b\n    dec a\nrr_l1:', '    ld a,b\n    nop\nrr_l1:')]],
  ['ring: only the first row of a record is repaired', [E(SC, '    inc a\n    ld (W_RR),a\n    jr c,rr_row', '    inc a\n    ld (W_RR),a\n    nop\n    nop')]],
  // ---- SHOW / CAMERA / collision / HIT ----
  ['show: window mode keeps the y high byte at 0', [E(SC, '    ld (hl),e\n    inc l\n    ld (hl),d\n    inc l\n    pop de', '    ld (hl),e\n    inc l\n    ld (hl),0\n    inc l\n    pop de')]],
  ['show: window mode does not store the frame', [E(SC, '    pop de\n    ld (hl),e\n    ret', '    pop de\n    nop\n    ret')]],
  ['api: show_f has no window branch (positions clamped)', [E('api.asm', '    jr nz,show_w ', '    nop\n    nop ')]],
  ['camera: a negative request is not 0', [E(SC, 'RT_CAMERA:\n    bit 7,h\n    jr z,.pos', 'RT_CAMERA:\n    bit 7,h\n    jr .pos')]],
  ['camera: cam_max itself is refused (cam_max - 1 is the maximum ... or more)', [E(SC, '    pop hl\n    jr c,.st\n    ex de,hl', '    pop hl\n    jr c,.st\n    ex de,hl\n    dec hl')]],
  ['world_cell: rows 16..31 (y 128..255) count as above (1)', [E(SC, '    bit 7,e\n    jr nz,.below                ; y 128..255', '    bit 7,e\n    jr nz,.side                 ; y 128..255')]],
  ['world_cell: x = 8 world_w counts as inside', [E(SC, '    ld a,l\n    sub c\n    ld a,h\n    sbc a,b\n    jr nc,.side                 ; x >= 8 world_w', '    ld a,c\n    sub l\n    ld a,b\n    sbc a,h\n    jr c,.side                  ; x >= 8 world_w')]],
  ['world_cell: the row address ignores bit 6 of y', [E(SC, '    rrca\n    and 7\n    add a,WORLD_RAM>>8', '    rrca\n    and 3\n    add a,WORLD_RAM>>8')]],
  ['TILEFLAGS: reads the attribute page', [E(SC, '    ld l,(hl)\n    ld h,W_FLAGT>>8', '    ld l,(hl)\n    ld h,W_ATTRT>>8')]],
  ['WORLDTILE: tile AND 15', [E(SC, '    rrca\n    and 31\n    ld l,a\n    ld h,0\n    ret\n.out:\n    ld hl,0', '    rrca\n    and 15\n    ld l,a\n    ld h,0\n    ret\n.out:\n    ld hl,0')]],
  ['SETWORLD: no invalidation when the attribute changes', [E(SC, '    ld a,(bc)\n    cp e\n    ret z', '    ld a,(bc)\n    cp e\n    ret')]],
  ['SETWORLD: writes tile * 4', [E(SC, '    ld a,(RA_V)\n    add a,a\n    add a,a\n    add a,a\n    ld c,(hl)', '    ld a,(RA_V)\n    add a,a\n    add a,a\n    nop\n    ld c,(hl)')]],
  ['TILEHIT: w = 0 is not refused', [E(SC, 'RT_TILEHIT:\n    ld hl,(RA_W)                ; w <= 0 or h <= 0: no pixel, 0\n    ld a,h\n    or a\n    jp m,th_zero\n    or l\n    jp z,th_zero', 'RT_TILEHIT:\n    ld hl,(RA_W)                ; w <= 0 or h <= 0: no pixel, 0\n    ld a,h\n    or a\n    jp m,th_zero\n    or l\n    nop\n    nop\n    nop')]],
  ['TILEHIT: y + h - 1 past 32,767 is taken as negative', [E(SC, '    adc hl,de                   ; y1; P/V: the signed sum passed 32,767 (upwards only: h > 0)\n    jp pe,.rb15', '    adc hl,de                   ; y1; P/V: the signed sum passed 32,767 (upwards only: h > 0)\n    nop\n    nop\n    nop')]],
  ['TILEHIT: rows above the world add nothing', [E(SC, '.above:\n    inc a                       ; rows above the world: 1', '.above:\n    nop                         ; rows above the world: 1')]],
  ['TILEHIT: the unrolled rows step 128 - n', [E(SC, '        add a,128-(n-1)', '        add a,128-n')]],
  ['TILEHIT: columns right of the world add nothing', [E(SC, '.cbmax:\n    call th_side', '.cbmax:\n    nop\n    nop\n    nop')]],
  ['TILEHIT: the long loop stops early on any bit (not every bit of the mask)', [E(SC, '    ld a,(RA_V)\n    ld d,a\n    and e\n    cp d\n    jr z,.done', '    ld a,(RA_V)\n    ld d,a\n    and e\n    nop\n    jr nz,.done')]],
  // EQUIVALENT: the edges are within +-2^17, so the top byte of a difference is $FE, $FF, $00 or $01; bit 0 and bit 7 differ only for $01 (the mutant
  // says "below", wrongly) and $FE (it says "not below", wrongly).  On one axis a.x0 - b.x1 >= 65,536 ($01) forces b.x0 - a.x1 <= -65,536 - widths ($FE),
  // and the other way round, so the axis test (both comparisons true) is false either way: RT_HIT's result never changes.
  ['EQUIVALENT HIT: lt24 takes the low bit for the sign (the axis result cannot change)', [E(SC, '    rla                         ; carry = the sign of the difference', '    rra                         ; carry = the sign of the difference')]],
  ['HIT: no sign extension (24-bit edges of negative positions)', [E(SC, '    rla\n    sbc a,a\n    ld (WH_T),a                 ; the sign extension', '    rla\n    xor a\n    ld (WH_T),a                 ; the sign extension')]],
  ['HIT: text.asm has no window branch (16-bit wrapped boxes)', [E('text.asm', '    jr nz,hit_w ', '    nop\n    nop ')]],
  ['main: no window branch (the part 1 tick in window mode)', [E('main.asm', '    jp nz,win_tick', '    nop\n    nop\n    nop')]],
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

const tmp = mkdtempSync(join(tmpdir(), 'm7mut-'));
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
      const r = spawnSync('node', [join(root, 'arcade/tests', t)], { encoding: 'utf8', timeout: 900000, env: { ...process.env, M7_QUICK: '1' } });
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
