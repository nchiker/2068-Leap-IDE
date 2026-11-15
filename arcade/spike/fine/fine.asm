; fine.asm -- F1 spike cartridge: SCLD mode 2 (8x1 colour), one screen, sprites updated after the frame interrupt.
; docs/ARCADE_FINE_COLOUR_CONTRACT.md section 3.  Booted from the stock TS2068 ROM as a DCK (bank 0: chunks 0, 1, 4, 5 from the dock).
;
; -D parameters:
;   METHOD    0 = A "direct": per instance in y order, erase the old cells and draw the sprite straight into the screen, with overlap repair
;             1 = B "compose and publish": compose the changed cells (16 bytes each) off screen after FRAME, publish them at the next tick
;   BUFCELLS  B only: buffer slots (18 bytes + a 2-byte pointer each; at most 254); cells beyond are composed and written at publish time, one at a time
;             (BUFCELLS 0 = every cell composed into one 16-byte slot and written right away, top to bottom: "direct per cell")
;   DIFF      B only: 1 = after the compose, compare each slot row with the screen and keep only the groups that change, as a list of
;             (address, bitmap, colour) that publish writes (fewer writes, so the beam meets the publish less often)
;   STOPAT    0 = run forever; n = stop after the update that shows state n (V_STOP = $A5), for the cross-emulator compare
;
; Tick (every 3 frames = 20 Hz, starting right after an interrupt): the screen update (A: updA; B: publish), then the "FRAME" (the next
; state: positions from the script table, the HUD counter), then (B) the compose of that state.  State n = scene.mjs positions(n).
; The data at $2000-$35FF and $8000-$BFFF is placed by scene.mjs placeData (addresses below must match its ADDR).
    DEVICE NOSLOT64K
    IFNDEF METHOD
METHOD  EQU 1
    ENDIF
    IFNDEF BUFCELLS
BUFCELLS EQU 254
    ENDIF
    IFNDEF DIFF
DIFF    EQU 0
    ENDIF
    IFNDEF STOPAT
STOPAT  EQU 0
    ENDIF

; ---- data in the DOCK (scene.mjs) ----
GLYPH       EQU $2000           ; 8 planes: row k of the glyph of value v at GLYPH + 256 k + v
TILE_ROWS   EQU $2800           ; tile t's row-k attribute at TILE_ROWS + 8 t + k
ASSET_TAB   EQU $2C00           ; 32 bytes per asset: h, wb0 (bytes at phase 0), w, 0, 8 x phase table pointer
ROW_TAB     EQU $2D00           ; bitmap address of pixel row y, column 0 (192 words)
INST_ASSET  EQU $2F00           ; asset of each instance (16 bytes)
INIT_CELLS  EQU $3000           ; 768 cell values
INIT_ATTRS  EQU $3300           ; 768 cell attributes
SCRIPT      EQU $A000           ; tick n, instance j: x at SCRIPT + 32 n + 2 j, y at +1 (256 ticks)

; ---- RAM ----
CELL_TILE   EQU $C000
CELL_ATTR   EQU $C300
INST        EQU $C600           ; 16 records of 32 bytes
VARS        EQU $C800
MARK        EQU $C900           ; 96 bytes: cell 8 i + b changed when bit b of MARK[i] is set (page aligned)
SFLAG       EQU $C980           ; A: 16 "redraw" flags
ORDER       EQU $C990           ; A: instance order (16)
KEYS        EQU $C9A0           ; A: sort keys (16)
ROWLIST     EQU $CA00           ; B: per cell row r (24), at ROWLIST + 32 r: count, then the instances whose new rect spans r
PREFIX      EQU $CD00           ; B: slots before each MARK byte (96)
SLOTS       EQU $D400           ; B: 18-byte slots: screen address, then (bitmap, colour) x 8 rows
GLIST       EQU $E600           ; B, DIFF: the changed groups: (address, bitmap, colour), ended by address $0000
TMPSLOT     EQU $FF00           ; one slot (cells composed at publish time)
STACK       EQU $FF00
    ASSERT SLOTS + 18*BUFCELLS <= GLIST-4 && GLIST + 4*768 + 2 <= STACK-256 && BUFCELLS <= 254

; instance record fields (IX)
I_A     EQU 0                   ; asset
I_X     EQU 1                   ; new (the state to show) x, y and cell rect c0, r0, c1, r1
I_Y     EQU 2
I_C0    EQU 3
I_OX    EQU 7                   ; old (the state on screen) x, y, rect
I_OY    EQU 8
I_OC0   EQU 9
I_CX    EQU 13                  ; A: current x, y, rect (old until the instance is processed, then new)
I_CY    EQU 14
I_CC0   EQU 15
I_CR0   EQU 16
I_CC1   EQU 17
I_CR1   EQU 18
I_H     EQU 19                  ; the asset's height and phase-0 width in bytes (cached)
I_WB0   EQU 20
I_WB    EQU 21                  ; window bytes of the new place
I_STR   EQU 22                  ; 4 WB - 3
I_TB    EQU 23                  ; (WB - 1) * 16
I_PTR   EQU 24                  ; (2) the new place's phase table

; variables
V_FRAMES    EQU VARS+0          ; ISR counter (8 bits)
V_TICKF     EQU VARS+1          ; V_FRAMES at the start of the last tick
V_N         EQU VARS+2          ; (2) index of the state in the "new" fields
V_MARKER    EQU VARS+4          ; harness marker: 1 update start, 2 update end, 3 compose start, 4 compose end, 9 ready
V_NSLOT     EQU VARS+5          ; slots composed (8 bits)
V_RESUME    EQU VARS+30         ; (2) first cell left for publish to compose ($FFFF = none)
V_STOP      EQU VARS+8          ; $A5 once stopped (STOPAT)
V_DIG       EQU VARS+9          ; (3) HUD digits
V_E         EQU VARS+12         ; (4) A: erased rect c0, r0, c1, r1
V_I         EQU VARS+16         ; A: the instance being processed ($FF none)
V_APTR      EQU VARS+17         ; (2) B: address list pointer
V_SPTR      EQU VARS+19         ; (2) B: slot pointer
V_CR        EQU VARS+21         ; B: cell row / column being composed
V_CC        EQU VARS+22
V_SLOT      EQU VARS+23         ; (2) B: the slot being composed
V_SP        EQU VARS+25         ; (2) saved SP (publish)
V_OVF       EQU VARS+27         ; (2) B: cells composed at publish time this tick (overflow), for the harness
V_CNT       EQU VARS+29         ; scratch counter

    ORG $0000
    DB $00, $01                 ; LROS: cartridge present, ROM type
    DW ENTRY
    DB $BC                      ; chunk spec at hand-off (as Leap's cartridges); we set $F4 ourselves

    ORG $0038
ISR:                            ; IM 1: count frames only (saves AF; never touches IX, IY or the alternates)
    push af
    ld a,(V_FRAMES)
    inc a
    ld (V_FRAMES),a
    pop af
    ei
    ret

    ORG $0066
    retn

    ORG $0100
BIT_TAB:
    DB $01, $02, $04, $08, $10, $20, $40, $80
; MASK_TAB[(cols - 1) * 8 + (c0 AND 7)] = ((1 << cols) - 1) << (c0 AND 7), 16 bit (as v2's)
MASK_TAB:
    DUP 3, n
    DUP 8, k
    DW ((1<<(n+1))-1)<<k
    EDUP
    EDUP
    ASSERT (MASK_TAB&$FF)+48 <= 256
    IF METHOD == 1
CLIP_ENT:
    DUP 8, kk
    DW CLIP8+(7-kk)*CLIP_ROW
    EDUP
    ENDIF
    IF METHOD == 1
    ASSERT (CLIP_ENT&$FF)+16 <= 256
    ENDIF
MUL4:                           ; MUL4[(WB - 1) * 16 + k] = 4 WB k
    DUP 3, ww
    DUP 16, kk
    DB 4*(ww+1)*kk
    EDUP
    EDUP
    ASSERT (MUL4&$FF)+48 <= 256
LOWMASK:                        ; LOWMASK[b] = 2^b - 1
    DB $00, $01, $03, $07, $0F, $1F, $3F, $7F
    ASSERT (LOWMASK&$FF)+8 <= 256
    ORG $0200
POP256:                         ; POP256[v] = bits set in v
    DUP 256, vv
    DB ((vv>>0)&1)+((vv>>1)&1)+((vv>>2)&1)+((vv>>3)&1)+((vv>>4)&1)+((vv>>5)&1)+((vv>>6)&1)+((vv>>7)&1)
    EDUP

; ---------------------------------------------------------------------------------------------------------------
ENTRY:
    di
    ld a,$33
    out ($F4),a                 ; DOCK chunks 0, 1, 4, 5; RAM 2, 3, 6, 7
    xor a
    out ($FF),a                 ; mode 0, DOCK, interrupt on
    ld sp,STACK
    im 1
    ld hl,$C000                 ; clear RAM $C000-$FEFF
    ld de,$C001
    ld bc,$3EFF
    ld (hl),0
    ldir
    ld hl,$4000                 ; bitmap and colour plane all 0 (black) before mode 2
    ld de,$4001
    ld bc,$37FF
    ld (hl),0
    ldir
    ld a,2
    out ($FF),a                 ; SCLD mode 2: bitmap $4000, colour byte per 8x1 group at + $2000
    ld hl,INIT_CELLS
    ld de,CELL_TILE
    ld bc,1536                  ; cells and attributes (contiguous in both)
    ldir
    ld a,'0'
    ld (V_DIG),a
    ld (V_DIG+1),a
    ld (V_DIG+2),a
    ; instance records: asset, h, wb0
    ld ix,INST
    ld hl,INST_ASSET
    ld b,16
.inst:
    ld a,(hl)
    ld (ix+I_A),a
    rrca
    rrca
    rrca                        ; 32 * asset (asset < 8)
    ld e,a
    ld d,ASSET_TAB>>8
    ld a,(de)
    ld (ix+I_H),a
    inc e
    ld a,(de)
    ld (ix+I_WB0),a
    inc hl
    ld de,32
    add ix,de
    djnz .inst
    ; state 0: load, draw every cell and every sprite
    ld hl,0
    ld (V_N),hl
    call load_state
    ld bc,0
.cells:
    push bc
    call cell_scr
    pop bc
    inc bc
    ld a,b
    cp 3
    jr nz,.cells
    ld ix,INST
    ld b,16
.spr:
    push bc
    call cur_new
    call spr_scr
    pop bc
    ld de,32
    add ix,de
    djnz .spr
    call commit                 ; old = new
    ; prepare state 1
    call next_state
    IF METHOD == 1
    call prep_b
    ENDIF
    ld a,9
    ld (V_MARKER),a
    ei
    halt
    ld a,(V_FRAMES)
    ld (V_TICKF),a
; ---------------------------------------------------------------------------------------------------------------
; The tick loop: wait for the interrupt that is 3 or more frames after the last tick's start, then the update straight away.
MAIN:
    halt
    ld a,(V_FRAMES)
    ld hl,V_TICKF
    sub (hl)
    cp 3
    jr c,MAIN
    ld a,(V_FRAMES)
    ld (hl),a
    IF STOPAT
    ld hl,(V_N)
    ld de,STOPAT+1
    or a
    sbc hl,de
    jr nz,.go
    ld a,$A5
    ld (V_STOP),a
.stop:
    halt
    jr .stop
.go:
    ENDIF
    ld a,1
    ld (V_MARKER),a
    IF METHOD == 0
    call upd_a
    ELSE
    call publish
    ENDIF
    ld a,2
    ld (V_MARKER),a
    call next_state             ; "FRAME": the next state
    IF METHOD == 1
    ld a,3
    ld (V_MARKER),a
    call prep_b
    ld a,4
    ld (V_MARKER),a
    ENDIF
    jr MAIN

; ---------------------------------------------------------------------------------------------------------------
; next_state: V_N + 1; positions of that state from the script, rects; the HUD counter (cell map; B marks the digit cells).
next_state:
    ld hl,(V_N)
    inc hl
    ld (V_N),hl
    call load_state
    ld hl,V_DIG+2               ; decimal increment of the 3 digits
.dig:
    ld a,(hl)
    inc a
    cp '9'+1
    jr c,.ok
    ld (hl),'0'
    dec hl
    ld a,l
    cp (V_DIG-1)&$FF
    jr nz,.dig
    jr .put
.ok:
    ld (hl),a
.put:
    ld hl,V_DIG
    ld de,CELL_TILE+29
    ld bc,3
    ldir
    ret

; load_state: positions of state V_N (script row V_N AND 255) into the new fields, and the new cell rects.
load_state:
    ld a,(V_N)
    ld l,a
    ld h,0
    add hl,hl
    add hl,hl
    add hl,hl
    add hl,hl
    add hl,hl
    ld de,SCRIPT
    add hl,de
    ld ix,INST
    ld b,16
.l:
    ld a,(hl)
    ld (ix+I_X),a
    inc hl
    ld a,(hl)
    ld (ix+I_Y),a
    inc hl
    push hl
    call rect_new
    pop hl
    ld de,32
    add ix,de
    djnz .l
    ret

; rect_new: the cell rect of the new place: c0 = x >> 3, c1 = c0 + window bytes - 1, r0 = y >> 3, r1 = (y + h - 1) >> 3.  Clobbers AF, C, E.
rect_new:
    ld a,(ix+I_X)
    ld c,a
    rrca
    rrca
    rrca
    and $1F
    ld (ix+I_C0),a
    ld e,a
    ld a,c
    and 7
    ld d,a                      ; phase
    ld a,(ix+I_WB0)             ; (LD keeps Z from the AND)
    jr z,.al
    inc a
.al:
    ld (ix+I_WB),a              ; window bytes
    ld c,a
    add a,a
    add a,a
    sub 3
    ld (ix+I_STR),a             ; 4 WB - 3: from the second pair of a row to the first of the next
    ld a,c
    dec a
    add a,e
    ld (ix+I_C0+2),a            ; c1
    ld a,c
    dec a
    rlca
    rlca
    rlca
    rlca
    ld (ix+I_TB),a              ; (WB - 1) * 16: MUL4 row
    ld a,d
    add a,a
    add a,4
    ld e,a
    ld a,(ix+I_A)
    rrca
    rrca
    rrca
    add a,e
    ld e,a
    ld d,ASSET_TAB>>8
    ld a,(de)
    ld (ix+I_PTR),a             ; the phase table
    inc e
    ld a,(de)
    ld (ix+I_PTR+1),a
    ld a,(ix+I_Y)
    ld c,a
    rrca
    rrca
    rrca
    and $1F
    ld (ix+I_C0+1),a
    ld a,c
    add a,(ix+I_H)
    dec a
    rrca
    rrca
    rrca
    and $1F
    ld (ix+I_C0+3),a
    ret

; commit: old = new (x, y, rect) for every instance.
commit:
    ld hl,INST+I_X
    ld de,INST+I_OX
    ld a,16
.l:
    ldi
    ldi
    ldi
    ldi
    ldi
    ldi
    ld bc,26
    add hl,bc
    ex de,hl
    add hl,bc
    ex de,hl
    dec a
    jr nz,.l
    ret

; cur_new / cur_old: IX's current place = the new / old one (6 bytes).  Clobbers BC, DE, HL.
cur_new:
    push ix
    pop hl
    ld bc,I_X
    jr cur_cp
cur_old:
    push ix
    pop hl
    ld bc,I_OX
cur_cp:
    add hl,bc
    push ix
    pop de
    ex de,hl
    ld bc,I_CX
    add hl,bc
    ex de,hl
    ld bc,6
    ldir
    ret

; ---------------------------------------------------------------------------------------------------------------
; KERNEL cell_scr: BC = cell index (0..767).  Renders the cell straight into the screen: 8 bitmap bytes from the glyph, 8 colour bytes
; (font cell: its attribute on all rows; tile cell: the tile's 8 row attributes), each group's bitmap byte and colour byte back to back.
; Clobbers AF, BC, DE, HL.
cell_scr:
    ld a,b
    add a,CELL_TILE>>8
    ld h,a
    ld l,c
    ld a,b
    add a,a
    add a,a
    add a,a
    add a,$40
    ld d,a                      ; D = $40 + 8 * third
    ld e,c                      ; E = (r AND 7) * 32 + c
    ld c,(hl)                   ; the cell value
    ld b,GLYPH>>8
    bit 7,c
    jr nz,.tile
    inc h
    inc h
    inc h
    ld l,(hl)                   ; L = the attribute (CELL_ATTR = CELL_TILE + $300)
    DUP 7
    ld a,(bc)
    ld (de),a
    set 5,d
    ld a,l
    ld (de),a
    res 5,d
    inc b
    inc d
    EDUP
    ld a,(bc)
    ld (de),a
    set 5,d
    ld a,l
    ld (de),a
    ret
.tile:
    ld l,c
    ld h,0
    add hl,hl
    add hl,hl
    add hl,hl
    ld a,h
    add a,(TILE_ROWS-$400)>>8
    ld h,a                      ; HL = TILE_ROWS + 8 (v - 128) (8-aligned)
    DUP 7
    ld a,(bc)
    ld (de),a
    set 5,d
    ld a,(hl)
    ld (de),a
    res 5,d
    inc l
    inc b
    inc d
    EDUP
    ld a,(bc)
    ld (de),a
    set 5,d
    ld a,(hl)
    ld (de),a
    ret

; KERNEL cell_buf: BC = cell index, DE = a 16-byte slot (any address).  As cell_scr, into the slot (bitmap, colour per row).
; Out: DE = the slot + 16 (low byte; the caller keeps the slot).  Clobbers AF, BC, HL.
cell_buf:
    ld a,b
    add a,CELL_TILE>>8
    ld h,a
    ld l,c
    ld c,(hl)
    ld b,GLYPH>>8
    bit 7,c
    jr nz,.tile
    inc h
    inc h
    inc h
    ld l,(hl)
    DUP 8
    ld a,(bc)
    ld (de),a
    inc de
    ld a,l
    ld (de),a
    inc de
    inc b
    EDUP
    ret
.tile:
    ld l,c
    ld h,0
    add hl,hl
    add hl,hl
    add hl,hl
    ld a,h
    add a,(TILE_ROWS-$400)>>8
    ld h,a
    DUP 8
    ld a,(bc)
    ld (de),a
    inc de
    ld a,(hl)
    ld (de),a
    inc de
    inc l
    inc b
    EDUP
    ret

; ---------------------------------------------------------------------------------------------------------------
; KERNEL spr_scr: IX = instance.  The fine masked blit of the asset at its CURRENT place (I_CX, I_CY) straight into the screen: per row,
; per window byte:  bitmap = (bitmap AND mask) OR image, then (same group) colour = (colour AND cmask) OR cink.  Clobbers AF, BC, DE, HL.
    MACRO FINE_BYTE
        ld a,(de)
        and (hl)
        inc hl
        or (hl)
        inc hl
        ld (de),a
        set 5,d
        ld a,(de)
        and (hl)
        inc hl
        or (hl)
        inc hl
        ld (de),a
        res 5,d
    ENDM
    MACRO ROW_DOWN              ; DE one pixel row down (Spectrum layout)
        inc d
        ld a,d
        and 7
        jr nz,1F
        ld a,e
        add a,32
        ld e,a
        jr c,1F
        ld a,d
        sub 8
        ld d,a
1:
    ENDM
spr_scr:
    ld a,(ix+I_CX)
    ld c,a
    and 7
    ld b,(ix+I_WB0)
    jr z,.al
    inc b                       ; B = window bytes (1..3)
.al:
    add a,a
    add a,4
    ld e,a
    ld a,(ix+I_A)
    rrca
    rrca
    rrca
    add a,e
    ld l,a
    ld h,ASSET_TAB>>8
    ld a,(hl)
    inc l
    ld h,(hl)
    ld l,a
    push hl                     ; the phase table
    ld a,(ix+I_CY)
    ld l,a
    ld h,0
    add hl,hl
    ld de,ROW_TAB
    add hl,de
    ld e,(hl)
    inc hl
    ld d,(hl)                   ; DE = row y, column 0
    ld a,c
    rrca
    rrca
    rrca
    and $1F
    add a,e
    ld e,a                      ; + x >> 3 (no carry: E <= $E0 + 31)
    pop hl
    ld a,b
    ld b,(ix+I_H)               ; rows
    dec a
    jr z,.w1
    dec a
    jr z,.w2
.w3:
    FINE_BYTE
    inc e
    FINE_BYTE
    inc e
    FINE_BYTE
    dec e
    dec e
    ROW_DOWN
    djnz .w3
    ret
.w2:
    FINE_BYTE
    inc e
    FINE_BYTE
    dec e
    ROW_DOWN
    djnz .w2
    ret
.w1:
    FINE_BYTE
    ROW_DOWN
    djnz .w1
    ret

; ---------------------------------------------------------------------------------------------------------------
; Method A.  upd_a: dirty cells first (the HUD digits, with repair), then per instance in order of min(old y, new y): erase its old cells
; (cell_scr), make its current place the new one, and repair: redraw, in instance order, every instance whose current rect meets the erased
; rect (and the instance itself), plus every later instance whose rect meets one redrawn (masked blits are idempotent and restore the order).
    IF METHOD == 0
upd_a:
    ld ix,INST                  ; current = old for every instance
    ld b,16
.co:
    push bc
    call cur_old
    pop bc
    ld de,32
    add ix,de
    djnz .co
    ld hl,HUD_RECT              ; the dirty cells: HUD digits 29..31 of row 0
    ld de,V_E
    ld bc,4
    ldir
    ld a,$FF
    ld (V_I),a
    ld hl,V_E
    call erase_rect
    call repair
    ; order by min(old y, new y): KEYS, ORDER (insertion sort)
    ld ix,INST
    ld hl,KEYS
    ld b,16
.k:
    ld a,(ix+I_OY)
    cp (ix+I_Y)
    jr c,.kk
    ld a,(ix+I_Y)
.kk:
    ld (hl),a
    inc l
    ld de,32
    add ix,de
    djnz .k
    ld hl,ORDER
    xor a
.o0:
    ld (hl),a
    inc l
    inc a
    cp 16
    jr nz,.o0
    ld c,1                      ; i
.ins:
    ld a,c
    add a,ORDER&$FF
    ld l,a
    ld h,ORDER>>8
    ld b,(hl)                   ; v = ORDER[i]
    ld a,b
    add a,KEYS&$FF
    ld e,a
    ld d,KEYS>>8
    ld a,(de)
    ld (V_CNT),a                ; key of v
.sh:
    ld a,l
    cp ORDER&$FF
    jr z,.put                   ; j < 0
    dec l
    ld a,(hl)                   ; ORDER[j]
    add a,KEYS&$FF
    ld e,a
    ld a,(V_CNT)
    ex de,hl
    cp (hl)                     ; key(v) - key(ORDER[j])
    ex de,hl
    jr nc,.stop                 ; key(ORDER[j]) <= key(v)
    ld a,(hl)
    inc l
    ld (hl),a                   ; ORDER[j + 1] = ORDER[j]
    dec l
    jr .sh
.stop:
    inc l
.put:
    ld (hl),b
    inc c
    ld a,c
    cp 16
    jr nz,.ins
    ; per instance
    ld hl,ORDER
.each:
    ld a,(hl)
    push hl
    ld (V_I),a
    rrca
    rrca
    rrca
    ld l,a
    and $1F
    ld h,a
    ld a,l
    and $E0
    ld l,a                      ; HL = 32 i
    ld de,INST
    add hl,de
    push hl
    pop ix
    ld de,I_OC0
    add hl,de
    ld de,V_E
    ld bc,4
    ldir                        ; E = the old rect
    ld hl,V_E
    call erase_rect
    call cur_new
    call repair
    pop hl
    inc l
    ld a,l
    cp (ORDER+16)&$FF
    jr nz,.each
    jp commit
HUD_RECT:
    DB 29, 0, 31, 0

; erase_rect: HL -> c0, r0, c1, r1: every cell of the rect rendered from the cell map (cell_scr).  Clobbers everything but IX, IY.
erase_rect:
    ld c,(hl)
    inc hl
    ld b,(hl)
    inc hl
    ld e,(hl)
    inc hl
    ld d,(hl)
.row:
    ld a,c
.col:
    push af
    push bc
    push de
    ld l,a                      ; cell index = 32 r + c
    ld a,b
    rrca
    rrca
    rrca
    ld h,a
    and $E0
    or l
    ld c,a
    ld a,h
    and 3
    ld b,a
    call cell_scr
    pop de
    pop bc
    pop af
    cp e
    inc a
    jr c,.col
    ld a,b
    cp d
    inc b
    jr c,.row
    ret

; repair: SFLAG[j] = 1 for the instance V_I and every instance whose current rect meets V_E; then for j = 0..15 with the flag: draw it
; (spr_scr) and flag every later k whose current rect meets j's.
repair:
    ld hl,SFLAG
    ld b,16
.cl:
    ld (hl),0
    inc l
    djnz .cl
    ld iy,V_E-I_CC0             ; (iy+I_CC0 .. I_CR1) = V_E
    ld ix,INST
    ld hl,SFLAG
    ld a,(V_I)
    ld c,a
    ld b,0
.s0:
    ld a,b
    cp c
    jr z,.set
    call ovl
    jr c,.no
.set:
    ld (hl),1
.no:
    inc l
    ld de,32
    add ix,de
    inc b
    ld a,b
    cp 16
    jr nz,.s0
    ld ix,INST
    ld hl,SFLAG
.dj:
    ld a,(hl)
    or a
    jr z,.nj
    push hl
    call spr_scr
    pop hl
    push hl                     ; flag later k meeting j
    push ix
    pop iy                      ; IY = j
    ld a,l
    sub SFLAG&$FF
    ld b,a                      ; j
    push ix
.k:
    inc l
    ld de,32
    add ix,de
    inc b
    ld a,b
    cp 16
    jr z,.kd
    ld a,(hl)
    or a
    jr nz,.k
    call ovl
    jr c,.k
    ld (hl),1
    jr .k
.kd:
    pop ix
    pop hl
.nj:
    ld de,32
    add ix,de
    inc l
    ld a,l
    cp (SFLAG+16)&$FF
    jr nz,.dj
    ret

; ovl: carry clear when the current rects of IX and IY meet.  Clobbers AF.
ovl:
    ld a,(ix+I_CC1)
    cp (iy+I_CC0)
    ret c
    ld a,(iy+I_CC1)
    cp (ix+I_CC0)
    ret c
    ld a,(ix+I_CR1)
    cp (iy+I_CR0)
    ret c
    ld a,(iy+I_CR1)
    cp (ix+I_CR0)
    ret
    ENDIF

; ---------------------------------------------------------------------------------------------------------------
; Method B (compose and publish).  prep_b runs after FRAME (no screen write):
;   1. mark: the cells under every instance's old and new places, and the HUD digits (MARK);
;   2. assign: walk MARK top to bottom: each marked cell gets the next slot (18 bytes: its screen address, then 8 x (bitmap, colour)) with
;      the cell's background (cell_buf); PREFIX[i] = slots before MARK byte i (so a cell's slot = PREFIX + popcount of the lower bits);
;      when BUFCELLS slots are used the rest is left for publish (V_RESUME = the first cell left);
;   3. sprites: per instance in order, per cell of its new rect that has a slot: clip_blit into the slot;
;   4. row lists (only when cells were left over: publish composes those with compose_cell), MARK cleared up to V_RESUME, old = new.
    IF METHOD == 1
prep_b:
    ld ix,INST
    ld b,16
.m:
    push bc
    push ix
    pop hl
    ld de,I_OC0
    add hl,de
    call mark_rect
    push ix
    pop hl
    inc hl
    inc hl
    inc hl                      ; I_C0
    call mark_rect
    pop bc
    ld de,32
    add ix,de
    djnz .m
    ld hl,MARK+3                ; HUD digits: cells 29, 30, 31
    ld a,(hl)
    or $E0
    ld (hl),a
    call assign
    ld a,(V_NSLOT)
    or a
    call nz,sprites_b
    IF DIFF
    call diff_b
    ENDIF
    ld a,(V_RESUME+1)
    inc a
    call nz,build_rows          ; cells left over: publish composes them cell by cell
    call clear_mark
    jp commit

; mark_rect: HL -> c0, r0, c1, r1.  Sets the rect's bits in MARK.  Clobbers AF, BC, DE, HL.
mark_rect:
    ld c,(hl)                   ; c0
    inc hl
    ld b,(hl)                   ; r0
    inc hl
    ld a,(hl)
    sub c                       ; cols - 1
    add a,a
    add a,a
    add a,a
    ld e,a
    ld a,c
    and 7
    add a,e
    add a,a
    add a,MASK_TAB&$FF
    ld e,a
    ld d,MASK_TAB>>8
    inc hl
    ld a,(hl)
    sub b
    inc a
    push af                     ; rows
    ld a,c
    rrca
    rrca
    rrca
    and 3
    ld c,a
    ld a,b
    add a,a
    add a,a
    add a,c
    ld l,a
    ld h,MARK>>8                ; MARK[4 r0 + c0 >> 3]
    ld a,(de)
    ld c,a
    inc e
    ld a,(de)
    ld b,a
    pop af
    ld e,a
.r:
    ld a,(hl)
    or c
    ld (hl),a
    inc l
    ld a,(hl)
    or b
    ld (hl),a
    inc l
    inc l
    inc l
    dec e
    jr nz,.r
    ret

; build_rows: ROWLIST[r] = count, then the instances (in order) whose new rect spans cell row r.
build_rows:
    ld hl,ROWLIST
    ld de,32
    ld b,24
.c:
    ld (hl),0
    add hl,de
    djnz .c
    ld ix,INST
    ld c,0
.j:
    ld b,(ix+I_C0+1)            ; r = r0
.r:
    ld a,b
    rrca
    rrca
    rrca
    ld l,a
    and 7
    add a,ROWLIST>>8
    ld h,a
    ld a,l
    and $E0
    ld l,a                      ; HL = ROWLIST + 32 r
    inc (hl)
    ld a,(hl)
    add a,l
    ld l,a
    ld (hl),c                   ; append j
    ld a,b
    inc b
    cp (ix+I_C0+3)
    jr c,.r
    ld de,32
    add ix,de
    inc c
    ld a,c
    cp 16
    jr nz,.j
    ret

; assign: step 2 above (DE = the next slot all along: cell_buf leaves it there).  Clobbers everything but IX, IY.
assign:
    xor a
    ld (V_NSLOT),a
    dec a
    ld (V_RESUME),a
    ld (V_RESUME+1),a           ; $FFFF: nothing left over
    ld de,SLOTS
    ld l,0
.byte:
    ld h,PREFIX>>8
    ld a,(V_NSLOT)
    ld (hl),a                   ; PREFIX[i]
    ld h,MARK>>8
    ld a,(hl)
    or a
    jr z,.next
    ld c,a
    ld b,0                      ; bit
.bit:
    srl c
    jr nc,.nb
    ld a,(V_NSLOT)
    cp BUFCELLS
    jr z,.full
    inc a
    ld (V_NSLOT),a
    push bc
    push hl
    ld a,l                      ; cell index 8 i + bit: low byte, then the third (i >> 5)
    add a,a
    add a,a
    add a,a
    or b
    ld (de),a                   ; the slot: screen address of the cell's row 0
    inc de
    ld c,a
    ld a,l
    rlca
    rlca
    rlca
    and 3
    ld b,a                      ; BC = cell index
    add a,a
    add a,a
    add a,a
    add a,$40
    ld (de),a
    inc de
    call cell_buf               ; the background; DE = the next slot
    pop hl
    pop bc
.nb:
    inc b
    ld a,c
    or a
    jr nz,.bit
.next:
    inc l
    ld a,l
    cp 96
    jr nz,.byte
    ret
.full:
    ld a,l
    add a,a
    add a,a
    add a,a
    or b
    ld (V_RESUME),a
    ld a,l
    rlca
    rlca
    rlca
    and 3
    ld (V_RESUME+1),a
    ld h,PREFIX>>8              ; the bytes after this one: PREFIX = 255, so no lookup finds a slot
.fill:
    inc l
    ld a,l
    cp 96
    ret z
    ld (hl),255
    jr .fill

; sprites_b: step 3 above.  Clobbers everything but IY.
sprites_b:
    ld ix,INST
    ld b,16
.j:
    push bc
    ld a,(ix+I_C0+1)
    ld (V_CR),a
.r:
    ld a,(ix+I_C0)
    ld (V_CC),a
.c:
    ld c,a                      ; the slot of cell (V_CR, c): PREFIX[i] + popcount(MARK[i] AND (2^bit - 1)), i = 4 r + c >> 3
    rrca
    rrca
    rrca
    and 3
    ld e,a
    ld a,(V_CR)
    add a,a
    add a,a
    add a,e
    ld l,a
    ld h,MARK>>8
    ld a,c
    and 7
    add a,LOWMASK&$FF
    ld e,a
    ld d,LOWMASK>>8
    ld a,(de)
    and (hl)
    ld e,a
    ld d,POP256>>8
    ld a,(de)
    ld h,PREFIX>>8
    add a,(hl)
    jr c,.skip
    ld hl,V_NSLOT
    cp (hl)
    jr nc,.skip                 ; a cell left for publish
    ld l,a                      ; its data: SLOTS + 18 slot + 2
    ld h,0
    add hl,hl
    ld d,h
    ld e,l
    add hl,hl
    add hl,hl
    add hl,hl
    add hl,de
    ld de,SLOTS+2
    add hl,de
    ld (V_SLOT),hl
    call clip_blit
.skip:
    ld a,(V_CC)
    inc a
    ld (V_CC),a
    dec a
    cp (ix+I_C0+2)
    ld a,(V_CC)
    jr c,.c
    ld a,(V_CR)
    inc a
    ld (V_CR),a
    dec a
    cp (ix+I_C0+3)
    jr c,.r
    pop bc
    ld de,32
    add ix,de
    djnz .j
    ret

    IF DIFF
; diff_b: the groups of the slots that differ from the screen now (bitmap or colour), as GLIST entries; ended by address $0000.
; Clobbers AF, BC, DE, HL.
diff_b:
    ld de,GLIST
    ld a,(V_NSLOT)
    or a
    jp z,.end
    ld (V_CNT),a
    ld hl,SLOTS
.slot:
    ld c,(hl)
    inc hl
    ld b,(hl)
    inc hl                      ; BC = the cell's row 0 on the screen, HL = its data
    DUP 8
    ld a,(bc)
    cp (hl)
    jr nz,1F
    set 5,b
    inc hl
    ld a,(bc)
    cp (hl)
    res 5,b
    dec hl
    jr z,2F
1:
    ld a,c
    ld (de),a
    inc de
    ld a,b
    ld (de),a
    inc de
    ld a,(hl)
    ld (de),a
    inc de
    inc hl
    ld a,(hl)
    ld (de),a
    inc de
    dec hl
2:
    inc hl
    inc hl
    inc b
    EDUP
    ld a,(V_CNT)
    dec a
    ld (V_CNT),a
    jp nz,.slot
.end:
    xor a
    ld (de),a
    inc de
    ld (de),a
    ret
    ENDIF

; clear_mark: MARK = 0 below V_RESUME (all of it when nothing is left over).  Clobbers AF, B, HL.
clear_mark:
    ld hl,(V_RESUME)
    ld a,h
    inc a
    ld b,96
    jr z,.all
    ld a,l                      ; B = full bytes = V_RESUME >> 3
    srl h
    rra
    srl h
    rra
    srl h
    rra
    ld b,a
    ld a,(V_RESUME)
    and 7
    add a,LOWMASK&$FF
    ld l,a
    ld h,LOWMASK>>8
    ld a,(hl)
    cpl                         ; keep the bits from the first cell left over on
    ld l,b
    ld h,MARK>>8
    and (hl)
    ld (hl),a
    ld a,b
    or a
    ret z
.all:
    ld hl,MARK
.cl:
    ld (hl),0
    inc l
    djnz .cl
    ret

; KERNEL compose_cell: BC = cell index, DE = slot.  Background (cell_buf), then every instance of ROWLIST[r] whose new rect spans the
; column, in instance order, clipped to the cell (clip_blit).  Clobbers AF, BC, DE, HL, IX, IY.
compose_cell:
    ld (V_SLOT),de
    ld a,c
    and 31
    ld (V_CC),a
    ld a,c
    rlca
    rlca
    rlca
    and 7
    ld l,a
    ld a,b
    add a,a
    add a,a
    add a,a
    or l
    ld (V_CR),a                 ; r = 8 * (idx >> 8) + ((idx AND $FF) >> 5)
    call cell_buf
    ld a,(V_CR)
    rrca
    rrca
    rrca
    ld l,a
    and 7
    add a,ROWLIST>>8
    ld h,a
    ld a,l
    and $E0
    ld l,a                      ; HL = ROWLIST + 32 r
    ld a,(hl)
    or a
    ret z
    ld b,a
.inst:
    inc l
    push bc
    push hl
    ld a,(hl)                   ; instance j: IX = INST + 32 j
    rrca
    rrca
    rrca
    ld l,a
    and 7
    add a,INST>>8
    ld h,a
    ld a,l
    and $E0
    ld l,a
    push hl
    pop ix
    ld a,(V_CC)
    cp (ix+I_C0)
    jr c,.skip                  ; c < c0
    ld a,(ix+I_C0+2)
    ld hl,V_CC
    cp (hl)
    call nc,clip_blit           ; c1 >= c
.skip:
    pop hl
    pop bc
    djnz .inst
    ret

; KERNEL clip_blit: IX = instance (new place), V_CR / V_CC = the cell, V_SLOT = its slot.  The rows of the sprite inside the cell, the window
; byte of the column: slot bitmap = (bitmap AND mask) OR image, slot colour = (colour AND cmask) OR cink.  Clobbers AF, BC, DE, HL.
clip_blit:
    ld a,(V_CC)
    sub (ix+I_C0)
    add a,a
    add a,a
    ld c,a                      ; 4 * the window byte
    ld a,(V_CR)
    add a,a
    add a,a
    add a,a
    sub (ix+I_Y)                ; 8 r - y
    jr c,.below
    ld e,a                      ; k0 = 8 r - y (the sprite started above the cell), d0 = 0
    ld a,(ix+I_H)
    sub e
    cp 8
    jr c,.r1
    ld a,8
.r1:
    ld b,a                      ; rows = min(h - k0, 8)
    ld a,(ix+I_TB)
    add a,e
    add a,MUL4&$FF
    ld l,a
    ld h,MUL4>>8
    ld a,(hl)                   ; 4 WB k0
    add a,c
    ld c,a
    ld de,(V_SLOT)
    jr .go
.below:
    neg                         ; d0 = y - 8 r (the sprite starts inside the cell), k0 = 0
    ld b,a
    add a,a
    ld hl,(V_SLOT)
    add a,l
    ld e,a
    ld a,h
    adc a,0
    ld d,a                      ; DE = slot + 2 d0
    ld a,8
    sub b
    cp (ix+I_H)
    jr c,.r2
    ld a,(ix+I_H)
.r2:
    ld b,a                      ; rows = min(8 - d0, h)
.go:
    ld l,(ix+I_PTR)
    ld h,(ix+I_PTR+1)
    ld a,b
    ld b,0
    add hl,bc                   ; HL = the first (mask, image, cmask, cink) of the window byte
    ld c,(ix+I_STR)             ; BC = stride - 3
    push hl
    add a,a
    add a,(CLIP_ENT-2)&$FF
    ld l,a
    ld h,CLIP_ENT>>8
    ld a,(hl)
    inc l
    ld h,(hl)
    ld l,a
    ex (sp),hl                  ; enter the unrolled block 8 - rows from its start (its RET returns to our caller)
    ret
CLIP8:
    DUP 8
    ld a,(de)
    and (hl)
    inc hl
    or (hl)
    inc hl
    ld (de),a
    inc de
    ld a,(de)
    and (hl)
    inc hl
    or (hl)
    ld (de),a
    inc de
    add hl,bc
    EDUP
    ret
CLIP8_END:
CLIP_ROW EQU 14                 ; bytes of code per row (asserted)
    ASSERT CLIP8_END-CLIP8 == 8*CLIP_ROW+1

; ---------------------------------------------------------------------------------------------------------------
; KERNEL publish (method B, right after the interrupt): every slot in order (top to bottom), read through SP (POP: C = bitmap, B = colour;
; an interrupt pushes into slot bytes already read); per row the bitmap byte (HL) and then the colour byte (DE = HL + $2000) of the group.
; About 340 T a cell.  Then the cells left over (V_RESUME): each composed into TMPSLOT and written at once.
publish:
    ld hl,0
    ld (V_OVF),hl
    ld a,(V_NSLOT)
    or a
    jr z,.ovf
    IF DIFF
    ld (V_SP),sp
    ld sp,GLIST                 ; the changed groups only: address, then C = bitmap, B = colour
.g:
    DUP 4
    pop hl
    ld a,h
    or a
    jr z,.done
    pop bc
    ld (hl),c
    set 5,h
    ld (hl),b
    EDUP
    jp .g
    ELSE
    ld (V_SP),sp
    ld sp,SLOTS
    ex af,af'                   ; A' = slots left (the ISR saves AF only, never AF')
.s:
    pop hl                      ; the cell's row 0
    ld a,h
    add a,$20
    ld d,a
    ld e,l
    DUP 7
    pop bc
    ld (hl),c
    ld a,b
    ld (de),a
    inc h
    inc d
    EDUP
    pop bc
    ld (hl),c
    ld a,b
    ld (de),a
    ex af,af'
    dec a
    jr z,.done
    ex af,af'
    jr .s
    ENDIF
.done:
    ld sp,(V_SP)
.ovf:
    ld hl,(V_RESUME)
    ld a,h
    inc a
    ret z
    srl h                       ; from the MARK byte of the first cell left over (its lower bits were cleared)
    rr l
    srl h
    rr l
    srl h
    rr l
    ld h,MARK>>8
.byte:
    ld a,(hl)
    or a
    jp z,.next
    ld (hl),0
    ld c,a
    ld b,0
.bit:
    srl c
    jp nc,.nb
    push bc
    push hl
    ld a,l
    ld h,0
    add a,a
    rl h
    add a,a
    rl h
    add a,a
    rl h
    or b
    ld c,a
    ld b,h                      ; BC = cell index
    push bc
    ld de,TMPSLOT
    call compose_cell
    pop bc
    ld a,b                      ; DE = the cell's screen address
    add a,a
    add a,a
    add a,a
    add a,$40
    ld d,a
    ld e,c
    ld hl,TMPSLOT
    DUP 8
    ld a,(hl)
    ld (de),a
    inc l
    set 5,d
    ld a,(hl)
    ld (de),a
    inc l
    res 5,d
    inc d
    EDUP
    ld hl,(V_OVF)
    inc hl
    ld (V_OVF),hl
    pop hl
    pop bc
.nb:
    inc b
    ld a,c
    or a
    jp nz,.bit
.next:
    inc l
    ld a,l
    cp 96
    jp nz,.byte
    ret
    ENDIF
CODE_END:
    ASSERT CODE_END <= GLYPH
    SAVEBIN "mem.bin", 0, 65536
