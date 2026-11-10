; video.asm -- display files, row table, pre-shifted sprite tables, masked blit and rectangle erase.
; From arcade/runtime/video.asm (M1): the blitters are the same; the tables are built for up to MAX_SPRITES sprites
; from the game image's header, and the blitters take the row count in B (sprites are 1..16 rows high).
; Lives in DOCK chunks 0-1 ($0200..).  Everything here is called with the play mapping ($F4 = $33), after boot.
;
; Banking notes: the display files ($4000-$7AFF) and the tables ($C000+) are RAM chunks 2, 3 and 6 and are never
; mapped from the DOCK, so every routine may write them directly.  The sprite source is read in place from the game
; image in DOCK chunks 4-5 ($8000+), which is mapped for the whole run.
;
; Pixel format after pre-shifting (see layout.inc): per row  m0 i0 m1 i1 m2 i2 : three screen bytes, each a
; (mask, image) pair, mask 1 = keep the background, image 1 = ink.  Phase p is the 16-bit sprite shifted right by p
; pixels inside a 24-bit window (mask fills with 1s, image with 0s).  Rows below the sprite's height are transparent.
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
    jp build_all_phases

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

; build_all_phases: read sprite_count and the descriptors from the game header; for each sprite store its height in
; SPR_HGT and build its 8 phase tables at PHASE_TAB + i * PHASE_SPR_LEN.  A count above MAX_SPRITES is clamped, a
; height of 0 is read as 1 and above 16 as 16.  V_SPRN = the clamped count.  Boot only (uses IX, IY).
build_all_phases:
    ld a,(GAME_NSPR)
    cp MAX_SPRITES+1
    jr c,.cok
    ld a,MAX_SPRITES
.cok:
    ld (V_SPRN),a
    xor a
    ld (V_I),a
.next:
    ld a,(V_SPRN)
    ld hl,V_I
    cp (hl)
    ret z                       ; i = count: done
    ld a,(hl)                   ; i
    ld e,a
    add a,a
    add a,e
    add a,a                     ; i * SD_LEN (6)
    ld e,a
    ld d,0
    ld hl,(GAME_SPRTAB)
    add hl,de                   ; HL = descriptor i
    push hl
    pop ix                      ; IX+1 = height, IX+2 / IX+3 = data pointer
    ld a,(ix+1)
    or a
    jr nz,.h1
    inc a                       ; height 0 -> 1
.h1:
    cp SPR_H+1
    jr c,.h2
    ld a,SPR_H                  ; height above 16 -> 16
.h2:
    ld (V_H),a
    ld a,(V_I)
    ld e,a
    ld d,0
    ld hl,SPR_HGT
    add hl,de
    ld a,(V_H)
    ld (hl),a                   ; SPR_HGT[i]
    ld l,(ix+2)
    ld h,(ix+3)
    push hl
    pop ix                      ; IX = the sprite's pixel data
    ld a,(V_I)
    ld e,a
    add a,a
    add a,e                     ; 3 * i
    add a,PHASE_TAB>>8          ; PHASE_TAB is page aligned and PHASE_SPR_LEN = 3 pages
    ld h,a
    ld l,0                      ; HL = phase 0 of sprite i
    call build_one
    ld hl,V_I
    inc (hl)
    jr .next

; build_one: IX = sprite data (V_H rows of mask_hi mask_lo image_hi image_lo), HL = destination of phase 0.
; Builds phase 0 (padded to 16 rows with transparent ones), then phases 1..7 each one pixel right of the previous.
build_one:
    ld a,(V_H)
    ld b,a
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
    ld a,(V_H)
    ld c,a
    ld a,PHASE_ROWS
    sub c
    jr z,.shift
    ld b,a
.pad:                           ; the rows below the sprite: mask all ones, no ink
    ld (hl),$FF
    inc hl
    ld (hl),0
    inc hl
    ld (hl),$FF
    inc hl
    ld (hl),0
    inc hl
    ld (hl),$FF
    inc hl
    ld (hl),0
    inc hl
    djnz .pad
.shift:
    push hl
    pop iy                      ; destination = phase 1 (directly after phase 0)
    ld de,-PHASE_LEN
    add hl,de
    push hl
    pop ix                      ; source = phase 0; later each phase is the source of the next (contiguous)
    ld b,(PHASE_COUNT-1)*PHASE_ROWS
.shl:
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
    djnz .shl
    ret

; ---------------------------------------------------------------------------------------------------------------
; video_screen_addr: B = x (pixels), C = y (pixels), A = display file (0 or 1)
;   -> DE = address of the byte holding pixel column x&~7 of row y in that file.   Clobbers AF, HL.  BC kept.
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
; video_phase_ptr: A = x (pixels), V_I = sprite index -> HL = PHASE_TAB + i * PHASE_SPR_LEN + (x AND 7) * PHASE_LEN.
; Clobbers AF, C (DE and B kept).  (96 p = 32 * 3p: with q = 3p, the rotate-right-by-3 of q is (q >> 3) | ((q AND 7) << 5), whose
; two parts are the high and low byte of q * 32.)
; ---------------------------------------------------------------------------------------------------------------
video_phase_ptr:
    and 7
    ld c,a
    add a,a
    add a,c                     ; 3p, at most 21
    rrca
    rrca
    rrca                        ; (3p >> 3) in bits 0-1, (3p AND 7) << 5 in bits 5-7
    ld c,a
    and $E0
    ld l,a                      ; low byte of 96 p
    ld a,c
    and $1F
    ld h,a                      ; high byte of 96 p
    ld a,(V_I)
    ld c,a
    add a,a
    add a,c                     ; 3 i = i * PHASE_SPR_LEN / 256
    add a,PHASE_TAB>>8
    add a,h
    ld h,a
    ret

; ---------------------------------------------------------------------------------------------------------------
; sprite_draw: masked blit.  DE = screen address of the left byte (video_screen_addr), HL = phase table
; (video_phase_ptr), B = rows (1..16).  For each row and 3 bytes:  screen = (screen AND mask) OR image.
; Clobbers AF, B, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
sprite_draw:
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
; sprite_erase: DE = screen address of the left byte, B = rows (1..16).  Restores the background in the 3-byte-wide
; rectangle that the sprite may cover.  The background is the checkerboard of fill_file, so it is recomputed from
; the row parity.  Clobbers AF, B, DE.
; ---------------------------------------------------------------------------------------------------------------
sprite_erase:
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
