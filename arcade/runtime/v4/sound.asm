; sound.asm -- RT_PLAY, RT_SILENCE, RT_MUSIC, RT_NOMUSIC and the frame interrupt's sound tick (v1; docs/ARCADE_RUNTIME_API_V1.md "Collision and
; sound"; three-channel effects: docs/ARCADE_LANGUAGE_BATCH5.md Part C; music: docs/ARCADE_MUSIC_CONTRACT.md).
;
; EFFECTS.  Type 1 (byte 3 of the first record 0..2): a run of 4-byte records  tone_lo, tone_hi | (vol << 4), noise | (mix << 5), 0  ended by a
; record whose second byte is $FF; one record per refresh on AY channel A:  R0 = tone_lo, R1 = tone_hi AND 15, R6 = noise AND 31,
; R7 = %00110110 | mix bit 0 (tone A off) | mix bit 1 << 3 (noise A off), R8 = vol.  Type 3 (byte 3 = 3): the header 0, 0, 0, 3 and a DELTA STREAM,
; one entry per refresh = n (0..11) and n pairs (register, value) ascending, the first entry all 11 registers R0-R10; $FF ends it.  Types 4 and 5
; (byte 3 = 4, only in games with songs): a one-channel effect on CHANNEL C as a delta stream: header 0, 0, noise, 4 (type = 4 + noise), pairs of
; R4, R5, R6 (type 5 only), R7 (only its bits 2 and 5 count: the other bits are kept from the chip) and R10.
; A register is written to the chip together with AY_SHADOW, which always holds what was last written (boot zeroed the AY and AY_SHADOW).
;
; SONGS (RT_MUSIC).  A song is  loop (an order position, $FF = none), DW pattern pointers in play order, DW 0.  A pattern is items: n (0..11) and
; n pairs as above (one refresh), $80 + k (k + 1 refreshes with no change), $FF (the pattern's end: the next order entry, in the same refresh).
; The song's own register values are kept in MUS_SHADOW ($FF00 + r, page aligned) whether or not the chip has them.
;
; SHARING THE CHIP.  V_SFX_ACTIVE is a set of bits: SB_FX (an effect plays), SB_MUS (a song plays), SB_SYNC (the interrupt must first bring the
; chip back: the registers no effect owns to the song's values, or with no song their volumes to 0).  MUS_OWN ($FF20 + r) says per register who has
; it: 0 the song, 1 the effect, 2 (R7 with a channel-C effect) both: the effect's bits $24, the song's the rest.  An effect of type 1 or 3 owns what
; it writes and PAUSES the song (its position is kept); a channel-C effect owns R4, R5, R10 (and R6 for type 5) and the song plays on A and B.
; While a song or a request is pending, the main thread never writes the chip (an interrupt between its register select and its data write would
; misdirect it): it posts SB_SYNC.  With no song and nothing pending, RT_PLAY and RT_SILENCE write the same registers as before music existed.
; While a song plays, RT_PLAY and RT_SILENCE do not touch the effect the interrupt is playing either (its type, pointer, MUS_OWN and SB_FX: an
; interrupt in the middle of changing them would play the song as if no effect owned anything, or move a paused song on): they post the new effect
; in V_SFX_NCH / V_SFX_NPTR with one SET of SB_NEW, and the interrupt installs it at its next refresh, before anything else (SND_TICK .new).
    ; (no ORG: follows text.asm)
M_SOUND_S:

; ---------------------------------------------------------------------------------------------------------------
; RT_PLAY: A = effect index.  Starts that effect (replacing the one playing); no sfx table, an index >= the table's count
; (read as at most 8) or a null effect pointer: ignored.  Clobbers AF, BC, DE, HL.
; With no song SB_FX is cleared first (one RES: the interrupt leaves the effect alone while its type and pointer change); with a song the effect
; is posted (SB_NEW, see the header).
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
    ld hl,3
    add hl,de
    ld a,(hl)                   ; byte 3 of the first record: 3 = three channels, 4 = channel C, anything else one channel
    cp 3
    jr z,.str
    cp 4
    jr nz,.one
    dec hl
    add a,(hl)                  ; 4 + the noise flag (byte 2)
    inc hl
.str:
    inc hl
    ex de,hl                    ; DE -> the stream, after the 4-byte header
    jr .set
.one:
    ld a,1
.set:                           ; A = the type, DE = the stream (types 3, 4, 5) or the first record (type 1)
    ld hl,V_SFX_ACTIVE
    res SB_NEW,(hl)             ; a posted effect not yet taken is replaced (an interrupt from here on finds none: the call takes effect a refresh later)
    bit SB_MUS,(hl)
    jr nz,.new                  ; a song plays: post it
    res SB_FX,(hl)
    ld (V_SFX_CH),a
    ld (V_SFX_PTR),de
    call SND_OWNSET             ; MUS_OWN for this type
    ld hl,V_SFX_ACTIVE
    ld a,(hl)
    or a
    jr nz,.post
    call SND_SYNC               ; nothing else plays: the volumes this effect does not own go to 0 now (as RT_PLAY did from 3 to 1 channels)
    ld hl,V_SFX_ACTIVE
    jr .go
.post:
    set SB_SYNC,(hl)           ; a request: the interrupt brings the chip back first
.go:
    set SB_FX,(hl)
    ret
.new:
    ld (V_SFX_NCH),a
    ld (V_SFX_NPTR),de
    set SB_NEW,(hl)            ; (one instruction: the interrupt sees the whole request or none)
    ret

; ---------------------------------------------------------------------------------------------------------------
; RT_SILENCE: stop the effect.  With no song: the volumes R8, R9, R10 to 0 (each written only when its AY_SHADOW is not 0), now; with a song:
; the interrupt gives the effect's registers back to the song at the next refresh (SB_SYNC).  Keeps BC, DE, HL; clobbers AF.
; ---------------------------------------------------------------------------------------------------------------
RT_SILENCE:
    push bc
    push de
    push hl
    ld hl,V_SFX_ACTIVE
    res SB_NEW,(hl)             ; a posted effect not yet taken is dropped
    bit SB_MUS,(hl)
    jr nz,.new                  ; a song plays: post "no effect"
    res SB_FX,(hl)
    call SND_OWNCLR             ; no effect owns anything
    ld hl,V_SFX_ACTIVE
    ld a,(hl)
    or a
    jr z,.now
    set SB_SYNC,(hl)
    jr .x
.new:
    xor a
    ld (V_SFX_NCH),a
    set SB_NEW,(hl)
    jr .x
.now:
    call SND_SYNC
.x:
    pop hl
    pop de
    pop bc
    ret

; ---------------------------------------------------------------------------------------------------------------
; RT_MUSIC: HL = a song (0: ignored).  Starts it from its first order entry, replacing the song playing.  Clobbers AF, BC, DE, HL.
; MUS_SHADOW starts as a copy of the chip, so a SND_SYNC before the song's first item writes nothing.
; ---------------------------------------------------------------------------------------------------------------
RT_MUSIC:
    ld a,h
    or l
    ret z
    push hl
    ld hl,V_SFX_ACTIVE
    res SB_MUS,(hl)            ; the interrupt leaves the song alone while it changes
    bit SB_FX,(hl)
    jr nz,.own                  ; an effect plays: RT_PLAY set MUS_OWN
    call SND_OWNCLR             ; (MUS_OWN is not cleared by the boot: no effect has played yet, or the last one ended)
.own:
    ld hl,AY_SHADOW
    ld de,MUS_SHADOW
    ld bc,11
    ldir
    pop hl
    ld a,(hl)                   ; the loop position
    inc hl
    ld (V_MUS_ORD),hl           ; the first order entry
    ld e,(hl)
    inc hl
    ld d,(hl)
    dec hl
    ld (V_MUS_PTR),de           ; its pattern
    ld de,0
    cp MUS_NO_LOOP
    jr z,.nl
    add a,a
    ld e,a
    add hl,de
    ex de,hl                    ; DE -> the order entry to loop to
.nl:
    ld (V_MUS_LOOP),de          ; (0: the song ends)
    xor a
    ld (V_MUS_WAIT),a
    ld hl,V_SFX_ACTIVE
    set SB_MUS,(hl)
    ret

; ---------------------------------------------------------------------------------------------------------------
; RT_NOMUSIC: stop the song; the volumes it held (those no effect owns) go to 0: now when nothing else plays, else at the next refresh.
; Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
RT_NOMUSIC:
    ld hl,V_SFX_ACTIVE
    bit SB_MUS,(hl)
    ret z
    res SB_MUS,(hl)
    ld a,(hl)
    or a
    jr z,SND_SYNC               ; nothing else plays: the main thread may write the chip
    set SB_SYNC,(hl)
    ret

; ---------------------------------------------------------------------------------------------------------------
; SND_OWNSET: A = effect type (1, 3, 4, 5) -> MUS_OWN[0..10] (no effect: SND_OWNCLR).  Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
; SND_XS: from here to SND_E is every instruction the frame interrupt runs in this module (SND_OWNCLR, SND_OWNSET, SND_SYNC, SND_TICK): the tests
; that time the interrupt by its program counter count [SND_XS, SND_E) once they are inside it (the main thread calls SND_OWNCLR / SND_SYNC too).
SND_XS:
SND_OWNCLR:                     ; (no effect owns anything: SND_OWNSET with A = 0, faster; clobbers AF, B, HL)
    ld hl,MUS_OWN
    ld b,11
    xor a
.z:
    ld (hl),a
    inc l
    djnz .z
    ret
SND_OWNSET:
    ld c,a
    ld de,$01C3                 ; 1: R0, R1, R6, R7, R8
    cp 3
    jr c,.m
    ld de,$07FF                 ; 3: all eleven
    jr z,.m
    ld de,$0430                 ; 4: R4, R5, R10
    cp 5
    jr c,.m
    ld de,$0470                 ; 5: and R6
.m:
    ld hl,MUS_OWN
    ld b,11
.l:
    xor a
    srl d
    rr e
    rla
    ld (hl),a
    inc l
    djnz .l
    ld a,c
    cp 4
    ret c
    ld a,2
    ld (MUS_OWN+7),a            ; channel C: R7 is shared
    ret

; ---------------------------------------------------------------------------------------------------------------
; SND_SYNC: bring the chip to what should sound now, for every register no effect owns: with a song, its MUS_SHADOW value (R7 with an owner
; value of 2: the song's bits outside $24, the chip's $24); with no song, the volumes R8-R10 to 0.  Each register is written only where AY_SHADOW
; differs, in ascending order.  Clobbers AF, BC, DE, HL.  (Main thread only when V_SFX_ACTIVE is 0; else from the interrupt.)
; ---------------------------------------------------------------------------------------------------------------
SND_SYNC:
    ld de,MUS_SHADOW            ; E = register (page aligned)
    ld hl,AY_SHADOW             ; L = register (page aligned)
    ld a,(V_SFX_ACTIVE)
    bit SB_MUS,a
    jr nz,.mus
    ld e,8
    ld l,e
    ld b,3
.v:
    set 5,e
    ld a,(de)                   ; MUS_OWN[r]
    res 5,e
    or a
    jr nz,.vn                   ; the effect's
    or (hl)
    jr z,.vn                    ; already 0
    xor a
    ld (hl),a
    ld a,l
    out (PORT_AY_REG),a
    xor a
    out (PORT_AY_DATA),a
.vn:
    inc e
    inc l
    djnz .v
    ret
.mus:
    ld b,11
.m:
    set 5,e
    ld a,(de)
    res 5,e
    dec a
    jr z,.mn                    ; 1: the effect's
    inc a
    ld a,(de)                   ; the song's value (the flags are INC A's: Z = owner 0)
    jr z,.mv
    and $DB                     ; 2: R7 shared with a channel-C effect
    ld c,a
    ld a,(AY_SHADOW+7)
    and $24
    or c
.mv:
    cp (hl)
    jr z,.mn
    ld (hl),a
    ld c,a
    ld a,l
    out (PORT_AY_REG),a
    ld a,c
    out (PORT_AY_DATA),a
.mn:
    inc e
    inc l
    djnz .m
    ret

; ---------------------------------------------------------------------------------------------------------------
; SND_TICK: the frame interrupt, V_SFX_ACTIVE <> 0 (A = it).  Entered from the ISR (AF is saved there) with interrupts off; leaves through
; ISR_DONE.  A song alone in a wait only counts down (no register saved).  Else, saving BC, DE, HL once: a pending SND_SYNC, the effect's refresh,
; the song's refresh (paused while an effect of type 1 or 3 plays).  Costs: arcade/tests/m10-runtime-sound.mjs, m15-runtime-music.mjs.
; ---------------------------------------------------------------------------------------------------------------
SND_TICK:
SND_S:
    cp 1<<SB_MUS
    jr nz,.full
    ld a,(V_MUS_WAIT)           ; a song alone
    or a
    jr z,.full                  ; (A = 0 acts as 1 << SB_MUS below: no SB_SYNC, no SB_FX)
    dec a
    ld (V_MUS_WAIT),a
    jp ISR_DONE
.full:
    push bc
    push de
    push hl
    cp 1<<SB_SYNC
    jr c,.fx                    ; neither a request nor a posted effect (bits 2 and 3 clear): the common case, 19 T
    bit SB_NEW,a
    jr z,.sy
    ; ---- .new: the effect RT_PLAY / RT_SILENCE posted while a song plays (type 0: none) replaces the one playing; the chip is then synchronised
    and ~((1<<SB_NEW)|(1<<SB_FX))
    or 1<<SB_SYNC
    ld (V_SFX_ACTIVE),a         ; (interrupts are off: the main thread cannot change it under us)
    ld a,(V_SFX_NCH)
    or a
    jr z,.none
    ld (V_SFX_CH),a
    ld hl,(V_SFX_NPTR)
    ld (V_SFX_PTR),hl
    call SND_OWNSET
    ld hl,V_SFX_ACTIVE
    set SB_FX,(hl)
    jr .nw
.none:
    call SND_OWNCLR
.nw:
    ld a,(V_SFX_ACTIVE)
.sy:
    bit SB_SYNC,a
    jr z,.fx
    ld hl,V_SFX_ACTIVE
    res SB_SYNC,(hl)
    call SND_SYNC
    ld a,(V_SFX_ACTIVE)
.fx:
    rra
    jp nc,.song
    ld a,(V_SFX_CH)
    ld c,a
    cp 3
    jp nc,.stream
    ; ---- type 1: one record on channel A ----
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
    jp z,.fxend                 ; $FF: the terminator
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
    jr z,.song
    ld (hl),a
    ld a,8
    out (PORT_AY_REG),a
    ld a,d
    out (PORT_AY_DATA),a
    jr .song
    ; ---- types 3, 4, 5: one entry of the stream (C = the type) ----
.stream:
    ld hl,(V_SFX_PTR)
    ld a,(hl)                   ; n (0..11), or $FF = the end of the stream
    inc hl
    inc a
    jr z,.fxend
    dec a
    jr z,.sd
    ld b,a                      ; B = pairs
    ASSERT (AY_SHADOW&$FF) == 0 && AY_SHADOW+15 < $10000   ; AY_SHADOW is page aligned: DE = AY_SHADOW + register with no arithmetic
    ld d,AY_SHADOW>>8           ; (E = the register)
    bit 2,c
    jr nz,.c                    ; 4, 5: channel C
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
.sd:
    ld (V_SFX_PTR),hl
    jr .song
.c:                             ; channel C: R7 keeps the chip's bits outside $24
    ld a,(hl)
    inc hl
    out (PORT_AY_REG),a
    ld e,a
    ld a,(hl)
    inc hl
    ld c,a
    ld a,e
    cp 7
    ld a,c
    jr nz,.cw
    and $24
    ld c,a
    ld a,(AY_SHADOW+7)
    and $DB
    or c
.cw:
    out (PORT_AY_DATA),a
    ld (de),a
    djnz .c
    jr .sd
.fxend:                         ; the effect is over (its terminator or the stream's $FF): no owner, the chip synchronised (no song: volumes 0)
    ld hl,V_SFX_ACTIVE
    res SB_FX,(hl)
    call SND_OWNCLR
    call SND_SYNC
    ; ---- the song ----
.song:
    ld a,(V_SFX_ACTIVE)
    bit SB_MUS,a
    jr z,.out
    rra
    jr nc,.go
    ld a,(V_SFX_CH)
    cp 4
    jr c,.out                   ; an effect of type 1 / 3: the song waits
.go:
    ld hl,V_MUS_WAIT
    ld a,(hl)
    or a
    jr z,.read
    dec (hl)
.out:
    pop hl
    pop de
    pop bc
    jp ISR_DONE
.read:
    ld hl,(V_MUS_PTR)
.item:
    ld a,(hl)
    inc hl
    cp $80
    jr nc,.hi
    or a
    jr z,.done
    ld b,a                      ; B = pairs
    ASSERT (MUS_SHADOW&$FF) == 0 && MUS_OWN == MUS_SHADOW+$20
    ld d,MUS_SHADOW>>8
    ld a,(V_SFX_ACTIVE)
    rra
    jr c,.pair2                 ; an effect plays: look at the owners
.fast:                          ; no effect: MUS_OWN is all 0
    ld e,(hl)                   ; E = register
    inc hl
    ld a,(hl)
    inc hl
    ld (de),a                   ; the song's value, kept
    ld c,a
    ld a,e
    out (PORT_AY_REG),a
    ld a,c
    out (PORT_AY_DATA),a
    ld d,AY_SHADOW>>8
    ld (de),a
    ld d,MUS_SHADOW>>8
    djnz .fast
.done:
    ld (V_MUS_PTR),hl
    jr .out
.pair2:
    ld e,(hl)                   ; E = register
    inc hl
    ld a,(hl)
    inc hl
    ld (de),a                   ; the song's value, kept
    ld c,a
    set 5,e
    ld a,(de)                   ; MUS_OWN[r]
    res 5,e
    or a
    jr nz,.own
.w:
    ld a,e
    out (PORT_AY_REG),a
    ld a,c
    out (PORT_AY_DATA),a
    ld d,AY_SHADOW>>8
    ld (de),a
    ld d,MUS_SHADOW>>8
.nx:
    djnz .pair2
    jr .done
.own:
    dec a
    jr z,.nx                    ; the effect's register: kept for later, not written
    ld a,c                      ; R7 with a channel-C effect: the song's bits outside $24
    and $DB
    ld c,a
    ld a,(AY_SHADOW+7)
    and $24
    or c
    ld c,a
    jr .w
.hi:
    inc a
    jr z,.next                  ; $FF: the pattern's end
    sub $81
    ld (V_MUS_WAIT),a           ; $80 + k: this refresh and k more
    jr .done
.next:
    ld hl,(V_MUS_ORD)
    inc hl
    inc hl
.ord:
    ld (V_MUS_ORD),hl
    ld a,(hl)
    inc hl
    ld h,(hl)
    ld l,a
    or h
    jr nz,.item                 ; HL = the next pattern
    ld hl,(V_MUS_LOOP)
    ld a,h
    or l
    jr nz,.ord
    ld hl,V_SFX_ACTIVE          ; the end of a song that does not loop
    res SB_MUS,(hl)
    call SND_SYNC
    jp .out
SND_E:
M_SOUND_E:

; KEY_ROWSEL (RT_KEYDOWN's half-row selects): 8 bytes of data, put in the unused gap $0068-$00FF of DOCK chunk 0 (between the NMI vector and the boot code), where
; they fill no space at the end of the image.  (The three-channel tick used to live in this gap; it is now the end of SND_TICK.)
    ORG $0068
M_KROW_S:
KEY_ROWSEL:
    DB $FE, $FD, $FB, $F7, $EF, $DF, $BF, $7F
M_KROW_E:
    ASSERT (KEY_ROWSEL&$FF)+7 < 256 && (KEY_ROWSEL>>8) == 0     ; RT_KEYDOWN adds the row to the low byte
    ASSERT M_KROW_E <= $0100    ; the gap ends where the boot code starts
    ORG M_SOUND_E
