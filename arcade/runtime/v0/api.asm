; api.asm -- the runtime routines compiled code calls (docs/ARCADE_RUNTIME_API.md, "Calling convention").
; Every routine clobbers AF, BC, DE, HL only, and preserves IX, IY and the alternate registers; none of them
; touches the stack beyond its own CALL / PUSH (at most 6 bytes deep).  Calls are plain CALLs from game code.
    ; (no ORG: follows main.asm)
M_API_S:

; ---------------------------------------------------------------------------------------------------------------
; RT_SHOW: A = sprite index, BC = x, DE = y (signed 16-bit; x is clamped to 0..SPR_XMAX, y to 0..SPR_YMAX).
; Makes the sprite visible at that position.  An index >= sprite_count is ignored.
; ---------------------------------------------------------------------------------------------------------------
RT_SHOW:
    ld hl,V_SPRN
    cp (hl)
    ret nc                      ; index >= sprite_count: no such sprite
    ld l,a
    add a,a
    add a,l
    add a,a                     ; i * 6
    ld l,a
    ld h,0
    push de                     ; y
    ld de,SPR_TAB
    add hl,de
    ld (hl),1                   ; visible
    inc hl
    ld (hl),0
    inc hl
    push hl                     ; -> x slot
    ld h,b
    ld l,c
    ld a,SPR_XMAX
    call clamp_hl
    ex de,hl                    ; DE = clamped x
    pop hl
    ld (hl),e
    inc hl
    ld (hl),d
    inc hl
    pop de                      ; y
    push hl                     ; -> y slot
    ex de,hl
    ld a,SPR_YMAX
    call clamp_hl
    ex de,hl
    pop hl
    ld (hl),e
    inc hl
    ld (hl),d
    ret

; clamp_hl: HL = signed value, A = maximum (0..255) -> HL in 0..A.  Clobbers AF, C.
clamp_hl:
    bit 7,h
    jr nz,.zero
    ld c,a
    ld a,h
    or a
    jr nz,.max                  ; above 255
    ld a,c
    cp l
    ret nc                      ; max >= value
.max:
    ld l,c
    ld h,0
    ret
.zero:
    ld hl,0
    ret

; ---------------------------------------------------------------------------------------------------------------
; RT_HIDE: A = sprite index.  An index >= sprite_count is ignored.
; ---------------------------------------------------------------------------------------------------------------
RT_HIDE:
    ld hl,V_SPRN
    cp (hl)
    ret nc
    ld l,a
    add a,a
    add a,l
    add a,a
    ld l,a
    ld h,0
    ld de,SPR_TAB
    add hl,de
    ld (hl),0
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
; RT_STICK: A = 1 or 2 -> HL = 0..31: direction bits 0-3 (active high; all four set reads as none) and fire = 16.
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
.dirs:
    bit 7,l
    jr z,.done
    or $10                      ; fire
.done:
    ld l,a
    ld h,0
    ret
M_API_E:
