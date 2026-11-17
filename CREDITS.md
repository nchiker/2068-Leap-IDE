# Credits and thanks

The Leap IDE and Leap Arcade stand on other people's work. Thank you.

## TSRun, the emulator

Everything you see running in the Studio runs on [TSRun](https://github.com/josef-jelinek/TSRun), the browser emulator for the Timex Sinclair 2068 written by **Josef Jelínek** ([josef-jelinek](https://github.com/josef-jelinek)): the Z80, the TS2068's video, the AY sound chip, keyboard, joysticks, tape and cartridge dock. The Leap projects use a [fork](https://github.com/nchiker/TSRun) that adds the Leap ROMs, a few small fixes and a Kempston mouse; the emulator itself is Josef's work. Thank you, Josef: without TSRun there would be no way to run any of this in a web page.

## The Timex Sinclair 2068

The computer itself: the **TS2068** by Timex Computer Corporation, descended from the Sinclair ZX Spectrum by **Sir Clive Sinclair** and Sinclair Research. Its stock ROM is used by the cartridge test (the TS2068 ROM files are, as TSRun's notes say, partly released by Amstrad for non-commercial use and partly abandonware). The hardware notes the runtime relies on cite the TS2068 Technical Reference Manual. Timex, Sinclair and ZX Spectrum are trademarks of their owners; this project is not affiliated with them.

## The Leap family

**Leap Arcade**, the **Leap IDE** and the Leap ROM languages ([Leap V2 BASIC](https://github.com/nchiker/2068-Leap), [Leap-Forth](https://github.com/nchiker/2068-Leap-Forth) and [Leap-C](https://github.com/nchiker/2068-Leap-C)) are the work of **nchiker** (the project owner), who designed them, directed their development and approved the games. The ROMs are released under the MIT licence from their own repositories.

## Built with Claude Code

Much of the code, the documentation, the example games and their art and music were written with **Claude Code** (Claude, by [Anthropic](https://www.anthropic.com)) working under nchiker's direction, with nchiker reviewing, choosing and approving the results. Commits made that way say so in their messages.

## The example games

All the example games are **original works**: their code, names, characters, art, sound effects and songs were made for this project. Several are in long-established genres (bat-and-ball, falling blocks, a vertical shooter, a platformer, a single-screen arena game, a maze chase, a ray-cast maze, wireframe space flight); they borrow the genre and the kind of mechanics, nothing else. Breakout, Blockfall and the rest are the names of genres of game that countless programmers have written; thanks to everyone who made those games worth imitating.

## Tools it is built and tested with

**CodeMirror 6** by **Marijn Haverbeke** and contributors is the code editor (loaded from jsDelivr, MIT licence). **SjASMPlus** assembles the Z80 runtime (a descendant of SjASM by Sjoerd Mastijn). The games and the runtime were cross-checked in two other TS2068 / Spectrum emulators, [ZEsarUX](https://github.com/chernandezba/zesarux) by **César Hernández Baño** (whose TS2068 source was also a hardware reference) and [Fuse](https://fuse-emulator.sourceforge.net/), the Free Unix Spectrum Emulator, by **Philip Kendall** and its contributors. GitHub Pages hosts this site.

## Licences

The Leap ROMs (Leap V2, Leap-Forth, Leap-C) are MIT licensed in their own repositories. TSRun, CodeMirror and the other tools keep their own licences. The TS2068 ROM files are used under the terms described in `tsrun/roms/README.md`. If you think a credit is missing or wrong, please open an issue.
