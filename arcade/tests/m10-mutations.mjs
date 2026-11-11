"use strict";
// m10-mutations.mjs -- mutation test of m10-runtime-sound.mjs (three-channel sound effects): copies arcade/ (runtime v2, v1 and v0 for the helpers, tools, tests) to a temporary
// directory, applies one deliberate bug at a time to the NEW code (the delta-stream tick, RT_PLAY's start of a stream) of v2's sound.asm (v3 and v4 carry the same file), rebuilds and runs m10 on v2 (M10_VERSIONS=2); a mutation is
// KILLED when the test fails.  Every mutant must be killed.  A pattern that does not occur exactly once is reported, not run.
//   node arcade/tests/m10-mutations.mjs [name-fragment] [--shard=i/n]       (about 20 s per mutant; --shard splits the list for parallel runs)
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
const shard = (args.find((a) => a.startsWith('--shard=')) ?? '').slice(8).split('/').map(Number);      // --shard=i/n: mutants i, i + n, i + 2n ... (0-based i)

const E = (from, to) => ({ file: 'sound.asm', from, to });
const NOP3 = '    nop\n    nop\n    nop';
const MUTANTS = [
  // ---- RT_PLAY / RT_SILENCE ----
  ['RT_PLAY: three channels recognised by byte 3 = 2', [E('; byte 3 of the first record: 3 = three channels\n    cp 3', '; byte 3 of the first record: 3 = three channels\n    cp 2')]],
  ['RT_PLAY: byte 3 read from offset 2', [E('    ld hl,3\n    add hl,de', '    ld hl,2\n    add hl,de')]],
  ['RT_PLAY: the test of byte 3 inverted', [E('    jr z,.three                 ; A = 3', '    jr nz,.three                ; A = 3')]],
  ['RT_PLAY: V_SFX_ACTIVE not cleared before the mode and the pointer change', [E('    xor a\n    ld (V_SFX_ACTIVE),a         ; the interrupt leaves', '    xor a\n    nop\n    nop\n    nop                         ; the interrupt leaves')]],
  ['RT_PLAY: V_SFX_CH never written', [E('.mode:\n    ld (V_SFX_CH),a', '.mode:\n' + NOP3)]],
  ['RT_PLAY: a three-channel stream starts at the header (V_SFX_PTR = effect + 3)', [E('    inc hl\n    ex de,hl                    ; DE -> the stream', '    nop\n    ex de,hl                    ; DE -> the stream')]],
  ['RT_PLAY: a three-channel stream starts at the effect itself (V_SFX_PTR = effect)', [E('    inc hl\n    ex de,hl                    ; DE -> the stream', '    nop\n    nop                         ; DE -> the stream')]],
  ['RT_PLAY: a one-channel effect over a three-channel one leaves B and C on', [E('    call z,SND_QUIET_BC         ;', NOP3 + '                         ;')]],
  ['RT_PLAY: the 3 -> 1 silencing also clears channel A (starts at R8)', [E('    ld hl,AY_SHADOW+9\n    ld bc,$0209', '    ld hl,AY_SHADOW+8\n    ld bc,$0309')]],
  ['RT_PLAY: the 3 -> 1 silencing stops after R9', [E('    ld bc,$0209', '    ld bc,$0109')]],
  ['RT_SILENCE: only R8 and R9', [E('    ld bc,$0308                 ; B = 3 registers', '    ld bc,$0208                 ; B = 3 registers')]],
  ['RT_SILENCE / silencing: writes even when the volume is already 0', [E('    ld a,(hl)\n    or a\n    jr z,.next                  ; already silent', '    ld a,(hl)\n    or a\n    nop\n    nop                         ; already silent')]],
  ['RT_SILENCE / silencing: the shadow is not updated', [E('    xor a\n    ld (hl),a\n    ld a,c\n    out (PORT_AY_REG),a', '    xor a\n    nop\n    ld a,c\n    out (PORT_AY_REG),a')]],
  // ---- the entry test ----
  ['entry test: three channels when V_SFX_CH is 1', [E('(+27 T)\n    cp 3\n    jr z,.three', '(+27 T)\n    cp 1\n    jr z,.three')]],
  ['entry test: inverted', [E('(+27 T)\n    cp 3\n    jr z,.three', '(+27 T)\n    cp 3\n    jr nz,.three')]],
  // ---- the delta-stream tick ----
  ['tick3: HL not saved (the entry pushes nothing, the exit pops)', [E('    push hl\n    ld hl,(V_SFX_PTR)           ; HL -> the entry', '    nop\n    ld hl,(V_SFX_PTR)           ; HL -> the entry')]],
  ['tick3: n is read again as the first pair byte (HL not advanced past n)', [E('    inc hl\n    or a                        ; (the flags stay', '    nop\n    or a                        ; (the flags stay')]],
  ['tick3: the test of n lost (every entry has pairs)', [E('    or a                        ; (the flags stay for .some: S = $FF)\n    jr nz,.some', '    cp a                        ; (the flags stay for .some: S = $FF)\n    jr nz,.some')]],
  ['tick3: n = 0 test inverted', [E('    jr nz,.some\n.x0:', '    jr z,.some\n.x0:')]],
  ['tick3: an entry does not store the next pointer (n = 0)', [E('.x0:                            ; the exit of every entry (the ISR\'s own pop af / ei / ret: the same three bytes as JP ISR_DONE, 10 T faster)\n    ld (V_SFX_PTR),hl           ; HL -> the next entry', '.x0:                            ; the exit of every entry (the ISR\'s own pop af / ei / ret: the same three bytes as JP ISR_DONE, 10 T faster)\n' + NOP3 + '                         ; HL -> the next entry')]],
  ['tick3: an entry with pairs does not store the next pointer', [E('    ld (V_SFX_PTR),hl           ; (.x0 again, inline', NOP3 + '                         ; (.x0 again, inline')]],
  ['tick3: the exit of n = 0 does not restore HL', [E('    ld (V_SFX_PTR),hl           ; HL -> the next entry\n    pop hl', '    ld (V_SFX_PTR),hl           ; HL -> the next entry\n    nop')]],
  ['tick3: the exit does not enable interrupts', [E('    pop hl\n    pop af\n    ei\n    ret\n.end:', '    pop hl\n    pop af\n    nop\n    ret\n.end:')]],
  ['tick3: $FF test inverted (the end is taken for a positive n)', [E('    jp m,.stop', '    jp p,.stop')]],
  ['tick3: the end does not silence the volumes', [E('    call RT_SILENCE             ; V_SFX_ACTIVE = 0', NOP3 + '                         ; V_SFX_ACTIVE = 0')]],
  ['tick3: BC is not preserved', [E('    push bc\n    push de\n    ld b,a                      ; B = pairs', '    push de\n    ld b,a                      ; B = pairs'), E('    djnz .pair\n    pop de\n    pop bc\n', '    djnz .pair\n    pop de\n')]],
  ['tick3: DE is not preserved', [E('    push bc\n    push de\n    ld b,a                      ; B = pairs', '    push bc\n    ld b,a                      ; B = pairs'), E('    djnz .pair\n    pop de\n    pop bc\n', '    djnz .pair\n    pop bc\n')]],
  ['tick3: the pair count is 1', [E('    ld b,a                      ; B = pairs', '    ld b,1                      ; B = pairs')]],
  ['tick3: the loop stops after the first pair', [E('    djnz .pair\n    pop de', '    nop\n    nop\n    pop de')]],
  ['tick3: the register is not skipped (read twice)', [E('    ld a,(hl)                   ; register\n    inc hl', '    ld a,(hl)                   ; register\n    nop')]],
  ['tick3: the value is not skipped (the next register is the value)', [E('    ld a,(hl)                   ; value\n    inc hl', '    ld a,(hl)                   ; value\n    nop')]],
  ['tick3: the register is selected on the data port', [E('    out (PORT_AY_REG),a         ; select it', '    out (PORT_AY_DATA),a        ; select it')]],
  ['tick3: the value is written to the select port', [E('    out (PORT_AY_DATA),a        ; write it', '    out (PORT_AY_REG),a         ; write it')]],
  ['tick3: the shadow is not updated', [E('    ld (de),a                   ; and keep the shadow exact', '    nop                         ; and keep the shadow exact')]],
  ['tick3: the shadow offset is one too high', [E('    ld e,a                      ; DE -> AY_SHADOW + register', '    inc a\n    ld e,a                      ; DE -> AY_SHADOW + register')]],
  ['tick3: the shadow page is wrong', [E('    ld d,AY_SHADOW>>8', '    ld d,(AY_SHADOW>>8)-1')]],
  ['tick3: the shadow gets the register instead of the value', [E('    ld (de),a                   ; and keep the shadow exact', '    ld a,e\n    ld (de),a                   ; and keep the shadow exact')]],
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
  for (const [mi, [name, edits]] of MUTANTS.entries()) {
    if (only && !name.includes(only)) continue;
    if (shard.length === 2 && mi % shard[1] !== shard[0]) continue;
    const root = join(tmp, 'root');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, 'arcade'), { recursive: true });
    for (const d of ['runtime/v2', 'runtime/v1', 'runtime/v0', 'tools', 'tests']) cpSync(join(ARCADE, d), join(root, 'arcade', d), { recursive: true });
    mkdirSync(join(root, 'arcade/build/v2'), { recursive: true });
    symlinkSync(TSRUN, join(root, 'tsrun'));
    symlinkSync(join(ARCADE, '../src'), join(root, 'src'));      // m10 compiles a game with the real compiler (src/lang/arcade)
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
