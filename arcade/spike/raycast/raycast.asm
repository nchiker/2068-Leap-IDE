; Raycaster spike for the TS2068 (see RESULTS.md). Assembled by run-raycast.mjs with sjasmplus.
; The per-configuration constants and the unrolled / generated parts come from build.mjs (gen_*.inc).
;
; METHOD 0 = A: clear the window (PUSH), then each ray is OR-ed into the bitmap (read-modify-write).
; METHOD 1 = B: byte columns are composed from the 8/WCOL rays that share a byte, sorted by height, written with
;               plain stores (no clear, no read); every window byte is written once.

        INCLUDE "gen_cfg.inc"           ; W HPX WCOL METHOD MAPN MAPLOG

NRAY    EQU W/WCOL
WB      EQU W/8
RPB     EQU 8/WCOL                      ; rays per byte column
HH      EQU HPX/2
XB0     EQU (32-WB)/2
Y0      EQU (192-HPX)/2
HGTN    EQU MAPN*48
RECN    EQU 320
ROWLO   EQU Y0+HH
ROWUP   EQU Y0+HH-1
LB      EQU 0x4000+(((ROWLO)&0xC0)<<5)+(((ROWLO)&7)<<8)+(((ROWLO)&0x38)<<2)+XB0   ; lower pointer, byte column 0
UB      EQU 0x4000+(((ROWUP)&0xC0)<<5)+(((ROWUP)&7)<<8)+(((ROWUP)&0x38)<<2)+XB0   ; upper pointer, byte column 0
ROWEND0 EQU 0x4000+(((Y0)&0xC0)<<5)+(((Y0)&7)<<8)+(((Y0)&0x38)<<2)+XB0+WB
MASK0   EQU ((1<<WCOL)-1)<<(8-WCOL)

; ---- RAM ---------------------------------------------------------------------------------------------------------
VARS    EQU 0xB000
PXV     EQU VARS+0
PYV     EQU VARS+2
ANGV    EQU VARS+4
RDX     EQU VARS+6
RDY     EQU VARS+8
STX     EQU VARS+10
STY     EQU VARS+12
MAPP0   EQU VARS+14
MXPN    EQU VARS+16                     ; +0 multiplier if dir >= 0, +1 if dir < 0
MYPN    EQU VARS+18
DXV     EQU VARS+20
DYV     EQU VARS+22
SIGNX   EQU VARS+24
RAYCNT  EQU VARS+25
HHPTR   EQU VARS+26
PIPTR   EQU VARS+28
SAVSP   EQU VARS+30
COSA    EQU VARS+32
SINA    EQU VARS+34
PLX     EQU VARS+36
PLY     EQU VARS+38
COLN    EQU VARS+40
JHH     EQU VARS+42
JPI     EQU VARS+44
LBC     EQU VARS+46
UBC     EQU VARS+48
EXITA   EQU VARS+50
SAVEB   EQU VARS+52
ACCV    EQU VARS+54
RCNT    EQU VARS+56
HHCUR   EQU VARS+57
PMB     EQU VARS+58
INCNT   EQU VARS+60
PREV    EQU VARS+61
D1V     EQU VARS+62
SLOT    EQU VARS+64
NREC    EQU VARS+66                     ; 3 bytes
MK      EQU VARS+70
ST4X    EQU VARS+74
ST4Y    EQU VARS+76
LRDX    EQU VARS+78
LRDY    EQU VARS+80
TPH     EQU VARS+82
TPP     EQU VARS+84
KCNT    EQU VARS+86
RES     EQU VARS+88                     ; RHH, RPI, RPTR (4 bytes, same layout as LRES)
RHH     EQU RES
RPI     EQU RES+1
RPTR    EQU RES+2
LRES    EQU VARS+92
LHH     EQU LRES
LPI     EQU LRES+1
LPTR    EQU LRES+2
SAVR    EQU VARS+96
PW      EQU VARS+72
SB      EQU VARS+0x88                   ; sorted records (hh, o, e); SB-3 holds the sentinel hh = 0
HHR     EQU 0xB100
PIR     EQU 0xB190
PATM    EQU 0xB280                      ; [r*16 + pi*2] = (O byte, E byte), masked
COS     EQU 0xB400                      ; 256 x int16, 4.12
RECIP   EQU 0xB600                      ; RECN x uint16 (8.8)
HGT     EQU 0xBA00                      ; HGTN bytes

        ORG 0x8000
START:  di
        ld sp,0xFF00
        call INIT
INIT_DONE:
        jr INIT_DONE
FRAME:  di
        ld sp,0xFF00
        call DOFRAME
FRAME_DONE:
        jr FRAME_DONE

DOFRAME:
        call SETUP
P_SETUP_END:
        call CAST
P_CAST_END:
  IF METHOD == 0
        call CLEARWIN
P_CLEAR_END:
        call DRAWA
  ELSE
        call DRAWB
  ENDIF
        ret

; ======================================================================================================================
; INIT: tables built at start
; ======================================================================================================================
L_INIT:
INIT:   call INIT_COS
        call INIT_RECIP
        call INIT_HGT
        call INIT_PATM
        call INIT_ATTR
        xor a
        ld (SB-3),a
        ret

INIT_COS:
        ld hl,QTAB+128
        ld de,COS
        ld b,65
.c1:    ld a,(hl) : ld (de),a : inc hl : inc de
        ld a,(hl) : ld (de),a : inc de
        dec hl : dec hl : dec hl
        djnz .c1
        ld hl,COS+126
        ld de,COS+130
        ld a,64 : ld (INCNT),a
.c2:    ld c,(hl) : inc hl : ld b,(hl) : dec hl : dec hl : dec hl
        xor a : sub c : ld c,a : sbc a,a : sub b : ld b,a
        ld a,c : ld (de),a : inc de : ld a,b : ld (de),a : inc de
        ld a,(INCNT) : dec a : ld (INCNT),a : jr nz,.c2
        ld hl,COS+254
        ld de,COS+258
        ld a,127 : ld (INCNT),a
.c3:    ld c,(hl) : inc hl : ld b,(hl) : dec hl : dec hl : dec hl
        ld a,c : ld (de),a : inc de : ld a,b : ld (de),a : inc de
        ld a,(INCNT) : dec a : ld (INCNT),a : jr nz,.c3
        ret

INIT_RECIP:
        ld hl,0x7FFF : ld (RECIP),hl
        ld ix,1
        ld iy,RECIP+2
.r:     push ix : pop de
        ld bc,65535 : call DIV16
        bit 7,b : jr z,.ok
        ld bc,0x7FFF
.ok:    ld (iy+0),c : ld (iy+1),b
        inc iy : inc iy : inc ix
        push ix : pop hl : ld de,RECN : or a : sbc hl,de : jr c,.r
        ret

INIT_HGT:
        ld hl,HGT : ld (hl),HH : ld de,HGT+1 : ld bc,32 : ldir
        ld ix,33
        ld iy,HGT+33
.h:     push ix : pop de
        ld bc,HH*32 : call DIV16
        ld (iy+0),c
        inc iy : inc ix
        push ix : pop hl : ld de,HGTN : or a : sbc hl,de : jr c,.h
        ret

INIT_PATM:
        ld hl,PATM : ld (PW),hl
        ld a,MASK0 : ld (MK),a
        ld a,RPB : ld (RCNT),a
.r:     ld de,PATB : ld b,8 : ld hl,(PW)
.p:     ld a,(MK) : ld c,a
        inc de : ld a,(de) : and c : ld (hl),a : inc hl          ; O
        dec de : ld a,(de) : and c : ld (hl),a : inc hl          ; E
        inc de : inc de
        djnz .p
        ld (PW),hl
        ld a,(MK)
        DUP WCOL
        srl a
        EDUP
        ld (MK),a
        ld hl,RCNT : dec (hl) : jr nz,.r
        ret

INIT_ATTR:
        ld hl,0x5800+(Y0/8)*32+XB0
        ld d,HPX/8
.ar:    ld e,WB : push hl
.ac:    ld (hl),0x47 : inc hl : dec e : jr nz,.ac
        pop hl : ld bc,32 : add hl,bc
        dec d : jr nz,.ar
        ret

