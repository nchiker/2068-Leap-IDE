"use strict";
// m10-mutations.mjs -- mutation test of m10-runtime-sound.mjs (three-channel sound effects): copies arcade/ (runtime v2, v1 and v0 for the helpers, tools, tests) to a temporary
// directory, applies one deliberate bug at a time to the NEW code of v2's sound.asm (v3 and v4 carry the same file), rebuilds and runs m10 on v2 (M10_VERSIONS=2); a mutation is
// KILLED when the test fails.  Every mutant must be killed.  A pattern that does not occur exactly once is reported, not run.
//   node arcade/tests/m10-mutations.mjs [name-fragment]       (about 15 s per mutant)
//   node arcade/tests/m10-mutations.mjs --check               only verify that every pattern occurs once
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

const E = (from, to) => ({ file: 'sound.asm', from, to });
const NOP3 = '    nop\n    nop\n    nop';
const MUTANTS = [
  ['RT_PLAY: three channels recognised by byte 3 = 2', [E('; byte 3 of the first record: 3 = three channels\n    cp 3', '; byte 3 of the first record: 3 = three channels\n    cp 2')]],
  ['RT_PLAY: byte 3 read from offset 2', [E('    ld hl,3\n    add hl,de', '    ld hl,2\n    add hl,de')]],
  ['RT_PLAY: V_SFX_ACTIVE not cleared before the mode and the pointer change', [E('    xor a\n    ld (V_SFX_ACTIVE),a         ; the interrupt leaves', '    xor a\n    nop\n    nop\n    nop                         ; the interrupt leaves')]],
  ['RT_PLAY: V_SFX_CH never written', [E('.mode:\n    ld (V_SFX_CH),a', '.mode:\n' + NOP3)]],
  ['RT_PLAY: a one-channel effect over a three-channel one leaves B and C on', [E('    call z,SND_QUIET_BC         ;', NOP3 + '                         ;')]],
  ['RT_PLAY: the 3 -> 1 silencing also clears channel A (starts at R8)', [E('    ld hl,AY_SHADOW+9\n    ld bc,$0209', '    ld hl,AY_SHADOW+8\n    ld bc,$0309')]],
  ['RT_PLAY: the 3 -> 1 silencing stops after R9', [E('    ld bc,$0209', '    ld bc,$0109')]],
  ['RT_SILENCE: only R8 and R9', [E('    ld bc,$0308                 ; B = 3 registers', '    ld bc,$0208                 ; B = 3 registers')]],
  ['RT_SILENCE / silencing: writes even when the volume is already 0', [E('    ld a,(hl)\n    or a\n    jr z,.next                  ; already silent', '    ld a,(hl)\n    or a\n    nop\n    nop                         ; already silent')]],
  ['RT_SILENCE / silencing: the shadow is not updated', [E('    xor a\n    ld (hl),a\n    ld a,c\n    out (PORT_AY_REG),a', '    xor a\n    nop\n    ld a,c\n    out (PORT_AY_REG),a')]],
  ['entry test: three channels when V_SFX_CH is 1', [E('    cp 3\n    jr z,.three', '    cp 1\n    jr z,.three')]],
  ['entry test: inverted', [E('    cp 3\n    jr z,.three', '    cp 3\n    jr nz,.three')]],
  ['tick3: the terminator is read from byte 0', [E('    inc de\n    ld a,(de)\n    dec de\n    inc a\n    jr z,.end', '    ld a,(de)\n    nop\n    nop\n    inc a\n    jr z,.end')]],
  ['tick3: the end does not silence the volumes', [E('    call RT_SILENCE             ; V_SFX_ACTIVE = 0', NOP3 + '                         ; V_SFX_ACTIVE = 0')]],
  ['tick3: only two channels of tone', [E('    ld bc,$0300                 ; B = 3 channels, C = the register', '    ld bc,$0200                 ; B = 3 channels, C = the register')]],
  ['tick3: tone high not masked to 4 bits', [E('    and $0F                     ; tone high', '    nop\n    nop                         ; tone high')]],
  ['tick3: the record step is 3 bytes', [E('    inc de\n    inc de\n    inc de                      ; the next record', '    inc de\n    inc de\n    nop                         ; the next record')]],
  ['tick3: no noise found leaves R6 = 0 instead of A\'s noise', [E('    ld de,$0080                 ; D = noise-off bits', '    ld de,$0000                 ; D = noise-off bits')]],
  ['tick3: noise sense inverted (the lowest channel with noise OFF)', [E('    bit 0,d\n    jr nz,.nonoise', '    bit 0,d\n    jr z,.nonoise')]],
  ['tick3: tone-off and noise-off accumulators swapped', [E('    rra\n    rl c\n    rra\n    rl d', '    rra\n    rl d\n    rra\n    rl c')]],
  ['tick3: noise-off bits go to R7 bits 2-4', [E('    add a,a\n    add a,a\n    add a,a                     ; noise off -> R7 bits 3-5', '    add a,a\n    add a,a\n    nop                         ; noise off -> R7 bits 3-5')]],
  ['tick3: R7 bits 6-7 set (joystick port output)', [E('    or c                        ; tone off -> R7 bits 0-2', '    or c                        ; tone off -> R7 bits 0-2\n    or $40')]],
  ['tick3: volume nibble shifted 3 times', [E('    rrca\n    rrca\n    rrca\n    rrca\n    and $0F\n    call SND_W                  ; R8, R9, R10', '    rrca\n    rrca\n    rrca\n    nop\n    and $0F\n    call SND_W                  ; R8, R9, R10')]],
  ['tick3: volumes read from byte 0 of the records', [E('    inc de                      ; byte 1 of record A', '    nop                         ; byte 1 of record A')]],
  ['tick3: the pointer advances 11 bytes', [E('    dec de\n    ld (V_SFX_PTR),de           ; the next group', '    nop\n    ld (V_SFX_PTR),de           ; the next group')]],
  ['SND_W: always writes', [E('    cp (hl)\n    ret z\n    ld (hl),a\n    ld a,c', '    cp (hl)\n    nop\n    ld (hl),a\n    ld a,c')]],
  ['SND_W: the shadow is not updated', [E('    ret z\n    ld (hl),a\n    ld a,c', '    ret z\n    nop\n    ld a,c')]],
  ['SND_W: wrong register selected', [E('    ld a,c\n    out (PORT_AY_REG),a\n    ld a,(hl)', '    ld a,l\n    out (PORT_AY_REG),a\n    ld a,(hl)')]],
  ['tick3: tone loop starts at the wrong shadow register (R1)', [E('    ld hl,AY_SHADOW\n    ld bc,$0300                 ; B = 3 channels', '    ld hl,AY_SHADOW+1\n    ld bc,$0300                 ; B = 3 channels')]],
  ['tick3: R6 written with the R7 value', [E('    ld hl,AY_SHADOW+6\n    ld c,6\n    ld a,e', '    ld hl,AY_SHADOW+6\n    ld c,6\n    ld a,d')]],
];

if (check) {
  let bad = 0;
  const src = readFileSync(join(ARCADE, 'runtime/v2/sound.asm'), 'utf8');
  for (const [name, edits] of MUTANTS) for (const e of edits) { const n = src.split(e.from).length - 1; if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times`); bad++; } }
  console.log(`${bad === 0 ? 'PASS' : 'FAIL'}: m10-mutations --check (${MUTANTS.length} mutants, ${bad} patterns not found exactly once)`);
  process.exit(bad ? 1 : 0);
}

const tmp = mkdtempSync(join(tmpdir(), 'm10mut-'));
let killed = 0; const survived = [], broken = [];
try {
  for (const [name, edits] of MUTANTS) {
    if (only && !name.includes(only)) continue;
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
    const r = spawnSync('node', [join(root, 'arcade/tests/m10-runtime-sound.mjs')], { encoding: 'utf8', timeout: 300000, env: { ...process.env, M10_VERSIONS: '2' } });
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    if (/sjasmplus failed/.test(out)) { console.log(out.split('\n').filter((l) => /error/.test(l)).slice(0, 3).join('\n')); console.log(`  BUILD ERROR  ${name}`); broken.push(name); }
    else if (r.status !== 0 || r.signal) { killed++; console.log(`  killed       ${name}  <- ${((out.match(/FAIL  .*/g) ?? [out.split('\n').filter(Boolean).pop()])[0] ?? '').slice(0, 110)}`); }
    else { survived.push(name); console.log(`  SURVIVED     ${name}`); }
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log(`\n${survived.length === 0 && broken.length === 0 ? 'PASS' : 'FAIL'}: mutation test (${killed} killed, ${survived.length} survived, ${broken.length} not run)`);
if (survived.length) console.log('survivors: ' + survived.join('; '));
process.exitCode = survived.length || broken.length ? 1 : 0;
