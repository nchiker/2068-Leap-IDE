; assets.asm -- boot only: read the game header's asset descriptors and instance table, clamp them, build the asset records (AST),
; the pre-shifted phase copies in the phase slots, PHASE_PTR and SPR_TAB (docs/ARCADE_RUNTIME_API_V2.md "Sprite assets and instances").
; Runs once from video_init before the frame interrupt is enabled; uses IX / IY.  Lives in DOCK chunks 0-1 (no ORG: follows sound.asm).
;
; Clamps (a bad header never crashes the boot):
;   sprite_count > MAX_ASSETS (8) is read as 8; sprite_table 0 means no assets.
;   width <= 8 is read as 8, otherwise 16 (the data rows are 2 resp. 4 bytes); height 0 is read as 1, above 16 as 16.
;   phases: 0 or 1 -> 1, 2..3 -> 2, 4..7 -> 4, 8 and above -> 8 (the largest of {1, 2, 4, 8} not above the value).
;   inst_table 0 = no instances; ninst > MAX_SPRITES (16) is read as 16; with no asset ninst is 0; an instance's asset index >= sprite_count
;   is read as sprite_count - 1.
;
; Phase copies.  The art of an asset is built once into VBUF (the 24-bit window of every row: m0 i0 m1 i1 m2 i2, mask 1 = background shows,
; image 1 = ink; the third byte is transparent), then for each phase q (shift s = q * 8 / phases bits) the first 2 x wb bytes of every row
; are packed into the next slot (wb = width / 8 for s = 0, one more otherwise) and PHASE_PTR[asset][s] points at it; between two phases VBUF
; is shifted right by the granularity (a 1 enters the mask, a 0 the image).
    ; (no ORG: follows sound.asm)
M_ASSETS_S:

VBUF            EQU $FC00       ; boot scratch: 96 bytes inside the stack area (the stack is at $FF00 and the boot uses < 32 bytes of it)

build_assets:
    ld hl,PHASE_PTR             ; no shift of any asset yet
    ld de,PHASE_PTR+1
    ld bc,PHASE_PTR_LEN-1
    ld (hl),0
    ldir
    ld a,(GAME_NSPR)
    cp MAX_ASSETS+1
    jr c,.nok
    ld a,MAX_ASSETS             ; more assets than the pool has slots for: read as 8
.nok:
    ld hl,(GAME_SPRTAB)
    ld b,a
    ld a,h
    or l
    ld a,b
    jr nz,.have
    xor a                       ; sprite_table 0: no assets
.have:
    ld (V_NAST),a
    xor a
    ld (V_SLOT),a
    ld (V_ASSET),a
.next:
    ld a,(V_NAST)
    ld hl,V_ASSET
    cp (hl)
    jr z,.insts
    call build_asset
    ld hl,V_ASSET
    inc (hl)
    jr .next
.insts:                         ; ---- the instance table ----
    xor a
    ld (V_NINST),a
    ld a,(V_NAST)
    or a
    ret z                       ; no asset: no instance
    ld hl,(GAME_INSTTAB)
    ld a,h
    or l
    ret z                       ; inst_table 0: none
    ld a,(hl)
    inc hl
    cp MAX_SPRITES+1
    jr c,.n
    ld a,MAX_SPRITES
.n:
    ld (V_NINST),a
    or a
    ret z
    ld b,a
    ld a,(V_NAST)
    ld c,a                      ; C = number of assets
    ld de,SPR_TAB+SPR_ASSET_OFF ; (SPR_TAB was cleared with the rest of chunk 6: visible 0, x = y = 0)
.inst:
    ld a,(hl)
    inc hl
    cp c
    jr c,.aok
    ld a,c
    dec a                       ; asset index >= count: the last asset
.aok:
    ld (de),a
    ld a,e
    add a,SPR_ENT
    ld e,a
    djnz .inst
    ret

; build_asset: asset V_ASSET -> its AST record, its phase copies.  Clobbers everything; IX = descriptor, IY = AST record.
build_asset:
    ld a,(V_ASSET)
    add a,a
    add a,a
    add a,a                     ; 8 * asset (SD_LEN = AST_LEN = 8)
    ld e,a
    ld d,0
    ld ix,(GAME_SPRTAB)
    add ix,de
    ld iy,AST
    add iy,de
    ld a,(ix+SD_H)              ; height 1..16
    or a
    jr nz,.h1
    inc a
.h1:
    cp PHASE_ROWS+1
    jr c,.h2
    ld a,PHASE_ROWS
.h2:
    ld (iy+AST_H),a
    ld (V_H),a
    ld a,(ix+SD_W)              ; width 8 or 16
    cp 9
    ld a,1
    jr c,.w8
    inc a
.w8:
    ld (iy+AST_WB),a
    ld a,(ix+SD_PHASES)         ; phases: the largest of 1, 2, 4, 8 not above the value
    ld b,1
    ld c,$F8
    cp 2
    jr c,.pdone
    ld b,2
    ld c,$FC
    cp 4
    jr c,.pdone
    ld b,4
    ld c,$FE
    cp 8
    jr c,.pdone
    ld b,8
    ld c,$FF
.pdone:
    ld (iy+AST_PHASES),b
    ld (iy+AST_XMASK),c
    ld a,c
    cpl
    and 7
    inc a                       ; bits between two phases: 8, 4, 2, 1
    ld (V_SHIFTS),a
    ld a,b
    ld (V_PHASES),a
    ld l,(ix+SD_HOT)            ; the collision box
    ld h,(ix+SD_HOT+1)
    ld a,h
    or l
    jr nz,.hot
    xor a
    ld (iy+AST_HOT),a
    ld (iy+AST_HOT+1),a
    ld a,(iy+AST_WB)
    add a,a
    add a,a
    add a,a
    ld (iy+AST_HOT+2),a         ; width
    ld a,(iy+AST_H)
    ld (iy+AST_HOT+3),a         ; height
    jr .hotdone
.hot:
    ld a,(hl)
    inc hl
    ld (iy+AST_HOT),a
    ld a,(hl)
    inc hl
    ld (iy+AST_HOT+1),a
    ld a,(hl)
    inc hl
    ld (iy+AST_HOT+2),a
    ld a,(hl)
    ld (iy+AST_HOT+3),a
.hotdone:
    ld l,(ix+SD_DATA)           ; ---- the art into VBUF ----
    ld h,(ix+SD_DATA+1)
    ld de,VBUF
    ld a,(V_H)
    ld b,a
    ld a,(iy+AST_WB)
    cp 2
    jr z,.build16
.build8:                        ; 2 bytes a row: mask, image
    ld a,(hl)
    inc hl
    ld (de),a                   ; m0
    inc de
    ld a,(hl)
    inc hl
    ld (de),a                   ; i0
    inc de
    ld a,$FF
    ld (de),a                   ; m1
    inc de
    xor a
    ld (de),a                   ; i1
    inc de
    ld a,$FF
    ld (de),a                   ; m2
    inc de
    xor a
    ld (de),a                   ; i2
    inc de
    djnz .build8
    jr .built
.build16:                       ; 4 bytes a row: mask_hi, mask_lo, image_hi, image_lo
    ld a,(hl)
    inc hl
    ld (de),a                   ; m0 = mask_hi
    inc de
    inc de
    ld a,(hl)
    inc hl
    ld (de),a                   ; m1 = mask_lo
    dec de
    ld a,(hl)
    inc hl
    ld (de),a                   ; i0 = image_hi
    inc de
    inc de
    ld a,(hl)
    inc hl
    ld (de),a                   ; i1 = image_lo
    inc de
    ld a,$FF
    ld (de),a                   ; m2
    inc de
    xor a
    ld (de),a                   ; i2
    inc de
    djnz .build16
.built:
    xor a
    ld (V_ROWSAVE),a            ; the shift of the copy being made (0, g, 2g, ...)
.phase:
    call pack_phase
    ld hl,V_PHASES
    dec (hl)
    ret z                       ; all phases made
    ld a,(V_SHIFTS)
    ld b,a
.sh:
    push bc
    call shift_vbuf
    pop bc
    djnz .sh
    ld a,(V_ROWSAVE)
    ld hl,V_SHIFTS
    add a,(hl)
    ld (V_ROWSAVE),a
    jr .phase

; pack_phase: the phase copy for shift V_ROWSAVE of asset V_ASSET: take the next slot, point PHASE_PTR at it, copy the first 2 x wb bytes of
; the V_H rows of VBUF.  Clobbers AF, BC, DE, HL (IX, IY kept).
pack_phase:
    ld a,(V_ROWSAVE)
    or a                        ; Z when the shift is 0
    ld a,(iy+AST_WB)
    jr z,.wb
    inc a                       ; one more byte when not byte aligned
.wb:
    add a,a
    ld (V_NEXT),a               ; bytes copied per row: 2 x wb  (2, 4 or 6)
    ld a,(V_SLOT)
    ld c,a
    inc a
    ld (V_SLOT),a
    ld a,c
    add a,a
    ld l,a
    ld h,0
    ld de,SLOT_TAB
    add hl,de
    ld e,(hl)
    inc hl
    ld d,(hl)                   ; DE = the slot
    ld a,(V_ASSET)
    rlca
    rlca
    rlca
    rlca                        ; 16 * asset
    ld l,a
    ld a,(V_ROWSAVE)
    add a,a
    add a,l
    add a,PHASE_PTR&$FF
    ld l,a
    ld h,PHASE_PTR>>8
    ld (hl),e
    inc l
    ld (hl),d                   ; PHASE_PTR[asset][shift] = slot
    ld hl,VBUF
    ld a,(V_H)
    ld b,a
.row:
    push bc
    ld a,(V_NEXT)
    ld c,a
    ld b,0
    ldir                        ; the 2 x wb bytes of the row
    ld a,(V_NEXT)
    ld c,a
    ld a,PHASE_ROWLEN
    sub c                       ; the bytes of the row not copied
    add a,l                     ; HL += them (VBUF is page aligned and 96 bytes long: L cannot carry)
    ld l,a
    pop bc
    djnz .row
    ret

; shift_vbuf: shift the V_H rows of VBUF right by one bit: the three mask bytes (m0 m1 m2) with a 1 entering at the left, the three image
; bytes with a 0.  Clobbers AF, B, HL.
shift_vbuf:
    ld hl,VBUF
    ld a,(V_H)
    ld b,a
.row:
    scf
    rr (hl)                     ; m0
    inc hl
    inc hl
    rr (hl)                     ; m1
    inc hl
    inc hl
    rr (hl)                     ; m2
    dec hl
    dec hl
    dec hl                      ; i0
    or a
    rr (hl)
    inc hl
    inc hl
    rr (hl)                     ; i1
    inc hl
    inc hl
    rr (hl)                     ; i2
    inc hl                      ; the next row
    djnz .row
    ret

; The slots: SLOT_TAB[n] = the address of phase slot n (POOL_A, POOL_B, then POOL_C).
SLOT_TAB:
    DUP POOL_A_SLOTS, n
    DW POOL_A+n*PHASE_LEN
    EDUP
    DUP POOL_B_SLOTS, n
    DW POOL_B+n*PHASE_LEN
    EDUP
    DUP POOL_C_SLOTS, n
    DW POOL_C+n*PHASE_LEN
    EDUP
M_ASSETS_E:
