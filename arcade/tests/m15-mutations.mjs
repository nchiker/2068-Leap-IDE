"use strict";
// m15-mutations.mjs -- mutation test of the sound code since MUSIC (sound.asm: RT_PLAY, RT_SILENCE, RT_MUSIC, RT_NOMUSIC, SND_OWNSET / SND_OWNCLR,
// SND_SYNC and the restructured tick; docs/ARCADE_MUSIC_CONTRACT.md section 9).  Copies arcade/ (runtime v2, v1, v0, tools, tests) to a temporary
// directory, applies one deliberate bug at a time to v2's sound.asm (v3 and v4 carry the same code), rebuilds and runs m15-runtime-music.mjs
// (M15_VERSIONS=2, M15_QUICK=1), then m10-runtime-sound.mjs (M10_VERSIONS=2) if m15 passed; a mutation is KILLED when one of them fails.  Every
// mutant must be killed, or be marked EQUIVALENT with the reason.  It replaces m10-mutations.mjs, whose patterns were the tick of before music
// (its mutants that still apply are here, marked "effect:").
//   node arcade/tests/m15-mutations.mjs [name-fragment] [--shard=i/n]       (about 30-60 s per mutant)
//   node arcade/tests/m15-mutations.mjs --check               only verify that every pattern occurs once
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

const E = (from, to) => ({ file: 'sound.asm', from, to });
const NOP2 = '    nop\n    nop', NOP3 = '    nop\n    nop\n    nop';
const MUTANTS = [
  // ---- RT_PLAY ----
  ['RT_PLAY: SB_FX not cleared before the type and pointer change (no song)', [E('    jr nz,.new                  ; a song plays: post it\n    res SB_FX,(hl)', '    jr nz,.new                  ; a song plays: post it\n' + NOP2)]],
  // (code review fix, 2026-11-12: with a song RT_PLAY / RT_SILENCE post the effect, SB_NEW, and the interrupt installs it)
  ['RT_PLAY: with a song the effect is changed under the interrupt instead of posted', [E('    jr nz,.new                  ; a song plays: post it', NOP2)]],
  ['RT_PLAY: the posted effect is never flagged (SB_NEW not set)', [E('    set SB_NEW,(hl)            ; (one instruction', NOP2 + '            ; (one instruction')]],
  ['tick: the shortcut skips a pending request (SYNC or a posted effect never taken)', [E('    cp 1<<SB_SYNC\n    jr c,.fx', '    cp 1<<SB_NEW+1\n    jr c,.fx')]],
  ['tick: a posted effect is never installed', [E('    bit SB_NEW,a\n    jr z,.sy', '    bit SB_NEW,a\n    jr .sy')]],
  ['tick: a posted RT_SILENCE (type 0) is installed as an effect', [E('    jr z,.none', NOP2)]],
  ['tick: the posted effect does not get its owners', [E('    call SND_OWNSET\n    ld hl,V_SFX_ACTIVE\n    set SB_FX,(hl)\n    jr .nw', NOP3 + '\n    ld hl,V_SFX_ACTIVE\n    set SB_FX,(hl)\n    jr .nw')]],
  ['tick: no chip synchronisation after installing a posted effect', [E('    or 1<<SB_SYNC', '    or 0')]],
  ['tick: the old effect keeps playing after a posted RT_SILENCE (SB_FX not cleared)', [E('    and ~((1<<SB_NEW)|(1<<SB_FX))', '    and ~(1<<SB_NEW)')]],
  ['RT_PLAY: byte 3 = 4 not recognised (channel C plays as records)', [E('    cp 4\n    jr nz,.one', '    cp 5\n    jr nz,.one')]],
  ['RT_PLAY: the noise flag not added (type 5 never)', [E('    add a,(hl)                  ; 4 + the noise flag (byte 2)', '    nop                         ; 4 + the noise flag (byte 2)')]],
  ['RT_PLAY: a channel-C stream starts at its header', [E('.str:\n    inc hl\n    ex de,hl', '.str:\n    nop\n    ex de,hl')]],
  ['RT_PLAY: MUS_OWN not set', [E('    call SND_OWNSET             ; MUS_OWN for this type', NOP3 + '                         ; MUS_OWN for this type')]],
  ['RT_PLAY: always posts SB_SYNC (also with nothing else playing)', [E('    or a\n    jr nz,.post\n    call SND_SYNC               ; nothing else plays', '    or a\n    jr .post\n    call SND_SYNC               ; nothing else plays')]],
  ['RT_PLAY: never posts (writes the chip from the main thread during a song)', [E('    or a\n    jr nz,.post\n    call SND_SYNC               ; nothing else plays', '    or a\n' + NOP2 + '\n    call SND_SYNC               ; nothing else plays')]],
  ['RT_PLAY: no SND_SYNC when nothing else plays (stale volumes of other channels)', [E('    call SND_SYNC               ; nothing else plays', NOP3 + '                         ; nothing else plays')]],
  ['RT_PLAY: SB_FX not set at the end', [E('.go:\n    set SB_FX,(hl)\n    ret', '.go:\n' + NOP2 + '\n    ret')]],
  // ---- RT_SILENCE ----
  ['RT_SILENCE: SB_FX not cleared (no song)', [E('    jr nz,.new                  ; a song plays: post "no effect"\n    res SB_FX,(hl)', '    jr nz,.new                  ; a song plays: post "no effect"\n' + NOP2)]],
  ['RT_SILENCE: with a song the effect is stopped under the interrupt instead of posted', [E('    jr nz,.new                  ; a song plays: post "no effect"', NOP2)]],
  ['RT_SILENCE: the owners not cleared', [E('    call SND_OWNCLR             ; no effect owns anything', NOP3 + '                         ; no effect owns anything')]],
  ['RT_SILENCE: never posts (writes the chip from the main thread during a song)', [E('    jr z,.now\n    set SB_SYNC,(hl)\n    jr .x', '    jr .now\n    set SB_SYNC,(hl)\n    jr .x')]],
  ['EQUIVALENT since the code review fix: RT_SILENCE posts nothing with a request pending (with a song RT_SILENCE now posts through SB_NEW; this line runs only with no song and V_SFX_ACTIVE <> 0 after SB_FX is cleared, i.e. SB_SYNC already set: setting it again changes nothing)', [E('    jr z,.now\n    set SB_SYNC,(hl)\n    jr .x', '    jr z,.now\n' + NOP2 + '\n    jr .x')]],
  ['RT_SILENCE: no SND_SYNC with nothing else playing (volumes stay)', [E('.now:\n    call SND_SYNC', '.now:\n' + NOP3)]],
  ['RT_SILENCE: BC not kept', [E('RT_SILENCE:\n    push bc', 'RT_SILENCE:\n    nop'), E('.x:\n    pop hl\n    pop de\n    pop bc', '.x:\n    pop hl\n    pop de\n    nop')]],
  // ---- RT_MUSIC ----
  ['RT_MUSIC: HL = 0 not ignored', [E('RT_MUSIC:\n    ld a,h\n    or l\n    ret z', 'RT_MUSIC:\n    ld a,h\n    or l\n    nop')]],
  ['RT_MUSIC: SB_MUS not cleared while it changes', [E('    res SB_MUS,(hl)            ; the interrupt leaves the song alone while it changes', NOP2 + '                       ; the interrupt leaves the song alone while it changes')]],
  ['RT_MUSIC: the owners are not cleared when no effect plays (junk in MUS_OWN)', [E('    call SND_OWNCLR             ; (MUS_OWN is not cleared by the boot', NOP3 + '                         ; (MUS_OWN is not cleared by the boot')]],
  ['RT_MUSIC: the owners are cleared even while an effect plays', [E('    bit SB_FX,(hl)\n    jr nz,.own', '    bit SB_FX,(hl)\n' + NOP2)]],
  ['RT_MUSIC: MUS_SHADOW not copied from the chip', [E('    ld bc,11\n    ldir', '    ld bc,11\n' + NOP2)]],
  ['RT_MUSIC: MUS_SHADOW copies only 10 registers', [E('    ld bc,11\n    ldir', '    ld bc,10\n    ldir')]],
  ['RT_MUSIC: the first pattern pointer read one byte late', [E('    ld (V_MUS_ORD),hl           ; the first order entry\n    ld e,(hl)\n    inc hl', '    ld (V_MUS_ORD),hl           ; the first order entry\n    inc hl\n    ld e,(hl)')]],
  ['RT_MUSIC: the loop position not doubled (entry = base + loop)', [E('    jr z,.nl\n    add a,a\n    ld e,a', '    jr z,.nl\n    nop\n    ld e,a')]],
  ['RT_MUSIC: a song without a loop loops to position 63', [E('    cp MUS_NO_LOOP\n    jr z,.nl', '    cp MUS_NO_LOOP-1\n    jr z,.nl')]],
  ['RT_MUSIC: the wait not reset', [E('    xor a\n    ld (V_MUS_WAIT),a\n    ld hl,V_SFX_ACTIVE\n    set SB_MUS,(hl)', NOP3 + '\n    ld hl,V_SFX_ACTIVE\n    set SB_MUS,(hl)')]],
  ['RT_MUSIC: SB_MUS never set', [E('    ld (V_MUS_WAIT),a\n    ld hl,V_SFX_ACTIVE\n    set SB_MUS,(hl)', '    ld (V_MUS_WAIT),a\n    ld hl,V_SFX_ACTIVE\n' + NOP2)]],
  // ---- RT_NOMUSIC ----
  ['RT_NOMUSIC: acts with no song playing', [E('    bit SB_MUS,(hl)\n    ret z\n    res SB_MUS,(hl)', '    bit SB_MUS,(hl)\n    nop\n    res SB_MUS,(hl)')]],
  ['RT_NOMUSIC: SB_MUS not cleared', [E('    ret z\n    res SB_MUS,(hl)\n    ld a,(hl)', '    ret z\n' + NOP2 + '\n    ld a,(hl)')]],
  ['RT_NOMUSIC: never posts (main-thread writes during an effect)', [E('    jr z,SND_SYNC               ; nothing else plays: the main thread may write the chip', '    jr SND_SYNC                 ; nothing else plays: the main thread may write the chip')]],
  ['RT_NOMUSIC: posts nothing during an effect (A / B volumes stay)', [E('    jr z,SND_SYNC               ; nothing else plays: the main thread may write the chip\n    set SB_SYNC,(hl)', '    jr z,SND_SYNC               ; nothing else plays: the main thread may write the chip\n' + NOP2)]],
  // ---- owners ----
  ['SND_OWNSET: a type 1 effect does not own R8 (its volume)', [E('    ld de,$01C3                 ; 1: R0, R1, R6, R7, R8', '    ld de,$00C3                 ; 1: R0, R1, R6, R7, R8')]],
  ['SND_OWNSET: a type 3 effect does not own R10', [E('    ld de,$07FF                 ; 3: all eleven', '    ld de,$03FF                 ; 3: all eleven')]],
  ['SND_OWNSET: a channel-C effect does not own R5', [E('    ld de,$0430                 ; 4: R4, R5, R10', '    ld de,$0410                 ; 4: R4, R5, R10')]],
  ['SND_OWNSET: a channel-C effect does not own R10', [E('    ld de,$0430                 ; 4: R4, R5, R10', '    ld de,$0030                 ; 4: R4, R5, R10')]],
  ['SND_OWNSET: type 5 does not own R6', [E('    ld de,$0470                 ; 5: and R6', '    ld de,$0430                 ; 5: and R6')]],
  ['SND_OWNSET: the masks are read from the wrong end (R10 first)', [E('    xor a\n    srl d\n    rr e\n    rla', '    xor a\n    sla e\n    rl d\n    rla')]],
  ['SND_OWNSET: R7 not shared with a channel-C effect (owner 1)', [E('    ld a,2\n    ld (MUS_OWN+7),a            ; channel C: R7 is shared', '    ld a,1\n    ld (MUS_OWN+7),a            ; channel C: R7 is shared')]],
  ['SND_OWNSET: type 4 does not share R7 (only 5)', [E('    ld a,c\n    cp 4\n    ret c', '    ld a,c\n    cp 5\n    ret c')]],
  ['SND_OWNCLR: R10 keeps its owner', [E('SND_OWNCLR:                     ; (no effect owns anything: SND_OWNSET with A = 0, faster; clobbers AF, B, HL)\n    ld hl,MUS_OWN\n    ld b,11', 'SND_OWNCLR:                     ; (no effect owns anything: SND_OWNSET with A = 0, faster; clobbers AF, B, HL)\n    ld hl,MUS_OWN\n    ld b,10')]],
  // ---- SND_SYNC ----
  ['SND_SYNC: no song: starts at R9 (R8 stays)', [E('    ld e,8\n    ld l,e\n    ld b,3', '    ld e,9\n    ld l,e\n    ld b,2')]],
  ['SND_SYNC: no song: an owned volume is zeroed too', [E('    or a\n    jr nz,.vn                   ; the effect\'s', '    or a\n' + NOP2 + '                   ; the effect\'s')]],
  ['SND_SYNC: no song: AY_SHADOW not updated', [E('    xor a\n    ld (hl),a\n    ld a,l\n    out (PORT_AY_REG),a', '    xor a\n    nop\n    ld a,l\n    out (PORT_AY_REG),a')]],
  ['SND_SYNC: song: an effect\'s register is given back too', [E('    dec a\n    jr z,.mn                    ; 1: the effect\'s', '    dec a\n' + NOP2 + '                    ; 1: the effect\'s')]],
  ['SND_SYNC: song: R7 shared takes the song\'s bit 2 / 5 as well', [E('    and $DB                     ; 2: R7 shared with a channel-C effect', '    and $FF                     ; 2: R7 shared with a channel-C effect')]],
  ['SND_SYNC: song: writes also an equal register', [E('.mv:\n    cp (hl)\n    jr z,.mn', '.mv:\n    cp (hl)\n' + NOP2)]],
  ['SND_SYNC: song: only R0-R9', [E('.mus:\n    ld b,11', '.mus:\n    ld b,10')]],
  // ---- the tick: entry and the effect ----
  ['tick: the wait of a song alone is not counted down', [E('    jr z,.full                  ; (A = 0 acts as 1 << SB_MUS below: no SB_SYNC, no SB_FX)\n    dec a', '    jr z,.full                  ; (A = 0 acts as 1 << SB_MUS below: no SB_SYNC, no SB_FX)\n    nop')]],
  ['tick: the fast path is taken with an effect playing too', [E('    cp 1<<SB_MUS\n    jr nz,.full', '    and 1<<SB_MUS\n    jr z,.full')]],
  ['tick: SB_SYNC not cleared (synchronises every refresh)', [E('    ld hl,V_SFX_ACTIVE\n    res SB_SYNC,(hl)\n    call SND_SYNC\n    ld a,(V_SFX_ACTIVE)', '    ld hl,V_SFX_ACTIVE\n' + NOP2 + '\n    call SND_SYNC\n    ld a,(V_SFX_ACTIVE)')]],
  ['tick: the pending SND_SYNC is not done', [E('    res SB_SYNC,(hl)\n    call SND_SYNC\n    ld a,(V_SFX_ACTIVE)', '    res SB_SYNC,(hl)\n' + NOP3 + '\n    ld a,(V_SFX_ACTIVE)')]],
  ['tick: the effect runs when only a song plays', [E('.fx:\n    rra\n    jp nc,.song', '.fx:\n    rra\n' + NOP3)]],
  ['tick: type 3 dispatched to the channel-C loop', [E('    bit 2,c\n    jr nz,.c                    ; 4, 5: channel C', '    bit 1,c\n    jr nz,.c                    ; 4, 5: channel C')]],
  ['tick: channel C played by the plain loop (R7 not merged)', [E('    bit 2,c\n    jr nz,.c                    ; 4, 5: channel C', '    bit 2,c\n' + NOP2 + '                    ; 4, 5: channel C')]],
  ['tick: channel C: R7 merge on R6', [E('    ld a,e\n    cp 7\n    ld a,c\n    jr nz,.cw', '    ld a,e\n    cp 6\n    ld a,c\n    jr nz,.cw')]],
  ['tick: channel C: the effect\'s R7 bits and the chip\'s swapped', [E('    and $24\n    ld c,a\n    ld a,(AY_SHADOW+7)\n    and $DB\n    or c\n.cw:', '    and $DB\n    ld c,a\n    ld a,(AY_SHADOW+7)\n    and $24\n    or c\n.cw:')]],
  ['tick: channel C: AY_SHADOW not kept', [E('.cw:\n    out (PORT_AY_DATA),a\n    ld (de),a', '.cw:\n    out (PORT_AY_DATA),a\n    nop')]],
  ['tick: the end of an effect keeps its owners', [E('    res SB_FX,(hl)\n    call SND_OWNCLR\n    call SND_SYNC', '    res SB_FX,(hl)\n' + NOP3 + '\n    call SND_SYNC')]],
  ['tick: the end of an effect does not synchronise', [E('    call SND_OWNCLR\n    call SND_SYNC\n    ; ---- the song ----', '    call SND_OWNCLR\n' + NOP3 + '\n    ; ---- the song ----')]],
  ['tick: the end of an effect leaves SB_FX set', [E('.fxend:                         ; the effect is over (its terminator or the stream\'s $FF): no owner, the chip synchronised (no song: volumes 0)\n    ld hl,V_SFX_ACTIVE\n    res SB_FX,(hl)', '.fxend:                         ; the effect is over (its terminator or the stream\'s $FF): no owner, the chip synchronised (no song: volumes 0)\n    ld hl,V_SFX_ACTIVE\n' + NOP2)]],
  ['effect: the register is selected on the data port', [E('    out (PORT_AY_REG),a         ; select it', '    out (PORT_AY_DATA),a        ; select it')]],
  ['effect: the value is written to the select port', [E('    out (PORT_AY_DATA),a        ; write it', '    out (PORT_AY_REG),a         ; write it')]],
  ['effect: the shadow is not updated', [E('    ld (de),a                   ; and keep the shadow exact', '    nop                         ; and keep the shadow exact')]],
  ['effect: the stream pointer is not stored', [E('.sd:\n    ld (V_SFX_PTR),hl', '.sd:\n' + NOP3)]],
  ['effect: an entry with n = 0 is taken as pairs', [E('    dec a\n    jr z,.sd', '    dec a\n' + NOP2)]],
  ['effect: the one-channel R8 is not written', [E('    ld (hl),a\n    ld a,8\n    out (PORT_AY_REG),a', '    ld (hl),a\n    ld a,9\n    out (PORT_AY_REG),a')]],
  // ---- the tick: the song ----
  ['song: not paused by a type 3 effect', [E('    cp 4\n    jr c,.out                   ; an effect of type 1 / 3: the song waits', '    cp 3\n    jr c,.out                   ; an effect of type 1 / 3: the song waits')]],
  ['song: paused by a channel-C effect too', [E('    cp 4\n    jr c,.out                   ; an effect of type 1 / 3: the song waits', '    cp 6\n    jr c,.out                   ; an effect of type 1 / 3: the song waits')]],
  ['song: the wait is not counted down in the full path', [E('    jr z,.read\n    dec (hl)\n.out:', '    jr z,.read\n    nop\n.out:')]],
  ['song: the fast loop is used with an effect (owners ignored)', [E('    rra\n    jr c,.pair2                 ; an effect plays: look at the owners', '    rra\n' + NOP2 + '                 ; an effect plays: look at the owners')]],
  ['song: the fast loop does not keep MUS_SHADOW', [E('.fast:                          ; no effect: MUS_OWN is all 0\n    ld e,(hl)                   ; E = register\n    inc hl\n    ld a,(hl)\n    inc hl\n    ld (de),a', '.fast:                          ; no effect: MUS_OWN is all 0\n    ld e,(hl)                   ; E = register\n    inc hl\n    ld a,(hl)\n    inc hl\n    nop')]],
  ['song: the fast loop does not keep AY_SHADOW', [E('    ld d,AY_SHADOW>>8\n    ld (de),a\n    ld d,MUS_SHADOW>>8\n    djnz .fast', '    ld d,AY_SHADOW>>8\n    nop\n    ld d,MUS_SHADOW>>8\n    djnz .fast')]],
  ['song: the owners\' loop does not keep MUS_SHADOW for an owned register', [E('.pair2:\n    ld e,(hl)                   ; E = register\n    inc hl\n    ld a,(hl)\n    inc hl\n    ld (de),a', '.pair2:\n    ld e,(hl)                   ; E = register\n    inc hl\n    ld a,(hl)\n    inc hl\n    nop')]],
  ['song: the owners\' loop writes the effect\'s registers', [E('    dec a\n    jr z,.nx                    ; the effect\'s register', '    dec a\n' + NOP2 + '                    ; the effect\'s register')]],
  ['song: the owners\' loop: R7 shared takes all the song\'s bits', [E('    ld a,c                      ; R7 with a channel-C effect: the song\'s bits outside $24\n    and $DB', '    ld a,c                      ; R7 with a channel-C effect: the song\'s bits outside $24\n    and $FF')]],
  ['song: a wait holds one refresh too many', [E('    sub $81\n    ld (V_MUS_WAIT),a', '    sub $80\n    ld (V_MUS_WAIT),a')]],
  ['song: an item with n = 0 is taken as pairs', [E('    cp $80\n    jr nc,.hi\n    or a\n    jr z,.done', '    cp $80\n    jr nc,.hi\n    or a\n' + NOP2)]],
  ['song: the order list steps one byte', [E('.next:\n    ld hl,(V_MUS_ORD)\n    inc hl\n    inc hl', '.next:\n    ld hl,(V_MUS_ORD)\n    inc hl\n    nop')]],
  ['song: V_MUS_ORD not kept', [E('.ord:\n    ld (V_MUS_ORD),hl', '.ord:\n' + NOP3)]],
  ['song: the pattern pointer\'s bytes swapped', [E('    ld a,(hl)\n    inc hl\n    ld h,(hl)\n    ld l,a\n    or h', '    ld a,(hl)\n    inc hl\n    ld l,(hl)\n    ld h,a\n    or h')]],
  ['song: a song without a loop starts again from the beginning', [E('    ld hl,(V_MUS_LOOP)\n    ld a,h\n    or l\n    jr nz,.ord', '    ld hl,(V_MUS_LOOP)\n    ld a,h\n    or l\n    jr nz,.ord\n    ld hl,(V_MUS_ORD)\n    jr .ord')]],
  ['song: the end of a song leaves SB_MUS set', [E('    ld hl,V_SFX_ACTIVE          ; the end of a song that does not loop\n    res SB_MUS,(hl)', '    ld hl,V_SFX_ACTIVE          ; the end of a song that does not loop\n' + NOP2)]],
  ['song: the end of a song does not silence it', [E('    res SB_MUS,(hl)\n    call SND_SYNC\n    jp .out', '    res SB_MUS,(hl)\n' + NOP3 + '\n    jp .out')]],
  ['song: the register is selected on the data port (fast loop)', [E('    ld c,a\n    ld a,e\n    out (PORT_AY_REG),a\n    ld a,c\n    out (PORT_AY_DATA),a\n    ld d,AY_SHADOW>>8\n    ld (de),a\n    ld d,MUS_SHADOW>>8\n    djnz .fast', '    ld c,a\n    ld a,e\n    out (PORT_AY_DATA),a\n    ld a,c\n    out (PORT_AY_DATA),a\n    ld d,AY_SHADOW>>8\n    ld (de),a\n    ld d,MUS_SHADOW>>8\n    djnz .fast')]],
];

if (check) {
  let bad = 0;
  const src = readFileSync(join(ARCADE, 'runtime/v2/sound.asm'), 'utf8');
  for (const [name, edits] of MUTANTS) for (const e of edits) { const n = src.split(e.from).length - 1; if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times`); bad++; } }
  console.log(`${bad === 0 ? 'PASS' : 'FAIL'}: m15-mutations --check (${MUTANTS.length} mutants, ${bad} patterns not found exactly once)`);
  process.exit(bad ? 1 : 0);
}

const tmp = mkdtempSync(join(tmpdir(), 'm15mut-'));
let killed = 0; const survived = [], broken = [], equivalent = [];
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
    symlinkSync(join(ARCADE, '../src'), join(root, 'src'));
    symlinkSync(join(ARCADE, '../.git'), join(root, '.git'));                      // m10 reads the runtime before songs from git
    let bad = false;
    for (const e of edits) {
      const p = join(root, 'arcade/runtime/v2', e.file);
      const src = readFileSync(p, 'utf8');
      const n = src.split(e.from).length - 1;
      if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad = true; break; }
      writeFileSync(p, src.replace(e.from, () => e.to));
    }
    if (bad) { broken.push(name); continue; }
    let out = '', status = 0, by = '';
    for (const [suite, env] of [['m15-runtime-music.mjs', { M15_VERSIONS: '2', M15_QUICK: '1' }], ['m10-runtime-sound.mjs', { M10_VERSIONS: '2' }]]) {
      const r = spawnSync('node', [join(root, 'arcade/tests', suite)], { encoding: 'utf8', timeout: 600000, env: { ...process.env, ...env } });
      out = (r.stdout ?? '') + (r.stderr ?? ''); status = r.status !== 0 || r.signal ? 1 : 0; by = suite;
      if (status || /sjasmplus failed/.test(out)) break;
    }
    if (/sjasmplus failed/.test(out)) { console.log(out.split('\n').filter((l) => /error/.test(l)).slice(0, 3).join('\n')); console.log(`  BUILD ERROR  ${name}`); broken.push(name); }
    else if (status) { killed++; console.log(`  killed       ${name}  <- ${by}: ${((out.match(/FAIL  .*/g) ?? [out.split('\n').filter(Boolean).pop()])[0] ?? '').slice(0, 110)}`); }
    else if (name.startsWith('EQUIVALENT')) { equivalent.push(name); console.log(`  SURVIVED     ${name}`); }
    else { survived.push(name); console.log(`  SURVIVED     ${name}`); }
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
console.log(`\n${survived.length === 0 && broken.length === 0 ? 'PASS' : 'FAIL'}: mutation test (${killed} killed, ${survived.length} survived, ${equivalent.length} equivalent mutants survived as expected, ${broken.length} not run)`);
if (survived.length) console.log('survivors: ' + survived.join('; '));
process.exitCode = survived.length || broken.length ? 1 : 0;
