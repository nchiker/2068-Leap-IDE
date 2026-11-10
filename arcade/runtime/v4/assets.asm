; assets.asm -- the sprite art of runtime v3 (docs/ARCADE_RUNTIME_API_V3.md "As built (v3 part 1)", layout.inc "THE PHASE POOL"):
;   boot:  read the asset descriptors (v3: DB w, DB h, DW data, DW hot, DB phases, DB nframes) and the instance table, clamp them, build the asset
;          records (AST), PHASE_OFF and SPR_TAB, plan the phase pool (FTABs and frame slots), build the frames that start in a slot;
;   play:  build_frame (the pre-shifted copies of one frame into its slot) and fc_miss (a frame that is not in the cache: pick a victim slot, build).
; Lives in DOCK chunks 0-1 (no ORG: follows sound.asm).
;
; Clamps (a bad header never crashes the boot):
;   sprite_count > MAX_ASSETS (8) is read as 8; sprite_table 0 means no assets.
;   width <= 8 is read as 8, <= 16 as 16, <= 24 as 24, otherwise 32; height 0 is read as 1, above 48 as 48; nframes 0 as 1, above 32 as 32.
;   phases: 0 or 1 -> 1, 2..3 -> 2, 4..7 -> 4, 8 and above -> 8 (the largest of {1, 2, 4, 8} not above the value).
;   inst_table 0 = no instances; ninst > MAX_SPRITES (16) is read as 16; with no asset ninst is 0; an instance's asset index >= sprite_count
;   is read as sprite_count - 1.
    ; (no ORG: follows sound.asm)
M_ASSETS_S:

build_assets:                   ; (PHASE_OFF was cleared by video_init: no shift of any asset yet; AST and SPR_TAB with the rest of chunk 6)
    ld a,(GAME_NSPR)
    cp MAX_ASSETS+1
    jr c,.nok
    ld a,MAX_ASSETS             ; more assets than records: read as 8
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
    ld (V_ASSET),a
.next:
    ld a,(V_NAST)
    ld hl,V_ASSET
    cp (hl)
    jr z,.insts
    call read_desc
    ld hl,V_ASSET
    inc (hl)
    jr .next
.insts:                         ; ---- the instance table (v4: in ray mode it ends in ray_assets, not plan_pool) ----
    xor a
    ld (V_NINST),a
    ld a,(V_NAST)
    or a
    jr z,plan_pool              ; no asset: no instance
    ld hl,(GAME_INSTTAB)
    ld a,h
    or l
    jr z,plan_pool              ; inst_table 0: none
    ld a,(hl)
    inc hl
    cp MAX_SPRITES+1
    jr c,.n
    ld a,MAX_SPRITES
.n:
    ld (V_NINST),a
    or a
    jr z,plan_pool
    ld b,a
    ld a,(V_NAST)
    ld c,a                      ; C = number of assets
    ld de,SPR_TAB+SPR_ASSET_OFF ; (SPR_TAB was cleared with the rest of chunk 6: visible 0, x = y = 0, frame 0)
.inst:
    ld a,(hl)
    inc hl
    cp c
    jr c,.aok
    ld a,c
    dec a                       ; asset index >= count: the last asset
.aok:
    ld (de),a
    push hl                     ; AST_NINST[asset] += 1
    add a,a
    add a,a
    add a,a
    add a,a
    add a,(AST&$FF)+AST_NINST
    ld l,a
    ld h,AST>>8
    inc (hl)
    pop hl
    ld a,e
    add a,SPR_ENT
    ld e,a
    djnz .inst
    ; (falls into plan_pool)

; ---------------------------------------------------------------------------------------------------------------
; plan_pool: the phase pool plan (layout.inc "THE PHASE POOL"; the linker repeats it: docs/ARCADE_RUNTIME_API_V3.md).  IX = the asset record.
; ---------------------------------------------------------------------------------------------------------------
plan_pool:
    ld a,(V_RAY)                ; v4: ray mode has no phase pool (billboards are drawn from the game image): ray.asm ray_assets
    or a
    jp nz,ray_assets
    ld hl,POOL_A                ; (FC_MISS and FC_MISSES are 0: boot cleared $E000-$F1FF)
    ld (FC_NEXT),hl
    ld hl,POOL_B
    ld (FC_NEXT+2),hl
    ld hl,POOL_C
    ld (FC_NEXT+4),hl
    ; ---- 1. the FTAB of every used asset: nframes x (DW rom, DW slot = 0) ----
    xor a
.ft:
    call pp_asset               ; IX = record; carry = past the last asset, Z = unused
    jr c,.ftdone
    jr z,.ftnext
    ld a,(ix+AST_NF)
    add a,a
    add a,a
    ld c,a
    ld b,0                      ; BC = 4 x nframes
    call pool_alloc
    jr nc,.ftok
    call pp_miss
    jr .ftnext
.ftok:
    ld (ix+AST_FTAB),l
    ld (ix+AST_FTAB+1),h
    push hl                     ; FTAB
    ld b,0                      ; the rows of frame f are at data + f x h x 2 wb
    ld c,(ix+AST_H)
    ld hl,0
    ld a,(ix+AST_WB)
    add a,a
.fs:
    add hl,bc
    dec a
    jr nz,.fs
    push hl                     ; the bytes of one frame
    ld a,(FC_A)
    add a,a
    add a,a
    add a,a                     ; 8 x asset: the descriptor
    ld e,a
    ld d,0
    ld hl,(GAME_SPRTAB)
    add hl,de
    inc hl
    inc hl
    ld e,(hl)
    inc hl
    ld d,(hl)                   ; DE = data
    pop bc                      ; BC = frame bytes
    pop hl                      ; HL = FTAB
    ld a,(ix+AST_NF)
.fte:
    ld (hl),e
    inc hl
    ld (hl),d
    inc hl
    ld (hl),0
    inc hl
    ld (hl),0
    inc hl
    ex de,hl
    add hl,bc
    ex de,hl
    dec a
    jr nz,.fte
.ftnext:
    ld a,(FC_A)
    inc a
    jr .ft
.ftdone:
    ; ---- 2. min(nframes, instances) slots of every used asset with phases > 1 ----
    xor a
.mk:
    call pp_asset
    jr c,.mkdone
    jr z,.mknext
    call pp_slen
    jr z,.mknext                ; one phase: no slot
    ld a,(ix+AST_NINST)
    cp (ix+AST_NF)
    jr c,.mkn
    ld a,(ix+AST_NF)
.mkn:
    ld b,a                      ; K0 = min(instances, nframes) >= 1
.mks:
    push bc
    ld bc,(FC_SLEN)
    call pool_alloc
    jr nc,.mkok
    call pp_miss
    jr .mkl
.mkok:
    call pp_assign
.mkl:
    pop bc
    djnz .mks
.mknext:
    ld a,(FC_A)
    inc a
    jr .mk
.mkdone:
    ld hl,(FC_MISS)
    ld a,h
    or l
    jp nz,pool_fail
    ; ---- 3. more slots, asset by asset, while they fit (up to nframes) ----
    xor a
.ex:
    call pp_asset
    jr c,.exdone
    jr z,.exnext
    call pp_slen
    jr z,.exnext
.exs:
    ld a,(ix+AST_K)
    cp (ix+AST_NF)
    jr nc,.exnext               ; every frame has its slot
    ld bc,(FC_SLEN)
    call pool_alloc
    jr c,.exnext                ; the next slot of this asset does not fit: the next asset
    call pp_assign
    jr .exs
.exnext:
    ld a,(FC_A)
    inc a
    jr .ex
.exdone:
    ; ---- 4. build the frames that have a slot (frames 0..K-1) ----
    xor a
.bd:
    call pp_asset
    ret c
    jr z,.bdnext
    ld a,(ix+AST_K)
    or a
    jr z,.bdnext
    ld b,a
    ld l,(ix+AST_FTAB)
    ld h,(ix+AST_FTAB+1)
.bdf:
    push bc
    push hl
    push ix
    ld a,(FC_A)
    call build_frame            ; frame entry HL (its slot is set), asset A
    pop ix
    pop hl
    ld de,FTE_LEN
    add hl,de
    pop bc
    djnz .bdf
.bdnext:
    ld a,(FC_A)
    inc a
    jr .bd

; pool_fail: the art does not fit the phase pool (FC_MISS = the bytes that did not fit).  Stop: magenta border, interrupts off.
pool_fail:
    di
    ld a,POOL_FAIL_BORDER
    out (PORT_ULA),a
    jr $

; pp_asset: A = asset index -> FC_A = A, IX = its record; carry = A >= V_NAST (past the last asset); else Z = unused (no instance).
; Clobbers AF, DE, HL.
pp_asset:
    ld (FC_A),a
    ld hl,V_NAST
    cp (hl)
    ccf
    ret c
    add a,a
    add a,a
    add a,a
    add a,a
    ld e,a
    ld d,0
    ld ix,AST
    add ix,de
    ld a,(ix+AST_NINST)
    or a                        ; (clears the carry)
    ret

; pp_slen: FC_SLEN = (phases - 1) x CLEN of the asset at IX; Z when phases = 1.  Clobbers AF, BC, HL.
pp_slen:
    ld hl,0
    ld c,(ix+AST_CLEN)
    ld b,(ix+AST_CLEN+1)
    ld a,(ix+AST_PHASES)
    dec a
    jr z,.z
.m:
    add hl,bc
    dec a
    jr nz,.m
    ld (FC_SLEN),hl
    or 1                        ; NZ
    ret
.z:
    ld (FC_SLEN),hl
    ret

; pp_miss: FC_MISS += BC.  Clobbers HL.
pp_miss:
    ld hl,(FC_MISS)
    add hl,bc
    ld (FC_MISS),hl
    ret

; pp_assign: HL = a new slot of the asset at IX: frame AST_K gets it (if the asset has its FTAB), AST_K += 1.  Clobbers AF, DE, HL.
pp_assign:
    ex de,hl                    ; DE = slot
    ld l,(ix+AST_FTAB)
    ld h,(ix+AST_FTAB+1)
    ld a,h
    or l
    ret z                       ; no FTAB (it did not fit: the boot stops anyway)
    ld a,(ix+AST_K)
    inc (ix+AST_K)
    add a,a
    add a,a
    add a,2                     ; + 4 K + 2: the slot word of frame K
    add a,l
    ld l,a
    jr nc,.c
    inc h
.c:
    ld (hl),e
    inc hl
    ld (hl),d
    ret

; pool_alloc: BC = bytes (1..3,360) -> HL = the first of BC free bytes, carry clear; or carry set when no piece has room.  First fit over
; POOL_A, POOL_B, POOL_C in that order (an allocation never straddles two pieces).  Clobbers AF, DE, HL.
    MACRO TRY_PIECE nextvar, pend
        ld hl,(nextvar)
        add hl,bc               ; the new next
        jr c,1F                 ; past $FFFF (POOL_B: $FA80 + 3,360 would wrap)
        ex de,hl
        ld hl,pend
        or a
        sbc hl,de               ; carry: the new next is past the end
        jr c,1F
        ld hl,(nextvar)         ; (LD keeps the flags: carry clear)
        ld (nextvar),de
        ret
1:
    ENDM
pool_alloc:
    TRY_PIECE FC_NEXT, POOL_A+POOL_A_LEN
    TRY_PIECE FC_NEXT+2, POOL_B+POOL_B_LEN
    TRY_PIECE FC_NEXT+4, POOL_C+POOL_C_LEN
    scf
    ret

; read_desc: asset V_ASSET -> its AST record (H, WB, XMASK, PHASES, HOT, NF, CLEN; the rest stays 0) and its PHASE_OFF row.
; Clobbers everything; IX = descriptor, IY = AST record.
read_desc:
    ld a,(V_ASSET)
    add a,a
    add a,a
    add a,a                     ; 8 * asset (SD_LEN = 8)
    ld e,a
    ld d,0
    ld ix,(GAME_SPRTAB)
    add ix,de
    ld a,e
    add a,a                     ; 16 * asset (AST_LEN = 16; 8 * asset <= 56, so it fits the byte); D is still 0
    ld e,a
    ld iy,AST
    add iy,de
    ld a,(ix+SD_H)              ; height 1..48
    or a
    jr nz,.h1
    inc a
.h1:
    cp MAX_H+1
    jr c,.h2
    ld a,MAX_H
.h2:
    ld (iy+AST_H),a
    ld a,(ix+SD_W)              ; width 8, 16, 24 or 32 -> wb 1..4
    ld b,1
    cp 9
    jr c,.w
    inc b
    cp 17
    jr c,.w
    inc b
    cp 25
    jr c,.w
    inc b
.w:
    ld (iy+AST_WB),b
    ld a,(ix+SD_PHASES)         ; phases: the largest of 1, 2, 4, 8 not above the value
    ld b,8                      ; B = the phases, C = the x mask: 8 / $FF, 4 / $FE, 2 / $FC, 1 / $F8
    ld c,$FF
.p:
    cp b
    jr nc,.pdone
    bit 0,b
    jr nz,.pdone                ; 1: the least (a value of 0 is read as 1)
    srl b
    sla c
    jr .p
.pdone:
    ld (iy+AST_PHASES),b
    ld (iy+AST_XMASK),c
    ld a,(ix+SD_NFRAMES)        ; frames 1..32 (0 = 1)
    or a
    jr nz,.f1
    inc a
.f1:
    cp MAX_FRAMES+1
    jr c,.f2
    ld a,MAX_FRAMES
.f2:
    ld (iy+AST_NF),a
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
    push iy
    pop de
    ld a,e
    add a,AST_HOT               ; (no carry: asserted below)
    ld e,a                      ; DE -> the record's hot x, y, w, h
    ldi
    ldi
    ldi
    ldi                         ; the four bytes of the descriptor's box
.hotdone:
    ld b,0                      ; CLEN = h x 2 (wb + 1)
    ld c,(iy+AST_H)
    ld hl,0
    ld a,(iy+AST_WB)
    inc a
    add a,a
.cl:
    add hl,bc
    dec a
    jr nz,.cl
    ld (iy+AST_CLEN),l
    ld (iy+AST_CLEN+1),h
    ld (V_PTR),hl
    push iy                     ; PHASE_OFF[a][q g] = (q - 1) x CLEN, q = 1..phases-1
    pop hl                      ; IY = AST + 16 * asset: its low byte is (AST & $FF) + 16 * asset, so the row's low byte follows by a constant
    ld a,l
    add a,(PHASE_OFF&$FF)-(AST&$FF)
    ld l,a
    ld h,PHASE_OFF>>8           ; HL -> PHASE_OFF[a][0]
    ld a,(iy+AST_XMASK)
    cpl
    and 7
    inc a                       ; g = bits between two phases
    add a,a
    ld e,a                      ; E = 2 g: the step in the table
    ld a,(iy+AST_PHASES)
    dec a
    ret z                       ; one phase: no copy
    ld d,a
    ld bc,0
.po:
    ld a,l
    add a,e
    ld l,a                      ; (PHASE_OFF + 16 * 7 + 14 stays inside the page: asserted in sprite.asm)
    ld (hl),c
    inc l
    ld (hl),b
    dec l
    push hl
    ld hl,(V_PTR)
    add hl,bc
    ld b,h
    ld c,l
    pop hl
    dec d
    jr nz,.po
    ret

; ---------------------------------------------------------------------------------------------------------------
; build_frame: A = asset, HL = the FTAB entry of a frame whose slot is set: write the frame's pre-shifted copies (every non-zero shift of the
; asset: phase q = 1..phases-1, shift q x g bits, copy q at slot + (q - 1) x CLEN) from its rows in the game image.  A copy row is wb + 1
; (mask, image) pairs: the source row shifted right inside a window one byte wider (mask: 1s enter at the left and fill the extra byte;
; image: 0s).  Row by row: the row is loaded into registers (mask bytes B C H L A, image bytes in the alternate B' C' H' L' A'), then shifted g
; bits and stored for each phase in turn (IX walks the copies, stride CLEN).  Clobbers everything, the alternate set, IX and IY (callers in
; the frame loop save them: fc_miss).  Cost: about 1,300 T per row of a 16-wide 4-phase frame (docs/ARCADE_RUNTIME_API_V3.md).
; ---------------------------------------------------------------------------------------------------------------
build_frame:
    push hl
    add a,a
    add a,a
    add a,a
    add a,a
    add a,AST&$FF
    ld l,a
    ld h,AST>>8                 ; HL -> the record
    ld a,(hl)
    ld (BF_ROWS),a              ; AST_H
    ld a,l
    add a,AST_WB-AST_H
    ld l,a
    ld b,(hl)                   ; B = AST_WB
    inc l
    ld a,(hl)                   ; AST_XMASK
    cpl
    and 7
    inc a                       ; g
    exx
    ld d,a                      ; D' = g (the bit counter E' is reloaded from it)
    exx
    inc l
    ld a,(hl)                   ; AST_PHASES
    dec a
    ld (BF_NPH),a
    ld a,l
    add a,AST_CLEN-AST_PHASES
    ld l,a
    ld a,(hl)
    ld (BF_CLEN),a
    inc l
    ld a,(hl)
    ld (BF_CLEN+1),a
    pop hl                      ; the FTAB entry
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl
    push de
    pop iy                      ; IY = the frame's rows in the game image
    ld e,(hl)
    inc hl
    ld d,(hl)
    push de
    pop ix                      ; IX = the slot = copy 1, row 0
    ld a,b
    dec a
    jp z,bf_w1
    dec a
    jp z,bf_w2
    dec a
    jp z,bf_w3
    jp bf_w4

; BF_VARIANT name, wb: the row loop of build_frame for one source width (window wb + 1 bytes).  Mask registers B C H L A (the first wb + 1 of
; them), image registers the same in the alternate set; E' counts the bits of a phase, D' = g; DE = CLEN (IX stride to the next copy).
    MACRO BF_VARIANT name, wb
name:
.row:
        ld (BF_ROWDST),ix
        ld a,(BF_NPH)
        ld (BF_CNT),a
        ld b,(iy+0)             ; ---- the mask bytes, $FF in the extra byte ----
        IF wb >= 2
        ld c,(iy+1)
        ELSE
        ld c,$FF
        ENDIF
        IF wb >= 3
        ld h,(iy+2)
        ELSEIF wb == 2
        ld h,$FF
        ENDIF
        IF wb >= 4
        ld l,(iy+3)
        ld a,$FF
        ELSEIF wb == 3
        ld l,$FF
        ENDIF
        exx                     ; ---- the image bytes, 0 in the extra byte ----
        IF wb >= 4
        ex af,af'
        ENDIF
        ld b,(iy+wb)
        IF wb >= 2
        ld c,(iy+wb+1)
        ELSE
        ld c,0
        ENDIF
        IF wb >= 3
        ld h,(iy+wb+2)
        ELSEIF wb == 2
        ld h,0
        ENDIF
        IF wb >= 4
        ld l,(iy+wb+3)
        xor a
        ELSEIF wb == 3
        ld l,0
        ENDIF
        ld e,d                  ; E' = g
        IF wb >= 4
        ex af,af'
        ENDIF
        exx
        ld de,2*wb
        add iy,de               ; the next source row
        ld de,(BF_CLEN)
.ph:
.bit:                           ; one bit right: the mask with a 1 entering, the image with a 0
        scf
        rr b
        rr c
        IF wb >= 2
        rr h
        ENDIF
        IF wb >= 3
        rr l
        ENDIF
        IF wb >= 4
        rra
        ENDIF
        exx
        IF wb >= 4
        ex af,af'
        ENDIF
        or a
        rr b
        rr c
        IF wb >= 2
        rr h
        ENDIF
        IF wb >= 3
        rr l
        ENDIF
        IF wb >= 4
        rra
        ex af,af'
        ENDIF
        dec e
        exx
        jr nz,.bit
        ld (ix+0),b             ; ---- store the row of this phase: pairs (mask, image) ----
        ld (ix+2),c
        IF wb >= 2
        ld (ix+4),h
        ENDIF
        IF wb >= 3
        ld (ix+6),l
        ENDIF
        IF wb >= 4
        ld (ix+8),a
        ENDIF
        exx
        IF wb >= 4
        ex af,af'
        ENDIF
        ld (ix+1),b
        ld (ix+3),c
        IF wb >= 2
        ld (ix+5),h
        ENDIF
        IF wb >= 3
        ld (ix+7),l
        ENDIF
        IF wb >= 4
        ld (ix+9),a
        ex af,af'
        ENDIF
        ld e,d                  ; E' = g for the next phase
        exx
        add ix,de               ; the same row of the next copy
        push hl
        ld hl,BF_CNT
        dec (hl)
        pop hl
        jp nz,.ph
        ld ix,(BF_ROWDST)
        ld de,2*(wb+1)
        add ix,de               ; the next row of copy 1
        ld a,(BF_ROWS)
        dec a
        ld (BF_ROWS),a
        jp nz,.row
        ret
    ENDM
    BF_VARIANT bf_w1, 1
    BF_VARIANT bf_w2, 2
    BF_VARIANT bf_w3, 3
    BF_VARIANT bf_w4, 4

; ---------------------------------------------------------------------------------------------------------------
; fc_miss: A = asset, V_FTE = the FTAB entry of the frame wanted (its slot is 0; only an asset with K < nframes can miss) -> HL = the slot now
; holding that frame (0 if no victim was found, which the slot count rules out: K >= the instances of the asset).  The victim is the first
; frame from AST_RR on (round robin) that has a slot and that no visible instance of the asset shows (its frame clamped).  Clobbers AF, BC,
; DE, HL; IX, IY and the alternate set are saved (the tick work reaches 26 bytes of stack with build_frame).
; ---------------------------------------------------------------------------------------------------------------
fc_miss:
    push ix
    push iy
    exx
    push bc
    push de
    push hl
    exx
    ex af,af'
    push af
    ex af,af'
    ld (FC_A),a
    add a,a
    add a,a
    add a,a
    add a,a
    ld e,a
    ld d,0
    ld ix,AST
    add ix,de                   ; IX = the record
    ld hl,0                     ; ---- the protected frames ----
    ld (FC_PROT),hl
    ld (FC_PROT+2),hl
    ld a,(V_NINST)
    ld b,a
    ld hl,SPR_TAB
.pl:
    ld a,(hl)
    or a
    jr z,.pn                    ; hidden
    inc l
    ld c,(hl)                   ; the asset
    dec l
    ld a,(FC_A)
    cp c
    jr nz,.pn
    ld a,l
    add a,SPR_FRAME_OFF
    ld e,a
    ld d,h
    ld a,(de)                   ; its frame, clamped
    cp (ix+AST_NF)
    jr c,.pc
    ld a,(ix+AST_NF)
    dec a
.pc:
    call prot_bit
    ld a,(de)
    or c
    ld (de),a
