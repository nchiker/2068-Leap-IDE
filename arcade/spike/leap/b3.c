/* B3 numbers: sieve of Eratosthenes over 2..3999, then an LCG (SPEC.md).
   unsigned wraps at 65536, which gives the same values mod 32768 (x) and mod 65536 (s).
   The results are also left in the attribute bytes of row 10 ($5940; the bitmap is not
   compared for B3) so the runner can read them back: marker $A5 written last. */
static unsigned char flag[4000];

int main(void)
{
    unsigned i, j, primes = 0, x = 1, s = 0, k;
    unsigned char *a = (unsigned char *)0x5940;
    cls();
    for (i = 0; i < 4000; i++)
        flag[i] = 0;
    for (i = 2; i < 4000; i++)
        if (!flag[i]) {
            primes++;
            for (j = i * 2; j < 4000; j += i)
                flag[j] = 1;
        }
    for (k = 0; k < 20000; k++) {
        x = (x * 5 + 3) % 32768;
        s = s + x;                      /* unsigned: wraps at 65536 */
    }
    printf("PRIMES %u\n", primes);
    printf("X %u\n", x);
    printf("S %u\n", s);
    a[1] = (unsigned char)(primes & 255);
    a[2] = (unsigned char)(primes >> 8);
    a[3] = (unsigned char)(x & 255);
    a[4] = (unsigned char)(x >> 8);
    a[5] = (unsigned char)(s & 255);
    a[6] = (unsigned char)(s >> 8);
    a[0] = 0xA5;
    return 0;
}
