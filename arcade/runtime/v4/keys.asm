; keys.asm -- RT_KEYDOWN (v2; docs/ARCADE_RUNTIME_API_V2.md "Keyboard").  Lives in DOCK chunks 0-1 (no ORG: follows sprite.asm).
;
; The TS2068 keyboard is the Spectrum's 8 x 5 matrix, read with IN A,(C) from port $FE with the half-row select in B (a 0 bit in B selects
; the row, as in Leap V2's IO_KEY_SCAN_ALL: B = $FE, $FD, $FB, $F7, $EF, $DF, $BF, $7F); the five low bits of the byte read are the keys of
; the row, 0 = pressed.  Rows (low bit first), as the keyboard is labelled:
;   row 0 ($FE)  CAPS SHIFT  Z  X  C  V        row 4 ($EF)  0  9  8  7  6
;   row 1 ($FD)  A  S  D  F  G                 row 5 ($DF)  P  O  I  U  Y
;   row 2 ($FB)  Q  W  E  R  T                 row 6 ($BF)  ENTER  L  K  J  H
;   row 3 ($F7)  1  2  3  4  5                 row 7 ($7F)  SPACE  SYMBOL SHIFT  M  N  B
; (own table from the matrix; the tests check every key against it on TSRun's keyMatrix.)  Codes: 'A'-'Z' (upper case), '0'-'9', 32 space,
; 13 enter, 1 CAPS SHIFT, 2 SYMBOL SHIFT.  Any other code gives 0.
    ; (no ORG: follows sprite.asm)
M_KEYS_S:

; RT_KEYDOWN: A = key code -> HL = 1 when that key is held, else 0.  Clobbers AF, BC, DE, HL.  One IN from port $FE; the value read is also stored
; in V_KEYS[row].  Touches neither the AY nor the interrupt handler's state, so no DI is needed.
RT_KEYDOWN:
    cp KEY_TAB_LAST+1
    jp nc,rt_zero
    ld e,a
    ld d,0
    ld hl,KEY_TAB
    add hl,de
    ld a,(hl)                   ; row << 3 | bit, or $FF
    inc a
    jp z,rt_zero
    dec a
    ld c,a
    and 7
    ld e,a                      ; E = the bit (0..4)
    ld a,c
    rrca
    rrca
    rrca
    and 7
    ld d,a                      ; D = the row (0..7)
    ld hl,KEY_ROWSEL
    ld c,a
    ld b,0
    add hl,bc
    ld b,(hl)                   ; B = the half-row select
    ld c,PORT_ULA
    in a,(c)                    ; the keys of the row
    ld b,a
    ld a,d
    add a,V_KEYS&$FF
    ld l,a
    ld h,V_KEYS>>8
    ld (hl),b                   ; V_KEYS[row] = what was read
    ld a,b
    inc e
.rot:
    rrca
    dec e
    jr nz,.rot                  ; E = bit + 1 rotations: the carry is the key's bit
    ld hl,0
    ret c                       ; 1 = not pressed
    inc l
    ret

KEY_ROWSEL:
    DB $FE, $FD, $FB, $F7, $EF, $DF, $BF, $7F

; KEY_TAB[code] = row << 3 | bit for codes 0..'Z' (90), $FF for no key.
    MACRO KEYS_NONE n
        DS n, $FF
    ENDM
KEY_TAB:
    DB $FF                                      ; 0
    DB $00                                      ; 1  CAPS SHIFT  (row 0, bit 0)
    DB $39                                      ; 2  SYMBOL SHIFT (row 7, bit 1)
    KEYS_NONE 10                                ; 3..12
    DB $30                                      ; 13 ENTER (row 6, bit 0)
    KEYS_NONE 18                                ; 14..31
    DB $38                                      ; 32 SPACE (row 7, bit 0)
    KEYS_NONE 15                                ; 33..47
    DB $20, $18, $19, $1A, $1B, $1C, $24, $23, $22, $21     ; '0'..'9': 0 (4,0)  1..5 (3,0..4)  6 (4,4)  7 (4,3)  8 (4,2)  9 (4,1)
    KEYS_NONE 7                                 ; 58..64
    DB $08, $3C, $03, $0A, $12, $0B, $0C, $34   ; A (1,0) B (7,4) C (0,3) D (1,2) E (2,2) F (1,3) G (1,4) H (6,4)
    DB $2A, $33, $32, $31, $3A, $3B, $29, $28   ; I (5,2) J (6,3) K (6,2) L (6,1) M (7,2) N (7,3) O (5,1) P (5,0)
    DB $10, $13, $09, $14, $2B, $04, $11, $02   ; Q (2,0) R (2,3) S (1,1) T (2,4) U (5,3) V (0,4) W (2,1) X (0,2)
    DB $2C, $01                                 ; Y (5,4) Z (0,1)
KEY_TAB_END:
    ASSERT KEY_TAB_END-KEY_TAB == KEY_TAB_LAST+1
M_KEYS_E:
