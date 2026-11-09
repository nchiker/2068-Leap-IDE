; game_placeholder.asm -- the game image the runtime boots with when no game is linked: init and frame are RET,
; frame_div 1, no sprites, no tileset, no sfx table, no map.  The linker (and the tests) overwrite chunks 4-5 with a real image.
    ORG GAME_BASE
M_GAME_S:
    DW .code                    ; init_entry
    DW .code                    ; frame_entry
    DB 1                        ; frame_div
    DB 0                        ; sprite_count
    DW .code                    ; sprite_table (empty)
    DW 0                        ; tileset_ptr
    DW 0                        ; sfx_table
    DW 0                        ; map_ptr
.code:
    ret
M_GAME_E:
