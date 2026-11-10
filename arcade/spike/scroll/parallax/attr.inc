; attr.inc -- attribute passes shared by p1.asm and lay.asm
; attr_rows: in HL = map pointer (first window row, first window column), DE = attribute destination of that row, A = rows.
;   out: DE = destination of the row after the last. B is set to the far attribute page. One attribute per cell:
;   attr = ATTRB[map byte] (the V2 convention: the attribute of the tile at the cell, no sub-cell shift)
attr_rows:
    ld (V_AR),a
    ld b,ATTRB>>8
.row:
    push hl
    push de
    DUP NC
    ld a,(hl)
    inc l
    ld c,a
    ld a,(bc)
    ld (de),a
    inc e
    EDUP
    pop de
    ld hl,32
    add hl,de
    ex de,hl
    pop hl
    push de
    ld de,MAPW
    add hl,de
    pop de
    ld a,(V_AR)
    dec a
    ld (V_AR),a
    jp nz,.row
    ret
