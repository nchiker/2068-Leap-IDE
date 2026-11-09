/* B2 tile map: 16 tiles of 8x8, 64x24 map, 32 scroll steps (SPEC.md).
   Leap-C has no UDGs, so each tile byte is poked straight into the bitmap. */
int main(void)
{
    unsigned t, row, c, r, mc, k, y, addr;
    unsigned char *p;
    cls();
    for (t = 0; t < 32; t++)
        for (row = 0; row < 24; row++)
            for (c = 0; c < 32; c++) {
                mc = (c + t) % 64;
                k = (mc * 7 + row * 13 + mc * row) & 15;
                for (r = 0; r < 8; r++) {
                    y = row * 8 + r;
                    addr = 0x4000 | ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2) | c;
                    p = (unsigned char *)addr;
                    *p = (unsigned char)((k * 37 + r * 11 + 3) & 255);
                }
            }
    return 0;
}
