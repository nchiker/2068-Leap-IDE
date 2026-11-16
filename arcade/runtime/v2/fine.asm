; fine.asm -- Leap Arcade runtime v2: fine colour scenes (SCLD mode 2: the bitmap at $4000, one colour byte per 8x1 group at + $2000), slice F2 of
; docs/ARCADE_FINE_COLOUR_CONTRACT.md (sections 2, 3a, 4, 5).  Appended after wiretick.asm.  Notes: arcade/runtime/v2/NOTES-FINE.md.
;
;   RT_FINEMODE   A = 0 off, anything else on; HL = the fine descriptor (on): DW tile_rows, DW sprite_inks.  Clobbers AF, BC, DE, HL, IX, IY, the
;                 alternates.  Called by ENTER in init_entry or a frame_entry (contract 4.1).  ON is refused (fine colour stays off) in a WIRE3D game,
;                 when the boot handed out more than 32 phase slots, or when not called from inside init_entry / a two-buffer tick's frame_entry.
;   The fine tick (FINE_LOOP, entered when ON returns, left when OFF runs inside its frame_entry): right after the frame interrupt the PUBLISH writes
;   the update list (8x1 groups that differ from the screen, top to bottom, bitmap and colour byte back to back), then frame_entry, then the COMPOSE
;   of the next picture off screen into the list, then back to the wait with V_SYNC = SYNC_BUSY (no flip request).
;
; How ON / OFF reach the tick: main.asm calls init_entry and every frame_entry with SP = STACK_TOP, so their return address is the word at STACK_TOP - 2
; (TICK_LOOP after init_entry, SKIP_CALL after a two-buffer tick's frame_entry).  ON replaces it with FINE_RES_INIT / FINE_RES_TICK, so the code that
; called ON returns into the fine tick (no test in main.asm: a game without fine colour pays nothing); OFF inside the fine tick's frame_entry is seen
; after it (the rest of the two-buffer tick follows from SKIP_CALL); OFF after ON in the same init_entry / frame_entry puts the address back.
;
; Compose (after frame_entry):
;   1. every instance: its state now (visible, x rounded to its phases, y, asset) against its record (F_REC: what the screen shows); when they differ,
;      the cells under the old window and under the new one are marked in F_CMAP (= DIRTY1, where mark_dirty also puts the dirty cells) and their
;      pixel rows in F_RMASK (one byte a cell row), one mark over both windows when they are close; the record follows.  Every visible instance gets
;      its blit data (F_INFO) and joins the list of each cell row it meets (F_RL).
;   2. the cell rows from the bottom up, each with a marked cell: the pixel rows K0 .. K1 to recompose (all 8 when a cell of the row is in DIRTY0,
;      else those of F_RMASK); the marked cells' backgrounds, rows K0 .. K1, into the strip (font cell: its attribute; tile cell: tile_rows + 8 t +
;      k); every instance of the row's list (in order) that covers a marked cell, blitted into the strip (bitmap (s AND mask) OR image; colour
;      (c AND $F8) OR ink of the row where the mask byte is not $FF); then each marked cell (right to left), rows K1 .. K0, compared with the screen
;      and every group that differs PUSHed (SP walks the list downwards; the publish POPs it upwards, so it runs top to bottom).  Before a row's
;      cells the room for 8 groups a cell is checked; when the list is full the row's cells go back into F_CMAP and rows 0 .. this one are left
;      to the publish, which composes them first (all 8 rows) and writes them straight (F_OVF; F_NOVF counts such ticks).
;   The background and the diff of a cell are unrolled 8 times and entered at block 8 - N (N = K1 - K0 + 1): IX = the entry, from F_ENT.
; Interrupts stay on.  While SP walks the list (compose step 2, publish) the frame interrupt pushes below SP: bytes of the list already read
; (publish) or the free bytes below it (compose; F_GUARD keeps >= 48 bytes free).  No self-modifying code.
    ; (no ORG: follows wiretick.asm)
M_FINE_S:

; F_INFO fields (16 bytes an instance, in the order fine_blit_inst reads them)
I_MB            EQU 0           ; F_RBITS + its first column / 8 (the low byte): the byte of its first column
I_MLO           EQU 1           ; its columns' bits in that F_RBITS byte
I_MHI           EQU 2           ;   and in the next
I_E0            EQU 3           ; 8 * the first byte column of the blit window (its strip column)
I_WB            EQU 4           ; window bytes (1..3)
I_EF            EQU 5           ; the strip row of its sprite row 0: I_E0 + (y AND 7)
I_ROWS0         EQU 6           ; its rows in its first cell row: min(h, j1), j1 = 8 - (y AND 7)
I_INK           EQU 7           ; word: sprite_inks + 16 asset (the ink of sprite row 0)
I_PTR           EQU 9           ; word: the phase copy (mask, image pairs; 2 wb bytes a row), sprite row 0
I_ROWSM         EQU 11          ; h - j1: its rows below its first cell row
I_INK1          EQU 12          ; word: the ink of sprite row j1 (the first in the next cell row)
I_PTR1          EQU 14          ; word: the phase row of sprite row j1

; ===============================================================================================================
; RT_FINEMODE
; ===============================================================================================================
RT_FINEMODE:
    or a
    jp z,fine_off
    ld a,(V_FINE)
    ld b,a
    ld a,(V_WIRE)
    or b
    ret nz                      ; on already, or a WIRE3D game
    ld a,(V_SLOT)
    cp POOL_A_SLOTS+1
    ret nc                      ; more than 32 phase slots: phase pool B holds art (refused)
    push hl
    ld bc,FINE_RES_INIT         ; called from init_entry?
    ld de,TICK_LOOP
    call fine_retis
    jr z,.from
    ld bc,FINE_RES_TICK         ; from a two-buffer tick's frame_entry?
    ld de,SKIP_CALL
    call fine_retis
    jr z,.from
    ld bc,FINE_FRET             ; from the fine tick's frame_entry (switched off earlier in it)?
    ld d,b
    ld e,c
    call fine_retis
.from:
    pop hl
    ret nz                      ; from anywhere else: refused
    push bc                     ; where init_entry / frame_entry will return to
    ld e,(hl)                   ; ---- the descriptor ----
    inc hl
    ld d,(hl)
    inc hl
    ld a,d
    or e
    jr z,.notiles
    ex de,hl
    ld bc,-1024
    add hl,bc
    ex de,hl
.notiles:
    ld (F_TBASE),de
    ld e,(hl)
    inc hl
    ld d,(hl)
    ld (F_INKS),de
    ld a,(V_SHADOW_FF)          ; ---- the hidden display file's attributes to 0 (plain black), and show it ----
    and 1
    xor 1
    ld b,a
    push bc
    rrca
    rrca
    rrca
    add a,DATTR0>>8
    ld h,a
    ld l,0
    call fine_plain
    pop bc
    ld a,b
    call fine_flip
    ld bc,0                     ; ---- the fine picture of the cell map (no sprite): bitmap at $4000, colours at $6000; the file shown is plain ----
.cell:
    push bc
    call fine_cell_scr
    pop bc
    inc bc
    ld a,b
    cp 3
    jr nz,.cell
    ld a,2
    call fine_flip              ; $FF = 2 (and V_SHADOW_FF) at the next interrupt
    ld hl,F_LOWBIT+1            ; (the attribute areas are not shown now) F_LOWBIT: the lowest set bit of each byte: 0 when odd, of v / 2 + 1 else
.lb:
    ld a,l
    rrca
    ld b,0
    jr c,.lbs
    ld e,l
    ld l,a
    ld b,(hl)
    inc b
    ld l,e
.lbs:
    ld (hl),b
    inc l
    jr nz,.lb
    xor a
    ld (F_NW+1),a               ; (F_NW + 1 stays 0)
    ld hl,(F_TBASE)             ; F_TMASK: $80 with a tileset, 0 without
    ld a,h
    or l
    jr z,.tm
    ld a,$80
.tm:
    ld (F_TMASK),a
    xor a
    ld (F_LASTM),a              ; (no cell row composed yet: F_TBASE may be new)
    ld hl,FILL_FINE             ; records (nothing drawn), the dirty maps (the list: the compose that always follows ON writes it)
    call fill_tab
    xor a
    ld (F_OVF),a
    ld (V_HIDDEN),a
    ld (V_HOFF),a
    ld (V_SYNC),a               ; SYNC_BUSY
    inc a
    ld (V_FINE),a
    pop hl
    ld (STACK_TOP-2),hl         ; init_entry / frame_entry returns into the fine tick
    ret

; fine_off (RT_FINEMODE A = 0): both display files rebuilt from the cell map for the two-buffer tick, file 1 shown.  Frames: the fine picture, then
; plain black (file 2 with its attributes 0), then file 1.
fine_off:
    ld a,(V_FINE)
    or a
    ret z
    xor a
    ld (V_FINE),a
    ld hl,DATTR1
    call fine_plain
    ld a,1
    call fine_flip              ; file 2 (plain)
    ld hl,FILL_DIRTY            ; every cell dirty in both maps
    call fill_tab
    xor a
    ld (V_HIDDEN),a
    ld (V_HOFF),a
    call redraw_dirty           ; file 1
    xor a
    call fine_flip              ; file 1 shown
    ld a,1
    ld (V_HIDDEN),a
    ld a,$20
    ld (V_HOFF),a
    call redraw_dirty           ; file 2 (the hidden one now)
    ld hl,FILL_OFF              ; SPR_DRAWN: no instance drawn in either file
    call fill_tab
    xor a
    ld (V_SYNC),a               ; SYNC_BUSY
    ld bc,SKIP_CALL             ; ON earlier in this frame_entry / init_entry: back to the two-buffer tick
    ld de,FINE_RES_TICK
    call fine_retis
    jr z,.put
    ld bc,TICK_LOOP
    ld de,FINE_RES_INIT
    call fine_retis
    ret nz
.put:
    ld (STACK_TOP-2),bc
    ret

; fine_retis: Z when the return address of init_entry / frame_entry (the word at STACK_TOP - 2) is DE.  Clobbers AF, HL.
fine_retis:
    ld hl,(STACK_TOP-2)
    or a
    sbc hl,de
    ret

; fine_flip: A = the value for port $FF: the next interrupt writes it (the ISR's flip: V_SYNC = SYNC_REQUEST + A); wait for it.  Clobbers AF.
fine_flip:
    add a,SYNC_REQUEST
    ld (V_SYNC),a
.w:
    ld a,(V_SYNC)
    cp SYNC_REQUEST
    jr nc,.w
    ret

; fine_plain: HL = an attribute area -> its 768 bytes 0.  Clobbers BC, DE, HL.
fine_plain:
    ld (hl),0
    ld d,h
    ld e,l
    inc de
    ld bc,DATTR_LEN-1
    ldir
    ret

FILL_FINE:
    DW DIRTY0, DIRTY_LEN-1
    DB 0
    DW DIRTY1, DIRTY_LEN-1
    DB 0
FILL_OFF:
    DW SPR_DRAWN, 2*SPR_DRAWN_FILE-1
    DB 0
    DW 0

; fine_tptr: C = a cell value, HL = its attribute byte.  A tile cell (with a tileset): HL = its 8 row attributes, carry set; else carry clear, HL kept.
; Clobbers AF.
fine_tptr:
    ld a,c
    add a,a
    ret nc                      ; a font cell
    push de
    ld de,(F_TBASE)
    ld a,d
    or e
    jr z,.none                  ; no tileset: the cell's attribute (carry clear)
    ld l,c
    ld h,0
    add hl,hl
    add hl,hl
    add hl,hl
    add hl,de
    scf
.none:
    pop de
    ret

; fine_cell_scr (ON): BC = cell index -> its 8 bitmap rows and 8 colour bytes straight into the screen.  Clobbers AF, AF', BC, DE, HL.
fine_cell_scr:
    ld a,b
    add a,CELL_TILE>>8
    ld h,a
    ld l,c
    ld a,b
    add a,a
    add a,a
    add a,a
    add a,DFILE0>>8
    ld d,a
    ld e,c                      ; DE = the cell's row 0
    ld c,(hl)
    inc h
    inc h
    inc h
    ld b,GLYPH_TAB>>8
    call fine_tptr
    jr c,.tile
    ld l,(hl)                   ; L = the attribute
    ld h,8
.f:
    ld a,(bc)
    ld (de),a
    set 5,d
    ld a,l
    ld (de),a
    res 5,d
    inc d
    inc b
    dec h
    jr nz,.f
    ret
.tile:
    ld a,8
.t:
    ex af,af'
    ld a,(bc)
    ld (de),a
    set 5,d
    ld a,(hl)
    ld (de),a
    res 5,d
    inc d
    inc b
    inc hl
    ex af,af'
    dec a
    jr nz,.t
    ret

; ===============================================================================================================
; The fine tick
; ===============================================================================================================
FINE_RES_INIT:                  ; init_entry switched fine colour on: compose the state it left, then the fine tick
    call fine_compose
    jr fine_wait
FINE_RES_TICK:                  ; a two-buffer tick's frame_entry switched it on (the tick counts)
fine_after:
    call fine_compose
    ld hl,(V_TICKS)
    inc hl
    ld (V_TICKS),hl
fine_wait:
    xor a
    ld (V_SYNC),a               ; SYNC_BUSY: the next update waits for the next interrupt
FINE_LOOP:                      ; (main.asm's TICK_LOOP)
    ld a,(V_SYNC)
    dec a
    jr nz,FINE_LOOP
    ld hl,(V_FRAMES)
    ld b,h
    ld c,l
    ld de,(V_TARGET)
    or a
    sbc hl,de
    jp m,FINE_LOOP
    xor a
    ld (V_SYNC),a
    ld a,(V_DIV)
    ld l,a
    ld h,0
    add hl,bc
    ld (V_TARGET),hl
    ld hl,(STACK_CANARY)
    ld de,CANARY_VALUE
    or a
    sbc hl,de
    jp nz,stack_dead
FINE_WORK:
    xor a
    ld (V_HIDDEN),a
    ld (V_HOFF),a
    call fine_publish
FINE_FRAME:
    ld hl,(GAME_FRAME)
    call call_hl
FINE_FRET:                      ; (frame_entry's return address in the fine tick)
    ld a,(V_FINE)
    or a
    jr nz,fine_after
    jp SKIP_CALL                ; switched off in frame_entry: the rest of the two-buffer tick (fine_off set V_HIDDEN / V_HOFF)

; ---------------------------------------------------------------------------------------------------------------
; fine_publish: the cell rows left by the compose (F_OVF), composed and written now; then the list, top to bottom: per group POP HL = the bitmap
; address, POP DE = E bitmap, D colour (unrolled 8 times, entered at block (-groups) AND 7).  Clobbers AF, BC, DE, HL, IX, IY, the alternates.
; ---------------------------------------------------------------------------------------------------------------
fine_publish:
    ld a,(F_OVF)
    or a
    call nz,fine_ovf
    ld hl,(F_LIST)              ; DE = 4 * the groups (F_LTOP - 2 - F_LIST)
    ld a,(F_LTOP-2)&$FF
    sub l
    ld e,a
    ld a,(F_LTOP-2)>>8
    sbc a,h
    ld d,a
    or e
    jr z,.done                  ; an empty list
    ld (F_SP),sp
    ld sp,hl
    ld hl,28                    ; B = the passes of 8 groups, rounded up: (4 groups + 28) / 32
    add hl,de
    add hl,hl
    add hl,hl
    add hl,hl
    ld b,h
    ld a,e                      ; the first pass enters at block (-groups) AND 7 (6 bytes a block)
    neg
    rrca
    rrca
    and 7
    ld l,a
    add a,a
    add a,l
    add a,a
    ld l,a
    ld h,0
    ld de,.pub
    add hl,de
    jp (hl)
.pub:                           ; per group: POP HL = the bitmap address, POP DE = E bitmap, D colour
    DUP 8
    pop hl
    pop de
    ld (hl),e
    set 5,h
    ld (hl),d
    EDUP
    djnz .pub
    ld sp,(F_SP)
.done:
    ld hl,F_LTOP-2
    ld (F_LIST),hl
    ret

; fine_ovf: cell rows 0 .. F_OVF - 1 composed (as the compose would, on all 8 pixel rows) and their marked cells written straight, top to bottom.
fine_ovf:
    xor a
.r:
    ld (F_R),a
    add a,a
    add a,a
    ld l,a
    ld h,F_CMAP>>8
    ld a,(hl)
    inc l
    or (hl)
    inc l
    or (hl)
    inc l
    or (hl)
    jr z,.n
    ld a,l
    add a,(F_RMASK&$FF)-3
    ld l,a
    ld h,F_RMASK>>8
    ld (hl),$FF                 ; all 8 pixel rows
    call fine_rowbuild          ; A = the marked cells, F_COLS = their screen low bytes
    ld b,a
    ld de,F_COLS
.c:
    ld a,(de)
    inc e
    push de
    ld l,a
    add a,a
    add a,a
    add a,a
    ld e,a
    ld d,F_STRIP>>8             ; DE = its strip row 0
    ld a,(F_SCR1)
    sub 7
    ld h,a                      ; HL = its screen row 0 (F_SCR1 is row K1 = 7)
    ld c,8
.w:
    ld a,(de)
    ld (hl),a
    inc d
    set 5,h
    ld a,(de)
    ld (hl),a
    dec d
    res 5,h
    inc h
    inc e
    dec c
    jr nz,.w
    pop de
    djnz .c
.n:
    ld a,(F_R)
    inc a
    ld hl,F_OVF
    cp (hl)
    jr c,.r
    xor a
    ld (F_OVF),a
    ret

; ---------------------------------------------------------------------------------------------------------------
; fine_compose: the update from the screen (the last picture) to the state now, into the list.  Clobbers everything.
; ---------------------------------------------------------------------------------------------------------------
fine_compose:
    ld hl,F_RLC                 ; ---- the instances (the dirty cells are in F_CMAP already: mark_dirty sets both dirty maps) ----
    ld b,CELL_ROWS
.rc:
    ld (hl),0
    inc l
    djnz .rc
    xor a
    ld (F_M),a
    ld a,(V_NINST)
    or a
    jr z,.rows
.inst:
    call fine_inst
    ld hl,F_M
    inc (hl)
    ld a,(V_NINST)
    cp (hl)
    jr nz,.inst
.rows:                          ; ---- the cell rows, bottom up, into the list ----
    ld (F_SP),sp
    ld sp,F_LTOP
    ld hl,0
    push hl                     ; the end marker
    ld a,CELL_ROWS-1
.r:
    ld (F_R),a
    add a,a
    add a,a
    ld l,a
    ld h,F_CMAP>>8
    ld a,(hl)
    inc l
    or (hl)
    inc l
    or (hl)
    inc l
    or (hl)
    jp z,.next
    call fine_rowbuild          ; A = n marked cells (F_COLS: their screen low bytes), their strip rows K0 .. K1 built; F_K1, F_SCR1, F_DENT
    ld b,a
    ld hl,-(F_LLOW+F_GUARD+32*32)   ; room for 8 groups a cell above F_LLOW + F_GUARD?  (room for 32 cells: yes)
    add hl,sp
    jr c,.room
    ld de,32*32
    add hl,de
    rrca
    rrca
    rrca
    ld e,a
    and $1F
    ld d,a
    xor e
    ld e,a                      ; DE = 32 n
    sbc hl,de                   ; (carry clear after XOR)
    jp c,.full
.room:
    ld a,b
    exx
    ld b,a                      ; B' = the cells left
    add a,F_COLS&$FF
    ld l,a
    ld h,F_COLS>>8              ; HL' = past the last F_COLS entry (the cells from the right)
    ld ix,(F_DENT)              ; IX = the diff of rows K1 .. K0
    ld a,(F_K1)
    ld iyh,a
    ld a,(F_SCR1)
    ld iyl,a
    exx
    ld d,F_STRIP>>8             ; (the blocks leave D as it was)
    exx
.col:                           ; (the other register set) the next cell from the right: HL = its screen row K1, DE = its strip row K1
    dec l
    ld a,(hl)
    exx
    ld l,a
    add a,a
    add a,a
    add a,a
    add a,iyh
    ld e,a
    ld a,iyl
    ld h,a
    jp (ix)
.diffb:                         ; rows K1 .. K0, entered at block 8 - N (the blocks are alike): a group that differs from the screen is pushed
    DUP 8
    ld a,(de)
    cp (hl)
    ld c,a
    jr nz,1F                    ; the bitmap differs
    set 5,h
    inc d
    ld a,(de)
    dec d
    cp (hl)
    res 5,h
    jr z,3F                     ; the same group
1:
    inc d
    ld a,(de)
    dec d
    ld b,a
    push bc
    push hl
3:
    dec h
    dec e
    EDUP
.diffe:
    exx
    dec b
    jp nz,.col
.next:
    ld a,(F_R)
    sub 1
    jp nc,.r
    jr .end
.full:                          ; the list is full: this row's cells back into F_CMAP (F_RBITS), rows 0 .. F_R left to the publish
    ld a,(F_R)
    add a,a
    add a,a
    ld e,a
    ld d,F_CMAP>>8
    ld hl,F_RBITS
    ld bc,4
    ldir
    ld a,(F_R)
    inc a
    ld (F_OVF),a
    ld hl,(F_NOVF)
    inc hl
    ld (F_NOVF),hl
.end:
    ld (F_LIST),sp
    ld sp,(F_SP)
    ret

; fine_inst: instance F_M (compose step 1): its state now (visible, x rounded to its phases, y, asset) against its record (F_REC: what the
; screen shows); when they differ, the cells (and their pixel rows) under the old window and the new one are marked and the record follows.  A
; visible instance gets its blit data (F_INFO) and joins the list of each cell row it meets (F_RL; the entry is 16 i + d, d = that cell row - its
; first).  Clobbers everything.
fine_inst:
    ld a,(F_M)
    ld b,a
    add a,a
    add a,b
    add a,a
    add a,SPR_TAB&$FF
    ld l,a
    ld h,SPR_TAB>>8
    ld bc,0
    ld de,0                     ; the state now: D flag, C x rounded, B y, E asset (0, 0, 0, 0 when hidden)
    ld a,(hl)
    or a
    jr z,.st
    inc d
    inc l
    ld e,(hl)
    inc l
    ld c,(hl)                   ; x (0..239)
    inc l
    inc l
    ld b,(hl)                   ; y (0..176)
    ld a,e
    add a,a
    add a,a
    add a,a
    add a,(AST+AST_XMASK)&$FF
    ld l,a                      ; (AST is in SPR_TAB's page)
    ld a,c
    and (hl)
    ld c,a
.st:
    ld a,(F_M)
    add a,a
    add a,a
    add a,F_REC&$FF
    ld l,a
    ld h,F_REC>>8               ; HL = the record (what the screen shows)
    ld a,(hl)
    cp d
    jr nz,.chg
    inc l
    ld a,(hl)
    cp c
    jr nz,.chg1
    inc l
    ld a,(hl)
    cp b
    jr nz,.chg2
    inc l
    ld a,(hl)
    cp e
    jr nz,.chg3
    ld a,d
    or a
    ret z                       ; hidden, as it was
    jp .vis                     ; visible, unchanged
.chg3:
    dec l
.chg2:
    dec l
.chg1:
    dec l
.chg:                           ; the record = the state now, D C B E = what the screen shows
    ld a,(hl)
    ld (hl),d
    ld d,a
    inc l
    ld a,(hl)
    ld (hl),c
    ld c,a
    inc l
    ld a,(hl)
    ld (hl),b
    ld b,a
    inc l
    ld a,(hl)
    ld (hl),e
    ld e,a
    push hl
    ld a,d
    or a
    jr z,.new                   ; nothing on screen
    dec l                       ; both shown, the same asset, at most 8 pixels apart: one mark over both windows
    dec l
    dec l
    ld a,(hl)
    or a
    jr z,.old                   ; hidden now
    inc l
    ld a,(hl)                   ; x now
    ld ixl,c
    ld ixh,a
    cp c
    jr nc,.x1
    ld ixl,a
    ld ixh,c                    ; IXL = the lower x, IXH = the higher
.x1:
    inc l
    ld a,(hl)                   ; y now
    ld iyl,b
    ld iyh,a
    cp b
    jr nc,.y1
    ld iyl,a
    ld iyh,b                    ; IYL = the lower y, IYH = the higher
.y1:
    inc l
    ld a,(hl)
    cp e
    jr nz,.old
    ld a,ixh
    sub ixl
    cp 9
    jr nc,.old
    ld a,iyh
    sub iyl
    cp 9
    jr nc,.old
    ld iyh,a                    ; IYH = the rows apart
    ld a,e
    add a,a
    add a,a
    add a,a
    add a,AST&$FF
    ld l,a
    ld h,AST>>8
    inc l
    ld a,(hl)                   ; AST_WB: the last byte column is that of the higher x + 8 AST_WB - 1
    dec l
    add a,a
    add a,a
    add a,a
    dec a
    add a,ixh
    rrca
    rrca
    rrca
    and $1F
    ld ixh,a
    ld a,ixl
    rrca
    rrca
    rrca
    and $1F
    ld d,a                      ; D = the first byte column (of the lower x)
    ld a,ixh
    sub d
    cp 3
    jr nc,.old                  ; 4 columns (MASK_TAB has 1..3)
    inc a
    ld e,a
    ld a,(hl)                   ; AST_H
    add a,iyh
    ld c,a                      ; C = h + the rows apart
    ld b,iyl
    call fine_mark
    pop hl
    ld e,(hl)                   ; the state now, from the record
    dec l
    ld b,(hl)
    dec l
    ld c,(hl)
    jr .vis
.old:
    ld d,b
    call fine_wdim
    call fine_mark              ; the old window's cells
.new:
    pop hl
    ld e,(hl)                   ; the state now, from the record
    dec l
    ld b,(hl)
    dec l
    ld c,(hl)
    dec l
    ld a,(hl)
    or a
    ret z                       ; hidden now
    push bc
    push de
    ld d,b
    call fine_wdim
    call fine_mark              ; the new window's cells
    pop de
    pop bc
.vis:                           ; a visible instance (C x rounded, B y, E asset): its blit data and the row lists
    ld a,e
    rlca
    rlca
    rlca
    rlca
    ld ixh,a                    ; IXH = 16 asset
    ld d,b
    call fine_wdim              ; B = y, C = h, D = c0, E = wb, A = shift
    add a,a                     ; IY = its phase copy: PHASE_PTR + 16 asset + 2 shift
    add a,ixh
    add a,PHASE_PTR&$FF
    ld l,a
    ld h,PHASE_PTR>>8
    ld a,(hl)
    ld iyl,a
    inc l
    ld a,(hl)
    ld iyh,a
    ld a,(F_M)
    add a,a
    add a,a
    add a,a
    add a,a
    ld l,a
    ld h,F_INFO>>8              ; HL = its F_INFO entry, written in order
    ld a,d                      ; I_MB
    rrca
    rrca
    rrca
    and 3
    add a,F_RBITS&$FF
    ld (hl),a
    inc l
    push bc
    ld a,e                      ; I_MLO, I_MHI = MASK_TAB[8 (wb - 1) + (c0 AND 7)]
    dec a
    add a,a
    add a,a
    add a,a
    ld c,a
    ld a,d
    and 7
    add a,c
    add a,a
    add a,MASK_TAB&$FF
    ld c,a
    ld b,MASK_TAB>>8
    ld a,(bc)
    ld (hl),a
    inc l
    inc c
    ld a,(bc)
    ld (hl),a
    inc l
    pop bc
    ld a,d                      ; I_E0 = 8 c0
    add a,a
    add a,a
    add a,a
    ld (hl),a
    inc l
    ld (hl),e                   ; I_WB
    inc l
    ld d,a
    ld a,b
    and 7
    add a,d
    ld (hl),a                   ; I_EF = I_E0 + (y AND 7)
    inc l
    sub d
    sub 8
    neg
    ld d,a                      ; D = j1 = 8 - (y AND 7)
    cp c
    jr c,.r0
    ld a,c
.r0:
    ld (hl),a                   ; I_ROWS0 = min(h, j1)
    inc l
    ld a,(F_INKS)               ; I_INK = sprite_inks + 16 asset
    add a,ixh
    ld (hl),a
    inc l
    ld ixl,a
    ld a,(F_INKS+1)
    adc a,0
    ld (hl),a
    inc l
    ld ixh,a                    ; IX = I_INK
    ld a,iyl                    ; I_PTR
    ld (hl),a
    inc l
    ld a,iyh
    ld (hl),a
    inc l
    ld a,c                      ; I_ROWSM = h - j1
    sub d
    ld (hl),a
    inc l
    ld a,ixl                    ; I_INK1 = I_INK + j1
    add a,d
    ld (hl),a
    inc l
    ld a,ixh
    adc a,0
    ld (hl),a
    inc l
    ld a,d                      ; I_PTR1 = I_PTR + 2 wb j1
    add a,a
    ld d,a
    dec e
    jr z,.p1
    add a,d
    dec e
    jr z,.p1
    add a,d
.p1:
    add a,iyl
    ld (hl),a
    inc l
    ld a,iyh
    adc a,0
    ld (hl),a
    ld a,b                      ; the cell rows r0 .. r1 (of y .. y + h - 1): D = their count
    add a,c
    dec a
    rrca
    rrca
    rrca
    and $1F
    ld d,a
    ld a,b
    rrca
    rrca
    rrca
    and $1F
    ld c,a                      ; C = r0
    neg
    add a,d
    inc a
    ld d,a                      ; D = r1 - r0 + 1
    ld b,F_RLC>>8
    ld a,c
    rrca
    rrca
    rrca
    rrca
    ld l,a
    and $0F
    add a,F_RL>>8
    ld h,a
    ld a,l
    and $F0
    ld l,a                      ; HL = F_RL + 16 r0
    ld a,c
    add a,F_RLC&$FF
    ld c,a                      ; BC = F_RLC + r0
    ld a,(F_M)
    rlca
    rlca
    rlca
    rlca
    ld e,a                      ; E = 16 i + d
.rl:
    ld a,(bc)                   ; append it to the row's list
    inc a
    ld (bc),a
    dec a
    or l
    ld l,a
    ld (hl),e
    inc e
    inc c
    ld a,l
    and $F0
    add a,16
    ld l,a
    jr nc,.rn
    inc h
.rn:
    dec d
    jr nz,.rl
    ret

; fine_wdim: E = asset, C = x rounded, D = y -> B = y, C = height, D = first byte column, E = window bytes, A = shift (x AND 7), Z when 0.
; Clobbers HL.
fine_wdim:
    ld a,e
    add a,a
    add a,a
    add a,a
    add a,AST&$FF
    ld l,a
    ld h,AST>>8
    ld b,d
    ld a,c
    rrca
    rrca
    rrca
    and $1F
    ld d,a
    ld a,(hl)                   ; AST_H
    inc l
    ld e,(hl)                   ; AST_WB
    ld l,a
    ld a,c
    and 7
    ld c,l
    ret z
    inc e
    ret

; fine_mark: B = y, C = height, D = first column, E = columns (1..4): the cells under rows y .. y + height - 1 of those byte columns into
; F_CMAP, and those pixel rows into F_RMASK of their cell rows.  Clobbers AF, AF', BC, DE, HL.
fine_mark:
    ld a,b
    add a,c
    dec a
    ld c,a                      ; C = the last pixel row y1
    ld h,BIT_TAB>>8
    and 7
    ld l,a
    ld a,(hl)
    add a,a
    dec a
    ex af,af'                   ; A' = rows 0 .. (y1 AND 7) of the last cell row
    ld a,b
    and 7
    ld l,a
    xor a
    sub (hl)
    push de
    ld e,a                      ; E = rows (y AND 7) .. 7 of the first
    ld a,c
    rrca
    and $7C
    or F_RMASK&$FF
    ld d,a                      ; D = the F_RMASK byte of the last cell row
    ld a,b
    rrca
    and $7C
    or F_RMASK&$FF
    ld l,a
    ld h,F_RMASK>>8             ; HL = of the first
    cp d
    jr nz,.span
    ex af,af'                   ; one cell row
    and e
    jr .last
.span:
    ld a,e
    or (hl)
    ld (hl),a
.mid:
    ld a,l
    add a,4
    ld l,a
    cp d
    jr z,.lst
    ld (hl),$FF                 ; a cell row in between: all 8
    jr .mid
.lst:
    ex af,af'
.last:
    or (hl)
    ld (hl),a
    pop de
    ld a,e                      ; ---- the cells ----
    dec a
    add a,a
    add a,a
    add a,a
    ld l,a
    ld a,d
    and 7
    add a,l
    add a,a
    add a,MASK_TAB&$FF
    ld l,a
    ld h,MASK_TAB>>8
    ld e,(hl)                   ; E = the cells' bits in their F_CMAP byte, D = in the next
    inc l
    ld a,(hl)
    push af
    ld a,c
    rrca
    and $7C
    ld c,a                      ; C = 4 * the last cell row
    ld a,b
    rrca
    and $7C
    ld b,a                      ; B = 4 * the first
    ld a,d
    rrca
    rrca
    rrca
    and 3
    or b
    ld l,a
    ld h,F_CMAP>>8              ; HL = the first cell's F_CMAP byte
    pop af
    ld d,a
.row:
    ld a,(hl)
    or e
    ld (hl),a
    inc l                       ; (the next byte gets 0 unless the columns cross a byte: on row 23 that is SPR_DRAWN's first, rewritten as it is)
    ld a,(hl)
    or d
    ld (hl),a
    inc l
    inc l
    inc l
    ld a,b
    add a,4
    ld b,a
    ld a,c
    cp b
    jr nc,.row
    ret

; fine_rowbuild: cell row F_R (a cell of it marked): its F_CMAP bytes into F_RBITS (and cleared); the pixel rows K0 .. K1 to recompose: all 8 when
; a cell of the row is marked in DIRTY0 too (mark_dirty marks both maps: text, tiles), else those of its F_RMASK byte (the rows of the instance
; windows that changed), both cleared; the marked cells' screen low bytes ((row AND 7) * 32 + column, ascending) into F_COLS; their backgrounds,
; rows K0 .. K1, into the strip; then every instance of the row's list that covers a marked cell, blitted.
; -> A = F_M = the marked cells; F_K1, F_SCR1 (the screen page of the row's pixel row K1), F_DENT (the diff's entry).  Clobbers everything.
fine_rowbuild:
    ld a,(F_R)
    add a,a
    add a,a
    ld l,a
    ld h,F_CMAP>>8
    ld de,F_RBITS
    ld b,0
    DUP 4
    ld a,(hl)
    ld (hl),b
    ld (de),a
    inc l
    inc e
    EDUP
    dec h                       ; DIRTY0 (= F_CMAP - $100): the row's four bytes, cleared
    dec l
    ld a,(hl)
    ld (hl),b
    dec l
    or (hl)
    ld (hl),b
    dec l
    or (hl)
    ld (hl),b
    dec l
    or (hl)
    ld (hl),b
    ld c,a
    ld a,l
    or F_RMASK&$FF
    ld l,a
    ld h,F_RMASK>>8
    ld a,(hl)                   ; the rows of the instance windows
    ld (hl),b
    inc c
    dec c
    jr nz,.all                  ; a dirty cell: all 8
    or a
    jr nz,.part
.all:
    ld a,$FF
.part:
    ld hl,F_LASTM               ; the same rows as the last cell row composed: the values below are still right
    cp (hl)
    jr z,.same
    ld (hl),a
    ld l,a
    ld h,F_LOWBIT>>8
    ld e,(hl)                   ; E = K0, the lowest row
    ld d,7
.hi:
    add a,a
    jr c,.k1
    dec d
    jr .hi
.k1:                            ; D = K1, the highest
    ld a,d
    ld (F_K1),a
    sub e
    inc a
    ld (F_NW),a                 ; N = K1 - K0 + 1 (F_NW + 1 is 0)
    add a,a
    add a,a
    add a,(F_ENT&$FF)-4
    ld l,a
    ld h,F_ENT>>8               ; the entries of N rows: the diff at block 8 - N, the background at block 8 - N
    ld a,(hl)
    ld (F_DENT),a
    inc l
    ld a,(hl)
    ld (F_DENT+1),a
    inc l
    ld a,(hl)
    ld (F_BENT),a
    inc l
    ld a,(hl)
    ld (F_BENT+1),a
    ld a,e
    ld (F_K0),a
    add a,GLYPH_TAB>>8
    ld (F_GP),a                 ; the glyph plane of row K0
    ld hl,(F_TBASE)
    ld a,e
    add a,l
    ld l,a
    adc a,h
    sub l
    ld h,a
    ld (F_TB0),hl               ; F_TBASE + K0
.same:
    ld ix,(F_BENT)
    ld a,(F_K0)
    ld iyh,a                    ; IYH = K0
    ld a,(F_K1)
    ld d,a
    ld a,(F_R)
    rrca
    rrca
    rrca
    ld b,a
    and $E0
    ld c,a                      ; C = the row's first screen low byte
    ld a,b
    and 3
    ld b,a                      ; B = its third
    add a,CELL_TILE>>8
    ld iyl,a                    ; IYL = its cell map page
    ld a,b
    add a,a
    add a,a
    add a,a
    add a,(DFILE0>>8)
    add a,d
    ld (F_SCR1),a               ; the screen page of its pixel row K1
    ld de,F_COLS                ; ---- the marked cells and their backgrounds ----
    ld h,F_LOWBIT>>8
    ld a,(F_RBITS)
    or a
    call nz,fine_bits
    ld a,c
    add a,8
    ld c,a
    ld a,(F_RBITS+1)
    or a
    call nz,fine_bits
    ld a,c
    add a,8
    ld c,a
    ld a,(F_RBITS+2)
    or a
    call nz,fine_bits
    ld a,c
    add a,8
    ld c,a
    ld a,(F_RBITS+3)
    or a
    call nz,fine_bits
    ld a,e
    sub F_COLS&$FF
    ld (F_M),a
    ld a,(F_R)                  ; ---- the instances of this row ----
    ld e,a
    add a,F_RLC&$FF
    ld l,a
    ld h,F_RLC>>8
    ld a,(hl)
    or a
    jr z,.done
    ld b,a
    ld a,e
    rrca
    rrca
    rrca
    rrca
    ld l,a
    and $0F
    add a,F_RL>>8
    ld h,a
    ld a,l
    and $F0
    ld l,a                      ; F_RL + 16 row
.bl:
    ld a,(hl)
    inc l
    exx
    call fine_blit_inst
    exx
    djnz .bl
.done:
    ld a,(F_M)
    ret

; fine_bits: A = a byte of marked cells (<> 0), C = the screen low byte of its first column, DE = the next F_COLS entry, H = F_LOWBIT's page: each
; cell's low byte appended (lowest first) and its background, rows K0 .. K1, built into the strip (in the other register set: IX = the entry of
; the bitmap blocks, IYH = K0, IYL = the cell map's page).  Clobbers AF, B, L, the other set's BC, DE, HL.
fine_bits:
    ld l,a
    dec a
    and l
    ld b,a                      ; B = the byte without its lowest bit
    ld a,(hl)
    add a,c
    ld (de),a
    inc e
    exx
    ld l,a                      ; L = the cell's low byte
    add a,a
    add a,a
    add a,a
    add a,iyh
    ld e,a                      ; E = its strip row K0
    ld a,iyl
    ld h,a                      ; HL = the cell
    ld c,(hl)                   ; C = its value
    ld d,l
    ld l,e
    ld h,F_STRIP>>8
    ld a,(F_GP)
    ld b,a                      ; BC = its glyph row K0, HL = its strip row K0
    jp (ix)
.bgb:                           ; N rows of the bitmap, entered at block 8 - N (the blocks are alike)
    DUP 8
    ld a,(bc)
    ld (hl),a
    inc l
    inc b
    EDUP
.bgbe:
    ld a,(F_TMASK)              ; a tile cell (and a tileset)?
    and c
    jp p,.font
    ld a,c                      ; HL = F_TB0 + 8 v: its tile's row attribute K0 (v >= 128: F_TBASE is tile_rows - 1024)
    rlca
    rlca
    rlca
    ld l,a
    and 7
    ld h,a
    xor l
    ld l,a
    ld bc,(F_TB0)
    add hl,bc
    ld d,(F_STRIP>>8)+1         ; DE = its strip colour row K0
    ld bc,(F_NW)
    ldir
.bgn:
    exx
    ld a,b
    or a
    jr nz,fine_bits
    ret
.font:                          ; a font cell: its attribute on the rows
    ld l,d
    ld a,iyl
    add a,3
    ld h,a
    ld a,(hl)                   ; (CELL_ATTR)
    ld l,e
    ld h,(F_STRIP>>8)+1
    ld bc,(F_NW)
    ld b,c
.f:
    ld (hl),a
    inc l
    djnz .f
    jr .bgn

; fine_blit_mid: (fine_blit_inst) the instance's second or third cell row: HL = its I_EF, C = the row-list entry.
fine_blit_mid:
    ld a,l
    add a,I_ROWSM-I_EF
    ld l,a
    ld b,(hl)                   ; the rows below the first cell row
    inc l
    bit 1,c
    jr nz,.third
    ld a,b                      ; the second cell row: from sprite row j1, min(8, h - j1) rows
    cp 8
    jr c,fine_blit_inst.go
    ld b,8
    jr fine_blit_inst.go
.third:                         ; the third: from sprite row j1 + 8, h - j1 - 8 rows
    ld a,b
    sub 8
    ld b,a
    ld a,(hl)
    add a,8
    ld iyl,a
    inc l
    ld a,(hl)
    adc a,0
    ld iyh,a
    inc l
    ex af,af'
    ld c,a
    ex af,af'
    ld a,c                      ; + 8 rows of 2 wb bytes
    add a,a
    add a,a
    add a,a
    add a,a
    add a,(hl)
    inc l
    ld h,(hl)
    ld l,a
    jr nc,fine_blit_inst.go2
    inc h
    jr fine_blit_inst.go2

; fine_blit_inst: A = a row-list entry (16 i + d: instance i, visible, d = this cell row - its first) -> blitted into the strip over this cell row,
; unless no cell it covers in this row is marked.  Clobbers AF, AF', BC, DE, HL, IX, IY.
fine_blit_inst:
    ld c,a
    and $F0
    ld l,a
    ld h,F_INFO>>8              ; HL = its F_INFO entry, read in order
    ld e,(hl)                   ; a marked cell under it in this row?
    inc l
    ld d,F_RBITS>>8
    ld a,(de)
    and (hl)
    inc l
    ld b,a
    inc e
    ld a,(de)
    and (hl)
    inc l
    or b
    ret z
    ld e,(hl)                   ; E = I_E0
    inc l
    ld a,(hl)                   ; I_WB
    inc l
    ex af,af'
    ld a,c
    and 3
    jr nz,fine_blit_mid
    ld e,(hl)                   ; its first cell row: from sprite row 0 at strip row I_EF, I_ROWS0 rows
    inc l
    ld b,(hl)
    inc l
.go:                            ; HL = the inks, then the phase row
    ld a,(hl)
    ld iyl,a
    inc l
    ld a,(hl)
    ld iyh,a
    inc l
    ld a,(hl)
    inc l
    ld h,(hl)
    ld l,a
.go2:
    ld d,F_STRIP>>8
    ld ixl,b
    ex af,af'
    cp 2
    jp c,fine_blit1
    jp z,fine_blit2
    ; (falls into fine_blit3)

; fine_blit1/2/3: IXL rows of a window of 1/2/3 bytes: HL = the phase copy's row (mask, image pairs), DE = the strip (column, row), IY = the inks.
    MACRO FBYTE
        ld b,(hl)               ; the mask
        inc hl
        ld a,(de)
        and b
        or (hl)
        inc hl
        ld (de),a
        inc b
        jr z,1F                 ; mask $FF: the sprite covers no pixel of this byte, the colour stays
        inc d
        ld a,(de)
        and $F8
        or c
        ld (de),a
        dec d
1:
    ENDM
fine_blit3:
    ld c,(iy+0)
    inc iy
    FBYTE
    ld a,e
    add a,8
    ld e,a
    FBYTE
    ld a,e
    add a,8
    ld e,a
    FBYTE
    ld a,e
    sub 15
    ld e,a
    dec ixl
    jr nz,fine_blit3
    ret
fine_blit2:
    ld c,(iy+0)
    inc iy
    FBYTE
    ld a,e
    add a,8
    ld e,a
    FBYTE
    ld a,e
    sub 7
    ld e,a
    dec ixl
    jr nz,fine_blit2
    ret
fine_blit1:
    ld c,(iy+0)
    inc iy
    FBYTE
    inc e
    dec ixl
    jr nz,fine_blit1
    ret

F_ENT:                          ; N = 1 .. 8: DW the diff's entry (block 8 - N, 23 bytes a block), DW the background's (4 bytes a block)
    DW fine_compose.diffb+23*7, fine_bits.bgb+4*7
    DW fine_compose.diffb+23*6, fine_bits.bgb+4*6
    DW fine_compose.diffb+23*5, fine_bits.bgb+4*5
    DW fine_compose.diffb+23*4, fine_bits.bgb+4*4
    DW fine_compose.diffb+23*3, fine_bits.bgb+4*3
    DW fine_compose.diffb+23*2, fine_bits.bgb+4*2
    DW fine_compose.diffb+23*1, fine_bits.bgb+4*1
    DW fine_compose.diffb, fine_bits.bgb
M_FINE_E:
    ASSERT (SPR_TAB>>8) == (AST>>8) && (F_REC>>8) == ((F_REC+63)>>8) && (F_RLC>>8) == ((F_RLC+23)>>8) && (F_COLS>>8) == ((F_COLS+31)>>8)
    ASSERT (PHASE_PTR&$FF)+127 < 256 && (MASK_TAB&$FF)+96 <= 256 && SYNC_BUSY == 0 && SYNC_READY == 1 && SYNC_REQUEST == 2
    ASSERT (F_RBITS&$FF)+4 < 256 && (F_INFO&$FF) == 0 && (F_RL&$FF) == 0 && (F_COLS>>8) == ((F_COLS+31)>>8) && (BIT_TAB&$FF) == 0
    ASSERT fine_compose.diffe-fine_compose.diffb == 8*23 && fine_bits.bgbe-fine_bits.bgb == 8*4
    ASSERT (F_ENT>>8) == ((F_ENT+31)>>8)
    ASSERT (F_RMASK&$FF) == $80 && (F_LOWBIT&$FF) == 0 && (F_STRIP>>8)+1 == (DATTR0>>8)+1 && CELL_ATTR == CELL_TILE+$300