; 16 / 16 unsigned division: BC / DE -> BC quotient, HL remainder (A destroyed). Divisor < 32768.
DIV16:  ld hl,0
        ld a,16
.l:     sla c : rl b : adc hl,hl
        or a : sbc hl,de
        jr nc,.ok
        add hl,de
        dec a : jr nz,.l
        ret
.ok:    inc c
        dec a : jr nz,.l
        ret

; ======================================================================================================================
; Per-frame setup: direction, camera plane, ray step, fractions, map pointer
; ======================================================================================================================
L_SETUP:
SETUP:  ld a,(ANGV)
        ld l,a : ld h,0 : add hl,hl : ld de,COS : add hl,de
        ld e,(hl) : inc hl : ld d,(hl) : ld (COSA),de
        ld a,(ANGV) : add a,192
        ld l,a : ld h,0 : add hl,hl : ld de,COS : add hl,de
        ld e,(hl) : inc hl : ld d,(hl) : ld (SINA),de
        ex de,hl
        call MULP                       ; HL = mulP(sin)
        ld a,l : cpl : ld l,a : ld a,h : cpl : ld h,a : inc hl
        ld (PLX),hl                     ; plane x = -mulP(sin)
        ld hl,(COSA)
        call MULP
        ld (PLY),hl
        ld hl,(PLX) : call STEPOF : ld (STX),hl
        ld hl,(PLY) : call STEPOF : ld (STY),hl
        ld hl,(COSA) : ld de,(PLX) : or a : sbc hl,de
        ld de,(STX) : sra d : rr e : add hl,de : ld (RDX),hl
        ld hl,(SINA) : ld de,(PLY) : or a : sbc hl,de
        ld de,(STY) : sra d : rr e : add hl,de : ld (RDY),hl
        ld a,(PXV) : ld b,a : neg : ld c,a : ld (MXPN),bc
        ld a,(PYV) : ld b,a : neg : ld c,a : ld (MYPN),bc
        ld a,(PYV+1) : ld l,a : ld h,0
        DUP MAPLOG
        add hl,hl
        EDUP
        ld de,MAP : add hl,de
        ld a,(PXV+1) : ld e,a : ld d,0 : add hl,de
        ld (MAPP0),hl
        ret

; HL = v * 37/64 using arithmetic shifts: (v>>1) + (v>>4) + (v>>6)
MULP:   ld d,h : ld e,l
        sra h : rr l
        DUP 4
        sra d : rr e
        EDUP
        add hl,de
        DUP 2
        sra d : rr e
        EDUP
        add hl,de
        ret

; HL = signed plane value -> HL = sign * ((2|p| + N/2) / N)
STEPOF: ld a,h : push af
        bit 7,h : jr z,.p
        ld a,l : cpl : ld l,a : ld a,h : cpl : ld h,a : inc hl
.p:     add hl,hl
        ld bc,NRAY/2 : add hl,bc
        ld b,h : ld c,l
        ld de,NRAY
        call DIV16
        ld h,b : ld l,c
        pop af : bit 7,a : ret z
        ld a,l : cpl : ld l,a : ld a,h : cpl : ld h,a : inc hl
        ret

; ======================================================================================================================
; Ray casting
; ======================================================================================================================
; AXIS: HL = dir (signed 4.12), C = multiplier if dir >= 0, B = multiplier if dir < 0
;       -> DE = delta (8.8, reciprocal table), HL = floor(m * delta / 256), C = 1 if dir < 0 else 0
L_CAST:
AXIS:   bit 7,h
        jr nz,.neg
        ld b,c : ld c,0
        jr .abs
.neg:   ld a,l : cpl : ld l,a : ld a,h : cpl : ld h,a : inc hl
        ld c,1
.abs:   DUP 4
        srl h : rr l
        EDUP
        add hl,hl
        ld de,RECIP : add hl,de
        ld e,(hl) : inc hl : ld d,(hl)
        ld a,b
        ld hl,0
        DUP 8
        rra
        jr nc,$+3
        add hl,de
        rr h
        rr l
        EDUP
        ret

  IF INTERP == 0
CAST:   ld hl,HHR : ld (HHPTR),hl
        ld hl,PIR : ld (PIPTR),hl
        ld a,NRAY : ld (RAYCNT),a
CASTLP: call RAY
        ld hl,(HHPTR) : ld a,(RHH) : ld (hl),a : inc hl : ld (HHPTR),hl
        ld hl,(PIPTR) : ld a,(RPI) : ld (hl),a : inc hl : ld (PIPTR),hl
        ld hl,(RDX) : ld de,(STX) : add hl,de : ld (RDX),hl
        ld hl,(RDY) : ld de,(STY) : add hl,de : ld (RDY),hl
        ld hl,RAYCNT : dec (hl)
        jr nz,CASTLP
        ret
  ELSE
; every 4th ray is cast; the 3 rays between two ends that hit the same cell and side get interpolated heights
CAST:   ld hl,HHR : ld (HHPTR),hl
        ld hl,PIR : ld (PIPTR),hl
        ld hl,(STX) : add hl,hl : add hl,hl : ld (ST4X),hl
        ld hl,(STY) : add hl,hl : add hl,hl : ld (ST4Y),hl
        call RAY
        ld hl,(HHPTR) : ld a,(RHH) : ld (hl),a
        ld hl,(PIPTR) : ld a,(RPI) : ld (hl),a
        ld hl,RES : ld de,LRES : ld bc,4 : ldir
        ld a,NRAY/4 : ld (RAYCNT),a
.iv:    ld hl,(RDX) : ld (LRDX),hl : ld de,(ST4X) : add hl,de : ld (RDX),hl
        ld hl,(RDY) : ld (LRDY),hl : ld de,(ST4Y) : add hl,de : ld (RDY),hl
        call RAY
        ld hl,(LPTR) : ld de,(RPTR) : or a : sbc hl,de : jr nz,.fb
        ld a,(LPI) : ld hl,RPI : cp (hl) : jr nz,.fb
        ; flat: v = 4*LHH + k*d, hh = (v + 2) >> 2
        ld ix,(HHPTR) : ld iy,(PIPTR)
        ld a,(LHH) : ld e,a : ld d,0
        ld a,(RHH) : ld l,a : ld h,0 : or a : sbc hl,de          ; HL = d
        ex de,hl                                                   ; DE = d, HL = LHH
        add hl,hl : add hl,hl                                      ; v0
        add hl,de
        push hl
        inc hl : inc hl
        srl h : rr l : srl h : rr l
        ld (ix+1),l
        pop hl
        add hl,de
        push hl
        inc hl : inc hl
        srl h : rr l : srl h : rr l
        ld (ix+2),l
        pop hl
        add hl,de
        inc hl : inc hl
        srl h : rr l : srl h : rr l
        ld (ix+3),l
        ld a,(LPI) : ld (iy+1),a : ld (iy+2),a : ld (iy+3),a
        jp .adv
.fb:    ld hl,RES : ld de,SAVR : ld bc,4 : ldir                  ; keep the right end's result
        ld hl,(LRDX) : ld (RDX),hl : ld hl,(LRDY) : ld (RDY),hl
        ld hl,(HHPTR) : inc hl : ld (TPH),hl
        ld hl,(PIPTR) : inc hl : ld (TPP),hl
        ld a,3 : ld (KCNT),a
.fk:    ld hl,(RDX) : ld de,(STX) : add hl,de : ld (RDX),hl
        ld hl,(RDY) : ld de,(STY) : add hl,de : ld (RDY),hl
        call RAY
        ld hl,(TPH) : ld a,(RHH) : ld (hl),a : inc hl : ld (TPH),hl
        ld hl,(TPP) : ld a,(RPI) : ld (hl),a : inc hl : ld (TPP),hl
        ld hl,KCNT : dec (hl) : jr nz,.fk
        ld hl,(LRDX) : ld de,(ST4X) : add hl,de : ld (RDX),hl
        ld hl,(LRDY) : ld de,(ST4Y) : add hl,de : ld (RDY),hl
        ld hl,SAVR : ld de,RES : ld bc,4 : ldir
.adv:   ld ix,(HHPTR) : ld a,(RHH) : ld (ix+4),a
        ld iy,(PIPTR) : ld a,(RPI) : ld (iy+4),a
        ld hl,RES : ld de,LRES : ld bc,4 : ldir
        ld de,4
        ld hl,(HHPTR) : add hl,de : ld (HHPTR),hl
        ld hl,(PIPTR) : add hl,de : ld (PIPTR),hl
        ld hl,RAYCNT : dec (hl)
        jp nz,.iv
        ret
  ENDIF

; one ray from (RDX, RDY): -> RHH, RPI, RPTR
RAY:    ld hl,(RDX) : ld bc,(MXPN) : call AXIS
        ld (DXV),de : push hl
        ld a,c : ld (SIGNX),a
        ld hl,(RDY) : ld bc,(MYPN) : call AXIS
        ld (DYV),de : push hl
        ld a,c : add a,a : ld c,a : ld a,(SIGNX) : add a,c
        add a,a : ld e,a : ld d,0 : ld hl,LOOPTAB : add hl,de
        ld e,(hl) : inc hl : ld d,(hl)
        push de : pop ix
        ld hl,(DXV) : ld (ix+DDA_PXL),l : ld (ix+DDA_PXH),h
        ld hl,(DYV) : ld (ix+DDA_PYL),l : ld (ix+DDA_PYH),h
        pop de                          ; sd0 y
        pop bc                          ; sd0 x
        ld hl,(MAPP0)
        jp (ix)                         ; the DDA loop ends with "jp HITX / HITY", whose RET returns to our caller

HITX:   ld (RPTR),hl
        ld d,a                          ; wall type
        ld hl,(DXV)
        ld a,c : sub l : ld l,a : ld a,b : sbc a,h : ld h,a          ; perpendicular distance = sdx - deltaX
        ld b,d : ld c,0
        jr HITC
HITY:   ld (RPTR),hl
        ld b,a
        ld hl,(DYV)
        ld a,e : sub l : ld l,a : ld a,d : sbc a,h : ld h,a
        ld c,1
HITC:   DUP 3
        srl h : rr l
        EDUP
        ld de,HGT : add hl,de : ld a,(hl)                             ; half height
        ld (RHH),a
        ld a,b : dec a : add a,a : add a,c                            ; pattern index
        ld (RPI),a
        ret

        INCLUDE "gen_dda.inc"           ; DDA0..DDA3, LOOPTAB, DDA_P?? offsets

; ======================================================================================================================
; Method A: clear + per-ray read-modify-write
; ======================================================================================================================
  IF METHOD == 0
L_DRAWA:
        INCLUDE "gen_clear.inc"         ; CLEARWIN

DRAWA:  ld hl,HHR : ld (JHH),hl
        ld hl,PIR : ld (JPI),hl
        xor a : ld (COLN),a
.col:   ld a,(COLN) : ld e,a : ld d,0
        ld hl,LB : add hl,de : ld (LBC),hl
        ld hl,UB : add hl,de : ld (UBC),hl
        ld hl,PATM : ld (PMB),hl
        ld a,RPB : ld (RCNT),a
.ray:   ld hl,(JHH) : ld a,(hl) : inc hl : ld (JHH),hl
        ld hl,(JPI) : ld c,(hl) : inc hl : ld (JPI),hl
        or a : jr z,.nodraw
        ld (HHCUR),a
        ld l,c : ld h,0 : add hl,hl : ld de,(PMB) : add hl,de
        ld c,(hl) : inc hl : ld b,(hl)                                  ; C = O pattern, B = E pattern
        ld a,(HHCUR) : ld l,a : ld h,0 : add hl,hl : ld de,UNITA : add hl,de
        ld e,(hl) : inc hl : ld d,(hl)
        ld (EXITA),de : ld a,(de) : ld (SAVEB),a : ld a,0xC9 : ld (de),a
        ld hl,(LBC) : ld de,(UBC)
        ld ix,UCHA
        call CALLIX
        ld hl,(EXITA) : ld a,(SAVEB) : ld (hl),a
.nodraw: ld hl,(PMB) : ld de,16 : add hl,de : ld (PMB),hl
        ld hl,RCNT : dec (hl) : jp nz,.ray
        ld a,(COLN) : inc a : ld (COLN),a : cp WB : jp nz,.col
        ret
