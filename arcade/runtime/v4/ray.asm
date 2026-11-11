; ray.asm -- runtime v4: the raycaster.  docs/ARCADE_RAYCASTER_CONTRACT.md (binding: sections 1-5), docs/ARCADE_RUNTIME_API_V4.md "As built".
; Ported from the raycaster spike (arcade/spike/raycast: raycast.asm method B, sprite.asm), hand-maintained here; the bit-exact JS reference is
; arcade/tests/m8-common.mjs.  Lives in DOCK chunks 0-1 (no ORG: follows tileops.asm); the self-modifying parts (the row chain, the DDA loop) are
; assembled for RAY_RAM ($5B00) and copied there at scene start, the billboard row code is generated into RAY_BCODE per billboard.
;
; Ray mode (V_RAY = 1): frame_div has DIV_EXT | DIV_VIEW and view_desc passes ray_check.  The tick: frame_entry, ray_mask_dirty (the window's cells
; are never drawn from the cell map), redraw_dirty (HUD), ray_render (cast, walls, billboards, BB_TAB) into the hidden file, the flip request.
;
; Fixed point: positions 8.8 (cell = high byte), directions and the camera plane 4.12, distances along a ray 8.8; angle 0..255.
; Per ray: for each axis, v = |direction component|; v = 0: the axis never steps; else v is normalised (w = v << e in 2048..8191), R = RECIP[w >> 4]
; (= floor(65536 / idx)), the delta D = R << e (exact, may exceed 16 bits), the step delta min(D, 32767), the first side distance
; min(65535, floor(m D / 256)) with m = 256 - frac (positive direction, 1..256) or frac (negative, 0..255).  The step cap is harmless: an axis
; whose delta exceeds 32767 steps at most once before every possible hit (rays end inside the 32 x 32 array, t < 11,000).  Exact cell edges
; (frac 0) give m = 256 (positive) or 0 (negative).  DDA: x steps when sdx < sdy, else y; perp = sd - step delta of the axis that hit;
; half height HGT[min(perp >> 3, 1535)]; pattern ((type - 1) 2 + side) AND 7.
;
; Register rules: every RT_* routine here clobbers AF, BC, DE, HL only (IX, IY, the alternates kept), no DI.  ray_render saves IX, IY, AF' and
; the alternate set and restores them (compiled code may keep values there across ticks).
    ; (no ORG: follows tileops.asm)
M_RAY_S:

LBL0            EQU $88         ; the lower centre row (window row 48 = screen row 96), byte column 0 of the window: $4888
LBH0            EQU $48
UBL0            EQU $68         ; the upper centre row (screen row 95): $4F68
UBH0            EQU $4F
RST_E_OP        EQU $D7         ; RST $10
RST_O_OP        EQU $E7         ; RST $20
UNIT_E_OP       EQU $70         ; LD (HL),B: the first byte of an even unit
UNIT_O_OP       EQU $71         ; LD (HL),C: odd

; ===============================================================================================================
; Boot
; ===============================================================================================================
; ray_check (boot, before video_init; may use IX): V_RAY = 1 when frame_div has DIV_EXT and DIV_VIEW and view_desc is valid: the pointer
; in $8000-$BFFF, map_src in $8000-$BFFF or $4000-$7FFF (the bank window), colw 2 or 4, map_w and map_h 4..32, patterns 0 or in $8000-$BFFF.  Otherwise nothing is written (non-ray mode).
ray_check:
    ld a,(GAME_DIV)
    and DIV_EXT|DIV_VIEW
    cp DIV_EXT|DIV_VIEW
    ret nz
    ld hl,(GAME_VIEWDESC)
    ld de,VD_LEN-1
    call in_image
    ret nc                      ; view_desc (10 bytes) inside the game image
    push hl
    pop ix
    ld a,(ix+0)
    cp 2
    jr z,.cw
    cp 4
    ret nz                      ; colw 2 or 4
.cw:
    ld a,(ix+1)
    sub 4
    cp 32-4+1
    ret nc                      ; map_w 4..32
    ld a,(ix+2)
    sub 4
    cp 32-4+1
    ret nc                      ; map_h 4..32
    ld a,(ix+6)
    sub BANK_LO
    cp $80
    ret nc                      ; map_src: inside the game image ($8000-$BFFF) or the bank window ($4000-$7FFF, banking)
    ld a,(ix+7)
    or (ix+8)
    jr z,.pd                    ; patterns 0: the default
    ld l,(ix+7)
    ld h,(ix+8)
    ld de,15
    call in_image
    ret nc                      ; the 16 pattern bytes inside the game image
.pd:
    ld a,1
    ld (V_RAY),a
    ret

; in_image: carry set when HL .. HL + DE lie in $8000-$BFFF (DE < $4000).  Clobbers AF.
in_image:
    ld a,h
    sub $80
    cp $40
    ret nc
    push hl
    add hl,de
    ld a,h
    pop hl
    sub $80
    cp $40
    ret

; ray_assets (from assets.asm plan_pool in ray mode): no phase pool.  Per asset: AST_FTAB = the descriptor's data pointer (frame 0's rows),
; AST_CLEN = the bytes of one frame (h x 2 x wb).  Returns to build_assets' caller.
ray_assets:
    xor a
.a:
    ld hl,V_NAST
    cp (hl)
    ret nc
    ld c,a                      ; C = asset
    add a,a
    add a,a
    add a,a
    ld e,a
    ld d,0
    ld hl,(GAME_SPRTAB)
    add hl,de
    inc hl
    inc hl
    ld e,(hl)
    inc hl
    ld d,(hl)                   ; DE = data
    ld a,c
    add a,a
    add a,a
    add a,a
    add a,a
    add a,AST&$FF
    ld l,a
    ld h,AST>>8
    ld b,(hl)                   ; B = h (AST_H)
    inc l
    inc l                       ; AST_FTAB
    ld (hl),e
    inc l
    ld (hl),d
    inc l                       ; AST_WB
    ld a,(hl)
    push hl
    ld e,b
    ld d,0
    ld hl,0
.m:
    add hl,de
    add hl,de
    dec a
    jr nz,.m                    ; HL = 2 wb h
    ex de,hl
    pop hl
    ld a,l
    add a,AST_CLEN-AST_WB
    ld l,a
    ld (hl),e
    inc l
    ld (hl),d
    ld a,c
    inc a
    jr .a

; ray_boot (boot, after video_init; may use IX, IY): in ray mode the view variables, the map, the tables, the patterns, the RAM routines, the window's
; attributes in both display files and BB_TAB ("not drawn").
ray_boot:
    ld a,(V_RAY)
    or a
    ret z
    ld ix,(GAME_VIEWDESC)
    ld a,(ix+0)
    ld (VD_COLW),a
    ld hl,R_CM                  ; the column masks of the positions: colw 4: $F0, $0F; colw 2: $C0, $30, $0C, $03
    cp 4
    jr nz,.m2
    ld a,32                     ; (VD_NRAY, B = rays per byte)
    ld b,2
    ld (hl),$F0
    inc l
    ld (hl),$0F
    jr .m4
.m2:
    ld a,64
    ld b,4
    ld (hl),$C0
    inc l
    ld (hl),$30
    inc l
    ld (hl),$0C
    inc l
    ld (hl),$03
.m4:
    ld (VD_NRAY),a
    ld a,b
    ld (VD_RPB),a
    dec a
    ld (R_PMASK),a
    ld b,(ix+1)
    ld c,(ix+2)
    call ray_dims               ; map_w, map_h and their limits
    ld l,(ix+5)
    ld h,(ix+6)                 ; map_src (mapped or banked)
    call ray_map_load
    call ray_tables             ; (uses IX)
    ld ix,(GAME_VIEWDESC)
    call ray_pat
    ld hl,CHAIN_T               ; the row chain: 5 x (8 units + FIX) by repeating the pattern (LDIR with the destination 60 bytes ahead), then 8 units, RET
    ld de,CHAIN
    ld bc,CHAIN_PAT_LEN
    ldir
    ld hl,CHAIN
    ld bc,4*CHAIN_PAT_LEN
    ldir
    ld hl,CHAIN
    ld bc,5*8
    ldir
    ld a,$C9
    ld (de),a
    inc de                      ; DE = DDA
    ld hl,RAM_SRC
    ld bc,RAM_SRC_END-RAM_SRC
    ldir                        ; the DDA loop and the row tails
    call ray_attrs
    ld a,$FF
    ld (R_QUAD),a               ; the DDA loop is patched for no quadrant yet
    ld hl,RAY_MULXN+1           ; the six multiply buffers hold no routine yet (kind $FF)
    ld de,46
    ld b,6
.mb:
    ld (hl),a
    add hl,de
    djnz .mb
    ld hl,BB_TAB+2              ; nothing drawn yet: col = $FFFF (depth 0 from the boot's clear)
    ld b,MAX_SPRITES
.bb:
    ld (hl),a                   ; (A = $FF)
    inc l
    ld (hl),a
    inc l
    inc l
    inc l
    djnz .bb
    ret

; ray_dims: B = map_w, C = map_h -> VD_MAPW, VD_MAPH, VD_XMAX = map_w * 256 - 1, VD_YMAX = map_h * 256 - 1.  Clobbers AF, DE.
ray_dims:
    ld a,b
    ld (VD_MAPW),a
    dec a
    ld d,a
    ld e,$FF
    ld (VD_XMAX),de
    ld a,c
    ld (VD_MAPH),a
    dec a
    ld d,a
    ld (VD_YMAX),de
    ret

; ray_map_load: HL = a plan's byte-RLE stream, mapped ($8000-$BFFF) or banked ($4000-$7FFF) -> the array, as ray_map.  A banked stream is read with the
; bank window mapped (docs/ARCADE_BANKING_CONTRACT.md section 3: ray_map reads the stream and writes MAP_RAM / R_T0 in chunk 7, nothing else; interrupts
; stay on); the window is unmapped before the caller touches RAY_RAM or the display files.  Clobbers AF, BC, DE, HL.
ray_map_load:
    ld a,h
    sub BANK_LO
    cp BANK_HI-BANK_LO
    jr nc,ray_map               ; mapped: as before
    call bank_on
    call ray_map
    jp bank_off

; RT_PLANLOAD: HL = the new plan's RLE stream (mapped or banked), B = map_w, C = map_h (each 4..32, not checked: the compiler does) -> VD_MAPW / VD_MAPH /
; VD_XMAX / VD_YMAX set, the 32 x 32 array rebuilt as the boot does (all 1, the plan, the outer ring) and the pose (RV_X, RV_Y) clamped into the new map
; as RT_VIEW does (the angle stays); the next tick draws the new plan.  Ray mode only (V_RAY = 1): otherwise it returns at once.  Clobbers AF, BC, DE, HL.
RT_PLANLOAD:
    ld a,(V_RAY)
    or a
    ret z
    call ray_dims
    call ray_map_load
    ld hl,(RV_X)
    ld de,(VD_XMAX)
    call clamp_hl
    ld (RV_X),hl
    ld hl,(RV_Y)
    ld de,(VD_YMAX)
    call clamp_hl
    ld (RV_Y),hl
    ret

; ray_map: the 32 x 32 array = 1, then the byte-RLE map_src (pairs count 1..255, value; count 0 ends; values above 4 read as 4) into the game's
; map_w x map_h cells, row-major; the expansion stops after map_w x map_h cells (a short list leaves the rest 1).  Then every 0 on the outer
; ring of the array becomes 1 (only a 32-wide or 32-high map has its own ring there): a ray always stops inside the array.  HL = the stream, the
; dimensions are VD_MAPW / VD_MAPH (so it can be called again: RT_PLANLOAD).  Clobbers AF, BC, DE, HL; not IX.
ray_map:
    push hl                     ; the stream
    ld hl,MAP_RAM
    ld de,MAP_RAM+1
    ld bc,32*32-1
    ld (hl),1
    ldir
    pop hl
    ld de,MAP_RAM
    ld a,(VD_MAPH)
    ld (R_T0),a                 ; rows left
    ld a,(VD_MAPW)
    ld c,a                      ; C = map_w
    ld b,a                      ; B = cells left in the row
.pair:
    ld a,(hl)
    or a
    jr z,.ring                  ; count 0: the end
    ld (R_T0+1),a               ; count
    inc hl
    ld a,(hl)
    inc hl
    cp 5
    jr c,.v
    ld a,4
.v:
    ld (R_T0+2),a               ; value
.cell:
    ld a,(R_T0+2)
    ld (de),a
    inc de
    dec b
    jr nz,.same
    push hl                     ; the end of a map row: on to the next array row
    ld a,32
    sub c
    ld l,a
    ld h,0
    add hl,de
    ex de,hl
    pop hl
    ld b,c
    ld a,(R_T0)
    dec a
    ld (R_T0),a
    jr z,.ring                  ; map_w x map_h cells written
.same:
    ld a,(R_T0+1)
    dec a
    ld (R_T0+1),a
    jr nz,.cell
    jr .pair
.ring:
    ld de,1
    ld hl,MAP_RAM               ; row 0
    call .line
    ld hl,MAP_RAM+31*32         ; row 31
    call .line
    ld e,32
    ld hl,MAP_RAM               ; column 0
    call .line
    ld hl,MAP_RAM+31            ; column 31 (falls into the line)
.line:                          ; 32 cells from HL, step DE: a 0 becomes 1
    ld b,32
.l:
    ld a,(hl)
    cp 1
    adc a,0
    ld (hl),a
    add hl,de
    djnz .l
    ret

; ray_tables: RAY_COS (from QTAB through cos_q, the same routine RT_COSA uses), RAY_RECIP, RAY_HGT.
ray_tables:
    ld hl,RAY_COS
    xor a
.cos:
    push af
    push hl
    call cos_q                  ; HL = C[a]
    ex de,hl
    pop hl
    ld (hl),e
    inc hl
    ld (hl),d
    inc hl
    pop af
    inc a
    jr nz,.cos
    ; RECIP[n] = min(65535, floor(65536 / n)), n = 0..511: n = 0, 1 -> 65535; n = 2..127 by division; 128..511 by the incremental rule
    ld hl,65535
    ld (RAY_RECIP),hl
    ld (RAY_RECIP+2),hl
    ld ix,RAY_RECIP+4
    ld c,2                      ; n
.rd:
    ld de,0                     ; 65536 / n: the dividend is 1:0000 -> restoring division with a 17-bit dividend, quotient 16 bits; DE = quotient
    ld hl,1                     ; remainder = 1 (the dividend's bit 16)
    ld b,16
.rb:
    add hl,hl                   ; remainder * 2 + next bit (0)
    ex de,hl
    add hl,hl                   ; quotient * 2
    ex de,hl
    ld a,l
    sub c
    ld a,h
    sbc a,0
    jr c,.r0
    ld h,a                      ; remainder -= n
    ld a,l
    sub c
    ld l,a
    inc e                       ; quotient bit 1
.r0:
    djnz .rb
    ld (ix+0),e
    ld (ix+1),d
    inc ix
    inc ix
    inc c
    bit 7,c
    jr z,.rd                    ; n = 2..127
    ld hl,512                   ; n = 128: q = 512, rem = 0 (65536 = 512 * 128); then n + 1: rem -= q; while rem < 0: q -= 1, rem += n + 1
    ld de,0
    ld bc,128
    ld ix,RAY_RECIP+2*128
    ld iy,512
    call inc_div
    ; HGT[0..32] = 48; HGT[i] = floor(1536 / i) for i = 33..1535 (q = 48, rem = 0 at i = 32)
    ld hl,RAY_HGT
    ld de,RAY_HGT+1
    ld bc,32
    ld (hl),VIEW_HH
    ldir
    ld hl,VIEW_HH
    ld de,0
    ld bc,32
    ld ix,RAY_HGT+32
    ld iy,RAY_HGT_LEN
    jr inc_div8

; inc_div: the table of floor(N / n) for n = BC .. IY - 1 (words at IX), from HL = floor(N / BC), DE = N mod BC.  Clobbers everything.
inc_div:
    xor a                       ; the mode (kept in A'): 0 = word entries, 1 = byte entries (inc_div8: the quotient fits a byte)
    jr inc_go
inc_div8:
    ld a,1
inc_go:
    ex af,af'
.s:
    ld (ix+0),l
    ex af,af'
    or a
    jr nz,.b
    ld (ix+1),h
    inc ix
.b:
    inc ix
    ex af,af'
    inc bc
    push hl
    push iy
    pop hl
    or a
    sbc hl,bc
    pop hl
    ret z                       ; n = IY: done
    ex de,hl                    ; HL = rem, DE = q
    or a
    sbc hl,de                   ; rem -= q
.w:
    bit 7,h
    jr z,.ok
    dec de                      ; q -= 1
    add hl,bc                   ; rem += n
    jr .w
.ok:
    ex de,hl
    jr .s

; ray_pat: RAY_PATM + 16 p + 2 pi = the pattern pi's (even, odd) bytes AND the column bits of position p (colw bits from the left).  The game's 16
; pattern bytes (view_desc + 7; 0 = PAT_DEFAULT).  IX = view_desc.
ray_pat:
    ld l,(ix+7)
    ld h,(ix+8)
    ld a,h
    or l
    jr nz,.g
    ld hl,PAT_DEFAULT
.g:
    ld de,RAY_PATM
    ld a,(VD_COLW)
    cp 4
    ld c,$F0
    jr z,.m
    ld c,$C0
.m:
    ld a,(VD_RPB)
    ld b,a
.p:
    push bc
    push hl
    ld b,16
.q:
    ld a,(hl)
    and c
    ld (de),a
    inc hl
    inc de
    djnz .q
    pop hl
    pop bc
    ld a,(VD_COLW)
.sh:
    srl c
    dec a
    jr nz,.sh
    djnz .p
    ret

; ray_attrs: the 192 window cells of both display files: rows 6..11 attr_top, rows 12..17 attr_bottom (columns 8..23).  IX = view_desc.
ray_attrs:
    ld hl,DATTR0+VIEW_CY*32+VIEW_CX
    call .file
    ld hl,DATTR1+VIEW_CY*32+VIEW_CX
.file:
    ld a,(ix+3)
    call .half
    ld a,(ix+4)
.half:
    ld c,6
.row:
    ld b,16
.col:
    ld (hl),a
    inc hl
    djnz .col
    ld de,16
    add hl,de
    dec c
    jr nz,.row
    ret

; ===============================================================================================================
; The tick (main.asm AFTER_FRAME jumps here in ray mode)
; ===============================================================================================================
ray_tick:
    call ray_mask_dirty         ; the window's cells are never drawn from the cell map
    call redraw_dirty           ; the HUD / the cells around the window
    call ray_render
    jp TICK_COUNT

; ray_mask_dirty: zero the dirty bytes 1 and 2 (columns 8..23) of rows 6..17 in the hidden file's dirty map.  Clobbers AF, B, HL.
ray_mask_dirty:
    ld a,(V_HIDDEN)
    add a,DIRTY0>>8
    ld h,a
    ld l,VIEW_CY*4+1
    ld b,12
    xor a
.r:
    ld (hl),a
    inc l
    ld (hl),a
    inc l
    inc l
    inc l
    djnz .r
    ret

; ray_render: the picture of the stored pose into the hidden display file: setup, cast, walls, billboards (+ BB_TAB).  Saves and restores IX, IY,
; AF' and the alternate set.  Clobbers AF, BC, DE, HL.
ray_render:
    push ix
    push iy
    ex af,af'
    push af
    ex af,af'
    exx
    push bc
    push de
    push hl
    exx
    call ray_setup
    call ray_cast               ; (composes and draws each byte column of walls as soon as its rays are cast)
    call ray_bb
    exx
    pop hl
    pop de
    pop bc
    exx
    ex af,af'
    pop af
    ex af,af'
    pop iy
    pop ix
    ret

; ray_setup: direction, camera plane, ray step, the first ray, multipliers, the viewer's cell, the hidden file's pointers, the billboards' cos / sin.
ray_setup:
    ld a,(RV_A)
    call cos_t
    ld (R_COSA),hl
    ld a,(RV_A)
    add a,192
    call cos_t
    ld (R_SINA),hl
    call mul_p
    call neg_hl
    ld (R_PLX),hl               ; plane x = -mulP(sin)
    ld hl,(R_COSA)
    call mul_p
    ld (R_PLY),hl               ; plane y = mulP(cos)
    ld hl,(R_PLX)
    call step_of
    ld (R_STX),hl
    ld hl,(R_PLY)
    call step_of
    ld (R_STY),hl
    ld hl,(R_COSA)              ; first ray: dir - plane + step / 2 (arithmetic shift)
    ld de,(R_PLX)
    or a
    sbc hl,de
    ld de,(R_STX)
    sra d
    rr e
    add hl,de
    ld (R_RDX),hl
    ld hl,(R_SINA)
    ld de,(R_PLY)
    or a
    sbc hl,de
    ld de,(R_STY)
    sra d
    rr e
    add hl,de
    ld (R_RDY),hl
    ld hl,(RV_X)                ; the cast's position: the pose clamped to cells 1..30 of the array (a viewer on the array's outer ring would cast out
    call clamp_in               ; of it; inside the ring nothing changes)
    ld (R_PX),hl
    ld hl,(RV_Y)
    call clamp_in
    ld (R_PY),hl
    ld a,(R_PX)                 ; multipliers: negative direction = frac, positive = 256 - frac (0 means 256)
    ld (R_MXN),a
    neg
    ld (R_MXP),a
    ld a,(R_PY)
    ld (R_MYN),a
    neg
    ld (R_MYP),a
    ld a,(R_PY+1)               ; the viewer's cell: MAP_RAM + 32 row + column
    rrca
    rrca
    rrca
    ld l,a
    and $E0
    ld h,a
    ld a,(R_PX+1)
    or h
    ld e,a
    ld a,l
    and $03
    add a,MAP_RAM>>8
    ld d,a
    ld (R_MAP0),de
    call gen_muls
    ld a,(V_HOFF)               ; the hidden file's centre rows
    or LBH0
    ld (R_LBH),a
    ld a,(V_HOFF)
    or UBH0
    ld (R_UBH),a
    ld hl,(R_COSA)              ; billboards: (C + 8) >> 4
    call fx8
    ld (R_CS),hl
    ld hl,(R_SINA)
    call fx8
    ld (R_SN),hl
    ret

; clamp_in: HL (0..8191, the clamped pose) -> max(256, min(7935, HL)).  Clobbers AF.
clamp_in:
    ld a,h
    or a
    jr nz,.lo
    inc h                       ; < 256: 256
    ld l,0
    ret
.lo:
    cp 31
    ret c
    ld hl,31*256-1              ; >= 7936: 7935
    ret

; cos_t: A = angle -> HL = RAY_COS[A].  Clobbers AF, DE.
cos_t:
    ld l,a
    ld h,0
    add hl,hl
    ld de,RAY_COS
    add hl,de
    ld a,(hl)
    inc hl
    ld h,(hl)
    ld l,a
    ret

; mul_p: HL = (HL >> 1) + (HL >> 4) + (HL >> 6) (arithmetic shifts): the plane length 0.578 = 37 / 64.  Clobbers AF, DE.
mul_p:
    ld d,h
    ld e,l
    sra h
    rr l
    sra d
    rr e
    sra d
    rr e
    sra d
    rr e
    sra d
    rr e
    add hl,de
    sra d
    rr e
    sra d
    rr e
    add hl,de
    ret

; step_of: HL = signed plane value p -> sign(p) * ((2 |p| + N / 2) >> log2 N), N = the number of rays.  Clobbers AF, DE.
step_of:
    ld a,h
    push af
    bit 7,h
    call nz,neg_hl
    add hl,hl
    ld a,(VD_NRAY)
    rra                         ; N / 2 (carry was 0 from ADD HL,HL: |p| < 32768)
    ld e,a
    ld d,0
    add hl,de
    ld a,(VD_NRAY)              ; >> 5 (32 rays) or >> 6 (64)
    srl h
    rr l
    srl h
    rr l
    srl h
    rr l
    srl h
    rr l
    srl h
    rr l
    cp 64
    jr nz,.s
    srl h
    rr l
.s:
    pop af
    bit 7,a
    ret z
    jp neg_hl

; fx8: HL = (HL + 8) >> 4 (arithmetic): a 4.12 value as 8.8.  Clobbers AF, DE.
fx8:
    ld de,8
    add hl,de
    sra h
    rr l
    sra h
    rr l
    sra h
    rr l
    sra h
    rr l
    ret

; ===============================================================================================================
; Casting
; ===============================================================================================================
; ray_cast: every ray j = 0..N-1 into RAY_HHR / PIR / DISTL / DISTH [j], each byte column composed and drawn when its rays are cast (rw_column).
; Clobbers everything but IY.
ray_cast:
    ld a,(VD_NRAY)
    ld (R_J),a
    xor a
    ld (R_OUT),a
    ld (R_COL),a
.ray:
    call ray_one
    ld hl,(R_RDX)
    ld de,(R_STX)
    add hl,de
    ld (R_RDX),hl
    ld hl,(R_RDY)
    ld de,(R_STY)
    add hl,de
    ld (R_RDY),hl
    ld hl,R_J
    dec (hl)
    jr nz,.ray
    ret

; ray_one: cast the ray (R_RDX, R_RDY) from the stored pose; the DDA loop (RAM) ends in HITX / HITY, whose RET returns to ray_one's caller.
; The first side distance of an axis is floor(m D / 256): the multiply by the frame's m is one of the four routines gen_muls wrote into RAM.
ray_one:
    ld hl,(R_RDX)
    ld bc,(R_MXN)               ; C = R_MXN, B = R_MXP
    call axis
    jr c,.xd                    ; done by axis (v = 0, or D >= 65536)
    or a
    jr nz,.xn
    call RAY_MULXP+2
    jr .xc
.xn:
    call RAY_MULXN+2
.xc:
    bit 7,d                     ; the step delta: min(D, 32767)
    jr z,.xd
    ld de,32767
.xd:
    ld (R_DX),de
    ld (R_SDX),hl
    ld (R_T0),a                 ; 1 = x negative
    ld a,e
    ld (DDA_PXL+1),a
    ld a,d
    ld (DDA_PXH+1),a
    ld hl,(R_RDY)
    ld bc,(R_MYN)
    call axis
    jr c,.yd
    or a
    jr nz,.yn
    call RAY_MULYP+2
    jr .yc
.yn:
    call RAY_MULYN+2
.yc:
    bit 7,d
    jr z,.yd
    ld de,32767
.yd:
    ld (R_DY),de
    add a,a
    ld b,a
    ld a,e
    ld (DDA_PYL+1),a
    ld a,d
    ld (DDA_PYH+1),a
    ex de,hl                    ; DE = sdy
    ld a,(R_T0)
    or b                        ; the quadrant: bit 0 = x negative, bit 1 = y negative
    ld hl,R_QUAD
    cp (hl)
    call nz,dda_patch
    ld bc,(R_SDX)
    ld hl,(R_MAP0)
    jp DDA

; dda_patch: A = quadrant -> R_QUAD = A and the DDA loop's step opcodes (x: INC HL / DEC HL; y: ADD A,32 + INC H / SUB 32 + DEC H).
; Clobbers AF, HL.
dda_patch:
    ld (hl),a                   ; (HL = R_QUAD)
    rra
    ld hl,DDA_XOP
    ld (hl),$23                 ; INC HL
    jr nc,.xp
    ld (hl),$2B                 ; DEC HL
.xp:
    rra
    ld hl,DDA_YOP
    ld (hl),$C6                 ; ADD A,n
    ld a,$24                    ; INC H
    jr nc,.yp
    ld (hl),$D6                 ; SUB n
    ld a,$25                    ; DEC H
.yp:
    ld (DDA_YC),a
    ret

; RLOOK: HL = w (2048..8191) -> HL = RECIP[w >> 4].  Clobbers AF.
    MACRO RLOOK
        srl h
        rr l
        srl h
        rr l
        srl h
        rr l
        res 0,l
        ld a,h
        add a,RAY_RECIP>>8
        ld h,a
        ld a,(hl)
        inc l
        ld h,(hl)
        ld l,a
    ENDM

; axis: HL = the ray's component v (signed 4.12), C = the multiplier for v < 0 (frac, 0..255), B = for v >= 0 (256 - frac, 0 means 256).
; v is normalised: w = |v| << e in 2048..8191 (|v| above 8191 is read as 8191), R = RECIP[w >> 4], D = R << e (exact).
; -> carry clear: DE = D (< 65536), A = 1 when v < 0 else 0 (the caller multiplies: first side distance floor(m D / 256), step min(D, 32767));
;    carry set: HL = the first side distance, DE = the step delta, A = the sign (v = 0: 65535 / 32767; D >= 65536).  Clobbers BC, F.
axis:
    bit 7,h
    jr z,.pos
    xor a                       ; |v|
    sub l
    ld l,a
    sbc a,a
    sub h
    ld h,a
    ld b,c                      ; m = frac (0..255; 0 is 0)
    ld c,1
    jr .abs
.pos:
    ld a,h
    or l
    jp z,.zero                  ; v = 0: never steps
    ld c,0                      ; m = 256 - frac (0 is 256)
.abs:
    ld a,h
    cp 8
    jr nc,.e0
    cp 4
    jr nc,.e1
    cp 2
    jr nc,.e2
    or a
    jr nz,.e3
    jp .slow                    ; |v| < 256
.e0:
    cp $20
    jr c,.e0r
    ld hl,8191
.e0r:
    RLOOK
.d:
    ex de,hl                    ; DE = D
    ld a,c
    or a                        ; carry clear
    ret
.e1:
    add hl,hl
    RLOOK
    add hl,hl
    jr .d
.e2:
    add hl,hl
    add hl,hl
    RLOOK
    add hl,hl
    add hl,hl
    jr .d
.e3:
    add hl,hl
    add hl,hl
    add hl,hl
    RLOOK
    add hl,hl
    add hl,hl
    add hl,hl
    jr .d
.zero:
    ld de,32767
    ld hl,65535
    xor a
    scf
    ret
.slow:                          ; |v| = 1..255: e = 4..11
    ld e,0
.nl:
    add hl,hl
    inc e
    ld a,h
    cp 8
    jr c,.nl
    RLOOK
    ld d,e                      ; D = e
    push hl
.sh:
    add hl,hl
    jr c,.big                   ; R << e >= 65536
    dec e
    jr nz,.sh
    pop af                      ; (drop R)
    jp .d
.big:                           ; D = R << e >= 65536 (so e >= 7): step 32767; first distance min(65535, floor(m R 2^e / 256)), m R computed exactly
    ld a,c
    ld (R_T0+1),a               ; the sign
    ld a,d
    ld (R_T0+2),a               ; e
    pop de                      ; DE = R
    ld a,b
    or a
    jr nz,.bm0
    bit 0,c
    jr nz,.bz                   ; m = 0: 0
    jr .sat                     ; m = 256: D >= 65536
.bm0:
    ld c,a                      ; C = m (1..255)
    ld hl,0
    xor a                       ; A:HL = m R, multiplier bits from the top
    ld b,8
.bml:
    add hl,hl
    rla
    sla c
    jr nc,.bmn
    add hl,de
    adc a,0
.bmn:
    djnz .bml
    ld b,a                      ; B:H:L = m R (<= 130,560)
    ld a,(R_T0+2)
    sub 8
    jr z,.b0                    ; e = 8: the product itself
    jr c,.br                    ; e = 7: / 2
.bl:
    sla l                       ; e > 8: << (e - 8)
    rl h
    rl b
    dec a
    jr nz,.bl
.b0:
    ld a,b
    or a
    jr nz,.sat
    jr .bdone
.br:
    srl b
    rr h
    rr l
.bdone:
    ld de,32767
    ld a,(R_T0+1)
    scf
    ret
.bz:
    ld hl,0
    jr .bdone
.sat:
    ld hl,65535
    jr .bdone

; gen_muls (per frame): the four multiply routines HL = floor(m DE / 256) for the frame's multipliers into RAM (RAY_MULXN, XP, YN, YP).
; A routine is LD HL,0 / for each bit of m from the lowest set one: ADD HL,DE / RR H / RR L (bit 1) or SRL H / RR L (bit 0) / RET (the shifts of the zero bits below the lowest set
; one change nothing); m = 0: LD HL,0 / RET; a positive direction's m byte 0 (m = 256): LD H,D / LD L,E / RET.  Clobbers AF, BC, DE, HL.
gen_muls:
    ld hl,RAY_MULXN
    ld a,(R_MXN)
    ld c,0
    call gen_mul
    ld hl,RAY_MULXP
    ld a,(R_MXP)
    ld c,1
    call gen_mul
    ld hl,RAY_MULYN
    ld a,(R_MYN)
    ld c,0
    call gen_mul
    ld hl,RAY_MULYP
    ld a,(R_MYP)
    ld c,1
; gen_mul: A = m byte, C = 1 when 0 means 256, HL = the routine's buffer: (m, kind) it holds at + 0, + 1, the code from + 2.  A routine that already
; holds this (m, kind) is not generated again.
gen_mul:
    ld b,a
    cp (hl)
    inc hl
    jr nz,.new
    ld a,c
    cp (hl)
    ret z                       ; unchanged
.new:
    dec hl
    ld (hl),b
    inc hl
    ld (hl),c
    inc hl
    ld a,b
    or a
    jr nz,.hd
    dec c
    jr nz,.hd                   ; m = 0, kind 0: LD HL,0 / RET (A = 0 below ends it)
    ld (hl),$62                 ; LD H,D / LD L,E / RET
    inc hl
    ld (hl),$6B
    inc hl
    jr .end
.hd:
    ld (hl),$21                 ; LD HL,0
    inc hl
    ld (hl),0
    inc hl
    ld (hl),0
    inc hl
    or a
    jr z,.end                   ; m = 0: LD HL,0 / RET
    ld b,8
.z:
    rra                         ; skip the zero bits below the lowest set one
    jr c,.one
    dec b
    jr .z
.bit:
    rra
    jr nc,.sh
.one:
    ld (hl),$19                 ; ADD HL,DE / RR H (the carry of the add) / RR L
    inc hl
    ld (hl),$CB
    inc hl
    ld (hl),$1C
    jr .rl
.sh:
    ld (hl),$CB                 ; SRL H / RR L
    inc hl
    ld (hl),$3C
.rl:
    inc hl
    ld (hl),$CB
    inc hl
    ld (hl),$1D
    inc hl
    dec b
    jr nz,.bit
.end:
    ld (hl),$C9
    ret

; mul8x16: A = m (1..255), DE -> HL = floor(m DE / 256) (exact: the shifted-out bits are dropped after each add).  Clobbers AF.
mul8x16:
    ld hl,0
    REPT 8
    rra
    jr nc,$+3
    add hl,de
    rr h
    rr l
    ENDR
    ret

; HITX / HITY: the DDA loop's ends.  A = the wall type (nonzero), BC = sdx / DE = sdy (the side distance after the step into the wall) ->
; the ray's results at R_OUT; RET returns to ray_one's caller.
HITX:
    ld h,b
    ld l,c
    ld bc,(R_DX)
    or a
    sbc hl,bc                   ; the perpendicular distance
    ld c,0
    jr hit_c
HITY:
    ex de,hl
    ld de,(R_DY)
    or a
    sbc hl,de
    ld c,1
hit_c:                          ; A = the wall type, C = the side, HL = the perpendicular distance
    dec a
    add a,a
    add a,c
    and 7
    ld c,a                      ; C = the pattern index
    ld a,(R_OUT)
    ld e,a                      ; E = j
    ld d,RAY_DISTL>>8
    ld a,l
    ld (de),a                   ; DISTL
    set 6,e
    ld a,h
    ld (de),a                   ; DISTH
    ld d,RAY_HHR>>8
    ld a,c
    ld (de),a                   ; PIR (= HHR + $40)
    res 6,e
    srl h                       ; >> 3, at most 1535
    rr l
    srl h
    rr l
    srl h
    rr l
    ld a,h
    cp RAY_HGT_LEN>>8
    jr c,.in
    ld hl,RAY_HGT_LEN-1
.in:
    ld a,h
    add a,RAY_HGT>>8            ; (RAY_HGT is page aligned, asserted below: the low byte needs no add)
    ld h,a
    ld a,(hl)
    ld (de),a                   ; HHR
    ld b,a                      ; B = hh
    ; ---- the byte column's record of this ray: position p = j AND (R - 1): key hh * 4 + p, the masked pattern bytes ----
    ld a,(R_PMASK)
    and e
    ld l,a                      ; L = p
    inc e
    ld a,e
    ld (R_OUT),a
    ld a,b
    add a,a
    add a,a
    or l
    ld h,a                      ; H = the key
    ld a,l
    add a,R_KEYS&$FF
    ld e,a
    ld d,R_KEYS>>8
    ld a,h
    ld (de),a
    ld a,l                      ; RAY_PATM + 16 p + 2 pi
    add a,a
    add a,a
    add a,a
    add a,c
    add a,a
    add a,RAY_PATM&$FF
    ld l,a
    ld h,RAY_PATM>>8
    ld a,e
    add a,R_PE-R_KEYS
    ld e,a
    ld a,(hl)
    ld (de),a                   ; R_PE[p]
    inc l
    ld a,e
    add a,R_PO-R_PE
    ld e,a
    ld a,(hl)
    ld (de),a                   ; R_PO[p]
    ld a,(R_PMASK)
    sub e
    add a,R_PO&$FF
    ret nz                      ; p < R - 1: the column is not complete
    ; (falls into rw_column: the column's last ray was cast)

; ===============================================================================================================
; Walls: the byte-column composer (method B), called when a byte column's R = 8 / colw rays are cast
; ===============================================================================================================
; The rays of the column (heights h, masked patterns E, O) give runs of constant bytes from the centre outwards: [0, T1) all rays with h > 0,
; [Tk, Tk+1) the rays with h > Tk, ..., [Tm, 48) the rays with h = 48 (T = the distinct heights 1..47).  The chain (RAM) is entered at unit 0
; with the first run's accumulators in B', C' and the pointers in HL', DE'; the unit Tk starts with an RST (RST_EVEN / RST_ODD, boot.asm) that
; restores the unit's first byte and takes the next run's accumulators from the stack (pushed here, last run first, above the return address
; rw_done); the chain's END returns to rw_done.  Keys = h * 4 + position, sorted descending.  Clobbers everything.
rw_column:
    ld hl,R_KEYS
    ld a,(VD_RPB)
    cp 4
    jr z,.s4
    ld b,(hl)                   ; two keys
    inc l
    ld c,(hl)
    ld a,b
    cp c
    jr nc,.sorted
    ld (hl),b
    dec l
    ld (hl),c
    jr .sorted
.s4:
    ld b,(hl)
    inc l
    ld c,(hl)
    inc l
    ld d,(hl)
    inc l
    ld e,(hl)
    MACRO CAS rx,ry             ; rx >= ry afterwards
        ld a,rx
        cp ry
        jr nc,1F
        ld rx,ry
        ld ry,a
1:
    ENDM
    CAS b,c
    CAS d,e
    CAS b,d
    CAS c,e
    CAS c,d
    ld (hl),e
    dec l
    ld (hl),d
    dec l
    ld (hl),c
    dec l
    ld (hl),b
.sorted:
    ld hl,rw_done
    push hl                     ; where the chain's END returns
    ld bc,0                     ; B = the even-row accumulator, C = the odd-row one (the run above the highest threshold: rays with h = 48)
    ld d,$FF                    ; the previous threshold (h * 4; $FF matches none)
    MACRO KEYSTEP k
        ld hl,R_KEYS+k
        ld a,(hl)
        ld e,a                  ; E = the key
        and $FC                 ; h * 4
        jp z,rw_go              ; h = 0: no pixel (and every later key too)
        cp VIEW_HH*4
        jr z,1F                 ; h = 48: no threshold
        cp d
        jr z,1F                 ; the same threshold as the previous key
        ld d,a
        push bc                 ; the accumulators of the run [h, the previous threshold)
        rrca                    ; h * 2
        add a,UNIT_TAB&$FF
        ld l,a
        ld h,UNIT_TAB>>8
        ld a,(hl)
        inc l
        ld h,(hl)
        ld l,a                  ; HL = the unit h
        bit 2,d
        ld (hl),RST_E_OP
        jr z,1F
        ld (hl),RST_O_OP
1:
        ld a,e                  ; the accumulators ^= the key's pattern
        and 3
        add a,R_PE&$FF
        ld l,a
        ld h,R_PE>>8
        ld a,b
        xor (hl)
        ld b,a
        ld a,l
        add a,R_PO-R_PE
        ld l,a
        ld a,c
        xor (hl)
        ld c,a
    ENDM
    KEYSTEP 0
    KEYSTEP 1
    ld a,(VD_RPB)
    cp 4
    jr nz,rw_go
    KEYSTEP 2
    KEYSTEP 3
rw_go:
    push bc                     ; the first run's accumulators -> B', C'
    exx
    pop bc
    ld a,(R_COL)
    ld e,a
    add a,LBL0
    ld l,a
    ld a,(R_LBH)
    ld h,a
    ld a,e
    add a,UBL0
    ld e,a
    ld a,(R_UBH)
    ld d,a
    jp CHAIN
rw_done:
    exx
    ld hl,R_COL
    inc (hl)
    ret
    ASSERT (R_KEYS&$FF)+12 <= 256 && R_PO == R_PE+4 && R_PE == R_KEYS+4 && (RAY_HGT&$FF) == 0

PAT_DEFAULT:                    ; the spike's PAT: (even-row byte, odd-row byte) for pi = (type - 1) * 2 + side
    DB $FF,$FF, $AA,$55         ; type 1: solid / checker
    DB $EE,$BB, $88,$22         ; type 2: 3/4 dither / 1/4 dither
    DB $FF,$00, $AA,$00         ; type 3: scanline stripes / sparse stripes
    DB $CC,$CC, $88,$88         ; type 4: vertical bars / thin bars

    MACRO QTAB_DATA
QTAB:                           ; Q[k] = round(4096 sin(k pi / 128)), k = 0..64
    DW 0, 101, 201, 301, 401, 501, 601, 700, 799, 897, 995, 1092, 1189, 1285, 1380, 1474
    DW 1567, 1660, 1751, 1842, 1931, 2019, 2106, 2191, 2276, 2359, 2440, 2520, 2598, 2675, 2751, 2824
    DW 2896, 2967, 3035, 3102, 3166, 3229, 3290, 3349, 3406, 3461, 3513, 3564, 3612, 3659, 3703, 3745
    DW 3784, 3822, 3857, 3889, 3920, 3948, 3973, 3996, 4017, 4036, 4052, 4065, 4076, 4085, 4091, 4095
    DW 4096
    ENDM
; The chain's unit table (RAM addresses of units 0..48; unit 48 = the END's RET).  Unit d at CHAIN + 5 d + 20 floor(d / 8).  Inside one page.
    MACRO UNIT_TAB_DATA
UNIT_TAB:
    DUP VIEW_HH+1, d
    DW CHAIN+5*d+20*(d/8)
    EDUP
    ASSERT (UNIT_TAB&$FF)+2*(VIEW_HH+1) <= 256
    ENDM
; The two tables in the order that needs no padding: the unit table does not straddle a page where it is put, so QTAB (any position) goes before
; it only when it would otherwise straddle (an ALIGN there once cost 85 bytes).
    IF (($ & $FF) + 2*(VIEW_HH+1)) <= 256
    UNIT_TAB_DATA
    QTAB_DATA
    ELSE
    QTAB_DATA
    IF (($ & $FF) + 2*(VIEW_HH+1)) > 256
    ALIGN 256
    ENDIF
    UNIT_TAB_DATA
    ENDIF


; ===============================================================================================================
; RAM routines: assembled for RAY_RAM, copied there by ray_boot
; ===============================================================================================================
; The row chain: unit d draws row 48 + d (lower, HL') and 47 - d (upper, DE') of one byte column: even d: lower = B' (even-row byte), upper = C'
; (odd row); odd d the other way round.  After units 7, 15, ..., 39 the pointers cross a character row (FIX).  Entered at unit 0 with JP; a run ends
; where the composer patched an RST; the END's RET returns to rw_done.  The chain (CHAIN .. CHAIN_END, 341 bytes) is built by ray_boot from this
; pattern, 8 units and a FIX (60 bytes), repeated 5 times, then 8 units and the RET: the same bytes the assembler used to lay out here.
CHAIN           EQU RAY_RAM
CHAIN_END       EQU CHAIN+5*VIEW_HH+20*(VIEW_HH/8-1)
CHAIN_T:
    DUP 8, d
      IF (d & 1) == 0
        ld (hl),b
        ld a,c
      ELSE
        ld (hl),c
        ld a,b
      ENDIF
        ld (de),a
        inc h
        dec d
      IF (d & 7) == 7
        ld a,l                  ; FIX: the lower pointer to the next character row
        add a,32
        ld l,a
        jr c,$+6
        ld a,h
        sub 8
        ld h,a
        ld a,e                  ; the upper pointer to the previous one
        sub 32
        ld e,a
        jr c,$+6
        ld a,d
        add a,8
        ld d,a
      ENDIF
    EDUP
CHAIN_T_END:
CHAIN_PAT_LEN   EQU CHAIN_T_END-CHAIN_T
    ASSERT CHAIN_PAT_LEN == 60 && VIEW_HH == 48 && 5*CHAIN_PAT_LEN+8*5+1 == CHAIN_END+1-CHAIN

RAM_SRC:
    DISP CHAIN_END+1

; The DDA loop: BC = sdx, DE = sdy, HL = the map pointer.  x steps when sdx < sdy, else y (ties go to y).  The immediates (the deltas) are
; patched per ray by ray_one, the step opcodes per quadrant by dda_patch.  Ends with JP HITX / HITY (A = the wall type).
DDA:
dda_loop:
    ld a,c
    sub e
    ld a,b
    sbc a,d
    jr nc,dda_y
    ld a,c
DDA_PXL:
    add a,0
    ld c,a
    ld a,b
DDA_PXH:
    adc a,0
    ld b,a
DDA_XOP:
    inc hl
    ld a,(hl)
    or a
    jr z,dda_loop
    jp HITX
dda_y:
    ld a,e
DDA_PYL:
    add a,0
    ld e,a
    ld a,d
DDA_PYH:
    adc a,0
    ld d,a
    ld a,l
DDA_YOP:
    add a,32
    ld l,a
    jr nc,dda_yn
DDA_YC:
    inc h
dda_yn:
    ld a,(hl)
    or a
    jr z,dda_loop
    jp HITY
; The billboard row tails (bb_draw ends the generated row code with JP to one of them; K and the fraction patched per billboard): back to the row's
; first byte (SUB K), one screen row down, the source row: frac and integer step (DE = 2 wb, DE' = the integer step in bytes), only frac, only
; the integer step (DE = it); DEC B / JP NZ to the row code / RET.
    MACRO BB_DOWN
        ld a,h                  ; (after LD A,L / SUB K / LD L,A / INC H)
        and 7
        jr nz,1F
        ld a,l
        add a,32
        ld l,a
        jr c,1F
        ld a,h
        sub 8
        ld h,a
1:
    ENDM
BT_FI:
    ld a,l
BT_FI_K:
    sub 0
    ld l,a
    inc h
    BB_DOWN
    ld a,c
BT_FI_F:
    add a,0
    ld c,a
    jr nc,$+4
    add ix,de
    exx
    add ix,de
    exx
    dec b
    jp nz,RAY_BCODE
    ret
BT_F:
    ld a,l
BT_F_K:
    sub 0
    ld l,a
    inc h
    BB_DOWN
    ld a,c
BT_F_F:
    add a,0
    ld c,a
    jr nc,$+4
    add ix,de
    dec b
    jp nz,RAY_BCODE
    ret
BT_I:
    ld a,l
BT_I_K:
    sub 0
    ld l,a
    inc h
    BB_DOWN
    add ix,de
    dec b
    jp nz,RAY_BCODE
    ret
RAY_RAM_END:
    ENT
RAY_MULXN       EQU RAY_RAM_END ; the six multiply routines (gen_muls / ray_bb; not copied): 2 bytes (m, kind) + at most 3 + 8 x 5 + 1 bytes of code
RAY_MULXP       EQU RAY_MULXN+46
RAY_MULYN       EQU RAY_MULXP+46
RAY_MULYP       EQU RAY_MULYN+46
RAY_MULC        EQU RAY_MULYP+46  ; (billboards: |cs| and |sn|, ray_bb)
RAY_MULS        EQU RAY_MULC+46
RAY_MUL_END     EQU RAY_MULS+46
RAM_SRC_END:
    ASSERT RAY_MUL_END <= RAY_RAM_LIMIT

    INCLUDE "raybb.asm"         ; billboards, RT_VIEW / COSA / SINA / FXMUL / WALL / SETWALL, show_ray, ray_hit
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
M_RAY_E:
