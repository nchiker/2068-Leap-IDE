; tileops.asm -- language batch 1 (docs/ARCADE_LANGUAGE_BATCH1.md, docs/ARCADE_RUNTIME_API_V2.md "As built: language batch 1"):
; the tile operations RT_FILL, RT_FILLC, RT_COPY, RT_LOADMAP / RT_LOADMAPAT / RT_LOADMAPPTR, and RT_BORDER, RT_RANDOMISE, plus maps_boot (the map table
; at boot).  ADDITIVE: this module sits after the font, so no address of v2 moves; it changes nothing but the cell map (CELL_TILE / CELL_ATTR), the dirty
; maps and its own RAM (the former T3 area, layout.inc); the display files are drawn by the frame loop (redraw_dirty) as for RT_TILE.
; Every RT_* routine clobbers AF, BC, DE, HL only and preserves IX, IY and the alternate registers; at most 14 bytes of stack beyond the CALL.
;
; HOW IT WORKS.  A rectangle is walked row by row; each row is cut into groups of cells that share one byte of the dirty maps (8 cells, aligned to
; column 0, 8, 16, 24).  A group function (g_fill / g_copy / g_load) compares and writes the cell bytes of the group in one pass and the attribute
; bytes in a second, and builds a bit mask of the cells whose byte differed (a sentinel bit in the mask register ends the loop: no counter);
; the walker ORs the mask into DIRTY0 and DIRTY1.  So a cell is marked dirty iff its cell byte or attribute changed, exactly as RT_TILE (cell_set) does,
; and no cell costs a call.  COPY is a memmove: rows are visited in the order that never reads a row already written; a copy within the same rows goes
; through a row buffer (TO_BUFT / TO_BUFA), so no cell is read after it was written.
    ; (no ORG: follows font.inc)
M_TILEOPS_S:

; scratch of the tile operations (TO_VARS = $FACC.., layout.inc)
TO_A            EQU TO_VARS+0   ; byte: the attribute RT_FILL writes
TO_V            EQU TO_VARS+1   ; byte: the cell byte it writes (TO_V follows TO_A: LD DE,(TO_A) = D the cell byte, E the attribute)
TO_GT           EQU TO_VARS+2   ; byte: right shifts that align the group's mask (8 - first bit - cells)
TO_GS           EQU TO_VARS+3   ; byte: sentinel of the current group (1 << (cells - 1)); TO_GS follows TO_GT: LD (TO_GT),BC stores C = shift, B = sentinel
TO_M1           EQU TO_VARS+4   ; byte: mask of the cell-byte pass
TO_REM          EQU TO_VARS+5   ; byte: cells of the row not yet done
TO_DP           EQU TO_VARS+6   ; byte: index (0..95) of the dirty byte of the current group
TO_X0           EQU TO_VARS+7   ; byte: first (destination) column
TO_Y0           EQU TO_VARS+8   ; byte: current (destination) row (FILL, LOADMAP); TO_Y0 follows TO_X0 (LD BC,(TO_X0) = row, column) and precedes TO_NY
TO_NY           EQU TO_VARS+9   ; byte: rows left
TO_NX           EQU TO_VARS+10  ; byte: cells per row
TO_SX0          EQU TO_VARS+11  ; byte: COPY source column
TO_SYC          EQU TO_VARS+12  ; byte: COPY current source row
TO_RSTEP        EQU TO_VARS+13  ; byte: COPY row step ($01 or $FF)
TO_SOFF         EQU TO_VARS+14  ; word: source attribute pointer - source cell pointer ($0300 in the map, $0020 in the row buffer)
TO_S            EQU TO_VARS+16  ; word: source pointer after the group
TO_P            EQU TO_VARS+18  ; word: destination pointer after the group
TO_MW           EQU TO_VARS+20  ; byte: map width
TO_MH           EQU TO_VARS+21  ; byte: map height
TO_MP           EQU TO_VARS+22  ; word: the map's cells
TO_PX           EQU TO_VARS+24  ; word: LOADMAP x
TO_PY           EQU TO_VARS+26  ; word: LOADMAP y
TO_SCX          EQU TO_VARS+28  ; byte: source column offset (clipped off on the left)
TO_SCY          EQU TO_VARS+29  ; byte: source row offset (clipped off at the top)
TO_SROW         EQU TO_VARS+30  ; word: LOADMAP source pointer of the current row
TO_DXS          EQU TO_VARS+32  ; byte: COPY delta x = dx - x (signed)
TO_DYS          EQU TO_VARS+33  ; byte: COPY delta y
TO_HN           EQU TO_VARS+34  ; byte: cells in the head group of a row (0 = none)
TO_HSC          EQU TO_VARS+35  ; word: the head group's sentinel << 8 | shift
TO_F            EQU TO_VARS+37  ; byte: whole bytes (8 cells) per row
TO_TN           EQU TO_VARS+38  ; byte: cells in the tail group (0 = none)
TO_TSC          EQU TO_VARS+39  ; word: the tail group's sentinel << 8 | shift
    ASSERT TO_TSC+2 <= T3+T3_LEN
    ASSERT TO_V == TO_A+1 && TO_GS == TO_GT+1 && TO_Y0 == TO_X0+1 && TO_NY == TO_Y0+1 && TO_SYC == TO_SX0+1 && TO_RSTEP == TO_SYC+1 && TO_DYS == TO_DXS+1   ; word loads / stores and INC HL steps below

; (RT_BORDER is in boot.asm, in the gap after the header.)

; ---------------------------------------------------------------------------------------------------------------
; RT_RANDOMISE: HL = seed -> RT_SEED.  HL = 0 takes the frame counter instead (one instruction reads it, the interrupt cannot split it), and a
; counter of 0 gives 1: RT_SEED is never left 0.  Clobbers AF, HL.
; ---------------------------------------------------------------------------------------------------------------
RT_RANDOMISE:
    ld a,h
    or l
    jr nz,.set
    ld hl,(V_FRAMES)
    ld a,h
    or l
    jr nz,.set
    inc l
.set:
    ld (RT_SEED),hl
    ret

; ---------------------------------------------------------------------------------------------------------------
; clip_axis: HL = position (signed), DE = length (signed), C = limit (32 or 24) -> carry clear: A = first index (0..limit-1) and B = count
; (1..limit-A) of the part of [position, position + length) inside [0, limit); carry set: nothing (length <= 0, or no overlap).  Works on the
; true sum (no 16-bit wrap).  C is kept.  Clobbers AF, B, HL.
; ---------------------------------------------------------------------------------------------------------------
clip_axis:
    bit 7,d
    jr nz,.empty                ; length < 0
    ld a,d
    or e
    jr z,.empty                 ; length 0
    bit 7,h
    jr nz,.neg
    ld a,h
    or a
    jr nz,.empty                ; position >= 256
    ld a,l
    cp c
    jr nc,.empty                ; position >= limit
    ld a,c
    sub l
    ld b,a                      ; B = room: cells from the position to the limit
    ld a,d
    or a
    jr nz,.start                ; length >= 256: the room
    ld a,e
    cp b
    jr nc,.start                ; length >= room
    ld b,e
.start:
    ld a,l
    or a                        ; (clears the carry)
    ret
.neg:                           ; position < 0: the end is position + length (cannot overflow: length <= 32767, position <= -1)
    add hl,de
    bit 7,h
    jr nz,.empty                ; end < 0
    ld a,h
    or l
    jr z,.empty                 ; end = 0
    ld a,h
    or a
    jr nz,.lim                  ; end >= 256
    ld a,l
    cp c
    jr c,.ok                    ; end < limit
.lim:
    ld b,c
    xor a
    ret
.ok:
    ld b,l
    xor a
    ret
.empty:
    scf
    ret

; ---------------------------------------------------------------------------------------------------------------
; The group functions.  In: HL = destination cell pointer of the first cell (CELL_TILE page, so INC L walks the cells of a row), B = sentinel
; (1 << (cells - 1)), C = t (the alignment shift of mask_done), DE = source cell pointer (COPY, LOADMAP).  Out: A = the dirty mask of the group
; (bit k = the cell in column 8 m + k changed; 0 = nothing changed), HL / DE = the pointers after the group.  Everything else is clobbered.
; Each pass: new XOR old gives zero for an unchanged byte; ADD A,255 turns "not zero" into the carry, RR C shifts it into the mask, and the
; sentinel (set when the mask was cleared, so the last cell shifts it out) ends the loop through the carry: 49..60 T per cell and plane.
; ---------------------------------------------------------------------------------------------------------------
g_fill:
    ld (TO_GT),bc               ; TO_GT = C, TO_GS = B
    ld c,b                      ; C = the mask register, holding only the sentinel
    ld de,(TO_A)                ; D = the cell byte, E = the attribute
    push hl
.p1:
    ld a,(hl)
    xor d
    ld (hl),d
    inc l
    add a,255
    rr c
    jr nc,.p1
    ld a,c
    ld (TO_M1),a
    ld (TO_P),hl
    pop hl
    inc h
    inc h
    inc h                       ; CELL_ATTR
    ld a,(TO_GS)
    ld c,a
.p2:
    ld a,(hl)
    xor e
    ld (hl),e
    inc l
    add a,255
    rr c
    jr nc,.p2
    jp mask_done

g_copy:                         ; source cell pointer DE, source attribute pointer DE + TO_SOFF
    ld (TO_GT),bc               ; TO_GT = C, TO_GS = B
    ld c,b
    push hl
    push de
.p1:
    ld a,(de)
    ld b,a
    xor (hl)
    ld (hl),b
    inc e
    inc l
    add a,255
    rr c
    jr nc,.p1
    ld a,c
    ld (TO_M1),a
    ld (TO_P),hl
    ld (TO_S),de
    pop de
    pop hl
    inc h
    inc h
    inc h
    push hl
    ld hl,(TO_SOFF)
    add hl,de
    ex de,hl                    ; DE = the source attribute pointer
    pop hl
    ld a,(TO_GS)
    ld c,a
.p2:
    ld a,(de)
    ld b,a
    xor (hl)
    ld (hl),b
    inc e
    inc l
    add a,255
    rr c
    jr nc,.p2
    ld de,(TO_S)
    jp mask_done

g_load:                         ; source cell bytes at DE (anywhere: INC DE), attributes from TILE_ATTR (tile cells) or BG_ATTR (font cells)
    ld (TO_GT),bc               ; TO_GT = C, TO_GS = B
    ld c,b
    push hl
.p1:
    ld a,(de)
    inc de
    ld b,a
    xor (hl)
    ld (hl),b
    inc l
    add a,255
    rr c
    jr nc,.p1
    ld a,c
    ld (TO_M1),a
    ld (TO_P),hl
    ld (TO_S),de
    pop hl                      ; the group's first cell: its new byte is in the map; the attribute follows from it
    ld a,(TO_GS)
    ld c,a
    ld d,TILE_ATTR>>8
.p2:
    ld a,(hl)
    ld e,a
    add a,a                     ; carry = bit 7: a game tile
    ld a,BG_ATTR                ; (LD keeps the carry)
    jr nc,.have
    res 7,e
    ld a,(de)                   ; TILE_ATTR[tile]
.have:
    ld e,a                      ; E = the new attribute
    inc h
    inc h
    inc h
    xor (hl)
    ld (hl),e
    dec h
    dec h
    dec h
    inc l
    add a,255
    rr c
    jr nc,.p2
    ld de,(TO_S)
    ; (falls into mask_done)

; mask_done: the end of every group function.  C = the attribute pass's mask register, TO_M1 = the cell pass's: their OR as the sentinel loop
; leaves it (right-justified: the first cell at bit 8 - cells), aligned to the cells' columns (shifted right by TO_GT), is the group's dirty mask:
; it is ORed into the dirty byte HL' of both files and HL' steps to the next byte (WALK_ROW's pointer); HL = TO_P.  DE as the caller set it.
; Clobbers AF, BC, C'.
mask_done:
    ld a,(TO_M1)
    or c
    jr z,.out                   ; nothing changed
    ld c,a
    ld a,(TO_GT)
    ld b,a
    or a
    ld a,c
    jr z,.out                   ; no shift
.sh:
    srl a
    djnz .sh
.out:
    exx                         ; A = the mask: mark the group's changed cells
    or a
    jr z,.z
    ld c,a
    or (hl)
    ld (hl),a
    inc h                       ; DIRTY1
    ld a,c
    or (hl)
    ld (hl),a
    dec h
.z: inc l
    exx
    ld hl,(TO_P)
    ret

; ---------------------------------------------------------------------------------------------------------------
; Unrolled slots: one cell of a whole-byte group (8 cells, the first at column 0, 8, 16 or 24).  Each compares the cell byte with the new one, writes
; it, and sets bit k of the mask register when it differed (JR Z skips the SET), so a slot costs 34..37 T (FILL), 41..44 T (COPY), 43..46 T (LOADMAP tile).
; ---------------------------------------------------------------------------------------------------------------
    MACRO SLOT_FILL k, mreg     ; HL -> cell byte, D / E = the new value (the macro's `vreg` is fixed to D: FILL_T) 
        ld a,(hl)
        cp d
        ld (hl),d
        jr z,$+4
        set k,mreg
        inc l
    ENDM
    MACRO SLOT_FILLA k, mreg    ; the attribute pass: the new value is in E
        ld a,(hl)
        cp e
        ld (hl),e
        jr z,$+4
        set k,mreg
        inc l
    ENDM
    MACRO SLOT_COPY k, mreg     ; HL -> destination, DE -> source (same plane layout)
        ld a,(de)
        cp (hl)
        ld (hl),a
        jr z,$+4
        set k,mreg
        inc e
        inc l
    ENDM
    MACRO SLOT_LOAD k, mreg     ; the source is anywhere: INC DE
        ld a,(de)
        inc de
        cp (hl)
        ld (hl),a
        jr z,$+4
        set k,mreg
        inc l
    ENDM
    MACRO SLOT_LATTR k, mreg    ; HL -> a cell byte in the (new) cell plane; D = TILE_ATTR page: the attribute of that cell, compared with CELL_ATTR (+$300)
        ld a,(hl)
        ld e,a
        add a,a                 ; carry = bit 7: a game tile
        ld a,BG_ATTR            ; (LD keeps the carry)
        jr nc,2F
        res 7,e
        ld a,(de)
2:      ld e,a
        inc h
        inc h
        inc h
        cp (hl)
        ld (hl),e
        jr z,3F
        set k,mreg
3:      dec h
        dec h
        dec h
        inc l
    ENDM
    MACRO EIGHT slot, mreg
        slot 0, mreg
        slot 1, mreg
        slot 2, mreg
        slot 3, mreg
        slot 4, mreg
        slot 5, mreg
        slot 6, mreg
        slot 7, mreg
    ENDM

; ---------------------------------------------------------------------------------------------------------------
; walk_setup (once per operation): TO_NX = cells per row (>= 1), TO_X0 = column of the first cell (it loads them into B and C).  Cuts every row of the operation the same way and stores the
; plan: a head group up to the next multiple of 8 (TO_HN cells, 0 = none; TO_HSC = sentinel << 8 | shift for the group function), F whole bytes (TO_F)
; and a tail (TO_TN cells, TO_TSC).  Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
walk_setup:
    ld a,(TO_NX)
    ld b,a
    ld a,(TO_X0)
    ld c,a
    xor a
    ld (TO_HN),a
    ld a,c
    and 7
    jr z,.f                     ; the rows start on a byte boundary: no head
    ld d,a
    ld a,8
    sub d
    ld e,a                      ; E = cells up to the next multiple of 8 (1..7)
    ld a,b
    cp e
    jr c,.short
    ld a,e                      ; the row reaches the boundary: the head is E cells, no shift
    ld (TO_HN),a
    call walk_sent
    ld h,a
    ld l,0
    ld (TO_HSC),hl
    ld a,b
    sub e
    ld b,a                      ; B = cells left after the head
    jr .f
.short:                         ; the row ends inside this byte: the head is the whole row, shifted by E - B
    ld a,b
    ld (TO_HN),a
    call walk_sent
    ld h,a
    ld a,e
    sub b
    ld l,a
    ld (TO_HSC),hl
    ld b,0
.f:
    ld a,b
    rrca
    rrca
    rrca
    and $1F
    ld (TO_F),a
    ld a,b
    and 7
    ld (TO_TN),a
    ret z
    ld d,a
    call walk_sent
    ld h,a
    ld a,8
    sub d
    ld l,a                      ; shift = 8 - tail cells
    ld (TO_TSC),hl
    ret
; (walk_sent, A = cells (1..8) -> A = 1 << (cells - 1), is in boot.asm, in the gap after the header.)

; (The marking of a group, its mask ORed into the dirty byte HL' of both files and HL' stepped on, is the end of mask_done: every group function
; call is followed by it.)

; ---------------------------------------------------------------------------------------------------------------
; row_at: B = row, C = column -> HL = the cell's CELL_TILE address and HL' = its byte of DIRTY0 (cell index >> 3): what WALK_ROW starts from.
; Clobbers AF, BC.  (rowcol_idx's instructions inline, then the pointers.)
row_at:
    ld a,b
    rrca
    rrca
    rrca
    ld b,a
    and $E0
    or c
    ld c,a                      ; C = the low byte of row * 32 + column
    ld a,b
    and $1F                     ; A = its high byte
    add a,CELL_TILE>>8
    ld h,a
    ld l,c                      ; HL = the cell
    ld a,l
    rrca
    rrca
    rrca
    and $1F
    ld b,a                      ; L >> 3
    ld a,h
    sub CELL_TILE>>8
    rrca
    rrca
    rrca                        ; (H - $CE) << 5
    or b
    exx
    ld l,a
    ld h,DIRTY0>>8              ; HL' = the dirty byte of the first cell (cell index >> 3)
    exx
    ret

; WALK_ROW: in HL = destination cell pointer of the row's first cell, HL' = its dirty byte (row_at), DE = source pointer (the plan of walk_setup).  Runs the head group, the whole
; bytes (kind-specific unrolled loop) and the tail group, ORing each group's mask into DIRTY0 and DIRTY1.  The dirty byte pointer lives in HL' and the
; count of whole bytes in B' (the alternate set: SAVE_ALT).  kind: 0 FILL, 1 COPY, 2 LOADMAP.  Clobbers everything.
; ---------------------------------------------------------------------------------------------------------------
    MACRO WALK_ROW group, kind
        ld a,(TO_HN)
        or a
        jr z,.nh
        ld bc,(TO_HSC)
        call group              ; (it marks the group's cells dirty: mask_done)
.nh:    ld a,(TO_F)
        or a
        jp z,.nf
        exx
        ld b,a                  ; B' = whole bytes left
        exx
        IF kind == 0
        ld de,(TO_A)            ; D = the cell byte, E = the attribute
        ENDIF
.fl:
        ld bc,0                 ; C = the mask of the cell bytes, B = the mask of the attributes
        IF kind == 0
        EIGHT SLOT_FILL, c
        ld a,l
        sub 8
        ld l,a
        inc h
        inc h
        inc h
        EIGHT SLOT_FILLA, b
        dec h
        dec h
        dec h
        ELSEIF kind == 1
        EIGHT SLOT_COPY, c
        push de
        ld a,l
        sub 8
        ld l,a
        inc h
        inc h
        inc h
        ld a,e
        sub 8
        ld e,a                  ; (mod 256: correct even when the eight INC E wrapped)
        ld a,(TO_SOFF)
        add a,e
        ld e,a
        ld a,(TO_SOFF+1)
        adc a,d
        ld d,a                  ; DE = the source attribute pointer of this group
        EIGHT SLOT_COPY, b
        dec h
        dec h
        dec h
        pop de
        ELSE
        EIGHT SLOT_LOAD, c
        push de
        ld a,l
        sub 8
        ld l,a
        ld d,TILE_ATTR>>8
        EIGHT SLOT_LATTR, b
        pop de
        ENDIF
        ld a,b
        or c
        exx
        jr z,.fz
        ld c,a
        or (hl)
        ld (hl),a
        inc h                   ; DIRTY1
        ld a,c
        or (hl)
        ld (hl),a
        dec h
.fz:    inc l
        dec b
        exx
        jp nz,.fl
.nf:    ld a,(TO_TN)
        or a
        jr z,.wend
        ld bc,(TO_TSC)
        call group              ; (it marks the group's cells dirty: mask_done)
.wend:
    ENDM

; SAVE_ALT / LOAD_ALT: the whole-byte loops use the alternate set (BC' = groups left, HL' = dirty byte), which belongs to the caller: it is pushed on the
; stack for the length of the operation (6 bytes of stack, 80 T in all) and put back.
    MACRO SAVE_ALT
        exx
        push hl
        push de
        push bc
        exx
    ENDM
    MACRO LOAD_ALT
        exx
        pop bc
        pop de
        pop hl
        exx
    ENDM

; ---------------------------------------------------------------------------------------------------------------
; RT_FILL / RT_FILLC: RA_X, RA_Y, RA_W, RA_H (signed words) and RA_V (tile / character code) in RT_ARGS.  The clipped rectangle becomes cell byte
; TO_V (128 + tile / the code AND $7F) with attribute TO_A (TILE_ATTR[tile] / V_TEXT_ATTR).  Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
RT_FILL:
    ld a,(RA_V)
    and $7F
    ld l,a
    ld h,TILE_ATTR>>8           ; TILE_ATTR is page aligned
    ld a,(hl)
    ld (TO_A),a
    ld a,l
    or $80
    ld (TO_V),a
    jr fill_go
RT_FILLC:
    ld a,(RA_V)
    and $7F
    ld (TO_V),a
    ld a,(V_TEXT_ATTR)
    ld (TO_A),a
fill_go:
    ld hl,(RA_X)
    ld de,(RA_W)
    ld c,CELL_COLS
    call clip_axis
    ret c
    ld (TO_X0),a
    ld a,b
    ld (TO_NX),a
    ld hl,(RA_Y)
    ld de,(RA_H)
    ld c,CELL_ROWS
    call clip_axis
    ret c
    ld (TO_Y0),a
    ld a,b
    ld (TO_NY),a
    call walk_setup
    SAVE_ALT
.row:
    ld bc,(TO_X0)               ; B = TO_Y0, C = TO_X0
    call row_at                 ; HL = the row's first cell, HL' = its dirty byte
    WALK_ROW g_fill, 0
    ld hl,TO_Y0
    inc (hl)
    inc hl                      ; TO_NY
    dec (hl)
    jp nz,.row
    LOAD_ALT
    ret

; ---------------------------------------------------------------------------------------------------------------
; delta_axis: HL = destination - source position (from SBC), C = limit -> carry clear: A = the difference as a signed byte, |difference| < limit;
; carry set: the rectangles cannot overlap on this axis.  Clobbers AF.
; adjust_axis: E = first index of the clipped source range, B = its count, D = difference (signed byte), C = limit -> A = first index, B = count of the
; part whose destination (index + difference) is also inside [0, limit); carry set = none.  Clobbers AF, DE.
; ---------------------------------------------------------------------------------------------------------------
; (delta_axis is in boot.asm, in the gap after the header.)
adjust_axis:
    bit 7,d
    jr nz,.neg
    ld a,c
    sub d
    sub e                       ; room = limit - difference - first
    jr c,.empty
    jr z,.empty
    cp b
    jr nc,.keep
    ld b,a
.keep:
    ld a,e
    or a
    ret
.neg:
    xor a
    sub d                       ; -difference: the first source index whose destination is on screen
    cp e
    jr c,.keepn
    jr z,.keepn
    sub e
    ld d,a                      ; D = cells cut off the front
    ld a,b
    sub d
    jr c,.empty
    jr z,.empty
    ld b,a
    ld a,e
    add a,d
    or a
    ret
.keepn:
    ld a,e
    or a
    ret
.empty:
    scf
    ret

; ---------------------------------------------------------------------------------------------------------------
; RT_COPY: RA_X, RA_Y, RA_W, RA_H (source), RA_DX, RA_DY (destination).  See the header: memmove semantics, both rectangles clipped.  Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
RT_COPY:
    ld hl,(RA_DX)
    ld de,(RA_X)
    or a
    sbc hl,de
    ret pe                      ; |difference| > 32767: no overlap
    ld c,CELL_COLS
    call delta_axis
    ret c
    ld (TO_DXS),a
    ld hl,(RA_X)
    ld de,(RA_W)
    ld c,CELL_COLS
    call clip_axis
    ret c
    ld e,a
    ld a,(TO_DXS)
    ld d,a
    call adjust_axis
    ret c
    ld (TO_SX0),a
    ld e,a
    ld a,(TO_DXS)
    add a,e
    ld (TO_X0),a                ; destination column of the first cell
    ld a,b
    ld (TO_NX),a
    ld hl,(RA_DY)
    ld de,(RA_Y)
    or a
    sbc hl,de
    ret pe
    ld c,CELL_ROWS
    call delta_axis
    ret c
    ld (TO_DYS),a
    ld hl,(RA_Y)
    ld de,(RA_H)
    ld c,CELL_ROWS
    call clip_axis
    ret c
    ld e,a
    ld a,(TO_DYS)
    ld d,a
    call adjust_axis
    ret c
    ld (TO_SYC),a               ; first source row
    ld a,b
    ld (TO_NY),a
    ld hl,TO_DXS
    ld a,(hl)
    inc hl                      ; TO_DYS
    or (hl)
    ret z                       ; copy onto itself
    ld hl,$0300
    ld (TO_SOFF),hl
    ld a,(TO_DYS)
    or a
    jr z,.same                  ; same rows: through the row buffer
    bit 7,a
    jr z,.down
    ld a,1                      ; the rectangle moves up: top to bottom
    ld (TO_RSTEP),a
    jr .go
.down:                          ; moves down: bottom to top, starting at the last row
    ld a,$FF
    ld (TO_RSTEP),a
    ld a,(TO_NY)
    ld b,a
    ld a,(TO_SYC)
    add a,b
    dec a
    ld (TO_SYC),a
    jr .go
.same:
    ld a,1
    ld (TO_RSTEP),a
    ld hl,TO_BUFA-TO_BUFT
    ld (TO_SOFF),hl
.go:
    call walk_setup
    SAVE_ALT
.row:
    ld bc,(TO_SX0)              ; B = TO_SYC (the next byte), C = TO_SX0
    call rowcol_idx
    ld a,b
    add a,CELL_TILE>>8
    ld d,a
    ld e,c                      ; DE = the source cell pointer
    ld a,(TO_DYS)
    or a
    jr nz,.direct
    ex de,hl                    ; same rows: copy the source row to the buffer first (LDIR: the destination does not overlap it)
    ld a,(TO_NX)
    ld c,a
    ld b,0
    ld de,TO_BUFT
    push hl
    push bc
    ldir
    pop bc
    pop hl
    inc h
    inc h
    inc h
    ld de,TO_BUFA
    ldir
    ld de,TO_BUFT
.direct:
    ld a,(TO_SYC)
    ld b,a
    ld a,(TO_DYS)
    add a,b
    ld b,a                      ; destination row
    ld a,(TO_X0)
    ld c,a
    call row_at
    WALK_ROW g_copy, 1
    ld hl,TO_RSTEP
    ld a,(hl)
    dec hl                      ; TO_SYC
    add a,(hl)
    ld (hl),a
    ld hl,TO_NY
    dec (hl)
    jp nz,.row
    LOAD_ALT
    ret

; ---------------------------------------------------------------------------------------------------------------
; RT_LOADMAP: A = map index -> the map at cell (0, 0).  RT_LOADMAPAT: A = map index, BC = x, DE = y (signed).  An index >= the map count, no table,
; or a zero pointer in the table: nothing.  RT_LOADMAPPTR: HL = address of a map record (DB w, DB h, w*h cell bytes; mapped $8000-$BFFF or banked
; $4000-$7FFF, read through the bank window), BC = x, DE = y.
; The map is cut to the screen on all four sides; cells outside it are untouched.  Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
RT_LOADMAP:
    ld bc,0
    ld de,0
RT_LOADMAPAT:
    ld hl,V_NMAP
    cp (hl)
    ret nc
    add a,a
    ld hl,(V_MAPTAB)
    add a,l
    ld l,a
    jr nc,.lo
    inc h
.lo:
    push de
    ld e,(hl)
    inc hl
    ld d,(hl)
    ex de,hl
    pop de
    ld a,h
    or l
    ret z
RT_LOADMAPPTR:
    ld a,h                      ; banking (docs/ARCADE_BANKING_CONTRACT.md section 3): a map record in $4000-$7FFF is read in place with the
    sub BANK_LO                 ; bank window mapped (DOCK chunks 2-3 over the display files), which only loadmap_core's source reads touch
    cp BANK_HI-BANK_LO
    jp nc,loadmap_core          ; a mapped map ($8000-$BFFF, or anything else): exactly as before
    call bank_on
    call loadmap_core
bank_off:                       ; unmap the window: $F4 = F4_PLAY.  bank_on / bank_off clobber A only; only these two (and the boot) write $F4
    ld a,F4_PLAY
    jr bank_set
bank_on:                        ; map the window: $F4 = F4_BANK (DOCK chunks 0-5; chunks 2-3 now read the cartridge, the display files vanish)
    ld a,F4_BANK
bank_set:
    ld (V_SHADOW_F4),a          ; the shadow first, then the port (the shadow is never read back from the port)
    out (PORT_HSR),a
    ret
loadmap_core:
    ld a,(hl)
    or a
    ret z                       ; width 0
    ld (TO_MW),a
    inc hl
    ld a,(hl)
    or a
    ret z                       ; height 0
    ld (TO_MH),a
    inc hl
    ld (TO_MP),hl
    ld (TO_PX),bc
    ld (TO_PY),de
    ld hl,(TO_PX)
    ld a,(TO_MW)
    ld e,a
    ld d,0
    ld c,CELL_COLS
    call clip_axis
    ret c
    ld (TO_X0),a
    ld a,b
    ld (TO_NX),a
    ld hl,(TO_PX)
    xor a
    bit 7,h
    jr z,.sx
    sub l                       ; x < 0: the map's first -x columns are cut off (x > -width here, so -x is one byte)
.sx:
    ld (TO_SCX),a
    ld hl,(TO_PY)
    ld a,(TO_MH)
    ld e,a
    ld d,0
    ld c,CELL_ROWS
    call clip_axis
    ret c
    ld (TO_Y0),a
    ld a,b
    ld (TO_NY),a
    ld hl,(TO_PY)
    xor a
    bit 7,h
    jr z,.sy
    sub l
.sy:
    ld (TO_SCY),a
    ld a,(TO_MW)                ; source pointer = cells + SCY * width + SCX
    ld e,a
    ld d,0
    ld a,(TO_SCY)
    ld hl,0
    ld b,8
.mul:
    add hl,hl
    rlca
    jr nc,.mn
    add hl,de
.mn:
    djnz .mul
    ld a,(TO_SCX)
    ld e,a
    ld d,0
    add hl,de
    ld de,(TO_MP)
    add hl,de
    ld (TO_SROW),hl
    call walk_setup
    SAVE_ALT
.row:
    ld bc,(TO_X0)               ; B = TO_Y0, C = TO_X0
    call row_at
    ld de,(TO_SROW)
    WALK_ROW g_load, 2
    ld hl,(TO_SROW)
    ld a,(TO_MW)
    ld e,a
    ld d,0
    add hl,de
    ld (TO_SROW),hl
    ld hl,TO_Y0
    inc (hl)
    inc hl                      ; TO_NY
    dec (hl)
    jp nz,.row
    LOAD_ALT
    ret

; ---------------------------------------------------------------------------------------------------------------
; maps_boot (boot only, from cells_init): reads the map table of an extended header (frame_div bit 7), sets V_NMAP / V_MAPTAB and, when the table has a
; map 0, loads it at (0, 0) as LOADMAP would.  Carry set = map 0 was loaded (the boot then skips the old map_ptr).  Clobbers everything.
; ---------------------------------------------------------------------------------------------------------------
maps_boot:
    ld a,(GAME_DIV)
    bit 7,a
    jr z,.none
    ld hl,(GAME_MAPTAB)
    ld a,h
    or l
    jr z,.none
    ld a,(hl)
    inc hl
    cp MAX_MAPS+1
    jr c,.cnt
    ld a,MAX_MAPS
.cnt:
    ld (V_NMAP),a
    ld (V_MAPTAB),hl
    or a
    jr z,.none
    ld e,(hl)
    inc hl
    ld d,(hl)
    ld a,d
    or e
    jr z,.none
    ex de,hl
    ld bc,0
    ld de,0
    call RT_LOADMAPPTR          ; (a map-table entry may point into the bank window)
    scf
    ret
.none:
    or a
    ret
; RT_TABLELOAD (docs/ARCADE_TABLES_CONTRACT.md section 4): HL = a table record, DB runs (1..255), then per run DW dst, DW len, len bytes (len even, >= 2; dst / len inside
; the game's variable block, chunk 7: the compiler's guarantee, not checked here).  Each run is LDIRed to its dst.  A record in $4000-$7FFF (H = BANK_LO..BANK_HI-1) is read in place
; with the bank window mapped for the WHOLE record (bank_on first, bank_off last; banking contract rules 1-5: interrupts stay enabled, nothing but the record is read from the window,
; writes go to chunk 7 only); a record anywhere else is read where it is.  The run count stays in A (LD, INC and LDIR leave it alone; no EX AF,AF' / EXX, no IX / IY).  Clobbers AF, BC, DE, HL.
; A run count of 0 returns at once (it would be 256 runs).
RT_TABLELOAD:
    ld a,h
    sub BANK_LO
    cp BANK_HI-BANK_LO
    jr nc,tabload_run           ; a mapped record ($8000-$BFFF, or anything else): read where it is
    call bank_on
    call tabload_run
    jp bank_off
tabload_run:
    ld a,(hl)
    inc hl
    or a
    ret z
tabload_one:
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl                      ; DE = dst
    ld c,(hl)
    inc hl
    ld b,(hl)
    inc hl                      ; BC = len
    ldir                        ; HL = the next run (the source is read in place, the destination is in chunk 7)
    dec a                       ; nothing in the loop touches A: the run count stays there
    jr nz,tabload_one
    ret
M_TILEOPS_E:
