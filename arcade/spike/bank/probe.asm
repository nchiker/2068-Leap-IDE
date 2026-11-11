; probe.asm -- bank probe: can the CPU map DOCK chunk 2 ($4000), 3 ($6000) or 6 ($C000) over RAM for the length of a copy
; (frame interrupt running, no DI), LDIR bytes out into RAM chunk 7, and unmap?  Built on arcade/spike/xip/stream.asm (E4).
;
; Memory plan (the same rules as E4): DOCK chunks 0,1 (LROS header, ISR at $0038) and 4,5 (main code at $8000) stay mapped
; ($F4 = BASE = $33); the display files are RAM $4000-$7AFF; the copy destination is RAM chunk 7 ($E000-$FAFF buffer; the
; two 8 KB-ish pieces of banks 2/3 / 191 go to RAM chunk 6 at $C000, which those banks do not hide); ISR variables and the
; probe's own variables at $FB00; the stack grows down from $FF00; the result record is at $FF00.
;
; Parameters (-D):
;   NOTEST 1  control: no copies, only the ISR flipping the two display files (reference screens for the checkers)
;   STORM  1  while a bank is mapped, also write $EE to its first 16 window bytes (writes must be ignored)
;   NEG    1  negative control: corrupt one copied byte of bank 3 piece off=2048 (the verify must catch it)
;   NEG    2  negative control: modify one RAM byte under bank 2 piece off=0 between the checksums (the RAM check must catch it)
;   NEG    3  negative control: corrupt the first chunk-3 byte of the 512-byte piece from $5F00 copied with chunks 2+3 mapped (straddle verify)
;   TARGET frames to run (default 600); the loop finishes whole iterations until the ISR count reaches it
    DEVICE NOSLOT64K
    IFNDEF NOTEST
NOTEST  EQU 0
    ENDIF
    IFNDEF STORM
STORM   EQU 0
    ENDIF
    IFNDEF NEG
NEG     EQU 0
    ENDIF
    IFNDEF TARGET
TARGET  EQU 600
    ENDIF
VARB    EQU $FB00
SHADOW  EQU VARB+0          ; shadow of port $FF (bit 0 = shown file)
FRAMES  EQU VARB+2          ; interrupts counted by the ISR (LE16)
MAPSH   EQU VARB+4          ; shadow of the last $F4 value written (the ISR counts interrupts taken while it is not BASE)
IRQMAP  EQU VARB+6          ; interrupts the ISR saw with MAPSH /= BASE (approximate: shadow and OUT differ by one instruction)
B_MAP   EQU VARB+8
B_ID    EQU VARB+9
B_K     EQU VARB+10
B_WHI   EQU VARB+11
B_MASK  EQU VARB+12
P_PTR   EQU VARB+14
P_OFF   EQU VARB+16
P_LEN   EQU VARB+18
P_DST   EQU VARB+20
P_SRC   EQU VARB+22
P_PRE   EQU VARB+24
PASSN   EQU VARB+26         ; pieces that passed both checks
BYTESV  EQU VARB+28         ; bytes verified (LE32)
ITERN   EQU VARB+32
V_OFF   EQU VARB+34
V_LEN   EQU VARB+36
V_DST   EQU VARB+38
V_N1    EQU VARB+40
V_K     EQU VARB+42
STATE   EQU VARB+43         ; FINISH's saved state (B_K+8 was a trap: VARB+18 = P_LEN)
STACK   EQU $FF00
REC     EQU $FF00           ; result record
BASE    EQU $33             ; DOCK chunks 0,1,4,5

    ORG $0000
    DB $00, $01
    DW ENTRY
    DB $BC

    ORG $0038
ISR:
    push af
    ld a,(SHADOW)
    xor 1
    ld (SHADOW),a
    out ($FF),a             ; display file flip, first thing
    ld a,(FRAMES)
    add a,1
    ld (FRAMES),a
    jr nc,.nc
    ld a,(FRAMES+1)
    inc a
    ld (FRAMES+1),a
.nc:
    ld a,(MAPSH)
    cp BASE
    jr z,.nm
    ld a,(IRQMAP)
    add a,1
    ld (IRQMAP),a
    jr nc,.nm
    ld a,(IRQMAP+1)
    inc a
    ld (IRQMAP+1),a
.nm:
    pop af
    ei
    ret

    ORG $0066
    retn

    ORG $0100
ENTRY:
    di
    ld sp,STACK
    ; the hand-off leaves $F4 = $43 (DOCK chunk 6 mapped at $C000): set our mapping first, or the fills below would write
    ; into DOCK chunk 6 (ignored on TSRun and Fuse, but ZEsarUX lets a DOCK chunk above $4000 be written)
    xor a
    out ($FF),a
    ld a,BASE
    out ($F4),a
    ; display file 1 ($4000-$5AFF): bitmap byte = low address byte, attributes $38, gap $5B00-$5FFF = $A5
    ; display file 2 ($6000-$7AFF): bitmap byte = low address byte xor $55, attributes $07, gap $7B00-$7FFF = $5A
    ld hl,$4000
.f1: ld a,l
    ld (hl),a
    inc hl
    ld a,h
    cp $58
    jr nz,.f1
    ld hl,$5800
.a1: ld (hl),$38
    inc hl
    ld a,h
    cp $5B
    jr nz,.a1
.g1: ld (hl),$A5
    inc hl
    ld a,h
    cp $60
    jr nz,.g1
.f2: ld a,l
    xor $55
    ld (hl),a
    inc hl
    ld a,h
    cp $78
    jr nz,.f2
.a2: ld (hl),$07
    inc hl
    ld a,h
    cp $7B
    jr nz,.a2
.g2: ld (hl),$5A
    inc hl
    ld a,h
    cp $80
    jr nz,.g2
    ; RAM chunk 6 and the variable page start as zero (chunk 6 is checksummed under bank 6)
    ld hl,$C000
.z6: ld (hl),0
    inc hl
    ld a,h
    cp $E0
    jr nz,.z6
    ld hl,VARB
    ld b,0
.zv: ld (hl),0
    inc hl
    djnz .zv
    ld hl,REC               ; result record: magic "BKPR", state 0
    ld b,32
.zr: ld (hl),0
    inc hl
    djnz .zr
    ld a,'B'
    ld (REC),a
    ld a,'K'
    ld (REC+1),a
    ld a,'P'
    ld (REC+2),a
    ld a,'R'
    ld (REC+3),a
    ld a,BASE
    ld (MAPSH),a
    im 1
    jp MAINC

; ---- CSUM: Fletcher-style sum of BC bytes at HL; returns DE = (sum2 << 8) | sum1 ---------------------------------------
CSUM:
    ld de,0
.l: ld a,e
    add a,(hl)
    ld e,a
    ld a,d
    add a,e
    ld d,a
    inc hl
    dec bc
    ld a,b
    or c
    jr nz,.l
    ret

; ---- VERIFY: P_LEN bytes at P_DST against the formula byte(i) = (7*(i & 255) + 13*(i >> 8) + K) & 255 for i = P_OFF + j.
; Computed here (initial value by shifts and adds, then +7 per byte and +13 more whenever the low byte of i wraps).
; Returns carry clear if all match; on a mismatch carry set, HL = address of the mismatching byte, B = expected, C = actual.
VERIFY:
    ld a,(P_OFF)            ; low byte of i
    ld c,a
    add a,a
    add a,a
    add a,a                 ; 8 * lo
    sub c                   ; 7 * lo
    ld c,a
    ld a,(P_OFF+1)          ; high byte of i
    ld b,a
    add a,a
    add a,a                 ; 4 * hi
    ld d,a
    add a,a                 ; 8 * hi
    add a,d                 ; 12 * hi
    add a,b                 ; 13 * hi
    add a,c
    ld hl,B_K
    add a,(hl)              ; + K
    ld e,a                  ; E = expected byte
    ld a,(P_OFF)
    ld d,a                  ; D = low byte of i
    ld hl,(P_DST)
    ld bc,(P_LEN)
.v: ld a,(hl)
    cp e
    jr nz,.bad
    inc hl
    ld a,e
    add a,7
    ld e,a
    inc d
    jr nz,.nw
    ld a,e
    add a,13
    ld e,a
.nw:
    dec bc
    ld a,b
    or c
    jr nz,.v
    or a                    ; carry clear
    ret
.bad:
    ld b,e                  ; expected
    ld c,a                  ; actual
    scf
    ret

; ---- VERIFYC: as VERIFY, but for bank 23 (chunks 2 and 3 mapped together, a 16 KB window $4000-$7FFF): P_OFF is the offset in
; the window, so the piece is split at 8192 into a part of chunk 2 (K 63) and a part of chunk 3 (K 94, offset - 8192).
; Same return convention; P_OFF, P_LEN, P_DST, B_K are restored.  For the other banks it is VERIFY.
VERIFYC:
    ld a,(B_ID)
    cp 23
    jp nz,VERIFY
    ld hl,(P_OFF)
    ld (V_OFF),hl
    ld hl,(P_LEN)
    ld (V_LEN),hl
    ld hl,(P_DST)
    ld (V_DST),hl
    ld a,(B_K)
    ld (V_K),a
    ; part 1: bytes of chunk 2 = min(len, 8192 - off) if off < 8192
    ld hl,(P_OFF)
    ld de,8192
    or a
    sbc hl,de               ; carry set when off < 8192
    jr nc,.p2only
    ; hl = off - 8192 (negative): n1 = 8192 - off = -hl
    ld a,l
    cpl
    ld l,a
    ld a,h
    cpl
    ld h,a
    inc hl                  ; HL = n1
    ld de,(V_LEN)
    or a
    sbc hl,de               ; n1 - len
    jr c,.split             ; n1 < len: straddles
    ; fits in chunk 2: one segment, unchanged
    ld a,63
    ld (B_K),a
    call VERIFY
    jp .out
.split:
    ; n1 = len + (n1 - len)  -> recompute
    add hl,de               ; HL = n1
    ld (V_N1),hl
    ld (P_LEN),hl
    ld a,63
    ld (B_K),a
    call VERIFY
    jr c,.out
    ; part 2: chunk 3 from offset 0, dst + n1, len - n1
    ld hl,(V_OFF)
    ld de,(V_N1)
    ; (offset of part 2 inside chunk 3 is 0)
    ld hl,0
    ld (P_OFF),hl
    ld hl,(V_DST)
    add hl,de
    ld (P_DST),hl
    ld hl,(V_LEN)
    or a
    sbc hl,de
    ld (P_LEN),hl
    ld a,94
    ld (B_K),a
    call VERIFY
    jr .out
.p2only:
    ; off >= 8192: HL = off - 8192
    ld (P_OFF),hl
    ld a,94
    ld (B_K),a
    call VERIFY
.out:
    ; restore (flags and HL/B/C must survive)
    push af
    push hl
    ld hl,(V_OFF)
    ld (P_OFF),hl
    ld hl,(V_LEN)
    ld (P_LEN),hl
    ld hl,(V_DST)
    ld (P_DST),hl
    ld a,(V_K)
    ld (B_K),a
    pop hl
    pop af
    ret

; ---- FINISH: A = 1 pass, 2 fail.  Attributes of both display files are filled green / red, border likewise, then DI and the
; record is written last (FRAMES latched with interrupts off), then a DI / jr $ stop.
FINISH:
    ld (STATE),a            ; keep the state across the fill
    ld a,(STATE)
    ld c,$20                ; green paper
    ld d,4                  ; green border
    cp 1
    jr z,.col
    ld c,$10                ; red paper
    ld d,2                  ; red border
.col:
    ld hl,$5800
    ld b,0
.fa: ld (hl),c
    inc hl
    djnz .fa
    ld b,0
.fb: ld (hl),c
    inc hl
    djnz .fb
    ld b,0
.fc: ld (hl),c
    inc hl
    djnz .fc
    ld hl,$7800
    ld b,0
.fd: ld (hl),c
    inc hl
    djnz .fd
    ld b,0
.fe: ld (hl),c
    inc hl
    djnz .fe
    ld b,0
.ff: ld (hl),c
    inc hl
    djnz .ff
    ld a,d
    out ($FE),a
FINDI:
    di
    ld hl,(FRAMES)
    ld (REC+12),hl
    ld hl,(PASSN)
    ld (REC+8),hl
    ld hl,(BYTESV)
    ld (REC+16),hl
    ld hl,(BYTESV+2)
    ld (REC+18),hl
    ld hl,(ITERN)
    ld (REC+20),hl
    ld hl,(IRQMAP)
    ld (REC+22),hl
    ld a,(STATE)
    ld (REC+4),a            ; state last
STOP:
    di
    jr STOP

; ---- FAIL: B = kind (1 verify, 2 RAM under the window changed); HL = offset within the chunk; D = expected, E = actual
FAIL:
    ld (REC+14),hl
    ld a,b
    ld (REC+5),a
    ld a,(B_ID)
    ld (REC+6),a
    ld a,d
    ld (REC+24),a
    ld a,e
    ld (REC+25),a
    ld hl,1
    ld (REC+10),hl
    ld a,2
    jp FINISH

    ORG $8000
MAINC:
    ei
    IF NOTEST
.idle:                      ; control: nothing is mapped; wait for TARGET frames, then finish like the test
    ld hl,(FRAMES)
    ld de,TARGET
    or a
    sbc hl,de
    jr c,.idle
    ld a,1
    jp FINISH
    ELSE
ITERLOOP:
    ld ix,BANKTAB
BANKLOOP:
    ld a,(ix+0)
    or a
    jp z,ITERDONE
    ld (B_MAP),a
    ld a,(ix+1)
    ld (B_ID),a
    ld a,(ix+2)
    ld (B_K),a
    ld a,(ix+3)
    ld (B_WHI),a
    ld a,(ix+4)
    ld (B_MASK),a
    ld hl,PIECES
    ld (P_PTR),hl
PIECELOOP:
    ld hl,(P_PTR)
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl                  ; DE = offset in the chunk
    ld c,(hl)
    inc hl
    ld b,(hl)
    inc hl                  ; BC = length
    ld a,b
    or c
    jp z,NEXTBANK
    ld (P_OFF),de
    ld (P_LEN),bc
    ld e,(hl)
    inc hl
    ld d,(hl)
    inc hl
    ld (P_DST),de
    ld a,(hl)
    inc hl
    ld (P_PTR),hl
    ld c,a
    ld a,(B_MASK)
    and c
    jr z,PIECELOOP          ; this piece is not for this bank
    ; src = window base + offset
    ld hl,(P_OFF)
    ld a,(B_WHI)
    add a,h
    ld h,a
    ld (P_SRC),hl
    ld bc,(P_LEN)
    call CSUM               ; checksum of the RAM under the window before
    ld (P_PRE),de
    ld hl,(P_SRC)
    ld de,(P_DST)
    ld bc,(P_LEN)
    ld a,(B_MAP)
    ld (MAPSH),a
    out ($F4),a             ; map the DOCK chunk
    IF STORM
    push hl
    ld bc,(P_LEN)           ; write min(16, len) bytes: never past the mapped window
    ld a,b
    or a
    jr nz,.sb
    ld a,c
    cp 16
    jr c,.sg
.sb: ld a,16
.sg: ld b,a
.st: ld (hl),$EE
    inc hl
    djnz .st
    pop hl
    ld bc,(P_LEN)
    ENDIF
    ldir
    ld a,BASE
    out ($F4),a             ; unmap
    ld (MAPSH),a
    IF NEG == 2
    ld a,(B_ID)
    cp 2
    jr nz,.n2
    ld hl,(P_OFF)
    ld a,h
    or l
    jr nz,.n2
    ld hl,(P_SRC)
    inc (hl)                ; damage one RAM byte under the window of bank 2 offset 0
.n2:
    ENDIF
    ld hl,(P_SRC)
    ld bc,(P_LEN)
    call CSUM               ; and after
    ld hl,(P_PRE)
    or a
    sbc hl,de
    jr z,.ramok
    ld hl,(P_OFF)
    ld de,0
    ld b,2
    jp FAIL
.ramok:
    IF NEG == 1
    ld a,(B_ID)
    cp 3
    jr nz,.n1
    ld hl,(P_OFF)
    ld a,h
    cp 8
    jr nz,.n1
    ld a,l
    or a
    jr nz,.n1
    ld hl,(P_DST)
    inc hl
    ld a,(hl)
    xor $10
    ld (hl),a               ; corrupt the second copied byte of bank 3 offset 2048
.n1:
    ENDIF
    IF NEG == 3
    ld a,(B_ID)
    cp 23
    jr nz,.n3
    ld hl,(P_OFF)
    ld de,$1F00
    or a
    sbc hl,de
    jr nz,.n3
    ld hl,(P_DST)
    inc h                   ; byte 256 of the 512-byte piece starting at $5F00 = the first byte of chunk 3 ($6000)
    ld a,(hl)
    xor $10
    ld (hl),a
.n3:
    ENDIF
    call VERIFYC
    jr nc,.good
    ; mismatch: HL = address in the buffer, B expected, C actual
    ld de,(P_DST)
    or a
    sbc hl,de               ; index in the piece
    ld de,(P_OFF)
    add hl,de               ; offset in the chunk
    ld d,b
    ld e,c
    ld b,1
    jp FAIL
.good:
    ld hl,(PASSN)
    inc hl
    ld (PASSN),hl
    ld hl,(BYTESV)
    ld bc,(P_LEN)
    add hl,bc
    ld (BYTESV),hl
    jr nc,.nb
    ld hl,(BYTESV+2)
    inc hl
    ld (BYTESV+2),hl
.nb:
    jp PIECELOOP
NEXTBANK:
    ld bc,5
    add ix,bc
    jp BANKLOOP
ITERDONE:
    ld hl,(ITERN)
    inc hl
    ld (ITERN),hl
    ld hl,(FRAMES)
    ld de,TARGET
    or a
    sbc hl,de
    jp c,ITERLOOP
    ld a,1
    jp FINISH
    ENDIF

; bank table: $F4 map value, chunk number, K = chunk*31+1, window high byte, piece mask bit
BANKTAB:
    DB $37, 2, 63, $40, 1
    DB $3B, 3, 94, $60, 2
    DB $73, 6, 187, $C0, 4
    DB $3F, 23, 0, $40, 8      ; chunks 2 and 3 together: a contiguous 16 KB window
    DB 0
; piece table: offset, length, destination, mask (bit 0 chunk 2, bit 1 chunk 3, bit 2 chunk 6, bit 3 chunks 2+3 together;
; for that bank the offset counts from $4000 and runs to 16383); length 0 ends
PIECES:
    DW 0,1024,$E000
    DB 15
    DW 1024,1024,$E083
    DB 15
    DW 2048,1024,$E106
    DB 15
    DW 3072,1024,$E189
    DB 15
    DW 4096,1024,$E20C
    DB 15
    DW 5120,1024,$E28F
    DB 15
    DW 6144,1024,$E312
    DB 15
    DW 7168,1024,$E395
    DB 15
    DW 1,1,$E000
    DB 15
    DW 1,255,$E101
    DB 15
    DW 255,256,$E003
    DB 15
    DW 256,257,$E1FF
    DB 15
    DW 4095,2,$F9FE
    DB 15
    DW 8191,1,$E000
    DB 15
    DW 7,1000,$E7F0
    DB 15
    DW $1B00,$0500,$F000
    DB 11                   ; the display-file gap area of chunks 2 and 3 (offset $1B00 = $5B00 / $7B00)
    DW 1,8191,$C000
    DB 3                    ; 8191 bytes from offset 1, into RAM chunk 6 (not hidden by banks 2 and 3)
    DW 1,6911,$E000
    DB 4                    ; the most chunk 7's buffer holds, from offset 1, for bank 6
    DW $1F00,512,$E000
    DB 8                    ; 512 bytes from $5F00: straddles $6000
    DW 8190,4,$E100
    DB 8                    ; 4 bytes across $5FFF / $6000
    DW 8191,2,$E200
    DB 8
    DW 5000,6911,$E000
    DB 8                    ; a long piece across the join
    DW $1B00,$0700,$F000
    DB 8                    ; $5B00-$61FF: gap of chunk 2, the join, start of chunk 3
    DW $3B00,$0500,$F000
    DB 8                    ; the gap of chunk 3 ($7B00-$7FFF)
    DW 8192,1024,$E000
    DB 8
    DW 9216,1024,$E083
    DB 8
    DW 10240,1024,$E106
    DB 8
    DW 11264,1024,$E189
    DB 8
    DW 12288,1024,$E20C
    DB 8
    DW 13312,1024,$E28F
    DB 8
    DW 14336,1024,$E312
    DB 8
    DW 15360,1024,$E395
    DB 8
    DW 0,0,0
    DB 0
    SAVEBIN "mem.bin", 0, 65536
