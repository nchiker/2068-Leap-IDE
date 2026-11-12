; q.asm -- candidate Q of the billboard spike: quantised pre-scaled sets (docs/ARCADE_BILLBOARDS_CONTRACT.md 2 and 3).
; The compiler (ref.mjs buildQSet) emits each frame at n heights Hs, column-sampled at colw with column 0 at every byte phase (2 phases at
; 4 px, 4 at 2 px): per (s, phase) Hs rows of Bq (mask, image) pairs.  The runtime picks the nearest Hs to hpx, snaps the billboard to the ray
; grid (column c is ray jL + c, jL = floor((sxc - wq / 2 + colw / 2) / colw)), and draws the set's rows 1:1 standing on the floor (top =
; 48 + hgt - Hs).  The set is in a bank: the visible rectangle is staged into RAM (QSTAGE, rows of 2 nb bytes, one LDIR when the set is not
; clipped left or right), hidden columns are folded into the staged bytes (mask 1, image 0), then a copy like A's draws it (INC HL: 44 T a byte).
; -DQMAP=1 (QM): the sets are readable in place (mapped, not banked): no staging unless a column must be folded.  The reference is ref.mjs drawQ.
; Entry q_draw: A = instance; its record as bb_project leaves it, but BR_FRAME = the frame's set directory:
;   + 0 n, + 1 .. n - 1 the thresholds (s = the number of thresholds <= hpx), + 16 + 16 s: Hs, ncq, wq, 0, then per phase (pointer, Bq).
; The bank switch (bank_on / bank_off around the staging) is not modelled here (no DOCK in the test machine); RESULTS.md adds its cost.

    IFNDEF QMAP
      DEFINE QMAP 0
    ENDIF
q_draw:
    ld (R_BI),a
    add a,a
    add a,a
    add a,a
    add a,a
    ld l,a
    ld h,RAY_BREC>>8
    push hl
    pop iy
    ld a,(iy+BR_TX)
    ld (A_TX),a
    ld a,(iy+BR_TX+1)
    ld (A_TX+1),a
    ; ---- the height: s = thresholds <= hpx ----
    ld l,(iy+BR_FRAME)
    ld h,(iy+BR_FRAME+1)
    push hl
    ld b,(hl)
    dec b
    ld c,0
    ld a,(iy+BR_HPX)
    jr z,.thd
.th:
    inc hl
    cp (hl)
    jr c,.thd
    inc c
    djnz .th
.thd:
    pop hl
    ld a,c
    add a,a
    add a,a
    add a,a
    add a,a
    add a,16
    ld e,a
    ld d,0
    add hl,de
    ld a,(hl)
    ld (Q_HS),a
    inc hl
    ld a,(hl)
    ld (Q_NC),a
    inc hl
    ld b,(hl)                   ; wq
    inc hl
    inc hl
    push hl                     ; the phases
    ; ---- jL = floor((sxc - wq >> 1 + half) / colw), sxc = L + wpx >> 1 ----
    ld a,(iy+BR_WPX)
    srl a
    ld e,a
    ld d,0
    ld l,(iy+BR_L)
    ld h,(iy+BR_L+1)
    add hl,de
    ld a,b
    srl a
    ld e,a
    or a
    sbc hl,de
    ld a,(VD_COLW)
    cp 4
    jr nz,.c2
    inc hl
    inc hl
    sra h
    rr l
    sra h
    rr l
    jr .c3
.c2:
    inc hl
    sra h
    rr l
.c3:
    ld (Q_JL),hl
    ld a,(R_PMASK)
    and l
    ld (Q_PH),a
    ld e,a                      ; the phase's (pointer, Bq)
    add a,a
    add a,e
    ld e,a
    ld d,0
    pop hl
    add hl,de
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl
    ld (Q_PTR),de
    ld a,(hl)
    ld (Q_BQ),a
    ; ---- the columns: QV[c] = 0 drawn, 1 hidden (outside the view or behind a wall); the first and last drawn ----
    ld a,$FF
    ld (Q_CF),a
    ld hl,(Q_JL)
    ld a,(Q_NC)
    ld b,a
    ld de,QV
.qc:
    ld a,h
    or a
    jr nz,.qh                   ; j < 0 (or >= 256)
    ld a,(VD_NRAY)
    dec a
    cp l
    jr c,.qh                    ; j >= N
    push hl
    ld h,RAY_DISTL>>8
    set 6,l
    ld a,(A_TX+1)
    cp (hl)
    jr c,.qv
    jr nz,.qh0
    res 6,l
    ld a,(A_TX)
    cp (hl)
    jr nc,.qh0
.qv:
    pop hl
    xor a
    ld (de),a
    ld a,e
    ld (Q_CL),a
    ld a,(Q_CF)
    inc a
    jr nz,.qn
    ld a,e
    ld (Q_CF),a
    jr .qn
.qh0:
    pop hl
.qh:
    ld a,1
    ld (de),a
.qn:
    inc e
    inc hl
    djnz .qc
    ld a,(Q_CF)
    inc a
    ret z                       ; no column drawn
    ; ---- BB_TAB ----
    ld a,(R_BI)
    add a,a
    add a,a
    ld l,a
    ld h,BB_TAB>>8
    ld a,(A_TX)
    ld (hl),a
    inc l
    ld a,(A_TX+1)
    ld (hl),a
    inc l
    ld a,(iy+BR_COL)
    ld (hl),a
    inc l
    ld (hl),0
    ; ---- the data bytes drawn: b0 = (ph + cf) >> log2 R .. (ph + cl) >> log2 R ----
    ld a,(Q_PH)
    ld hl,Q_CF
    add a,(hl)
    call q_byte
    ld (Q_B0),a
    ld e,a
    ld a,(Q_PH)
    ld hl,Q_CL
    add a,(hl)
    call q_byte
    sub e
    inc a
    ld (Q_NB),a
    ld (QT_N+1),a
    add a,a
    neg
    add a,32
    ld (QT_K+1),a               ; 32 - 2 nb
    ; ---- the hide masks of the drawn bytes (hidden columns cf .. cl) ----
    xor a
    ld (Q_HID),a
    ld hl,QHM
    ld a,(Q_NB)
    ld b,a
    xor a
.hz:
    ld (hl),a
    inc l
    djnz .hz
    ; every column whose byte is drawn: c = R b0 - ph .. R (b0 + nb) - ph - 1, inside 0 .. ncq - 1 (a drawn byte may also hold
    ; hidden columns left of cf or right of cl)
    ld a,(Q_B0)
    call q_mulr
    ld hl,Q_PH
    sub (hl)
    jr nc,.cs
    xor a
.cs:
    ld c,a
    ld a,(Q_B0)
    ld hl,Q_NB
    add a,(hl)
    call q_mulr
    ld hl,Q_PH
    sub (hl)
    dec a
    ld hl,Q_NC
    cp (hl)
    jr c,.ce
    ld a,(hl)
    dec a
.ce:
    ld (Q_CL),a                 ; (Q_CL now the last column to look at)
.hm:
    ld a,c
    ld hl,Q_CL
    cp (hl)
    jr z,.hm1
    jr nc,.hme
.hm1:
    ld l,c                      ; (QV is page aligned)
    ld h,QV>>8
    ld a,(hl)
    or a
    jr z,.hmn
    ld (Q_HID),a
    ld a,(Q_PH)
    add a,c
    ld b,a
    ld a,(R_PMASK)
    and b
    add a,R_CM&$FF
    ld l,a
    ld h,R_CM>>8
    ld d,(hl)                   ; D = cm of the position
    ld a,b
    call q_byte
    ld hl,Q_B0
    sub (hl)
    add a,QHM&$FF
    ld l,a
    ld h,QHM>>8
    ld a,(hl)
    or d
    ld (hl),a
.hmn:
    inc c
    jr .hm
.hme:
    ; ---- the rows: window rows max(0, top) .. 48 + hgt - 1, top = 48 + hgt - Hs; set row r0 = rt - top ----
    ld a,(iy+BR_HGT)
    add a,VIEW_HH
    ld b,a
    ld hl,Q_HS
    sub (hl)
    ld c,0
    jr nc,.tp
    neg
    ld c,a
    xor a
.tp:
    ld (A_RT),a
    ld e,a
    ld a,b
    sub e
    ld (A_ROWS),a
    ld a,c
    ld (Q_R0),a
    ; ---- the set's first byte drawn: Q_PTR + r0 2 Bq + 2 b0; the set's skip between drawn rows: 2 (Bq - nb) ----
    ld a,(Q_BQ)
    add a,a
    ld e,a
    ld d,0
    ld a,(Q_R0)
    call mul8x16c               ; L:C = r0 2 Bq
    ld h,l
    ld l,c
    ld de,(Q_PTR)
    add hl,de
    ld a,(Q_B0)
    add a,a
    ld e,a
    ld d,0
    add hl,de
    ld a,(Q_NB)
    ld c,a
    ld a,(Q_BQ)
    sub c
    add a,a
    ld (QT_K+1),a
  IF QMAP
    ld a,(Q_HID)                ; QM: nothing to fold: the copy reads the set where it is
    or a
    jr nz,.stage
    ld de,$C67D                 ; the tail skips 2 (Bq - nb) bytes of the set (LD A,L / ADD A,n)
    ld (QT_SK),de
    jp .go
.stage:
  ENDIF
    ; ---- stage: rows r0 .. r0 + rows - 1, data bytes b0 .. b0 + nb - 1, to QSTAGE in rows of 2 nb bytes ----
.stg:
    ld de,QSTAGE
    ld a,(QT_K+1)
    or a
    jr nz,.strow
    push hl                     ; the set is not clipped left or right: one block of rows x 2 nb bytes
    ld a,(Q_NB)
    add a,a
    ld e,a
    ld d,0
    ld a,(A_ROWS)
    call mul8x16c               ; L:C = rows 2 nb
    ld b,l
    pop hl
    ld de,QSTAGE
    ldir
    jr .staged
.strow:
    ld a,(A_ROWS)
    ld (Q_CNT),a
.st:
    ld a,(Q_NB)
    add a,a
    ld c,a
    ld b,0
    ldir
    ld a,(QT_K+1)
    ld c,a
    add hl,bc
    ld a,(Q_CNT)
    dec a
    ld (Q_CNT),a
    jr nz,.st
.staged:
    ld hl,$E9DD                 ; the staged rows follow each other: the tail skips nothing (JP (IX) over LD A,L / ADD A,n)
    ld (QT_SK),hl
    ; ---- fold the hidden columns: mask |= hm, image &= ~hm in every staged row ----
    ld a,(Q_HID)
    or a
    jr z,.nofold
    ld a,(Q_NB)
    ld b,a
    ld c,0                      ; C = byte index
.fb:
    push bc
    ld a,c
    add a,QHM&$FF
    ld l,a
    ld h,QHM>>8
    ld a,(hl)
    or a
    jr z,.fbn
    ld d,a                      ; D = hm
    cpl
    ld e,a                      ; E = ~hm
    ld a,c
    add a,a
    ld l,a
    ld h,QSTAGE>>8
    ld a,(Q_NB)
    add a,a
    dec a
    ld c,a                      ; C = 2 nb - 1
    ld a,(A_ROWS)
    ld b,a
.fr:
    ld a,(hl)
    or d
    ld (hl),a
    inc hl
    ld a,(hl)
    and e
    ld (hl),a
    ld a,l
    add a,c
    ld l,a
    jr nc,.fr1
    inc h
.fr1:
    djnz .fr
.fbn:
    pop bc
    inc c
    djnz .fb
.nofold:
    ld hl,QSTAGE
.go:
    ; ---- the copy: DE = screen (first window row, byte column VIEW_CX + kq0 + b0), HL = the first byte (QSTAGE or the set), B = rows ----
    push hl
    ld a,(A_RT)
    add a,VIEW_CY*8
    ld b,a
    and $C0
    rrca
    rrca
    rrca
    ld l,a
    ld a,b
    and 7
    or l
    ld l,a
    ld a,(V_HOFF)
    or DFILE0>>8
    or l
    ld h,a
    ld a,b
    and $38
    rlca
    rlca
    ld l,a
    push hl
    ld hl,(Q_JL)                ; kq0 = (jL - ph) >> log2 R; the screen byte column = kq0 + b0 (0..15)
    ld a,(Q_PH)
    ld e,a
    ld a,l
    sub e
    call q_byte
    ld hl,Q_B0
    add a,(hl)
    add a,VIEW_CX
    pop hl
    or l
    ld l,a
    ex de,hl
    ld a,(Q_NB)
    ld b,a
    ld a,16
    sub b
    ld c,a
    add a,a
    add a,a
    add a,a
    sub c
    ld c,a
    ld b,0
    ld ix,q_copy
    add ix,bc
    pop hl
    ld a,(A_ROWS)
    ld b,a
    jp (ix)

; q_byte: A = a position count from the data's byte 0 (or a signed ray) -> A = A >> log2 R (arithmetic).  Clobbers nothing else.
q_byte:
    push bc
    ld b,a
    ld a,(VD_COLW)
    cp 4
    ld a,b
    jr z,.q4
    sra a
.q4:
    sra a
    pop bc
    ret
; q_mulr: A -> A R (R = 8 / colw rays per byte).  Clobbers F.
q_mulr:
    push bc
    ld b,a
    ld a,(VD_COLW)
    cp 4
    ld a,b
    jr z,.m4
    add a,a
.m4:
    add a,a
    pop bc
    ret
q_rom_e:

; ===================================================================================================================================
; RAM: Q's copy (as A's, with INC HL: the staged rows are 2 nb bytes long and may cross a page) and its row tail.
q_ram_s:
q_copy:
    REPT 16
    ld a,(de)
    and (hl)
    inc hl
    or (hl)
    inc hl
    ld (de),a
    inc e
    ENDR
q_tail:
    ld a,e
QT_N:
    sub 0
    ld e,a
    inc d
    ld a,d
    and 7
    jr nz,.ok
    ld a,e
    add a,32
    ld e,a
    jr c,.ok
    ld a,d
    sub 8
    ld d,a
.ok:
    dec b
    ret z
QT_SK:                          ; staged: JP (IX) here; QM reading the set in place: skip 2 (Bq - nb) bytes
    ld a,l
QT_K:
    add a,0
    ld l,a
    jr nc,.n
    inc h
.n:
    jp (ix)
q_ram_e:
