; api.asm -- the v0 runtime routines compiled code calls (docs/ARCADE_RUNTIME_API.md, "Calling convention"); the v1 ones are
; in text.asm (text, tiles, RT_HIT) and sound.asm (RT_PLAY, RT_SILENCE, the frame interrupt's sound tick).
; Every routine clobbers AF, BC, DE, HL only, and preserves IX, IY and the alternate registers; none of them
; touches the stack beyond its own CALL / PUSH (at most 6 bytes deep).  Calls are plain CALLs from game code.
    ; (no ORG: follows main.asm)
M_API_S:

; ---------------------------------------------------------------------------------------------------------------
; RT_SHOW: A = instance index, BC = x, DE = y (signed 16-bit).  Makes the instance visible at that position with the frame it already has
; (0 at start).  RT_SHOWF: the same with HL = frame (taken AND $FF; draw_all clamps it to nframes - 1).
; Non-window mode clamps per asset: x to 0..256 - width, y to 0..192 - height.  An index >= ninst is ignored.  The stored x is unrounded: the draw
; rounds it down to the asset's phase granularity (main.asm draw_all).  Nothing changes (visible, x, y, frame equal): nothing is written;
; otherwise the entry is written and V_CHG[i] = 2 (the skip analysis: the two display files still owe a draw).  28..567 T (measured).
; ---------------------------------------------------------------------------------------------------------------
RT_SHOWF:
    push hl                     ; L = the frame
    ld hl,V_NINST
    cp (hl)
    jr c,show_f
    pop hl
    ret                         ; index >= ninst: no such instance
RT_SHOW:
    ld hl,V_NINST
    cp (hl)
    ret nc                      ; index >= ninst: no such instance
    ld h,a
    add a,a
    add a,a
    add a,a
    add a,(SPR_TAB&$FF)+SPR_FRAME_OFF
    ld l,a
    ld a,h
    ld h,SPR_TAB>>8
    ld l,(hl)                   ; L = the frame the instance has
    push hl
show_f:                         ; A = index (< ninst), BC = x, DE = y; the frame on the stack (low byte)
    ld hl,V_WIN
    bit 0,(hl)
    jr nz,show_w                ; window mode (v3 part 2, scroll.asm): x, y stored signed and unclamped (29 T on the non-window path)
    add a,a
    add a,a
    add a,a
    add a,SPR_TAB&$FF
    ld l,a
    ld h,SPR_TAB>>8
    push hl                     ; the entry
    inc l
    ld a,(hl)                   ; the asset
    add a,a
    add a,a
    add a,a
    add a,a
    add a,AST&$FF
    ld l,a
    ld h,AST>>8
    ld a,192
    sub (hl)                    ; y max = 192 - h (AST_H; 144..191)
    push af
    ld a,l
    add a,AST_WB-AST_H
    ld l,a
    ld a,(hl)
    add a,a
    add a,a
    add a,a
    neg
    ld h,a                      ; H = x max = 256 - 8 wb (224..248)
    xor a                       ; ---- x: signed 16-bit -> 0..x max ----
    bit 7,b
    jr nz,.xs                   ; negative: 0
    ld a,b
    or a
    ld a,h
    jr nz,.xs                   ; 256 or more: the maximum
    ld a,c
    cp h
    jr c,.xs
    ld a,h
.xs:
    ld c,a
    pop hl                      ; H = y max
    ld b,c                      ; B = x
    xor a                       ; ---- y ----
    bit 7,d
    jr nz,.ys
    ld a,d
    or a
    ld a,h
    jr nz,.ys
    ld a,e
    cp h
    jr c,.ys
    ld a,h
.ys:
    ld c,a                      ; C = y
    pop hl                      ; HL = the entry
    pop de                      ; E = the frame
    ld a,(hl)
    or a
    jr z,.w                     ; hidden: it is shown now
    inc l
    inc l
    ld a,(hl)
    cp b
    jr nz,.w                    ; x differs
    inc l
    inc l
    ld a,(hl)
    cp c
    jr nz,.w                    ; y differs
    inc l
    inc l
    ld a,(hl)
    cp e
    ret z                       ; visible at this position with this frame already: nothing has to be redrawn
.w:
    ld a,l
    and $F8
    ld l,a                      ; back to the start of the entry (entries are 8-aligned)
    ld (hl),1                   ; visible
    inc l
    inc l                       ; (the second byte is the instance's asset: set at boot, never changed)
    ld (hl),b
    inc l
    ld (hl),0                   ; x high
    inc l
    ld (hl),c
    inc l
    ld (hl),0                   ; y high
    inc l
    ld (hl),e                   ; frame
    ld a,l                      ; the entry changed: it has to be drawn into both display files (V_CHG counts the ticks still owed)
    sub (SPR_TAB&$FF)+SPR_FRAME_OFF
    rrca
    rrca
    rrca
    add a,V_CHG&$FF
    ld l,a
    ld h,V_CHG>>8
    ld (hl),2
    ret
show_w:
    jp show_win
    ASSERT (SPR_TAB&7) == 0

; ---------------------------------------------------------------------------------------------------------------
; RT_HIDE: A = instance index.  An index >= ninst is ignored.
; ---------------------------------------------------------------------------------------------------------------
RT_HIDE:
    ld hl,V_NINST
    cp (hl)
    ret nc
    add a,a
    add a,a
    add a,a
    add a,SPR_TAB&$FF
    ld l,a
    ld h,SPR_TAB>>8
    ld (hl),0                   ; (V_CHG is not touched: a hidden instance is never a skip candidate, and RT_SHOW sets it when it shows the instance again)
    ret

; ---------------------------------------------------------------------------------------------------------------
; RT_MUL: HL = low 16 bits of HL * DE (two's complement: the signed and unsigned low halves are the same).
; Shift-and-add over the SMALLER operand (unsigned), so the loop runs once per significant bit of that operand:
; 1 to 16 passes of 77 T (+11 T when the bit is set), typically 4 to 10 for game values.
; ---------------------------------------------------------------------------------------------------------------
RT_MUL:
    push hl
    or a
    sbc hl,de                   ; carry when HL < DE (unsigned)
    pop hl
    jr nc,.go                   ; HL >= DE: DE is the multiplier
    ex de,hl                    ; else swap, so DE is the smaller one
.go:
    ld b,h
    ld c,l                      ; BC = multiplicand
    ld hl,0                     ; product
.loop:
    srl d
    rr e                        ; carry = next multiplier bit, lowest first
    jr nc,.skip
    add hl,bc
.skip:
    ld a,d
    or e
    ret z                       ; no bits left (also covers a multiplier of 0)
    sla c
    rl b                        ; multiplicand * 2
    jr .loop

; ---------------------------------------------------------------------------------------------------------------
; RT_DIV: HL = HL DIV DE, truncating toward zero; DE = 0 gives 0.  -32768 DIV -1 wraps to -32768.
; RT_MOD: HL = HL MOD DE with the sign of the dividend (HL = (HL DIV DE) * DE + HL MOD DE); DE = 0 gives 0.
; Both: unsigned shift-subtract on the absolute values (16 passes of about 80 T, or 8 when the dividend is < 256).
; ---------------------------------------------------------------------------------------------------------------
RT_DIV:
    ld a,d
    or e
    jr z,rt_zero
    ld a,h
    xor d                       ; bit 7 = sign of the quotient
    push af
    bit 7,h
    call nz,neg_hl
    bit 7,d
    call nz,neg_de
    call udiv16                 ; HL = quotient
    pop af
    ret p
    jr neg_hl

RT_MOD:
    ld a,d
    or e
    jr z,rt_zero
    ld a,h
    or a                        ; S = sign of the dividend
    push af
    bit 7,h
    call nz,neg_hl
    bit 7,d
    call nz,neg_de
    call udiv16
    ex de,hl                    ; HL = remainder
    pop af
    ret p
    ; (fall into neg_hl)

neg_hl:                         ; HL = -HL.  Clobbers AF.
    xor a
    sub l
    ld l,a
    sbc a,a
    sub h
    ld h,a
    ret

neg_de:                         ; DE = -DE.  Clobbers AF.
    xor a
    sub e
    ld e,a
    sbc a,a
    sub d
    ld d,a
    ret

rt_zero:
    ld hl,0
    ret

; udiv16: HL = dividend (0..$8000), DE = divisor (1..$8000) -> HL = quotient, DE = remainder.  Clobbers AF, BC.
; Restoring division with the dividend and the quotient sharing A:C: each pass shifts the top dividend bit into the
; remainder and the quotient bit into the freed bottom of C.  Neither remainder doubling can overflow because the
; remainder is below the divisor (<= $8000) before the shift.
udiv16:
    ld a,h
    ld c,l
    ld hl,0
    ld b,16
    or a
    jr nz,.lp
    ld a,c                      ; dividend < 256: only its low byte has bits to bring in, 8 passes
    ld c,0
    ld b,8
.lp:
    sla c
    rla
    adc hl,hl
    sbc hl,de
    jr nc,.one
    add hl,de
    djnz .lp
    jr .done
.one:
    inc c
    djnz .lp
.done:
    ex de,hl                    ; DE = remainder
    ld h,a
    ld l,c                      ; HL = quotient (A:C)
    ret

; ---------------------------------------------------------------------------------------------------------------
; RT_RND: HL = 0..32767.  16-bit xorshift (x ^= x << 7; x ^= x >> 9; x ^= x << 8), full period 65535 over 1..65535;
; the result is the new state with bit 15 cleared.  RT_SEED (word) is the state; 0 would stay 0, so it is read as 1.
; ---------------------------------------------------------------------------------------------------------------
RT_RND:
    ld hl,(RT_SEED)
    ld a,h
    or l
    jr nz,.go
    inc l                       ; seed 0 -> 1
.go:
    ld a,h                      ; x ^= x << 7:  new high = H ^ (L >> 1) ^ (H0 << 7), new low = L ^ (L0 << 7)
    rra                         ; carry = H0
    ld a,l
    rra                         ; A = (H0 << 7) | (L >> 1), carry = L0
    ld b,a
    ld a,0                      ; (LD keeps the carry)
    rra                         ; A = L0 << 7
    xor l
    ld l,a
    ld a,h
    xor b
    ld h,a
    ld a,h                      ; x ^= x >> 9:  low ^= high >> 1
    srl a
    xor l
    ld l,a
    ld a,h                      ; x ^= x << 8:  high ^= low
    xor l
    ld h,a
    ld (RT_SEED),hl
    res 7,h
    ret

; ---------------------------------------------------------------------------------------------------------------
; RT_STICK: A = 1 or 2 -> HL = 0..31: direction bits 0-3 (active high) and fire = 16.  All four direction lines active at once
; is impossible for a real stick: it reads as an unconnected port and the whole result is 0 (fire included).
; Leap V2's BUILTIN_FN_STICK (rom/exrom_v2_vm_core.asm) reproduced: AY register 7 bit 6 = 0 (port A an input), select
; register 14, read it with A8 (joystick 1) or A9 (joystick 2) high in the port address (B = n), invert.  Any other
; A gives 0 (V2 raises error 15).
; ---------------------------------------------------------------------------------------------------------------
RT_STICK:
    dec a
    cp 2
    jr nc,rt_zero
    inc a
    ld e,a                      ; E = 1 or 2
    di                          ; v1: the frame interrupt's sound tick also selects AY registers; an interrupt between the
                                ; select and the data access below would redirect it.  Compiled code runs with interrupts on,
                                ; so the EI at .done restores that.
    ld a,7
    out (PORT_AY_REG),a         ; the mixer
    ld bc,PORT_AY_DATA          ; B = 0: no joystick enabled while writing
    in a,(c)
    and $BF                     ; bit 6 = 0: port A an input
    out (c),a
    ld a,$0E
    out (PORT_AY_REG),a         ; select AY register 14
    ld b,e                      ; A8 or A9: joystick n
    in a,(c)
    cpl                         ; active low -> active high
    ld l,a
    and $0F
    cp $0F
    jr c,.dirs
    xor a                       ; all four set: no real input
    jr .done                    ; ... and no fire either.  A stick cannot press up+down+left+right together; the port is
                                ; unconnected or the emulator answers 0 (ZEsarUX has no joystick on AY port A and reads
                                ; register 14 as 0 after boot: that used to read as fire held), so the whole port is ignored.
.dirs:
    bit 7,l
    jr z,.done
    or $10                      ; fire
.done:
    ld l,a
    ld h,0
    ei
    ret
M_API_E:
