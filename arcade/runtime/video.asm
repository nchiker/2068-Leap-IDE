; video.asm -- display files, row table, pre-shifted sprite tables, masked blit and rectangle erase.
; Lives in DOCK chunks 0-1 ($0200..).  Everything here is called with the play mapping ($F4 = $33), after boot.
;
; Banking notes: the display files ($4000-$7AFF) and the tables ($C000+) are RAM chunks 2, 3 and 6 and are never
; mapped from the DOCK in M1, so every routine may write them directly.  The sprite source (SPRITE) is read in place
; from DOCK chunk 4 ($8000+), which is mapped for the whole run.
;
; Sprite pixel format after pre-shifting (PHASE_TAB, 8 phases x 16 rows x 6 bytes): per row  m0 i0 m1 i1 m2 i2 :
; three screen bytes, each a (mask, image) pair, mask 1 = keep the background, image 1 = ink.
; Phase p is the 16-bit sprite shifted right by p pixels inside a 24-bit window (mask fills with 1s, image with 0s).
    ORG RT_VIDEO
M_VIDEO_S:

; ---------------------------------------------------------------------------------------------------------------
; video_init: clear both display files (checkerboard background), set the attributes, build the tables.
; Clobbers everything.
; ---------------------------------------------------------------------------------------------------------------
video_init:
    ld hl,DFILE0
    call fill_file
    ld hl,DFILE1
    call fill_file
    ld hl,DATTR0                ; attributes of file 1: one value for all 768 cells
    ld de,DATTR0+1
    ld bc,DATTR_LEN-1
    ld (hl),BG_ATTR
    ldir
    ld hl,DATTR1                ; attributes of file 2
    ld de,DATTR1+1
    ld bc,DATTR_LEN-1
    ld (hl),BG_ATTR
    ldir
    call build_row_table
    jp build_phases

; fill_file: HL = display file base.  Fills 24 pages of 256 bytes; the background byte of a page is $AA when the
; page's high address byte is even and $55 when odd, i.e. $AA on even pixel rows and $55 on odd ones (a pixel row's
; high byte has y bit 0 in its bit 0).  The sprite erase uses the same rule.
fill_file:
    ld c,DFILE_LEN/256          ; 24 pages
.page:
    ld a,h
    rrca                        ; carry = bit 0 of H
    sbc a,a                     ; $FF if odd page, $00 if even
    xor BG_EVEN                 ; odd -> $55, even -> $AA
    ld b,0                      ; 256 bytes
.byte:
    ld (hl),a
    inc hl
    djnz .byte
    dec c
    jr nz,.page
    ret

; build_row_table: ROW_TAB[y] = address of the first byte of pixel row y in display file 1 (192 words).
; Walks the Spectrum-style screen layout with the usual "one row down" step.
build_row_table:
    ld hl,DFILE0
    ld ix,ROW_TAB
    ld b,192
.row:
    ld (ix+0),l
    ld (ix+1),h
    inc ix
    inc ix
    inc h                       ; next pixel row inside the character cell: H + 1
    ld a,h
    and 7
    jr nz,.next                 ; still inside the cell
    ld a,l                      ; next character row: L + 32
    add a,32
    ld l,a
    jr c,.next                  ; wrapped into the next third: H already points there
    ld a,h
    sub 8                       ; same third: undo the 8 added by the 8 pixel rows
    ld h,a
.next:
    djnz .row
    ret

; build_phases: PHASE_TAB phase 0 from SPRITE, phases 1..7 each one pixel to the right of the previous.
build_phases:
    ld ix,SPRITE                ; source rows: mask_hi mask_lo image_hi image_lo
    ld hl,PHASE_TAB
    ld b,PHASE_ROWS
.p0:
    ld a,(ix+0)
    ld (hl),a                   ; m0 = mask high byte
    inc hl
    ld a,(ix+2)
    ld (hl),a                   ; i0 = image high byte
    inc hl
    ld a,(ix+1)
    ld (hl),a                   ; m1 = mask low byte
    inc hl
    ld a,(ix+3)
    ld (hl),a                   ; i1 = image low byte
    inc hl
    ld (hl),$FF                 ; m2: the third byte is entirely background in phase 0
    inc hl
    ld (hl),0                   ; i2: and has no ink
    inc hl
    ld de,4
    add ix,de
    djnz .p0

    ld ix,PHASE_TAB             ; source = previous phase
    ld iy,PHASE_TAB+PHASE_LEN   ; destination = next phase (contiguous, so one loop covers phases 1..7)
    ld b,(PHASE_COUNT-1)*PHASE_ROWS
.shift:
    ld a,(ix+0)                 ; mask chain: shift the 24-bit mask right one bit, a 1 enters at the top
    scf
    rra
    ld (iy+0),a
    ld a,(ix+2)
    rra
    ld (iy+2),a
    ld a,(ix+4)
    rra
    ld (iy+4),a
    ld a,(ix+1)                 ; image chain: a 0 enters at the top (OR A clears carry)
    or a
    rra
    ld (iy+1),a
    ld a,(ix+3)
    rra
    ld (iy+3),a
    ld a,(ix+5)
    rra
    ld (iy+5),a
    ld de,PHASE_ROWLEN
    add ix,de
    add iy,de
    djnz .shift
    ret

; ---------------------------------------------------------------------------------------------------------------
; video_screen_addr: B = x (pixels), C = y (pixels), A = display file (0 or 1)
;   -> DE = address of the byte holding pixel column x&~7 of row y in that file.   Clobbers AF, HL.
; ---------------------------------------------------------------------------------------------------------------
video_screen_addr:
    push af                     ; file index survives the table lookup
    ld l,c
    ld h,0
    add hl,hl                   ; y * 2
    ld de,ROW_TAB
    add hl,de
    ld e,(hl)
    inc hl
    ld d,(hl)                   ; DE = row start in file 1
    ld a,b
    rrca
    rrca
    rrca
    and $1F                     ; x / 8 = byte column
    add a,e                     ; the row start has its low 5 bits clear, so no carry
    ld e,a
    pop af
    rrca
    rrca
    rrca                        ; file 1 -> $20, file 0 -> 0: file 2 is file 1 + $2000
    or d
    ld d,a
    ret

; ---------------------------------------------------------------------------------------------------------------
; video_phase_ptr: A = x (pixels) -> HL = PHASE_TAB + (x AND 7) * 96.   Clobbers AF, BC.
; ---------------------------------------------------------------------------------------------------------------
video_phase_ptr:
    and 7
    ld l,a
    ld h,0
    ld c,l
    ld b,h                      ; BC = p
    add hl,hl
    add hl,bc                   ; 3p
    add hl,hl
    add hl,hl
    add hl,hl
    add hl,hl
    add hl,hl                   ; 3p * 32 = 96p
    ld bc,PHASE_TAB
    add hl,bc
    ret

; ---------------------------------------------------------------------------------------------------------------
; sprite_draw: masked blit.  DE = screen address of the left byte (video_screen_addr), HL = phase table (video_phase_ptr).
; For each of the 16 rows and 3 bytes:  screen = (screen AND mask) OR image.   Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
sprite_draw:
    ld b,SPR_H
.row:
    ld a,(de)
    and (hl)                    ; keep the background where the mask is 1
    inc hl
    or (hl)                     ; add the sprite's ink
    inc hl
    ld (de),a
    inc e                       ; next byte in the row (the column is <= 29, so E never carries into D)
    ld a,(de)
    and (hl)
    inc hl
    or (hl)
    inc hl
    ld (de),a
    inc e
    ld a,(de)
    and (hl)
    inc hl
    or (hl)
    inc hl
    ld (de),a
    dec e                       ; back to the left byte
    dec e
    inc d                       ; one pixel row down (see build_row_table for the three cases)
    ld a,d
    and 7
    jr nz,.next
    ld a,e
    add a,32
    ld e,a
    jr c,.next
    ld a,d
    sub 8
    ld d,a
.next:
    djnz .row
    ret

; ---------------------------------------------------------------------------------------------------------------
; sprite_erase: DE = screen address of the left byte.  Restores the background in the 3 x 16 byte rectangle that the
; sprite may cover.  The background is the checkerboard of fill_file, so it is recomputed from the row parity.
; Clobbers AF, B, DE.
; ---------------------------------------------------------------------------------------------------------------
sprite_erase:
    ld b,SPR_H
.row:
    ld a,d
    rrca                        ; carry = bit 0 of D = y bit 0
    sbc a,a
    xor BG_EVEN                 ; $AA on even rows, $55 on odd rows
    ld (de),a
    inc e
    ld (de),a
    inc e
    ld (de),a
    dec e
    dec e
    inc d
    ld a,d
    and 7
    jr nz,.next
    ld a,e
    add a,32
    ld e,a
    jr c,.next
    ld a,d
    sub 8
    ld d,a
.next:
    djnz .row
    ret
M_VIDEO_E:
