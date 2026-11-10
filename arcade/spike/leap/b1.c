/* B1 sprites: 8 XOR sprites, 16x16, 99 steps (SPEC.md). plot() with over(1) is exclusive-or. */
static unsigned shape[16];

void blit(unsigned i, unsigned t)
{
    unsigned px = (16 * i + (i + 1) * t) % 240;
    unsigned py = (8 * i + 8 + ((i & 3) + 1) * t) % 176;
    unsigned r, c;
    for (r = 0; r < 16; r++)
        for (c = 0; c < 16; c++)
            if ((shape[r] >> (15 - c)) & 1)
                plot((int)(px + c), (int)(py + r));
}

int main(void)
{
    unsigned r, i, t;
    cls();
    for (r = 0; r < 16; r++)
        shape[r] = r * 2663u + 4129u;
    over(1);
    for (i = 0; i < 8; i++)
        blit(i, 0);
    for (t = 1; t < 100; t++)
        for (i = 0; i < 8; i++) {
            blit(i, t - 1);
            blit(i, t);
        }
    over(0);
    return 0;
}
