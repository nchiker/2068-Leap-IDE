# A proposed replacement for Part 7 example 11, "Colour lines in high resolution"

From: the Leap IDE (github.com/nchiker/2068-Leap-IDE), 2026-11-01.
For: the 2068-Leap-C project, to replace section 11 of `docs/manual/07_examples.md` (as of `v1.1.0`, `f8db836`).

## Why

A user ran the example from the IDE's Examples menu and reported that "it runs, but then the screen changes to black
paper on black text and you can't see the results". That is what the program does, and the manual says so: the lines
show only between `mode(1)` and `mode(0)`, a few frames, and `paper(0)` + `cls()` at the start have made the normal
screen ink 0 on paper 0, so after `mode(0)` the whole screen is black. As the first example a reader meets for
`mode(1)`, it shows nothing.

The replacement keeps what the example teaches (`#pragma hires`, 8 by 1 colour, each pixel row its own ink) and makes
it visible:

- it waits for a key in mode 1 (the first of the section's own "Ideas"), with `PRESS A KEY` on the screen;
- it draws a band of 56 rows, so the seven inks repeat and the 8 by 1 colour is plain to see;
- it no longer sets `paper(0)`, so after `mode(0)` the same pixels stay visible, black on white, which shows what
  8 by 8 colour does to them;
- `ink(0); paper(7);` at the end are dropped (the section already says the next `RUN` resets the print colours).

The test directives change with it: `// keys: " "` (one key for the `getkey()`), and pixels at the band's corners and
just outside it.

## Verified in the IDE (not in this project's harness)

On the 1.0.0 ROMs (byte-identical to 1.1.0's) in TSRun, through the IDE's Run path, with the key typed on the keyboard
matrix while the program waits in `getkey()` (one key per keyboard read, as `tools/exectest.py` feeds `// keys:`):
exit 0 and the four pixels as the directives say. Before the key, the high-resolution attributes at `$6000` for pixel
rows 40 to 54, column 10, hold inks `123456712345671`. It checks clean with the ROM's compiler. **Not run** in
ZEsarUX through `exectest.py` / `make check`; please run it there before taking it.

The IDE carries the text below as `tools/leapc-example-overrides/11-colour-lines-in-high-resolution.md` and generates
its Examples menu with it; the file will be deleted once a release's manual has the change.

## The section, as it would stand in `07_examples.md`

````markdown
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
````
