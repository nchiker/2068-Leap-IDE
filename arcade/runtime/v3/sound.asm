; sound.asm -- RT_PLAY, RT_SILENCE and the frame interrupt's sound tick (v1; docs/ARCADE_RUNTIME_API_V1.md "Collision and sound").
;
; An effect is a run of 4-byte records  tone_lo, tone_hi | (vol << 4), noise | (mix << 5), 0  ended by a record whose second
; byte is $FF.  The interrupt plays ONE record per refresh on AY channel A:  R0 = tone_lo, R1 = tone_hi AND 15, R6 = noise AND 31,
; R7 = %00110110 | mix bit 0 (tone A off) | mix bit 1 << 3 (noise A off), R8 = vol.  The mixer keeps channels B and C
; off and bit 6 (port A = input, the joystick) clear.  A register is written only when the value differs from AY_SHADOW, which
; holds what was last written (boot zeroed the AY and AY_SHADOW).  The terminator stops the effect: V_SFX_ACTIVE = 0 and R8 = 0.
;
; THREE-CHANNEL EFFECTS (batch 5, docs/ARCADE_LANGUAGE_BATCH5.md Part C items 16-18, DELTA STREAM): when byte 3 of the effect's first record is 3, RT_PLAY sets V_SFX_CH = 3
; (anything else: 1, the code above), and the effect is the 4-byte header  0, 0, 0, 3  followed by the stream: one ENTRY per refresh = a byte n (0..11) and n pairs
; (register, value) in ascending register order, the first entry holding all 11 registers R0-R10 and each later one only the registers that changed; a single byte $FF
; ends the stream.  RT_PLAY starts V_SFX_PTR after the header.  The tick (the `.three` code at the end of SND_TICK) reads one entry per refresh and, for every pair,
; selects the register (OUT $F5), writes the value (OUT $F6) and stores it in AY_SHADOW + register, so the shadow stays exact for the one-channel tick, RT_SILENCE and
; RT_PLAY.  At $FF it calls RT_SILENCE: V_SFX_ACTIVE = 0 and R8, R9, R10 = 0 (each written only when its shadow is not 0).  All the channel logic (the shared noise
; generator, the mixer, the padding of shorter channels) is the compiler's work (convertSfx, src/lang/arcade/arcade-assets.js).
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
    jr z,.three                 ; A = 3
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
.three:
    inc hl
    ex de,hl                    ; DE -> the stream, after the 4-byte header (0, 0, 0, 3)
    jr .mode

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
    jr z,.three                 ; (the three-channel code is below, after .out)
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
.three:                         ; V_SFX_CH = 3: one stream entry per refresh.  Only HL is saved for an entry with no change; BC and DE for the pairs.
    push hl
    ld hl,(V_SFX_PTR)           ; HL -> the entry
    ld a,(hl)                   ; n, the number of pairs (0..11), or $FF = the end of the stream
    inc hl
    or a                        ; (the flags stay for .some: S = $FF)
    jr nz,.some
.x0:                            ; the exit of every entry (the ISR's own pop af / ei / ret: the same three bytes as JP ISR_DONE, 10 T faster)
    ld (V_SFX_PTR),hl           ; HL -> the next entry
    pop hl
    pop af
    ei
    ret
.end:                           ; one channel: the terminator
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
.some:
    jp m,.stop                  ; $FF: the effect is over
    push bc
    push de
    ld b,a                      ; B = pairs
    ASSERT (AY_SHADOW&$FF) == 0 && AY_SHADOW+15 < $10000   ; AY_SHADOW is page aligned: DE = AY_SHADOW + register with no arithmetic
    ld d,AY_SHADOW>>8           ; (E = the register)
.pair:
    ld a,(hl)                   ; register
    inc hl
    out (PORT_AY_REG),a         ; select it
    ld e,a                      ; DE -> AY_SHADOW + register
    ld a,(hl)                   ; value
    inc hl
    out (PORT_AY_DATA),a        ; write it
    ld (de),a                   ; and keep the shadow exact
    djnz .pair
    pop de
    pop bc
    ld (V_SFX_PTR),hl           ; (.x0 again, inline: 12 T less than JR .x0)
    pop hl
    pop af
    ei
    ret
.stop:
    call RT_SILENCE             ; V_SFX_ACTIVE = 0 and R8-R10 = 0 where not already (saves BC and HL; leaves DE alone)
    jr .x0                      ; (stores HL, harmless: the effect is over)
SND_E:
M_SOUND_E:
