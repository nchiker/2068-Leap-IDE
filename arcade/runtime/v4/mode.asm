; mode.asm -- runtime v4, language batch 7 Part B (docs/ARCADE_LANGUAGE_BATCH7.md sections 1 and 3, B0's option (c)): the 3D view switched off and on
; per scene.  RT_VIEWMODE is called by the compiled ENTER sequence after the machine reset (every sprite hidden, CLS, the first map) and before the
; target scene's INIT, and by the boot entry before the first scene's INIT.  Appended after ray.asm so that no existing address moves.
;
; Register rules: RT_VIEWMODE clobbers AF, BC, DE, HL only: it saves IX, IY and the alternate set (the phase-pool plan and build_frame clobber
; them); no DI, interrupts may arrive at any instruction, no self-modifying code.
    ; (no ORG: follows ray.asm)
M_MODE_S:

; ---------------------------------------------------------------------------------------------------------------
; RT_VIEWMODE: A = 0 the view off, anything else on.  A switch to the mode the game is already in, and "on" in a game whose boot found no valid
; view, do nothing at all (nothing is written).
;   off (V_RAY = 1 -> 0): V_RAY = 0, V_RAYOFF = 1; the 2D sprite records emptied (drawn_dirty; always empty in ray mode); the asset records get
;        their 2D meaning back (AST_FTAB 0, AST_CLEN = h x 2 x (wb + 1), AST_RR 0, AST_K 0: ray_assets overwrote FTAB and CLEN; PHASE_OFF, which
;        ray mode never writes, survives); the phase pool is planned and built by the boot's code (assets.asm plan_pool.body: FTABs, slots,
;        the frames that have a slot) with FC_MISS 0 and FC_NEXT at the NOVIEW pieces NV_POOL_A, NV_POOL_B, NV_POOL_C (the linker guarantees that
;        the art fits them: a miss would stop the machine as the boot's does); the view's cells (rows 6..17, columns 8..23) dirty in both
;        display files' maps, so that the next two ticks redraw them from the cell map.  The non-ray path then starts clean, as after a boot
;        without a view.  The ray tables ($C080-$CCFF), the map, RAY_RAM ($5B00-$5D94), the pose, BB_TAB and V4VARS are not touched.
;   on (V_RAYOFF = 1 -> 0): V_RAY = 1, V_RAYOFF = 0; every 2D sprite record of both files turned into dirty cells and emptied (drawn_dirty: the
;        sprites drawn at screen positions outside the view are redrawn from the cell map; the ray tick never erases); ray_assets (the records'
;        billboard meaning) and the view's attributes as the boot's ray_attrs writes them: into the hidden file now, into the file on screen when the
;        ray tick next draws it (V_RAYATTR, vm_pre), so the old scene's picture on screen is not touched (vm_attr_view, a faster copy of ray_attrs).  Nothing else is rebuilt: the
;        next tick renders the view from the pose, the map and the instances as they are.
; Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
RT_VIEWMODE:
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
    call vm_switch
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

vm_switch:
    or a
    jr z,.off
    ld a,(V_RAYOFF)
    or a
    ret z                       ; on already, or no view
    xor a
    ld (V_RAYOFF),a
    call drawn_dirty
    call ray_assets
    ld a,(V_SHADOW_FF)          ; the view's attributes: into the hidden file now (the file on screen keeps the old scene's picture), into the other one
    and 1                       ; when the ray tick next draws it (V_RAYATTR, vm_pre).  The hidden file is the one not on screen, from the flip shadow:
    xor 1                       ; valid in the frame code of a tick and in the boot's INIT alike (V_HIDDEN is set only by a tick)
    push af
    xor 1
    inc a
    ld (V_RAYATTR),a            ; 1 + the file on screen
    pop af
    call vm_attr_view
    ld a,1
    ld (V_RAY),a
    ret
.off:
    ld a,(V_RAY)
    or a
    ret z                       ; off already, or no view
    xor a
    ld (V_RAY),a
    inc a
    ld (V_RAYOFF),a
    xor a
    ld (V_RAYATTR),a            ; no file owes the view's attributes any more (the next ON sets it again)
    ld hl,(V_TICKS)             ; before the first tick (the first scene, at the boot's INIT or in tick 0's frame code) no picture has been flipped yet:
    ld a,h                      ; both files are the boot's, with the view's attributes ray_boot wrote; put back what a boot without a view leaves (BG_ATTR),
    or l                        ; so that the file on screen is a blank screen too (later the dirty cells below redraw each file at its next tick)
    jr nz,.nb
    ld de,BG_ATTR*257
    call vm_attr_file           ; A = 0: file 1
    ld a,1
    call vm_attr_file
.nb:
    call drawn_dirty
    ld a,(V_NAST)               ; ---- the asset records' 2D meaning (read_desc's CLEN; FTAB, RR, K as before the plan) ----
    or a
    jr z,.pool
    ld b,a
    ld hl,AST
.as:
    push bc
    ld c,(hl)                   ; AST_H
    ld b,0
    inc l
    inc l                       ; AST_FTAB = 0
    ld (hl),b
    inc l
    ld (hl),b
    inc l                       ; AST_WB
    ld a,(hl)
    inc a
    add a,a                     ; CLEN = h x 2 (wb + 1)
    push hl
    ld hl,0
.m:
    add hl,bc
    dec a
    jr nz,.m
    ex de,hl
    pop hl
    ld a,l
    add a,AST_CLEN-AST_WB
    ld l,a
    ld (hl),e
    inc l
    ld (hl),d
    inc l                       ; AST_RR = 0
    ld (hl),b
    inc l                       ; AST_K = 0
    ld (hl),b
    inc l                       ; the next record
    pop bc
    djnz .as
.pool:
    ld hl,0
    ld (FC_MISS),hl
    ld hl,NV_POOL_A
    ld (FC_NEXT),hl
    ld hl,NV_POOL_B
    ld (FC_NEXT+2),hl
    ld hl,NV_POOL_C
    ld (FC_NEXT+4),hl
    call plan_pool.body         ; (uses IX, IY, the alternates: saved by RT_VIEWMODE)
    ld hl,DIRTY0+VIEW_CY*4+1    ; ---- the view's cells dirty in both files: dirty bytes 1 and 2 (columns 8..23) of rows 6..17 ----
    call .vd
    ld hl,DIRTY1+VIEW_CY*4+1
.vd:
    ld b,12
    ld a,$FF
.r:
    ld (hl),a
    inc l
    ld (hl),a
    inc l
    inc l
    inc l
    djnz .r
    ret
    ASSERT AST_H == 0 && AST_FTAB == 2 && AST_WB == 4 && AST_RR == AST_CLEN+2 && AST_K == AST_RR+1 && AST_LEN == 16 && AST_K == 15
    ASSERT (AST&$FF)+MAX_ASSETS*AST_LEN <= 256 && VIEW_CX == 8 && VIEW_W == 128 && VIEW_H == 96

; ---------------------------------------------------------------------------------------------------------------
; vm_pre: the ray tick's first call (ray.asm ray_tick).  When the hidden file is the one that still owes the view's attributes (V_RAYATTR = 1 + file),
; write them now (before ray_render draws the view, so the file is complete when it is flipped) and clear V_RAYATTR; then ray_mask_dirty.  When nothing
; is owed (always, except in the tick after an ON): 27 T more than the direct call (LD A,(nn), OR A, JP Z).  Clobbers AF, BC, DE, HL (ray_mask_dirty: AF, B, HL).
; ---------------------------------------------------------------------------------------------------------------
vm_pre:
    ld a,(V_RAYATTR)
    or a
    jp z,ray_mask_dirty
    dec a
    ld hl,V_HIDDEN
    cp (hl)
    jp nz,ray_mask_dirty
    xor a
    ld (V_RAYATTR),a
    ld a,(hl)
    call vm_attr_view
    jp ray_mask_dirty

; ---------------------------------------------------------------------------------------------------------------
; vm_attr_view: A = display file (0 / 1) -> the view's attributes in that file exactly as ray_attrs writes them at the boot (rows 6..11 attr_top =
; view_desc + 3, rows 12..17 attr_bottom = view_desc + 4, columns 8..23).  vm_attr_file: the same with D = the top rows' attribute, E = the bottom's.
; A row of 16 stores unrolled (about 2,450 T a file against ray_attrs' 5,560; no IX).  A row's 16 bytes never cross a page (a row of attributes is
; 32-byte aligned and columns 8..23 lie inside it).  Clobber AF, BC, HL (vm_attr_view: DE too).
; ---------------------------------------------------------------------------------------------------------------
vm_attr_view:
    ld hl,(GAME_VIEWDESC)
    inc hl
    inc hl
    inc hl
    ld d,(hl)                   ; D = attr_top
    inc hl
    ld e,(hl)                   ; E = attr_bottom
vm_attr_file:
    ld hl,DATTR0+VIEW_CY*32+VIEW_CX
    or a
    jr z,.file
    ld h,(DATTR1+VIEW_CY*32+VIEW_CX)>>8
.file:
    ld a,d
    call .half
    ld a,e
.half:
    ld b,6
.row:
    REPT 16
    ld (hl),a
    inc l
    ENDR
    ld c,a
    ld a,l
    add a,32-16
    ld l,a
    jr nc,.nc
    inc h
.nc:
    ld a,c
    djnz .row
    ret
    ASSERT ((DATTR1-DATTR0)&$FF) == 0 && ((DATTR0+VIEW_CY*32+VIEW_CX)&31) == VIEW_CX && VIEW_CX+16 <= 32 && VIEW_W/8 == 16 && VIEW_H/8 == 12 && VIEW_CY == 6

; ---------------------------------------------------------------------------------------------------------------
; view_has: Z when the game has no view (V_RAY = V_RAYOFF = 0).  RT_PLANLOAD's test (it works in a NOVIEW scene).  Clobbers AF.
; ---------------------------------------------------------------------------------------------------------------
view_has:
    ld a,(V_RAY)
    or a
    ret nz
    ld a,(V_RAYOFF)
    or a
    ret

; ---------------------------------------------------------------------------------------------------------------
; drawn_dirty: every 2D sprite record (SPR_DRAWN: 2 files x 16 instances x (flag, E, D, N); only the first V_NINST of each file can be set) with
; its flag set becomes dirty cells in the map of the record's own file (the cell rectangle it covers: N >> 3 rows from the row of the address D E,
; N AND 7 columns from E AND 31; the file from bit 5 of D), and its flag is cleared (E, D, N stay, as erase_all leaves them).  Clobbers AF, BC, DE, HL.
; ---------------------------------------------------------------------------------------------------------------
drawn_dirty:
    ld hl,SPR_DRAWN
    call .file
    ld hl,SPR_DRAWN+64          ; the second file's records
.file:
    ld a,(V_NINST)
    or a
    ret z
    ld b,a
.rec:
    ld a,(hl)
    or a
    jr z,.next
    ld (hl),0
    push bc
    push hl
    inc l
    ld e,(hl)                   ; E = row bits 3-5 of y (bits 5-7) | the first byte column
    inc l
    ld d,(hl)                   ; D = $40 | file << 5 | (y AND $C0) >> 3 | (y AND 7)
    inc l
    ld b,(hl)                   ; B = N = cell rows << 3 | byte columns
    ld a,b                      ; the columns' 16-bit mask: MASK_TAB[(columns - 1) * 8 + (column AND 7)] (skip.asm)
    and 7
    dec a
    add a,a
    add a,a
    add a,a
    ld c,a
    ld a,e
    and 7
    add a,c
    add a,a
    add a,MASK_TAB&$FF
    ld l,a
    ld h,MASK_TAB>>8
    ld c,(hl)                   ; C = the mask of the first dirty byte
    inc l
    ld h,(hl)                   ; H = the mask of the next one
    ld a,e                      ; the first dirty byte: 4 * row + column / 8, row = (D AND $18) | E >> 5
    rlca
    rlca
    rlca
    and 7
    ld l,a
    ld a,d
    and $18
    or l
    add a,a
    add a,a
    ld l,a
    ld a,e
    rrca
    rrca
    rrca
    and 3
    add a,l
    ld e,a                      ; E = the dirty byte's index
    ld a,d
    and $20                     ; the record's file: bit 5 of the address
    rlca
    rlca
    rlca                        ; $20 -> $01
    add a,DIRTY0>>8
    ld d,a                      ; DE = the first dirty byte
    ld a,b
    rrca
    rrca
    rrca
    and 7
    ld b,a                      ; B = cell rows (1..7)
    ld a,h
    or a
    jr nz,.two
.one:                           ; the columns lie in one dirty byte (never past byte 3 of the row: column + columns <= 32)
    ld a,(de)
    or c
    ld (de),a
    ld a,e
    add a,4
    ld e,a
    djnz .one
    pop hl
    pop bc
    jr .next
.two:                           ; in two (the second is byte 1..3 of the same row)
    ld a,(de)
    or c
    ld (de),a
    inc e
    ld a,(de)
    or h
    ld (de),a
    ld a,e
    add a,3
    ld e,a
    djnz .two
    pop hl
    pop bc
.next:
    ld a,l
    add a,4
    ld l,a
    djnz .rec
    ret
    ASSERT ((SPR_DRAWN&$FF)+128 <= 256) && MAX_SPRITES == 16
M_MODE_E:
