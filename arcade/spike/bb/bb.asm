; bb.asm -- the billboard spike (sjasmplus).  Loaded at $8000 of a stock TS2068.   -DKERNEL=0 K0 (today), 1 A (-DA2=1: A2), 2 Q (-DQMAP=1: QM), 3 the projection + sort before B1 (copied), 4 B1 (the live runtime source)
    IFNDEF KERNEL
      DEFINE KERNEL 0
    ENDIF
    INCLUDE "common.inc"
    ORG $8000
    IF KERNEL == 0
    INCLUDE "k0.asm"
    ENDIF
    IF KERNEL == 1
    INCLUDE "a.asm"
    ENDIF
    IF KERNEL == 2
    INCLUDE "q.asm"
    ENDIF
    IF KERNEL == 3
    INCLUDE "proj.asm"
    ENDIF
    IF KERNEL == 4
    INCLUDE "proj-b1.asm"
    ENDIF
shared_s:
    INCLUDE "shared.asm"
shared_e:
prog_end:
    ASSERT prog_end <= $8800
