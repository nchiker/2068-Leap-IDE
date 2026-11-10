; skip.asm -- skip_analysis: which instances need neither an erase nor a draw this tick.  Lives in DOCK chunks 0-1 (no ORG: follows keys.asm).
;
; Every tick each instance is erased from the hidden display file (from the record of where it was drawn in THAT file) and drawn again.  For an
; instance that has not changed since it was drawn into BOTH files this is wasted work: the pixels are already there.  The analysis finds such
; instances and marks their record in the hidden file (flag $81); erase_all and draw_all leave a marked instance alone.
;
; "Unchanged" is tracked by RT_SHOW / RT_HIDE: V_CHG[i] is set to 2 when they change the instance (visibility or the clamped position) and
; draw_all lowers it by one for each display file the instance is drawn into, so it is 0 exactly when both files hold the instance as it is now.
; An instance is a CANDIDATE when it is visible, V_CHG = 0 and its record in the hidden file says it is drawn there.
;
; A candidate i is marked when
;   (a) none of the cells it covers is dirty for the hidden file (redraw_dirty would overwrite the part of the sprite in a dirty cell), and
;   (b) no other instance j that is drawn, was drawn or is visible has a cell rectangle that meets the one of i.
; Why this is enough: the erase of another instance restores whole cells and its draw touches only its own cells, both inside its rectangle, and
; the cell redraw touches only dirty cells; by (a) and (b) none of that lies on a cell of i, and the cells of i hold nothing but the map and i
; itself (nothing else was drawn there, by (b) applied to the previous ticks' records), so they already are what erase + draw would produce.
; Rectangles are in cells (cx0, cx1, cy0, cy1, inclusive) in SK_RECT[i]: a candidate's is exact (from its record: the bytes and rows its blit
; wrote); an idle instance's is (255, 0, 255, 0), which no rectangle meets; for the others it is the join of the 3 x 3 cells from the first cell of
; their old record and from the cell of their current position (v3: the join of the exact box of the old record and the box of the new position from the asset's size, cx1 = cx0 + wb covering a shifted copy).
;
; The analysis runs only when SKIP_MIN or more instances are candidates (see the measured cost in docs/ARCADE_RUNTIME_API_V2.md: it only pays off
; when about a third of the instances stand still; a skipped instance saves 3,000 to 5,000 T).  Out: V_ANYSKIP = 1 when at least one instance was marked.  Clobbers AF, BC, DE, HL.
    ; (no ORG: follows keys.asm)
M_SKIP_S:

SKIP_MIN        EQU 6
SK_T            EQU VARS+$F0            ; 8 bytes of scratch
SK_I            EQU SK_T+4              ; instance being looked at
SK_CNT          EQU SK_T+5

skip_analysis:
    xor a
    ld (V_ANYSKIP),a
    ld a,(V_NINST)
    or a
    ret z
    ld b,a
    ld c,0                      ; C = candidates (visible, nothing owed)
    ld hl,V_CHG
    ld de,SPR_TAB
.scan:
    ld a,(hl)
    or a
    jr nz,.nscan
    ld a,(de)
    or a
    jr z,.nscan
    inc c
.nscan:
    inc hl
    ld a,e
    add a,SPR_ENT
    ld e,a
    djnz .scan
    ld a,c
    cp SKIP_MIN
    ret c                       ; too few to pay for the analysis

; ---- pass A: the rectangle of every instance (SK_RECT) and its class (V_KIND: 0 idle, 1 changed, 2 candidate) ----
    xor a
    ld (SK_I),a
.ia:
    ld a,(SK_I)
    call sk_recptr              ; HL = the record in the hidden file
    ld a,(hl)
    or a
    jr z,.norec
    ld (hl),1                   ; (normalised: no stale mark)
.norec:
    ld d,a                      ; D = record flag (0 or non-zero)
    ld a,(SK_I)
    call sk_entptr              ; HL = the entry
    ld e,(hl)                   ; E = visible
    ld a,(SK_I)
    add a,V_CHG&$FF
    ld l,a
    ld h,V_CHG>>8
    ld c,(hl)                   ; C = owed ticks
    ld a,d
    or e
    jr z,.idle                  ; neither drawn nor visible
    ld a,d
    and e
    jr z,.kind1                 ; only one of them
    ld a,c
    or a
    jr nz,.kind1                ; changed since it was drawn
    ; ---- kind 2: the exact rectangle of its record ----
    ld a,(SK_I)
    call sk_recptr
    call sk_recrect             ; B = cx0, C = cx1, D = cy0, E = cy1
    ld a,2
    jr .store
    ; ---- kind 1: the join of the old box (if drawn: exact, from the record) and the new one (if visible: from the position and the asset) ----
.kind1:
    ld a,d
    ld (SK_T+7),a               ; the record flag
    ld a,(SK_I)
    call sk_entptr
    ld a,(hl)
    or a
    jr z,.k1old                 ; not visible: the old box alone
    call sk_entrect             ; B, C, D, E = the new box
    ld a,(SK_T+7)
    or a
    jr z,.k1done                ; nothing drawn: the new box alone
    ld hl,SK_T
    ld (hl),b
    inc l
    ld (hl),c
    inc l
    ld (hl),d
    inc l
    ld (hl),e
    ld a,(SK_I)
    call sk_recptr
    call sk_recrect             ; B, C, D, E = the old box
    ld hl,SK_T                  ; the join: min cx0, max cx1, min cy0, max cy1
    ld a,(hl)
    cp b
    jr nc,.j0
    ld b,a
.j0:
    inc l
    ld a,(hl)
    cp c
    jr c,.j1
    ld c,a
.j1:
    inc l
    ld a,(hl)
    cp d
    jr nc,.j2
    ld d,a
.j2:
    inc l
    ld a,(hl)
    cp e
    jr c,.k1done
    ld e,a
    jr .k1done
.k1old:
    ld a,(SK_I)
    call sk_recptr
    call sk_recrect
.k1done:
    ld a,1
    jr .store
.idle:
    ld b,255                    ; the rectangle no other rectangle meets
    ld c,0
    ld d,255
    ld e,0
    xor a
.store:                         ; A = class; B, C, D, E = the rectangle
    push af
    ld a,(SK_I)
    add a,a
    add a,a
    add a,SK_RECT&$FF
    ld l,a
    ld h,SK_RECT>>8
    ld (hl),b
    inc l
    ld (hl),c
    inc l
    ld (hl),d
    inc l
    ld (hl),e
    ld a,(SK_I)
    add a,V_KIND&$FF
    ld l,a
    ld h,V_KIND>>8
    pop af
    ld (hl),a
    ld hl,SK_I
    inc (hl)
    ld a,(V_NINST)
    cp (hl)
    jp nz,.ia

; ---- pass B: mark the candidates that are clean and alone ----
    xor a
    ld (SK_I),a
.ib:
    ld a,(SK_I)
    add a,V_KIND&$FF
    ld l,a
    ld h,V_KIND>>8
    ld a,(hl)
    cp 2
    jr nz,.nextb
    ld a,(SK_I)
    call sk_dirty               ; carry = a cell of the instance is dirty
    jr c,.nextb
    ld a,(SK_I)                 ; i's rectangle into registers; its own slot is made empty meanwhile so that i does not meet itself
    add a,a
    add a,a
    add a,SK_RECT&$FF
    ld l,a
    ld h,SK_RECT>>8
    ld b,(hl)
    ld (hl),255
    inc l
    ld c,(hl)
    inc l
    ld d,(hl)
    inc l
    ld e,(hl)
    push bc
    ld hl,SK_RECT
.jloop:                         ; all 16 slots (the unused ones hold the empty rectangle)
    ld a,(hl)                   ; j.cx0 > i.cx1: apart
    cp c
    jr z,.xin1
    jr nc,.nextj
.xin1:
    inc l
    ld a,b                      ; i.cx0 > j.cx1: apart
    cp (hl)
    jr z,.xin2
    jr nc,.nextj
.xin2:
    inc l
    ld a,(hl)                   ; j.cy0 > i.cy1
    cp e
    jr z,.yin1
    jr nc,.nextj
.yin1:
    inc l
    ld a,d                      ; i.cy0 > j.cy1
    cp (hl)
    jr z,.yin2
    jr nc,.nextj
.yin2:
    pop bc                      ; the rectangles meet: i is not alone
    jr .restore
.nextj:
    ld a,l                      ; the next slot (the four tests leave L anywhere inside the slot)
    or 3
    inc a
    ld l,a
    cp (SK_RECT&$FF)+4*MAX_SPRITES
    jr nz,.jloop
    pop bc
    ld a,(SK_I)                 ; alone and clean: mark its record in the hidden file
    call sk_recptr
    set 7,(hl)
    ld a,1
    ld (V_ANYSKIP),a
.restore:
    ld a,(SK_I)                 ; give i its rectangle back
    add a,a
    add a,a
    add a,SK_RECT&$FF
    ld l,a
    ld h,SK_RECT>>8
    ld (hl),b
.nextb:
    ld hl,SK_I
    inc (hl)
    ld a,(V_NINST)
    cp (hl)
    jp nz,.ib
    ret

; sk_recptr: A = instance -> HL = its record in the hidden file.  Clobbers AF.
sk_recptr:
    add a,a
    add a,a
    ld l,a
    ld a,(V_HIDDEN)
    rrca
    rrca
    add a,l
    add a,SPR_DRAWN&$FF
    ld l,a
    ld h,SPR_DRAWN>>8
    ret

; sk_entptr: A = instance -> HL = its SPR_TAB entry.  Clobbers AF.
sk_entptr:
    add a,a
    add a,a
    add a,a
    add a,SPR_TAB&$FF
    ld l,a
    ld h,SPR_TAB>>8
    ret

; sk_entrect: HL -> an SPR_TAB entry -> the cells the instance can cover at its position: B = cx0, C = cx1 = cx0 + wb (the extra byte of a
; shifted copy included), D = cy0, E = cy1 (exact).  Clobbers AF, HL.
sk_entrect:
    inc hl
    ld a,(hl)                   ; the asset
    inc hl
    ld b,(hl)                   ; x
    inc hl
    inc hl
    ld d,(hl)                   ; y
    add a,a
    add a,a
    add a,a
    add a,a
    add a,AST&$FF
    ld l,a
    ld h,AST>>8
    ld e,(hl)                   ; AST_H
    ld a,l
    add a,AST_WB-AST_H
    ld l,a
    ld c,(hl)                   ; AST_WB
    ld a,b
    rrca
    rrca
    rrca
    and $1F
    ld b,a                      ; cx0
    add a,c
    ld c,a                      ; cx1
    ld a,d
    add a,e
    dec a                       ; the last row (y <= 192 - h)
    rrca
    rrca
    rrca
    and $1F
    ld e,a                      ; cy1
    ld a,d
    rrca
    rrca
    rrca
    and $1F
    ld d,a                      ; cy0
    ret

; sk_recrect: HL -> a record (flag, E, D, N) -> the exact cell rectangle of what was drawn: B = cx0, C = cx1, D = cy0, E = cy1.
; N = cell rows << 3 | columns.  Clobbers AF, HL.
sk_recrect:
    inc hl
    ld c,(hl)                   ; C = E (screen address low: cell column and row bits)
    inc hl
    ld d,(hl)                   ; D = screen address high
    inc hl
    ld e,(hl)                   ; E = N
    ld a,c
    and $1F
    ld b,a                      ; B = cx0
    ld a,e
    and 7
    add a,b
    dec a
    ld (SK_T+6),a               ; cx1 = cx0 + columns - 1
    ld a,e
    rrca
    rrca
    rrca
    and 7
    dec a
    ld e,a                      ; E = cell rows - 1
    ld a,c
    rlca
    rlca
    rlca
    and 7
    ld c,a                      ; C = cell row within the third
    ld a,d
    rrca
    rrca
    rrca
    and 3
    rlca
    rlca
    rlca                        ; third * 8
    or c
    ld d,a                      ; D = cy0
    add a,e
    ld e,a                      ; E = cy1
    ld a,(SK_T+6)
    ld c,a                      ; C = cx1
    ret

; sk_dirty: A = instance (a candidate: its exact rectangle is in SK_RECT) -> carry set when a cell of it is dirty for the hidden file.
; The cells of one row of the rectangle (1..3, in one or two bytes of the dirty map) are tested with one mask.
; Clobbers AF, BC, DE, HL.
sk_dirty:
    add a,a
    add a,a
    add a,SK_RECT&$FF
    ld l,a
    ld h,SK_RECT>>8
    ld b,(hl)                   ; cx0
    inc l
    ld a,(hl)
    sub b
    inc a
    ld c,a                      ; C = columns (1..5)
    inc l
    ld d,(hl)                   ; D = row
    inc l
    ld a,(hl)
    sub d
    inc a
    ld e,a                      ; E = rows (1..7)
    ; the 16 bit mask of the columns: MASK_TAB[(columns - 1) * 8 + (cx0 AND 7)]
    ld a,c
    dec a
    add a,a
    add a,a
    add a,a
    ld c,a
    ld a,b
    and 7
    add a,c
    add a,a
    ld c,a
    ld a,b                      ; the dirty byte of the first row: DIRTY0 (+ page of the hidden file) + 4 * row + cx0 / 8
    rrca
    rrca
    rrca
    and 3
    ld b,a
    ld a,d
    add a,a
    add a,a
    add a,b
    ld b,a                      ; B = byte index of the first row
    ld hl,MASK_TAB
    ld a,l
    add a,c
    ld l,a
    ld c,(hl)                   ; C = mask, low byte
    inc l
    ld d,(hl)                   ; D = mask, high byte
.row:
    ld a,(V_HIDDEN)
    add a,DIRTY0>>8
    ld h,a
    ld l,b
    ld a,(hl)
    and c
    jr nz,.dirty
    inc l
    ld a,(hl)
    and d
    jr nz,.dirty
    ld a,b
    add a,4
    ld b,a
    dec e
    jr nz,.row
    or a                        ; clean (carry clear)
    ret
.dirty:
    scf
    ret

; MASK_TAB[(columns - 1) * 8 + (cx0 AND 7)] = ((1 << columns) - 1) << (cx0 AND 7), 16 bit, columns 1..5.  (Inside one page: L is the index.)
    IF ($ & $FF) + 80 > 256
    ALIGN 256
    ENDIF
MASK_TAB:
    DUP 5, n
    DUP 8, k
    DW ((1<<(n+1))-1)<<k
    EDUP
    EDUP
M_SKIP_E:
