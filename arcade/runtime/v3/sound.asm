; sound.asm -- RT_PLAY, RT_SILENCE and the frame interrupt's sound tick (v1; docs/ARCADE_RUNTIME_API_V1.md "Collision and sound").
;
; An effect is a run of 4-byte records  tone_lo, tone_hi | (vol << 4), noise | (mix << 5), 0  ended by a record whose second
; byte is $FF.  The interrupt plays ONE record per refresh on AY channel A:  R0 = tone_lo, R1 = tone_hi AND 15, R6 = noise AND 31,
; R7 = %00110110 | mix bit 0 (tone A off) | mix bit 1 << 3 (noise A off), R8 = vol.  The mixer keeps channels B and C
; off and bit 6 (port A = input, the joystick) clear.  A register is written only when the value differs from AY_SHADOW, which
; holds what was last written (boot zeroed the AY and AY_SHADOW).  The terminator stops the effect: V_SFX_ACTIVE = 0 and R8 = 0.
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
    ld (V_SFX_PTR),de
    ld a,1
    ld (V_SFX_ACTIVE),a
    ret

; ---------------------------------------------------------------------------------------------------------------
; RT_SILENCE: stop the effect; AY channel A volume 0.  Clobbers AF.  V_SFX_ACTIVE is cleared FIRST, so the interrupt cannot
; write the AY between the two OUTs below.
; ---------------------------------------------------------------------------------------------------------------
RT_SILENCE:
    xor a
    ld (V_SFX_ACTIVE),a
    ld a,(AY_SHADOW+8)
    or a
    ret z                       ; already silent
    xor a
    ld (AY_SHADOW+8),a
    ld a,8
    out (PORT_AY_REG),a
    xor a
    out (PORT_AY_DATA),a
    ret

; ---------------------------------------------------------------------------------------------------------------
; SND_TICK: the frame interrupt, V_SFX_ACTIVE <> 0.  Entered from the ISR (AF is saved there) with interrupts off; saves BC,
; DE, HL, and leaves through ISR_DONE.  Cost: see arcade/tests/m3-sound.mjs (it measures every case).
; ---------------------------------------------------------------------------------------------------------------
SND_TICK:
SND_S:
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
SND_E:
M_SOUND_E:
