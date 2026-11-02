## 11. Colour lines in high resolution

The TS2068's high-resolution colour mode uses the second display file, the memory at `$6000-$77FF`. A program that uses `mode(1)` should say `#pragma hires` at its top: that keeps the compiled program out of that memory. Without the pragma, a large program could occupy the memory and `mode(1)` would stop with runtime error 3 (see [High resolution](05_concepts.md#high-resolution)). In this mode the colours are given for every 8 by 1 pixels instead of every 8 by 8, so lines one pixel row apart can each have their own ink. The program draws a band of 56 such lines in the seven inks, waits for a key so that you can look at it, then returns to the normal mode.

```c
// expect: exit 0
// keys: " "
// pixel: 40 40 1
// pixel: 215 95 1
// pixel: 39 40 0
// pixel: 128 96 0
#pragma hires
int main(void)
{
    int i;
    cls();
    mode(1);
    for (i = 0; i < 56; i++) {
        ink(i % 7 + 1);
        draw(40, 40 + i, 215, 40 + i);
    }
    at(20, 10);
    print("PRESS A KEY");
    getkey();
    mode(0);
    return 0;
}
```

A band of 56 lines of 176 pixels is drawn, at 40 to 95 pixels from the top, **each pixel row in its own ink**, 1 to 7 in turn, on a white screen. `mode(1)` sets every high-resolution attribute to paper 7 (white) and ink 0 (black), and each pixel that `draw` sets gives its 8 by 1 cell the print attribute: ink 1 to 7, and paper 7, which does not show because every pixel of those cells is set. `PRESS A KEY` is in ink 0 on paper 7, the attributes `mode(1)` set: text printed in mode 1 does not take `ink` or `paper`.

After the key, `mode(0)` shows the normal attributes at `$5800` again, which `cls()` painted ink 0 on paper 7. The pixels are all still there, but now a colour covers 8 by 8 of them, so the band is plain black on white: the seven inks were in the high-resolution attributes only. (With `paper(0)` before the `cls()`, the normal screen would be ink 0 on paper 0 and the band could not be seen at all after `mode(0)`.) The end of any program restores mode 0; calling `mode(0)` yourself, as here, puts the normal display back before the program ends.

Ideas: draw the band once in mode 0 too, beside this one, to see the difference on one screen; use `plot` to draw a diagonal and see what colours it gets; print some text in mode 1 and see that `ink` and `paper` do not change its colours (see [High resolution](05_concepts.md#high-resolution)).