CALLIX: jp (ix)

        INCLUDE "gen_chain.inc"         ; UCHA, UNITA
  ELSE
; ======================================================================================================================
; Method B: byte-column composer
; ======================================================================================================================
L_DRAWB:
DRAWB:  ld hl,HHR : ld (JHH),hl
        ld hl,PIR : ld (JPI),hl
        xor a : ld (COLN),a
.col:   ld hl,PATM : ld (PMB),hl
        ld hl,0 : ld (ACCV),hl
        ld hl,SB : ld (SLOT),hl
        ld a,RPB : ld (RCNT),a
.g:     ld hl,(JHH) : ld c,(hl) : inc hl : ld (JHH),hl
        ld hl,(JPI) : ld a,(hl) : inc hl : ld (JPI),hl
        add a,a : ld l,a : ld h,0 : ld de,(PMB) : add hl,de
        ld e,(hl) : inc hl : ld d,(hl)
        ld hl,(ACCV) : ld a,l : xor e : ld l,a : ld a,h : xor d : ld h,a : ld (ACCV),hl
        ld a,c : ld (NREC),a : ld (NREC+1),de
        call INSREC
        ld hl,(PMB) : ld de,16 : add hl,de : ld (PMB),hl
        ld hl,RCNT : dec (hl) : jr nz,.g
        ; column pointers into the shadow register set
        ld a,(COLN) : ld e,a : ld d,0
        ld hl,LB : add hl,de : ld (LBC),hl
        ld hl,UB : add hl,de : ld (UBC),hl
        exx : ld hl,(LBC) : ld de,(UBC) : exx
        ld iy,SB
        ld ix,UCHB
        xor a : ld (PREV),a
        ld a,RPB : ld (RCNT),a
.rl:    ld a,(iy+0)
        ld hl,PREV : cp (hl) : jr z,.nr
        call DORUN
.nr:    ld hl,(ACCV) : ld a,l : xor (iy+1) : ld l,a : ld a,h : xor (iy+2) : ld h,a : ld (ACCV),hl
        ld de,3 : add iy,de
        ld hl,RCNT : dec (hl) : jr nz,.rl
        ld a,(PREV) : cp HH : jr z,.cd
        ld a,HH : call DORUN
.cd:    ld a,(COLN) : inc a : ld (COLN),a : cp WB : jp nz,.col
        ret

; draw rows (PREV .. A) of the current column with the accumulators in ACCV; the pointers live in HL', DE'
DORUN:  ld (D1V),a                      ; IX = entry address of row PREV (the previous run's exit)
        add a,a : ld l,a : ld h,0 : ld de,UNITB : add hl,de
        ld e,(hl) : inc hl : ld d,(hl)
        ld (EXITA),de : ld a,(de) : ld (SAVEB),a : ld a,0xC9 : ld (de),a
        exx
        ld bc,(ACCV)                    ; C = O accumulator, B = E accumulator
        call CALLIX
        exx
        ld hl,(EXITA) : ld a,(SAVEB) : ld (hl),a
        push hl : pop ix                ; next entry
        ld a,(D1V) : ld (PREV),a
        ret
CALLIX: jp (ix)

; insert the record at NREC into the list at SB (ascending by hh), SLOT = first free slot
INSREC: ld hl,(SLOT)
.il:    dec hl : dec hl : dec hl
        ld a,(NREC)
        cp (hl)
        jr nc,.place
        ld d,h : ld e,l : inc de : inc de : inc de
        ldi : ldi : ldi
        dec hl : dec hl : dec hl
        jr .il
.place: inc hl : inc hl : inc hl
        ld a,(NREC) : ld (hl),a : inc hl
        ld a,(NREC+1) : ld (hl),a : inc hl
        ld a,(NREC+2) : ld (hl),a
        ld hl,(SLOT) : ld de,3 : add hl,de : ld (SLOT),hl
        ret

        INCLUDE "gen_chain.inc"         ; UCHB, UNITB
  ENDIF

L_DATA:
        INCLUDE "gen_data.inc"          ; QTAB, PATB, MAP
L_END:
