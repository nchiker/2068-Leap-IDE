; Column-scaled billboard: a 32x32 source (one byte per source pixel, stored column by column, 32 bytes a column)
; is drawn HS pixels high and HS pixels wide at screen x XPIX, vertically centred on screen row CYROW, one pixel
; column at a time (OR into the bitmap). Source indexes are 8.8 accumulators, so the picture is nearest-neighbour.
        INCLUDE "spr_cfg.inc"           ; HS, XPIX, CYROW, SW (pixel columns per drawn column: 1 or 4)
STEP    EQU (32*256)/HS                 ; 8.8 source step per destination pixel
COLS    EQU HS/SW
TOPROW  EQU CYROW-HS/2
TOPADDR EQU 0x4000+(((TOPROW)&0xC0)<<5)+(((TOPROW)&7)<<8)+(((TOPROW)&0x38)<<2)
        ORG 0x8000
START:  di
        ld sp,0xFF00
        call SPRITE
DONE:   jr DONE

SPRITE: ld hl,TOPADDR+(XPIX>>3) : ld (SCRP),hl
  IF SW == 1
        ld a,0x80>>(XPIX&7) : ld (MASK),a
  ELSE
        ld a,0xF0>>(XPIX&7) : ld (MASK),a
  ENDIF
        ld hl,0 : ld (UACC),hl
        ld a,COLS : ld (COLCNT),a
.col:   ld a,(MASK) : ld (.msk+1),a
        ld a,(UACC+1) : ld l,a : ld h,0
        add hl,hl : add hl,hl : add hl,hl : add hl,hl : add hl,hl
        ld de,SRC : add hl,de : ex de,hl           ; DE = source column
        ld hl,(SCRP)
        ld b,HS : ld c,0
.row:   ld a,(de)
        or a
        jr z,.skip
        ld a,(hl)
.msk:   or 0
        ld (hl),a
.skip:  ld a,c : add a,STEP&255 : ld c,a
        ld a,e : adc a,STEP>>8 : ld e,a
        inc h
        ld a,h : and 7
        jr z,.cell
        djnz .row
        jr .next
.cell:  ld a,l : add a,32 : ld l,a
        jr c,.nc
        ld a,h : sub 8 : ld h,a
.nc:    djnz .row
.next:  ld hl,(UACC) : ld de,STEP*SW : add hl,de : ld (UACC),hl
  IF SW == 1
        ld a,(MASK) : rrca : ld (MASK),a
        jr nc,.same
  ELSE
        ld a,(MASK) : rrca : rrca : rrca : rrca : ld (MASK),a
        cp 0xF0
        jr nz,.same
  ENDIF
        ld hl,(SCRP) : inc hl : ld (SCRP),hl
.same:  ld hl,COLCNT : dec (hl) : jr nz,.col
        ret

MASK    EQU 0xB000
UACC    EQU 0xB002
SCRP    EQU 0xB004
COLCNT  EQU 0xB006
        ALIGN 256
SRC:    INCBIN "spr_src.bin"
