; wiremode.asm -- Leap Arcade runtime v2: the wireframe play area's switch and boot (slice W2, docs/ARCADE_WIREFRAME_CONTRACT.md sections 2.6, 3.3).
; Lives in the free bytes of DOCK chunk 0 between the NMI vector and the cold start ($0068-$00FF, unused before W2: nothing else moves, and the
; wireframe's bytes after RT_END stay within the contract's bound).  The tick's part is wiretick.asm (appended after wire.asm).
;   RT_WIREMODE   A = 0 the play area off, anything else on.  Clobbers AF, BC, DE, HL (IX, IY and the alternates kept).  Nothing at all in a game
;                 without the play area (V_WIRE = 0: its W_* RAM is phase slots there) and when the game is in that mode already.
;                 on:  V_WIRE bit 0 and W_ON = 1, W_ATTR into the play-area cells of BOTH display files.  Nothing else (the next tick clears).
;                 off: V_WIRE bit 0 and W_ON = 0, every play-area cell dirty in BOTH files' maps (the cell map appears in the next two ticks).
;   wire_boot     (boot.asm, after video_init, so after the map table): a DIV_EXT | DIV_WIRE header whose wire_desc is a valid play area
;                 (r1 <= 23, r1 >= r0 + 3) -> wire_setup (clip rectangle, projection centre, the clear's rows, W_ATTR, the eye 0, 0, 0, 0),
;                 V_WIRE = has, and the area on.  Otherwise nothing is written (V_WIRE stays 0).  Clobbers everything (wire_setup: IX, IY, the alternates).
; No self-modifying code; interrupts are left as they are.
    ORG $0068                   ; (follows the NMI vector; the cold start is at RT_ENTRY)
M_WMODE_S:

RT_WIREMODE:
    ld hl,V_WIRE
    bit 1,(hl)                  ; WIRE_HAS
    ret z                       ; no play area in this game
    or a
    jr z,.off
    bit 0,(hl)
    ret nz                      ; on already
.on:                            ; (HL = V_WIRE; wire_boot enters here)
    set 0,(hl)
    ld a,1
    ld (W_ON),a
    ld b,5
    call w_span                 ; HL = 32 r0, BC = 32 (r1 - r0 + 1)
    ld de,DATTR0
    add hl,de
    ld a,(W_ATTR)
    push hl
    push bc
    call w_fill
    pop bc
    pop hl
    set 5,h                     ; DATTR1 = DATTR0 + $2000
    jr w_fill
.off:
    bit 0,(hl)
    ret z                       ; off already
    res 0,(hl)
    xor a
    ld (W_ON),a
    ld b,2
    call w_span                 ; L = 4 r0, BC = 4 (r1 - r0 + 1): the play rows' dirty bytes
    ld h,DIRTY0>>8
    ld a,$FF
    push hl
    push bc
    call w_fill
    pop bc
    pop hl
    inc h                       ; DIRTY1 = DIRTY0 + $100
    ; (falls into w_fill)

; w_fill: BC (>= 2) bytes from HL to A.  A is kept; clobbers BC, DE, HL.
w_fill:
    ld (hl),a
    ld d,h
    ld e,l
    inc de
    dec bc
    ldir
    ret

; w_span: B = k (1..5) -> HL = r0 << k, BC = (r1 - r0 + 1) << k (the play area's rows of 2^k bytes from the start of a map).  Clobbers AF.
w_span:
    ld a,(W_CLR0)
    ld l,a
    ld a,(W_CLR1)
    sub l
    inc a
    ld c,a
    ld a,b
    ld b,0
    ld h,b
.s:
    add hl,hl
    sla c
    rl b
    dec a
    jr nz,.s
    ret

wire_boot:
    ld a,(GAME_DIV)
    cpl
    and DIV_EXT|DIV_WIRE
    ret nz                      ; not both bits
    ld hl,(GAME_WIREDESC)
    ld a,h
    or l
    ret z
    ld b,(hl)                   ; r0
    inc hl
    ld c,(hl)                   ; r1
    inc hl
    ld a,c
    cp CELL_ROWS
    ret nc                      ; r1 > 23
    sub b
    ret c
    cp 3
    ret c                       ; fewer than 4 rows
    ld a,(hl)                   ; the attribute
    call wire_setup
    ld hl,V_WIRE
    ld (hl),WIRE_HAS
    jr RT_WIREMODE.on
M_WMODE_E:
    ASSERT M_WMODE_E <= RT_ENTRY
    ASSERT DATTR1 == DATTR0+$2000 && (DATTR0 & $2000) == 0 && DIRTY1 == DIRTY0+$100 && (DIRTY0 & $FF) == 0 && WIRE_HAS == 2
