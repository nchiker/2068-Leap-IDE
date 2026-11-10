; sound.asm -- RT_PLAY, RT_SILENCE and the frame interrupt's sound tick (v1; docs/ARCADE_RUNTIME_API_V1.md "Collision and sound").
;
; An effect is a run of 4-byte records  tone_lo, tone_hi | (vol << 4), noise | (mix << 5), 0  ended by a record whose second
; byte is $FF.  The interrupt plays ONE record per refresh on AY channel A:  R0 = tone_lo, R1 = tone_hi AND 15, R6 = noise AND 31,
; R7 = %00110110 | mix bit 0 (tone A off) | mix bit 1 << 3 (noise A off), R8 = vol.  The mixer keeps channels B and C
; off and bit 6 (port A = input, the joystick) clear.  A register is written only when the value differs from AY_SHADOW, which
; holds what was last written (boot zeroed the AY and AY_SHADOW).  The terminator stops the effect: V_SFX_ACTIVE = 0 and R8 = 0.
;
; THREE-CHANNEL EFFECTS (batch 5, docs/ARCADE_LANGUAGE_BATCH5.md Part C): when byte 3 of the effect's first record is 3, RT_PLAY sets V_SFX_CH = 3 (anything
; else: 1, the code above) and the effect is a run of 12-byte GROUPS = the records of AY channels A, B, C of one refresh; the terminator is one 4-byte record
; (byte 1 = $FF) in place of a group.  SND_TICK3 plays one group per refresh and writes, in this order and each only when different from AY_SHADOW:
; R0 R1 (A) R2 R3 (B) R4 R5 (C) tone, R6 noise, R7 mixer, R8 R9 R10 volumes.  R6 = the noise of the lowest channel whose record has noise on (mix bit 1 = 0),
; none: channel A's; R7 = bits 0-2 tone off (mix bit 0) of A B C, bits 3-5 noise off (mix bit 1), bits 6-7 0.  The terminator and RT_SILENCE write R8-R10 = 0.
    ; (no ORG: follows text.asm)
M_SOUND_S:

; ---------------------------------------------------------------------------------------------------------------
; RT_PLAY: A = effect index.  Starts that effect (replacing the one playing); no sfx table, an index >= the table's count
; (read as at most 8) or a null effect pointer: ignored.  Clobbers AF, BC, DE, HL.
; The pointer is written with one instruction before V_SFX_ACTIVE is set, so the interrupt never sees half of it.
; ---------------------------------------------------------------------------------------------------------------
RT_PLAY:
    ld c,a
    ld hl,(GAME_SFX)
    ld a,h
    or l
    ret z                       ; no table
    ld a,(hl)
    cp MAX_SFX+1
    jr c,.count
    ld a,MAX_SFX
.count:
    inc hl                      ; HL -> the first pointer
    cp c
    ret z                       ; count = index
    ret c                       ; count < index
    ld a,c
    add a,a
    ld e,a
    ld d,0
    add hl,de
    ld e,(hl)
    inc hl
    ld d,(hl)
    ld a,d
    or e
    ret z                       ; a null pointer is no effect
    xor a
    ld (V_SFX_ACTIVE),a         ; the interrupt leaves the sound alone while the mode and the pointer change (and while B / C are silenced)
    ld hl,3
    add hl,de
    ld a,(hl)                   ; byte 3 of the first record: 3 = three channels
    cp 3
    jr z,.mode                  ; A = 3
    ld a,(V_SFX_CH)
    cp 3
    call z,SND_QUIET_BC         ; a three-channel effect is replaced by a one-channel one: B and C volume 0
    ld a,1
.mode:
    ld (V_SFX_CH),a
    ld (V_SFX_PTR),de
    ld a,1
    ld (V_SFX_ACTIVE),a
    ret

; ---------------------------------------------------------------------------------------------------------------
; RT_SILENCE: stop the effect; AY channels A, B, C volume 0 (R8, R9, R10, each written only when its AY_SHADOW is not 0).  Clobbers AF.
; V_SFX_ACTIVE is cleared FIRST, so the interrupt cannot write the AY between the two OUTs below.  SND_QUIET_BC (R9, R10 only) is
; RT_PLAY's; both save BC and HL.  (They are not part of the interrupt's code, so the main thread's AY writes are not mistaken for it.)
; ---------------------------------------------------------------------------------------------------------------
RT_SILENCE:
    xor a
    ld (V_SFX_ACTIVE),a
    push bc
    push hl
    ld hl,AY_SHADOW+8
    ld bc,$0308                 ; B = 3 registers, C = the first
    jr SND_QUIET_L
SND_QUIET_BC:
    push bc
    push hl
    ld hl,AY_SHADOW+9
    ld bc,$0209
SND_QUIET_L:
    ld a,(hl)
    or a
    jr z,.next                  ; already silent
    xor a
    ld (hl),a
    ld a,c
    out (PORT_AY_REG),a
    xor a
    out (PORT_AY_DATA),a
.next:
    inc hl
    inc c
    djnz SND_QUIET_L
    pop hl
    pop bc
    ret

; ---------------------------------------------------------------------------------------------------------------
; SND_TICK: the frame interrupt, V_SFX_ACTIVE <> 0.  Entered from the ISR (AF is saved there) with interrupts off; saves BC,
; DE, HL, and leaves through ISR_DONE.  Cost: see arcade/tests/m3-sound.mjs (it measures every case).
; ---------------------------------------------------------------------------------------------------------------
SND_TICK:
SND_S:
    ld a,(V_SFX_CH)             ; the one test of the three-channel effects (+27 T)
    cp 3
    jr z,.three                 ; (the jump is below: JR does not reach SND_TICK3)
    push bc
    push de
    push hl
    ld hl,(V_SFX_PTR)
    ld c,(hl)                   ; C = tone_lo
    inc hl
    ld a,(hl)                   ; byte 1
    inc hl
    ld e,(hl)                   ; E = byte 2
    inc hl
    inc hl                      ; skip the reserved byte
    ld (V_SFX_PTR),hl           ; the next record
    ld b,a                      ; B = byte 1
    inc a
    jr z,.end                   ; $FF: the terminator
    ld hl,AY_SHADOW             ; (AY_SHADOW does not cross a page: INC L walks it)
    ld a,c                      ; R0
    cp (hl)
    jr z,.r1
    ld (hl),a
    xor a
    out (PORT_AY_REG),a
    ld a,c
    out (PORT_AY_DATA),a
.r1:
    inc l
    ld a,b
    and $0F
    ld d,a
    cp (hl)
    jr z,.r6
    ld (hl),a
    ld a,1
    out (PORT_AY_REG),a
    ld a,d
    out (PORT_AY_DATA),a
.r6:
    ld l,(AY_SHADOW+6)&$FF
    ld a,e
    and $1F
    ld d,a
    cp (hl)
    jr z,.r7
    ld (hl),a
    ld a,6
    out (PORT_AY_REG),a
    ld a,d
    out (PORT_AY_DATA),a
.r7:
    inc l
    ld a,e
    rlca
    rlca
    rlca                        ; bit 0 = byte 2 bit 5 (tone off), bit 1 = bit 6 (noise off)
    and 3
    bit 1,a
    jr z,.mix
    add a,6                     ; 2 -> 8, 3 -> 9: noise-off is R7 bit 3
.mix:
    or $36
    ld d,a
    cp (hl)
    jr z,.r8
    ld (hl),a
    ld a,7
    out (PORT_AY_REG),a
    ld a,d
    out (PORT_AY_DATA),a
.r8:
    inc l
    ld a,b
    rrca
    rrca
    rrca
    rrca
    and $0F
    ld d,a
    cp (hl)
    jr z,.out
    ld (hl),a
    ld a,8
    out (PORT_AY_REG),a
    ld a,d
    out (PORT_AY_DATA),a
.out:
    pop hl
    pop de
    pop bc
    jp ISR_DONE
.three:
    jp SND_TICK3
.end:
    xor a
    ld (V_SFX_ACTIVE),a
    ld hl,AY_SHADOW+8
    cp (hl)
    jr z,.out                   ; volume already 0
    ld (hl),a
    ld a,8
    out (PORT_AY_REG),a
    xor a
    out (PORT_AY_DATA),a
    jr .out

; SND_W: A = value, HL -> AY_SHADOW[C], C = AY register: write it when it differs (select $F5, data $F6).  Clobbers AF.  (Used by SND_TICK3 below.)
SND_W:
    cp (hl)
    ret z
    ld (hl),a
    ld a,c
    out (PORT_AY_REG),a
    ld a,(hl)
    out (PORT_AY_DATA),a
    ret
SND_E:
M_SOUND_E:
.resume EQU $

    ORG $0068                   ; (see SND_TICK3)
M_SND3_S:
; ---------------------------------------------------------------------------------------------------------------
; SND_TICK3: V_SFX_CH = 3: one 12-byte group per refresh (the header says what is written).  Entered like SND_TICK; leaves through SND_S.out.
; It lives in the unused gap $0068-$00FF of DOCK chunk 0 (the v4 runtime has only $4000 - RT_END bytes after its last module, fewer than it needs;
; the same place in v2 and v3 keeps the three builds identical).  It is the interrupt's code all the same.
; ---------------------------------------------------------------------------------------------------------------
SND_TICK3:
    push bc
    push de
    push hl
    ld de,(V_SFX_PTR)           ; DE -> the group
    inc de
    ld a,(de)
    dec de
    inc a
    jr z,.end                   ; byte 1 of the first record = $FF: the terminator
    ld hl,AY_SHADOW
    ld bc,$0300                 ; B = 3 channels, C = the register
.tone:
    ld a,(de)                   ; tone low of channel c
    call SND_W
    inc hl
    inc c
    inc de
    ld a,(de)
    and $0F                     ; tone high
    call SND_W
    inc hl
    inc c
    inc de
    inc de
    inc de                      ; the next record
    djnz .tone                  ; DE -> the next group
    ex de,hl
    inc hl
    inc hl                      ; the byte 2 of record C is 4 below
    ld bc,$0300                 ; B = 3 records, C = tone-off bits
    ld de,$0080                 ; D = noise-off bits, E = $80: no noise on found yet
.mix:                           ; records C, B, A: the lowest channel with noise on is seen last
    dec hl
    dec hl
    dec hl
    dec hl
    ld a,(hl)
    rlca
    rlca
    rlca                        ; bit 0 = tone off, bit 1 = noise off
    rra
    rl c
    rra
    rl d                        ; (RL changes the carry: the noise-off bit is read back from D)
    bit 0,d
    jr nz,.nonoise
    ld a,(hl)
    and $1F
    ld e,a                      ; the noise of this channel
.nonoise:
    djnz .mix                   ; HL -> byte 2 of record A
    bit 7,e
    jr z,.havenoise
    ld a,(hl)                   ; no channel has noise on: channel A's noise
    and $1F
    ld e,a
.havenoise:
    ld a,d
    add a,a
    add a,a
    add a,a                     ; noise off -> R7 bits 3-5
    or c                        ; tone off -> R7 bits 0-2
    ld d,a
    ld hl,AY_SHADOW+6
    ld c,6
    ld a,e
    call SND_W                  ; R6
    inc hl
    inc c
    ld a,d
    call SND_W                  ; R7
    inc hl
    inc c
    ld de,(V_SFX_PTR)
    inc de                      ; byte 1 of record A
    ld b,3
.vol:
    ld a,(de)
    rrca
    rrca
    rrca
    rrca
    and $0F
    call SND_W                  ; R8, R9, R10
    inc hl
    inc c
    inc de
    inc de
    inc de
    inc de
    djnz .vol
    dec de
    ld (V_SFX_PTR),de           ; the next group
    jp SND_S.out
.end:
    call RT_SILENCE             ; V_SFX_ACTIVE = 0 and the volumes of A, B, C = 0 (saves BC and HL)
    jp SND_S.out

M_SND3_E:
; KEY_ROWSEL (RT_KEYDOWN's half-row selects): 8 bytes of data, put in the rest of the gap (it saves 8 bytes at the end of the image)
M_KROW_S:
KEY_ROWSEL:
    DB $FE, $FD, $FB, $F7, $EF, $DF, $BF, $7F
M_KROW_E:
    ASSERT (KEY_ROWSEL&$FF)+7 < 256 && (KEY_ROWSEL>>8) == 0     ; RT_KEYDOWN adds the row to the low byte
    ASSERT M_KROW_E <= $0100    ; the gap ends where the boot code starts
    ORG M_SOUND_E.resume
