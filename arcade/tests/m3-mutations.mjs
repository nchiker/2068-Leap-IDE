"use strict";
// m3-mutations.mjs -- mutation test of the M3 test suite: copies arcade/ (runtime v1, tools, tests) to a temporary directory, applies one deliberate
// bug at a time to the runtime sources, rebuilds and runs the M3 tests; a mutation is KILLED when at least one test fails.  Every mutant must be killed.
//   node arcade/tests/m3-mutations.mjs [name-fragment]       (about 15 s per mutant)
import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = join(HERE, '..');
const TSRUN = join(ARCADE, '../tsrun');
const only = process.argv[2];
const TESTS = ['m3-runtime.mjs', 'm3-runtime-text.mjs', 'm3-runtime-sound.mjs', 'm3-runtime-regs.mjs'];

const E = (file, from, to) => ({ file, from, to });
const MUTANTS = [
  ['draw_cell forgets the attribute byte', [E('video.asm', '    ld (hl),d\n    ld a,b                      ; bitmap address of row 0', '    nop\n    ld a,b                      ; bitmap address of row 0')]],
  ['draw_cell: third offset of the bitmap address wrong', [E('video.asm', '; bitmap address of row 0 of the cell: $4000 + hoff + 8 * (idx >> 8)\n    add a,a\n', '; bitmap address of row 0 of the cell: $4000 + hoff + 8 * (idx >> 8)\n')]],
  ['erase misses the last column (x + 14)', [E('video.asm', '    ld a,b\n    add a,15\n', '    ld a,b\n    add a,14\n')]],
  ['erase never redraws the third column', [E('video.asm', '    cp 3\n    ret nz\n    ERASE_CELL', '    cp 4\n    ret nz\n    ERASE_CELL')]],
  ['mark_dirty marks only file 1', [E('text.asm', '    inc h                       ; DIRTY1 = DIRTY0 + $100\n    pop af\n    or (hl)\n    ld (hl),a\n    ret', '    pop af\n    ret')]],
  ['frame loop redraws dirty cells BEFORE frame_entry', [E('main.asm', '    call erase_all\n    ld hl,(GAME_FRAME)\n    call call_hl', '    call erase_all\n    call redraw_dirty\n    ld hl,(GAME_FRAME)\n    call call_hl'), E('main.asm', '    call redraw_dirty           ; cells changed', '    nop\n    nop\n    nop                         ; cells changed')]],
  ['sprites drawn BEFORE the dirty cells', [E('main.asm', '    call redraw_dirty           ; cells changed by init_entry / frame_entry (or by the map at boot) appear in this file now\n    call draw_all', '    call draw_all\n    call redraw_dirty')]],
  ['hidden-file offset always file 1', [E('main.asm', '    ld (V_HOFF),a', '    xor a\n    ld (V_HOFF),a')]],
  ['sound tick forgets to preserve DE', [E('sound.asm', '    push bc\n    push de\n    push hl\n    ld hl,(V_SFX_PTR)', '    push bc\n    push hl\n    ld hl,(V_SFX_PTR)'), E('sound.asm', '.out:\n    pop hl\n    pop de\n    pop bc', '.out:\n    pop hl\n    pop bc')]],
  ['RT_STICK without DI (the sound tick may split an AY access)', [E('api.asm', '    di                          ; v1:', '    nop                         ; v1:')]],
  ['RT_HIT: touching boxes hit (<=)', [E('text.asm', '    ld de,(HB_B+2)\n    or a', '    ld de,(HB_B+2)\n    inc de\n    or a')]],
  ['RT_PRINTN: no negation of negative values', [E('text.asm', '    call neg_hl                 ; -32768', '    nop\n    nop\n    nop                         ; -32768')]],
  ['sound: noise-off mixer bit mapped to bit 3 + 2', [E('sound.asm', '    add a,6                     ; 2 -> 8', '    add a,5                     ; 2 -> 8')]],
  ['tile count above 128 not clamped', [E('video.asm', '    ld a,MAX_TILES\n.count:', '    nop\n.count:')]],
  ['cursor wraps at row 25 instead of 24', [E('text.asm', '    inc a\n    cp CELL_ROWS\n    jr c,.row\n    xor a\n.row:', '    inc a\n    cp CELL_ROWS+1\n    jr c,.row\n    xor a\n.row:')]],
  ['cell_set: an attribute-only change is not stored', [E('text.asm', '    cp e\n    ret z                       ; nothing changed: nothing to redraw', '    cp e\n    ret                         ; nothing changed: nothing to redraw')]],
  ['boot does not zero AY register 0..14', [E('boot.asm', '    djnz .ay\n', '')]],
  ['RT_PLAY accepts index = count', [E('sound.asm', '    cp c\n    ret z                       ; count = index\n', '    cp c\n    nop                         ; count = index\n')]],
  ['hot box pointer ignored', [E('video.asm', '    ld l,(ix+SD_HOT)', '    ld l,0')]],
  ['terminator does not clear V_SFX_ACTIVE', [E('sound.asm', '.end:\n    xor a\n    ld (V_SFX_ACTIVE),a', '.end:\n    xor a\n    nop\n    nop\n    nop')]],
  ['RT_SILENCE writes nothing', [E('sound.asm', '    ret z                       ; already silent', '    ret                         ; already silent')]],
  ['redraw_dirty skips the last block', [E('video.asm', '    ld b,DIRTY_LEN/8\n.block:', '    ld b,DIRTY_LEN/8-1\n.block:')]],
  ['RT_TILE uses BG_ATTR instead of the tile attribute', [E('text.asm', '    ld e,(hl)                   ; the tile\'s attribute', '    ld e,BG_ATTR')]],
  ['RT_AT clamps the row to 24', [E('text.asm', '    ld a,CELL_ROWS-1\n.row:\n    ld (V_CUR_ROW),a', '    ld a,CELL_ROWS\n.row:\n    ld (V_CUR_ROW),a')]],
  ['draw_cell: glyph plane step missing (INC B lost once)', [E('video.asm', 'cell_rows:\n    ld a,(bc)\n    ld (de),a\n    inc b\n    inc d\n    ld a,(bc)\n    ld (de),a\n    inc b\n    inc d', 'cell_rows:\n    ld a,(bc)\n    ld (de),a\n    inc b\n    inc d\n    ld a,(bc)\n    ld (de),a\n    nop\n    inc d')]],
  ['ISR: sound check lost (sound never plays)', [E('isr.asm', '    jp nz,SND_TICK', '    nop\n    nop\n    nop')]],
  ['sound tick: terminator test uses byte 0', [E('sound.asm', '    ld b,a                      ; B = byte 1\n    inc a\n    jr z,.end', '    ld b,a                      ; B = byte 1\n    ld a,c\n    inc a\n    jr z,.end')]],
  ['tick: V_SYNC request uses the wrong file', [E('main.asm', '    ld a,(V_HIDDEN)\n    add a,SYNC_REQUEST', '    ld a,(V_HIDDEN)\n    xor 1\n    add a,SYNC_REQUEST')]],
  ['print_char writes the cursor cell with the wrong attribute (ink only)', [E('text.asm', '    ld a,(V_TEXT_ATTR)\n    ld e,a\n    call cursor_idx', '    ld a,(V_TEXT_ATTR)\n    and 7\n    ld e,a\n    call cursor_idx')]],
];

const tmp = mkdtempSync(join(tmpdir(), 'm3mut-'));
let killed = 0, survived = [], broken = [];
try {
  for (const [name, edits] of MUTANTS) {
    if (only && !name.includes(only)) continue;
    const root = join(tmp, 'root');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, 'arcade'), { recursive: true });
    for (const d of ['runtime/v1', 'tools', 'tests']) cpSync(join(ARCADE, d), join(root, 'arcade', d), { recursive: true });
    symlinkSync(TSRUN, join(root, 'tsrun'));
    let bad = false;
    for (const e of edits) {
      const p = join(root, 'arcade/runtime/v1', e.file);
      const src = readFileSync(p, 'utf8');
      const n = src.split(e.from).length - 1;
      if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad = true; break; }
      writeFileSync(p, src.replace(e.from, () => e.to));
    }
    if (bad) { broken.push(name); continue; }
    let failedBy = null, buildErr = false;
    for (const t of TESTS) {
      const r = spawnSync('node', [join(root, 'arcade/tests', t)], { encoding: 'utf8', timeout: 240000 });
      const out = (r.stdout ?? '') + (r.stderr ?? '');
      if (/sjasmplus failed/.test(out)) { buildErr = true; break; }
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
