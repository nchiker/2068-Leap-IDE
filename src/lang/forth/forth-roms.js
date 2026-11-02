/**
 * src/lang/forth/forth-roms.js — the 2068-Forth ROM builds the IDE knows how to drive.
 *
 * Keyed by the SHA-256 of HOME (16K) followed by EXROM (8K); a ROM pair not
 * listed here is refused rather than driven with the wrong addresses. Every
 * address comes from the release's symbols/forth_boot.sym.
 *
 * To add a release: unpack its zip, then
 *   tools/forth-rom-entry.py <unpacked release> <version>
 * and paste the printed entry below.
 */

"use strict";

export const KNOWN_ROMS = {
  // 2068-Forth 2.0 (SHA-256 HOME 730c86d0…, EXROM fd877dd0…)
  '04c3e54d1fd3996146d42be3b6103f78f294b9147a79d7962347a4ad2a2f6344': {
    version: '2.0',
    keyWait:          0x0533,   // IO_READ_KEY.wait_hit
    promptReturn:     0x382E,   // EDITOR_LOOP_LIVE.key_ret
    enterLine:        0x3833,   // EDITOR_LOOP_LIVE.enter
    editBuf:          0x8205,   // EDIT_BUF
    editLen:          0x8285,   // EDIT_LEN
    editCursor:       0x8286,   // EDIT_CURSOR
    editMaxLen:       0x0080,   // EDIT_MAX_LEN
    lastError:        0x8492,   // LAST_ERROR
    srcPtr:           0x811A,   // SRC_PTR
    srcEnd:           0x811C,   // SRC_END
    storeStart:       0xD000,   // STORE_START
    storeEnd:         0x83C4,   // STORE_END
    storeLimit:       0xF000,   // STORE_LIMIT
    latest:           0x81CB,   // LATEST
    here:             0x81CD,   // HERE
    state:            0x811E,   // STATE
    colonXt:          0x848E,   // COLON_XT
    wordBuf:          0x8128,   // WORD_BUF
    interpToken:      0x0E84,   // INTERPRET_NESTED.token
    kbdKeyHit:        0x80EF,   // KBD_KEYHIT
    dstackTop:        0x9000,   // DSTACK_TOP
    dstackLimit:      0x8900,   // DSTACK_LIMIT
    fstackTop:        0x8900,   // FSTACK_TOP
    fstackLimit:      0x8504,   // FSTACK_LIMIT
    dictBase:         0x9100,   // FORTH_DICT_RAM
    dictCeiling:      0xD000,   // DICT_RAM_CEILING
    romIdentity:      0x0B0A,   // ROM_IDENTITY
    udgTable:         0xF180,   // UDG_TABLE
    udgCodeBase:      0x0090,   // UDG_CODE_BASE
    udgCount:         0x0015,   // UDG_COUNT
    doLit:            0x0D85,   // DOLIT
    doFLit:           0x1A4F,   // DOFLIT
    doDoes:           0x3120,   // DODOES
    qBranch:          0x0F60,   // QBRANCH
    branch:           0x0F78,   // BRANCH
    stkGuard:         0x2C53,   // STK_GUARD
    keyWaitEnd:       0x0539,   // end of the spin loop (exclusive)
  },
  // 2068-Forth 2.0.1 (SHA-256 HOME f0cd0785…, EXROM fd877dd0…)
  'e57d88cdcccd6e30f163a2686fd8cf129e7368eab541de328c8b16147c2a8c02': {
    version: '2.0.1',
    keyWait:          0x0535,   // IO_READ_KEY.wait_hit
    promptReturn:     0x3839,   // EDITOR_LOOP_LIVE.key_ret
    enterLine:        0x383E,   // EDITOR_LOOP_LIVE.enter
    editBuf:          0x8205,   // EDIT_BUF
    editLen:          0x8285,   // EDIT_LEN
    editCursor:       0x8286,   // EDIT_CURSOR
    editMaxLen:       0x0080,   // EDIT_MAX_LEN
    lastError:        0x8492,   // LAST_ERROR
    srcPtr:           0x811A,   // SRC_PTR
    srcEnd:           0x811C,   // SRC_END
    storeStart:       0xD000,   // STORE_START
    storeEnd:         0x83C4,   // STORE_END
    storeLimit:       0xF000,   // STORE_LIMIT
    latest:           0x81CB,   // LATEST
    here:             0x81CD,   // HERE
    state:            0x811E,   // STATE
    colonXt:          0x848E,   // COLON_XT
    wordBuf:          0x8128,   // WORD_BUF
    interpToken:      0x0E8F,   // INTERPRET_NESTED.token
    kbdKeyHit:        0x80EF,   // KBD_KEYHIT
    dstackTop:        0x9000,   // DSTACK_TOP
    dstackLimit:      0x8900,   // DSTACK_LIMIT
    fstackTop:        0x8900,   // FSTACK_TOP
    fstackLimit:      0x8504,   // FSTACK_LIMIT
    dictBase:         0x9100,   // FORTH_DICT_RAM
    dictCeiling:      0xD000,   // DICT_RAM_CEILING
    romIdentity:      0x0B15,   // ROM_IDENTITY
    udgTable:         0xF180,   // UDG_TABLE
    udgCodeBase:      0x0090,   // UDG_CODE_BASE
    udgCount:         0x0015,   // UDG_COUNT
    doLit:            0x0D90,   // DOLIT
    doFLit:           0x1A5A,   // DOFLIT
    doDoes:           0x312B,   // DODOES
    qBranch:          0x0F6B,   // QBRANCH
    branch:           0x0F83,   // BRANCH
    stkGuard:         0x2C5E,   // STK_GUARD
    keyWaitEnd:       0x053B,   // end of the spin loop (exclusive)
  },
};