.pn:
    ld a,l
    add a,SPR_ENT
    ld l,a
    djnz .pl
    ld a,(ix+AST_RR)            ; ---- the victim ----
    ld b,(ix+AST_NF)
.sc:
    ld (FC_F),a
    add a,a
    add a,a
    add a,(ix+AST_FTAB)
    ld l,a
    ld a,(ix+AST_FTAB+1)
    adc a,0
    ld h,a
    inc hl
    inc hl                      ; HL -> the slot word of frame g
    ld a,(hl)
    inc hl
    or (hl)
    jr z,.nx                    ; not cached
    ld a,(FC_F)
    call prot_bit
    ld a,(de)
    and c
    jr nz,.nx                   ; shown by an instance
    ld d,(hl)                   ; take its slot
    ld (hl),0
    dec hl
    ld e,(hl)
    ld (hl),0
    ld a,(FC_F)
    inc a
    cp (ix+AST_NF)
    jr c,.rr
    xor a
.rr:
    ld (ix+AST_RR),a
    ld hl,(V_FTE)
    inc hl
    inc hl
    ld (hl),e
    inc hl
    ld (hl),d
    push de
    ld hl,(V_FTE)
    ld a,(FC_A)
    call build_frame
    ld hl,(FC_MISSES)
    inc hl
    ld (FC_MISSES),hl
    pop hl
    jr .out
.nx:
    ld a,(FC_F)
    inc a
    cp (ix+AST_NF)
    jr c,.n2
    xor a
.n2:
    djnz .sc
    ld hl,0
.out:
    ex af,af'
    pop af
    ex af,af'
    exx
    pop hl
    pop de
    pop bc
    exx
    pop iy
    pop ix
    ret

; prot_bit: A = frame (0..31) -> DE = its byte in FC_PROT, C = its bit.  Clobbers AF, C, DE (B, HL kept).
prot_bit:
    ld c,a
    rrca
    rrca
    rrca
    and 3
    add a,FC_PROT&$FF
    ld e,a
    ld d,FC_PROT>>8
    ld a,c
    and 7
    ld c,1
    ret z
.s:
    sla c
    dec a
    jr nz,.s
    ret

    ASSERT (FC_PROT&$FF)+3 < 256
    ASSERT (AST&$FF)+AST_LEN*(MAX_ASSETS-1)+AST_HOT+3 < 256     ; read_desc: the hot box copy
    ASSERT (AST&$FF)+AST_LEN*(MAX_ASSETS-1) < 256 && (PHASE_OFF&$FF)+AST_LEN*(MAX_ASSETS-1) < 256      ; read_desc: 16 * asset is added to a low byte
    ASSERT AST_XMASK == AST_WB+1 && AST_PHASES == AST_XMASK+1      ; build_frame and draw_all walk the record with INC L
    ASSERT AST_NF == AST_H+1 && AST_FTAB == AST_NF+1 && AST_WB == AST_FTAB+2
; delta_axis (tileops.asm RT_COPY; the comment there): HL = destination - source position (from SBC), C = limit -> carry clear: A = the difference as a signed byte,
; |difference| < limit; carry set: the rectangles cannot overlap on this axis.  Clobbers AF.  Moved here from the end of the image: the code in front of
; sprite.asm is sized so that the sprite blitters' blocks need no alignment padding (a few bytes more or fewer there are not wasted when something
; else moves with them), so a routine that can live anywhere goes in front of it.
delta_axis:
    ld a,h
    or a
    jr z,.pos
    inc a
    jr nz,.big                  ; below -256
    ld a,l
    add a,c                     ; carry when difference >= -limit; zero then when it is exactly -limit
    jr nc,.big
    jr z,.big
    ld a,l
    or a
    ret
.pos:
    ld a,l
    cp c
    jr nc,.big
    or a
    ret
.big:
    scf
    ret

M_ASSETS_E:
