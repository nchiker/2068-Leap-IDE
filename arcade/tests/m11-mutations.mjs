"use strict";
// m11-mutations.mjs -- mutation test of m11-runtime-bank.mjs (banking, slice B1): copies arcade/ (all runtimes, tools, tests) to a temporary directory, applies one deliberate
// bug at a time to the NEW code (the bank_on / bank_off helpers, the checking entry of RT_LOADMAPPTR, maps_boot's call, MAX_MAPS, v3's world_load / RT_WORLDLOAD / window_boot's
// checks, v4's ray_check / ray_map_load / ray_dims / RT_PLANLOAD), rebuilds and runs m11 on that runtime only (M11_VERSIONS); a mutation is KILLED when the test fails.  Every
// mutant must be killed (or be listed as equivalent below, with the reason).  A pattern that does not occur exactly once is reported, not run.
//   node arcade/tests/m11-mutations.mjs [name-fragment] [--shard=i/n] [--versions=2,3]     (5-12 s per mutant; --shard splits the list for parallel runs)
//   node arcade/tests/m11-mutations.mjs --check               only verify that every pattern occurs once
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
const shard = (args.find((a) => a.startsWith('--shard=')) ?? '').slice(8).split('/').map(Number);      // --shard=i/n: mutants i, i + n, i + 2n ... (0-based i)
const versions = (args.find((a) => a.startsWith('--versions=')) ?? '').slice(11).split(',').filter(Boolean).map(Number);

// A mutant: [name, version, edits]; an edit replaces `from` (found exactly once in runtime/v<version>/<file>) with `to`.
const E = (file, from, to) => ({ file, from, to });
const NOP = (n) => Array(n).fill('    nop').join('\n');
const T = 'tileops.asm';
const MUTANTS = [];
const add = (name, v, ...edits) => MUTANTS.push([name, v, edits]);

// ---- v2: the checking entry, the helpers, MAX_MAPS (v3 and v4 carry the same text in tileops.asm) ----
add('RT_LOADMAPPTR: the window starts at $41 ($40 not banked)', 2, E(T, '    sub BANK_LO ', '    sub BANK_LO+1 '));
add('RT_LOADMAPPTR: the window starts at $3F ($3F banked)', 2, E(T, '    sub BANK_LO ', '    sub BANK_LO-1 '));
add('RT_LOADMAPPTR: the window ends at $7E ($7F not banked)', 2, E(T, '    cp BANK_HI-BANK_LO\n    jp nc,loadmap_core', '    cp BANK_HI-BANK_LO-1\n    jp nc,loadmap_core'));
add('RT_LOADMAPPTR: the window ends at $80 ($80 banked)', 2, E(T, '    cp BANK_HI-BANK_LO\n    jp nc,loadmap_core', '    cp BANK_HI-BANK_LO+1\n    jp nc,loadmap_core'));
add('RT_LOADMAPPTR: the test looks at D, not H', 2, E(T, 'RT_LOADMAPPTR:\n    ld a,h', 'RT_LOADMAPPTR:\n    ld a,d'));
add('RT_LOADMAPPTR: the test inverted (a mapped map goes through the window)', 2, E(T, '    jp nc,loadmap_core ', '    jp c,loadmap_core  '));
add('RT_LOADMAPPTR: the window is never mapped', 2, E(T, '    call bank_on\n    call loadmap_core\nbank_off:', NOP(3) + '\n    call loadmap_core\nbank_off:'));
add('RT_LOADMAPPTR: the window is never unmapped', 2, E(T, '    call bank_on\n    call loadmap_core\nbank_off:', '    call bank_on\n    jp loadmap_core\nbank_off:'));
add('bank_off maps the window ($3F) instead of unmapping', 2, E(T, 'bank_off:                       ; unmap the window: $F4 = F4_PLAY.  bank_on / bank_off clobber A only; only these two (and the boot) write $F4\n    ld a,F4_PLAY', 'bank_off:                       ; unmap the window: $F4 = F4_PLAY.  bank_on / bank_off clobber A only; only these two (and the boot) write $F4\n    ld a,F4_BANK'));
add('bank_on writes F4_PLAY (nothing is mapped)', 2, E(T, '    ld a,F4_BANK\nbank_set:', '    ld a,F4_PLAY\nbank_set:'));
add('bank_on / bank_off: the shadow is never written', 2, E(T, '    ld (V_SHADOW_F4),a          ; the shadow first', NOP(3) + '                          ; the shadow first'));
add('bank_on / bank_off: the port first, then the shadow (the order of the contract reversed)', 2, E(T, '    ld (V_SHADOW_F4),a          ; the shadow first, then the port (the shadow is never read back from the port)\n    out (PORT_HSR),a', '    out (PORT_HSR),a\n    ld (V_SHADOW_F4),a'));
add('bank_on / bank_off: the value goes to port $FF', 2, E(T, '    out (PORT_HSR),a\n    ret\nloadmap_core:', '    out (PORT_SCLD),a\n    ret\nloadmap_core:'));
add('bank_on / bank_off clobber C (the x of the map)', 2, E(T, 'bank_set:\n    ld (V_SHADOW_F4),a', 'bank_set:\n    ld c,a\n    ld (V_SHADOW_F4),a'));
add('bank_on / bank_off clobber D (the y of the map)', 2, E(T, 'bank_set:\n    ld (V_SHADOW_F4),a', 'bank_set:\n    ld d,a\n    ld (V_SHADOW_F4),a'));
add('RT_LOADMAP / RT_LOADMAPAT skip the checking entry', 2, E(T, '    or l\n    ret z\nRT_LOADMAPPTR:', '    or l\n    ret z\n    jp loadmap_core\nRT_LOADMAPPTR:'));
add('maps_boot calls loadmap_core directly (map 0 in the window is read unmapped)', 2, E(T, '    call RT_LOADMAPPTR          ; (a map-table entry may point into the bank window)', '    call loadmap_core           ; (a map-table entry may point into the bank window)'));
add('MAX_MAPS 63', 2, E('layout.inc', 'MAX_MAPS        EQU 64 ', 'MAX_MAPS        EQU 63 '));
add('MAX_MAPS 65', 2, E('layout.inc', 'MAX_MAPS        EQU 64 ', 'MAX_MAPS        EQU 65 '));
add('MAX_MAPS 8 (as before banking)', 2, E('layout.inc', 'MAX_MAPS        EQU 64 ', 'MAX_MAPS        EQU 8  '));
add('F4_BANK $37 (chunk 2 only)', 2, E('layout.inc', 'F4_BANK         EQU $3F ', 'F4_BANK         EQU $37 '));
add('F4_BANK $3B (chunk 3 only)', 2, E('layout.inc', 'F4_BANK         EQU $3F ', 'F4_BANK         EQU $3B '));
add('F4_BANK $7F (chunk 6 too: the variables vanish)', 2, E('layout.inc', 'F4_BANK         EQU $3F ', 'F4_BANK         EQU $7F '));
// ---- v3 / v4: the same wrapper and maps_boot in their own files ----
add('v3 RT_LOADMAPPTR: the window is never mapped', 3, E(T, '    call bank_on\n    call loadmap_core\nbank_off:', NOP(3) + '\n    call loadmap_core\nbank_off:'));
add('v3 maps_boot calls loadmap_core directly', 3, E('video.asm', '    call RT_LOADMAPPTR          ; (a map-table entry may point into the bank window)', '    call loadmap_core           ; (a map-table entry may point into the bank window)'));
add('v3 MAX_MAPS 63', 3, E('layout.inc', 'MAX_MAPS        EQU 64 ', 'MAX_MAPS        EQU 63 '));
add('v4 RT_LOADMAPPTR: the window is never unmapped', 4, E(T, '    call bank_on\n    call loadmap_core\nbank_off:', '    call bank_on\n    jp loadmap_core\nbank_off:'));
add('v4 maps_boot calls loadmap_core directly', 4, E(T, '    call RT_LOADMAPPTR          ; (a map-table entry may point into the bank window)', '    call loadmap_core           ; (a map-table entry may point into the bank window)'));
add('v4 MAX_MAPS 63', 4, E('layout.inc', 'MAX_MAPS        EQU 64 ', 'MAX_MAPS        EQU 63 '));
// ---- v3: window_boot's checks, world_load, RT_WORLDLOAD ----
const S3 = 'scroll.asm';
add('window_boot: world_src must be in $8000-$BFFF as before (the window refused)', 3, E(S3, '    ld a,(ix+11)\n    sub BANK_LO\n    cp $80', '    ld a,(ix+11)\n    sub $80\n    cp $40'));
add('window_boot: world_src accepted from $3F', 3, E(S3, '    ld a,(ix+11)\n    sub BANK_LO\n', '    ld a,(ix+11)\n    sub BANK_LO-1\n'));
add('window_boot: world_src accepted up to $C0', 3, E(S3, '    cp $80\n    ret nc                      ; world_src', '    cp $81\n    ret nc                      ; world_src'));
add('window_boot: tile_flags accepted in the window', 3, E(S3, '    ld a,(ix+9)\n    sub $80\n', '    ld a,(ix+9)\n    sub BANK_LO\n'));
add('window_boot: tilerows accepted in the window', 3, E(S3, '    ld a,(ix+13)\n    sub $80\n', '    ld a,(ix+13)\n    sub BANK_LO\n'));
add('window_boot: tile_flags no longer checked', 3, E(S3, '    ld a,(ix+9)\n    sub $80\n    cp $40\n    ret nc                      ; tile_flags (+9) and tilerows (+13): inside the game image\n', '    ld a,(ix+9)\n    sub $80\n    cp $40\n    nop                         ; tile_flags (+9) and tilerows (+13): inside the game image\n'));
add('window_boot decodes without the window (call world_decode)', 3, E(S3, '    ld h,(ix+11)\n    call world_load', '    ld h,(ix+11)\n    call world_decode'));
add('world_load: the test inverted', 3, E(S3, '    jr nc,world_decode          ; mapped: as before', '    jr c,world_decode           ; mapped: as before'));
add('world_load: the window starts at $41', 3, E(S3, 'world_load:\n    ld a,h\n    sub BANK_LO', 'world_load:\n    ld a,h\n    sub BANK_LO+1'));
add('world_load: the window starts at $3F', 3, E(S3, 'world_load:\n    ld a,h\n    sub BANK_LO', 'world_load:\n    ld a,h\n    sub BANK_LO-1'));
add('world_load: the window ends at $7E', 3, E(S3, '    cp BANK_HI-BANK_LO\n    jr nc,world_decode', '    cp BANK_HI-BANK_LO-1\n    jr nc,world_decode'));
add('world_load: the window ends at $80', 3, E(S3, '    cp BANK_HI-BANK_LO\n    jr nc,world_decode', '    cp BANK_HI-BANK_LO+1\n    jr nc,world_decode'));
add('world_load: the window is never mapped', 3, E(S3, '    call bank_on\n    call world_decode\n    jp bank_off', NOP(3) + '\n    call world_decode\n    jp bank_off'));
add('world_load: the window is never unmapped', 3, E(S3, '    call world_decode\n    jp bank_off', '    call world_decode\n    ret'));
add('RT_WORLDLOAD: no window-mode test', 3, E(S3, 'RT_WORLDLOAD:\n    ld c,a\n    ld a,(V_WIN)\n    or a\n    ret z', 'RT_WORLDLOAD:\n    ld c,a\n    ld a,(V_WIN)\n    or a\n    nop'));
add('RT_WORLDLOAD: the window-mode test inverted', 3, E(S3, 'RT_WORLDLOAD:\n    ld c,a\n    ld a,(V_WIN)\n    or a\n    ret z', 'RT_WORLDLOAD:\n    ld c,a\n    ld a,(V_WIN)\n    or a\n    ret nz'));
add('RT_WORLDLOAD: the world width is not stored', 3, E(S3, '    ld a,c\n    ld (W_WW),a', '    ld a,c\n' + NOP(3)));
add('RT_WORLDLOAD: the width is taken from B (0)', 3, E(S3, '    ld a,c\n    ld (W_WW),a', '    ld a,b\n    ld (W_WW),a'));
add('RT_WORLDLOAD: cam_max is not stored', 3, E(S3, '    ld (W_CAMMAX),de', NOP(4)));
add('RT_WORLDLOAD: 4 world_w instead of 8', 3, E(S3, '    ld l,c\n    add hl,hl\n    add hl,hl\n    add hl,hl\n    ld (W_WXR),hl', '    ld l,c\n    add hl,hl\n    add hl,hl\n    ld (W_WXR),hl'));
add('RT_WORLDLOAD: 8 world_w not stored', 3, E(S3, '    ld (W_WXR),hl\n    ld l,b', NOP(3) + '\n    ld l,b'));
add('RT_WORLDLOAD: the camera is not reset', 3, E(S3, '    ld (V_CAM),hl               ; camera 0', NOP(3) + '                          ; camera 0'));
add('RT_WORLDLOAD: the camera becomes the width', 3, E(S3, '    ld l,b\n    ld h,b\n    ld (V_CAM),hl', '    ld l,c\n    ld h,b\n    ld (V_CAM),hl'));
add('RT_WORLDLOAD: the attribute caches are not invalidated', 3, E(S3, '    call win_ac_clear\n    pop hl\n    jr world_load', NOP(3) + '\n    pop hl\n    jr world_load'));
add('RT_WORLDLOAD: the source is lost (no PUSH / POP)', 3, E(S3, '    push hl                     ; the stream', '    nop                         ; the stream'), E(S3, '    call win_ac_clear\n    pop hl\n    jr world_load', '    call win_ac_clear\n    nop\n    jr world_load'));
add('RT_WORLDLOAD: the world is not decoded (RET instead of JR)', 3, E(S3, '    pop hl\n    jr world_load', '    pop hl\n    ret'));
// ---- v4: ray_check, ray_boot, ray_map_load, ray_dims, RT_PLANLOAD ----
const R4 = 'ray.asm';
add('ray_check: map_src must be in $8000-$BFFF as before', 4, E(R4, '    ld a,(ix+6)\n    sub BANK_LO\n    cp $80', '    ld a,(ix+6)\n    sub $80\n    cp $40'));
add('ray_check: map_src accepted from $3F', 4, E(R4, '    ld a,(ix+6)\n    sub BANK_LO\n', '    ld a,(ix+6)\n    sub BANK_LO-1\n'));
add('ray_check: map_src accepted up to $C0', 4, E(R4, '    cp $80\n    ret nc                      ; map_src', '    cp $81\n    ret nc                      ; map_src'));
add('ray_boot decodes without the window (call ray_map)', 4, E(R4, '    call ray_map_load\n    call ray_tables', '    call ray_map\n    call ray_tables'));
add('ray_boot: map_w and map_h swapped', 4, E(R4, '    ld b,(ix+1)\n    ld c,(ix+2)\n    call ray_dims', '    ld b,(ix+2)\n    ld c,(ix+1)\n    call ray_dims'));
add('ray_map_load: the test inverted', 4, E(R4, '    jr nc,ray_map               ; mapped: as before', '    jr c,ray_map                ; mapped: as before'));
add('ray_map_load: the window starts at $41', 4, E(R4, 'ray_map_load:\n    ld a,h\n    sub BANK_LO', 'ray_map_load:\n    ld a,h\n    sub BANK_LO+1'));
add('ray_map_load: the window starts at $3F', 4, E(R4, 'ray_map_load:\n    ld a,h\n    sub BANK_LO', 'ray_map_load:\n    ld a,h\n    sub BANK_LO-1'));
add('ray_map_load: the window ends at $7E', 4, E(R4, '    cp BANK_HI-BANK_LO\n    jr nc,ray_map ', '    cp BANK_HI-BANK_LO-1\n    jr nc,ray_map '));
add('ray_map_load: the window ends at $80', 4, E(R4, '    cp BANK_HI-BANK_LO\n    jr nc,ray_map ', '    cp BANK_HI-BANK_LO+1\n    jr nc,ray_map '));
add('ray_map_load: the window is never mapped', 4, E(R4, '    call bank_on\n    call ray_map\n    jp bank_off', NOP(3) + '\n    call ray_map\n    jp bank_off'));
add('ray_map_load: the window is never unmapped', 4, E(R4, '    call ray_map\n    jp bank_off', '    call ray_map\n    ret'));
add('ray_map: the source pointer is lost (no PUSH / POP)', 4, E(R4, 'ray_map:\n    push hl                     ; the stream', 'ray_map:\n    nop                         ; the stream'), E(R4, '    ldir\n    pop hl\n    ld de,MAP_RAM', '    ldir\n    nop\n    ld de,MAP_RAM'));
add('ray_dims: VD_XMAX low byte $FE', 4, E(R4, '    ld e,$FF\n    ld (VD_XMAX),de', '    ld e,$FE\n    ld (VD_XMAX),de'));
add('ray_dims: VD_XMAX not stored', 4, E(R4, '    ld (VD_XMAX),de\n    ld a,c', NOP(4) + '\n    ld a,c'));
add('ray_dims: VD_YMAX not stored', 4, E(R4, '    ld (VD_YMAX),de\n    ret', NOP(4) + '\n    ret'));
add('ray_dims: VD_MAPH not stored', 4, E(R4, '    ld (VD_MAPH),a', NOP(3)));
add('ray_dims: VD_MAPW not stored', 4, E(R4, 'ray_dims:\n    ld a,b\n    ld (VD_MAPW),a', 'ray_dims:\n    ld a,b\n' + NOP(3)));
add('ray_dims: VD_XMAX = map_w * 256 (no DEC)', 4, E(R4, '    ld (VD_MAPW),a\n    dec a\n    ld d,a', '    ld (VD_MAPW),a\n    nop\n    ld d,a'));
add('RT_PLANLOAD: no ray-mode test', 4, E(R4, 'RT_PLANLOAD:\n    ld a,(V_RAY)\n    or a\n    ret z', 'RT_PLANLOAD:\n    ld a,(V_RAY)\n    or a\n    nop'));
add('RT_PLANLOAD: the dimensions are not set', 4, E(R4, '    ret z\n    call ray_dims\n    call ray_map_load\n    ld hl,(RV_X)', '    ret z\n' + NOP(3) + '\n    call ray_map_load\n    ld hl,(RV_X)'));
add('RT_PLANLOAD: the array is not rebuilt', 4, E(R4, '    call ray_dims\n    call ray_map_load\n    ld hl,(RV_X)', '    call ray_dims\n' + NOP(3) + '\n    ld hl,(RV_X)'));
add('RT_PLANLOAD: x is not clamped', 4, E(R4, '    ld de,(VD_XMAX)\n    call clamp_hl\n    ld (RV_X),hl', '    ld de,(VD_XMAX)\n' + NOP(3) + '\n    ld (RV_X),hl'));
add('RT_PLANLOAD: y is not clamped', 4, E(R4, '    ld de,(VD_YMAX)\n    call clamp_hl\n    ld (RV_Y),hl\n    ret', '    ld de,(VD_YMAX)\n' + NOP(3) + '\n    ld (RV_Y),hl\n    ret'));
add('RT_PLANLOAD: y clamped to the x limit', 4, E(R4, '    ld de,(VD_YMAX)\n    call clamp_hl\n    ld (RV_Y),hl\n    ret', '    ld de,(VD_XMAX)\n    call clamp_hl\n    ld (RV_Y),hl\n    ret'));
add('RT_PLANLOAD: x is not stored back', 4, E(R4, '    call clamp_hl\n    ld (RV_X),hl', '    call clamp_hl\n' + NOP(3)));

const filtered = MUTANTS.filter(([, v]) => versions.length === 0 || versions.includes(v));

if (check) {
  let bad = 0;
  for (const [name, v, edits] of MUTANTS) for (const e of edits) {
    const src = readFileSync(join(ARCADE, `runtime/v${v}`, e.file), 'utf8');
    const n = src.split(e.from).length - 1;
    if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in v${v}/${e.file}`); bad++; }
  }
  console.log(`${bad === 0 ? 'PASS' : 'FAIL'}: m11-mutations --check (${MUTANTS.length} mutants, ${bad} patterns not found exactly once)`);
  process.exit(bad ? 1 : 0);
}

const tmp = mkdtempSync(join(tmpdir(), 'm11mut-'));
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
    const r = spawnSync('node', [join(root, 'arcade/tests/m11-runtime-bank.mjs')], { encoding: 'utf8', timeout: 300000, env: { ...process.env, M11_VERSIONS: String(v) } });
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    if (/sjasmplus failed/.test(out)) { console.log(out.split('\n').filter((l) => /error/.test(l)).slice(0, 3).join('\n')); console.log(`  BUILD ERROR  ${name}`); broken.push(name); }
    else if (r.status !== 0 || r.signal) { killed++; console.log(`  killed       ${name}  <- ${((out.match(/FAIL  .*/g) ?? [out.split('\n').filter(Boolean).pop()])[0] ?? '').slice(0, 110)}`); }
    else { survived.push(name); console.log(`  SURVIVED     ${name}`); }
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log(`\n${survived.length === 0 && broken.length === 0 ? 'PASS' : 'FAIL'}: mutation test (${killed} killed of ${ran} run, ${survived.length} survived, ${broken.length} not run)`);
if (survived.length) console.log('survivors: ' + survived.join('; '));
process.exitCode = survived.length || broken.length ? 1 : 0;
