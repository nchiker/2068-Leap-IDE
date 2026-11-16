/**
 * src/starters/starters-a.js -- the first four starter games of the Leap Arcade Studio's New dialog (stage 4, N1; pure: no DOM, Node can import it).
 *
 *   STARTERS_A = [{id, title, about, runtime, make() -> project}]    blank, sprites-tiles, scenes-music, fine-colour
 *
 * Each starter is a small GAME WITH A POINT (a goal on the screen, live controls, a challenge that rises, a score, game over and a restart), under 150 lines of
 * commented source, built for the v2 runtime. make() builds a NEW project every call: the source text and the assets drawn by code, deterministic (the same
 * bytes every time; no file is read). All colour is BRIGHT 0 on black paper (the two-blacks rule). tests/arcade-starters-a.mjs compiles every one on the real
 * runtime, plays it scripted tick by tick against the reference interpreter and checks it compiles with no warning and no asset finding.
 */

"use strict";

import { exampleProject } from '../arcade-project.js';
import { sprite, mirror, tileOf, ticks, picture, dither, set, text, tiler } from './starter-a-art.js';
import { pattern, song } from './starter-a-songs.js';

// ── 1. blank: Star Dash ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const BLANK_SOURCE = `REM STAR DASH: the smallest game that still has a point (the starter "Blank game", runtime v2).
REM Steer the ball with joystick 1, or the keys O P Q A, and catch the star before the clock runs out.
REM Each star adds seconds to the clock, a few less every time, so the time always runs out in the end:
REM score as many stars as you can.  Fire (SPACE or the joystick button) plays again.
REM Change first: the 300 in NEWGAME (the start time, 30 to a second), SPEED, the star's "*" and its colour.
GAME "Star Dash"
FRAMERATE 30                       REM PROC FRAME runs 30 times a second
CONST SPEED = 3                    REM how many pixels the ball moves in a tick

SPRITE ball = "ball"               REM a picture drawn in the Sprites tab; "ball" is its name there

SCENE play                         REM a game is made of scenes; the first one starts by itself
  DIM x, y, sx, sy, score, best, over, js, b
  TIMER clock                      REM a number the game counts down by itself, once a tick, to 0

  REM A new game: a black screen, the ball in the middle, the first star, 10 seconds on the clock.
  PROC NEWGAME():
    BORDER 0 : PAPER 0 : INK 7 : BRIGHT 0
    FILLC 0, 0, 32, 24 = 32        REM clear the screen to white-on-black blanks (a sprite takes the colour of the cell under it)
    x = 120 : y = 88 : score = 0 : over = 0 : clock = 300
    INK 5 : PRINT AT 23, 0; "O P Q A OR STICK: CATCH THE *";
    CALL NEWSTAR()
  ENDP

  REM The star is a character of text: erase the old one, pick a new cell at random, print it yellow.
  PROC NEWSTAR():
    PRINT AT sy, sx; " ";
    sx = 1 + RND(30) : sy = 2 + RND(20)
    INK 6 : PRINT AT sy, sx; "*";
    INK 7 : PRINT AT 0, 0; "SCORE "; score USING "###"; "   BEST "; best USING "###";
  ENDP

  PROC INIT():                     REM runs once, when the scene starts
    CALL NEWGAME()
  ENDP

  PROC FRAME():                    REM runs every tick
    js = STICK(1)                  REM the joystick as bits: 1 up, 2 down, 4 left, 8 right, 16 fire
    IF over THEN
      IF KEYPRESS(" ") OR BIT(JOYPRESS(1), 4) THEN CALL NEWGAME() ENDIF
    ELSE
      IF KEYDOWN("O") OR BIT(js, 2) THEN x = x - SPEED ENDIF
      IF KEYDOWN("P") OR BIT(js, 3) THEN x = x + SPEED ENDIF
      IF KEYDOWN("Q") OR BIT(js, 0) THEN y = y - SPEED ENDIF
      IF KEYDOWN("A") OR BIT(js, 1) THEN y = y + SPEED ENDIF
      IF x < 0 THEN x = 0 ENDIF
      IF x > 248 THEN x = 248 ENDIF
      IF y < 16 THEN y = 16 ENDIF
      IF y > 176 THEN y = 176 ENDIF
      IF ABS(x - sx * 8) < 8 AND ABS(y - sy * 8) < 8 THEN     REM the ball touches the star
        score = score + 1
        b = 75 - score * 4 : IF b < 15 THEN b = 15 ENDIF       REM the bonus time shrinks with every star
        clock = clock + b
        IF score > best THEN best = score ENDIF
        CALL NEWSTAR()
      ENDIF
      INK 7 : PRINT AT 0, 24; "TIME "; clock DIV 30 USING "##";
      IF clock = 0 THEN
        over = 1
        INK 6 : PRINT AT 10, 11; "TIME UP!"; : PRINT AT 12, 7; "PRESS FIRE TO PLAY AGAIN";
      ENDIF
    ENDIF
    SHOW ball AT x, y              REM draw the sprite at pixel (x, y); y counts from the top
  ENDP
ENDSCENE
`;

function blankAssets() {
  // the ball: 8 x 8, white on black (a sprite takes the colour of the screen cell under it)
  const ball = sprite(['..####..', '.######.', '########', '########', '########', '########', '.######.', '..####..'], { hot: [0, 0, 8, 8], phases: 8 });
  return { sprites: { ball } };
}

// ── 2. sprites-tiles: Gem Mine ───────────────────────────────────────────────────────────────────────────────────────────────────

const GEMS_SOURCE = `REM GEM MINE (the starter "Sprites and tiles", runtime v2): grab every gem in the mine and dodge the bats.
REM Hero: joystick 1 or the keys O P Q A.  The walls and the gems are TILES of the screen map, the hero and the bats are SPRITES.
REM Every level has one more bat (up to 4) and they get faster; you have 3 lives; fire plays again after GAME OVER.
REM Change first: the lives (NEWGAME), the bats' speed (SETUP), the points (FRAME), the pictures (Sprites and Tiles tabs).
GAME "Gem Mine"
FRAMERATE 30
CONST TFLOOR = 0                   REM tile numbers of the TILESET "gfx"
CONST TWALL = 1
CONST TGEM = 2
CONST NGEMS = 12                   REM how many gems the map holds

REM Assets are named pictures and sounds made in the Studio's editors; the program declares the ones it uses.
SPRITE hero = "hero"
SPRITE bat(4) = "bat"              REM a pool: four bats that share one picture, bat(0) to bat(3)
TILESET gfx = "gfx"
MAP mine = "mine"                  REM the 32 x 24 map of tiles, drawn in the Maps tab
SFX pick = "pick"                  REM sound effects, drawn in the Sounds tab; PLAY name starts one
SFX hurt = "hurt"
SFX win = "win"
SFX lose = "lose"

SCENE play
  REM Variables hold numbers: the hero's pixel position (x, y), the game state, the current level's bat count and speed.
  DIM x, y, js, lives, score, level, gems, over, nb, spd, c, r, ok
  TIMER inv                        REM ticks of safety after a hit: the game counts it down by itself
  REM Arrays hold one number per bat: the position and the step it takes each tick, and where each bat starts.
  DIM bx(3), by(3), bdx(3), bdy(3)
  DIM hx(3) = 80, 160, 80, 88
  DIM hy(3) = 24, 16, 160, 96

  REM Lay out a level: the map, the hero, the bats (one more each level, and faster).
  PROC SETUP():
    LOADMAP mine
    x = 120 : y = 80 : gems = NGEMS : inv = 60
    nb = 1 + level : IF nb > 4 THEN nb = 4 ENDIF
    spd = 1 + level DIV 3 : IF spd > 2 THEN spd = 2 ENDIF
    FOR i = 0 TO 3
      bx(i) = hx(i) : by(i) = hy(i) : bdx(i) = 0 : bdy(i) = 0
      IF i MOD 2 = 0 THEN bdx(i) = spd ELSE bdy(i) = spd ENDIF   REM even bats go sideways, odd ones up and down
      IF i >= nb THEN HIDE bat(i) ENDIF
    NEXT i
    INK 5 : PRINT AT 23, 0; "GRAB ALL THE GEMS, DODGE BATS";
  ENDP

  REM A new game: no points, 3 lives, level 1.
  PROC NEWGAME():
    score = 0 : lives = 3 : level = 1 : over = 0
    CALL SETUP()
  ENDP

  REM INIT runs once when the scene starts: a black border and black paper with white ink, then the first game.
  PROC INIT():
    BORDER 0 : PAPER 0 : INK 7 : BRIGHT 0
    CALL NEWGAME()
  ENDP

  REM Move the hero by (dx, dy) unless a wall tile is under a corner of its box (TILEAT tells which tile is in a cell).
  PROC TRY(dx, dy):
    LOCAL nx, ny
    nx = x + dx : ny = y + dy
    ok = 1
    FOR i = 0 TO 3                                             REM the four corners of the hero's box, one after the other
      IF TILEAT((nx + 1 + (i MOD 2) * 5) DIV 8, (ny + 1 + (i DIV 2) * 5) DIV 8) = TWALL THEN ok = 0 ENDIF
    NEXT i
    IF ok THEN x = nx : y = ny ENDIF
  ENDP

  REM Move the bats; one that meets a wall turns round.  A bat that touches the hero costs a life.
  PROC BATS():
    LOCAL nx, ny
    FOR i = 0 TO nb - 1                                        REM only the bats of this level
      nx = bx(i) + bdx(i) : ny = by(i) + bdy(i)
      IF TILEAT((nx + 4 + 4 * SGN(bdx(i))) DIV 8, (ny + 4 + 4 * SGN(bdy(i))) DIV 8) = TWALL THEN
        bdx(i) = -bdx(i) : bdy(i) = -bdy(i)
      ELSE
        bx(i) = nx : by(i) = ny
      ENDIF
      SHOW bat(i) AT bx(i), by(i)
      IF inv = 0 AND HIT(hero, bat(i)) THEN CALL HURT() ENDIF
    NEXT i
  ENDP

  REM A bat got the hero: lose a life, or end the game when the last one is gone.
  PROC HURT():
    lives = lives - 1
    IF lives = 0 THEN
      over = 1 : PLAY lose
      INK 6 : PRINT AT 11, 11; "GAME OVER"; : PRINT AT 13, 7; "PRESS FIRE TO PLAY AGAIN";
    ELSE
      PLAY hurt : x = 120 : y = 80 : inv = 90
    ENDIF
  ENDP

  REM FRAME runs every tick: read the keys, move the hero, take a gem, move the bats, draw, show the score.
  PROC FRAME():
    js = STICK(1)                                              REM joystick 1 as bits: 1 up, 2 down, 4 left, 8 right, 16 fire
    IF over THEN
      REM after GAME OVER a fresh press of fire (KEYPRESS / JOYPRESS) starts a new game
      IF KEYPRESS(" ") OR BIT(JOYPRESS(1), 4) THEN CALL NEWGAME() ENDIF
    ELSE
      REM KEYDOWN is true while a key is held; each direction moves the hero 2 pixels a tick, if TRY finds no wall
      IF KEYDOWN("O") OR BIT(js, 2) THEN CALL TRY(-2, 0) ENDIF
      IF KEYDOWN("P") OR BIT(js, 3) THEN CALL TRY(2, 0) ENDIF
      IF KEYDOWN("Q") OR BIT(js, 0) THEN CALL TRY(0, -2) ENDIF
      IF KEYDOWN("A") OR BIT(js, 1) THEN CALL TRY(0, 2) ENDIF
      c = (x + 4) DIV 8 : r = (y + 4) DIV 8                    REM the cell under the hero's middle
      IF TILEAT(c, r) = TGEM THEN
        TILE c, r = TFLOOR                                      REM take the gem: a floor tile in its place
        score = score + 10 : gems = gems - 1
        PLAY pick                                              REM start the sound effect "pick"
        IF gems = 0 THEN                                       REM the last gem: the next level
          level = level + 1 : score = score + 50
          PLAY win
          CALL SETUP()
        ENDIF
      ENDIF
      CALL BATS()
      REM SHOW draws a sprite at pixel (x, y), HIDE removes it; after a hit the hero blinks while the safety time runs
      IF inv > 0 AND BIT(inv, 2) THEN HIDE hero ELSE SHOW hero AT x, y ENDIF     REM after a hit the hero blinks
      INK 7 : PRINT AT 0, 0; "SCORE "; score USING "00000"; "  LIVES "; lives; "  LEVEL "; level;
    ENDIF
  ENDP
ENDSCENE
`;

// the mine: a 32 x 24 map of tiles (0 floor, 1 brick wall, 2 gem); rows 0 and 23 are the text rows
const MINE_WALLS = [[0, 1, 32, 1], [0, 22, 32, 1], [0, 1, 1, 22], [31, 1, 1, 22],        // the outer wall
  [4, 5, 6, 2], [22, 5, 6, 2], [14, 8, 4, 2], [4, 10, 2, 5], [26, 10, 2, 5], [4, 17, 6, 2], [22, 17, 6, 2], [14, 15, 4, 2]];
const MINE_GEMS = [[2, 3], [29, 3], [15, 5], [7, 8], [24, 8], [2, 12], [29, 12], [15, 13], [7, 15], [24, 15], [2, 20], [29, 20]];
const MINE_START = [15, 10];

function mineMap() {
  const cells = new Array(32 * 24).fill(0);
  for (const [x, y, w, h] of MINE_WALLS) for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) cells[r * 32 + c] = 1;
  for (const [c, r] of MINE_GEMS) { if (cells[r * 32 + c] !== 0) throw new Error(`gem (${c}, ${r}) is not on the floor`); cells[r * 32 + c] = 2; }
  // every gem can be reached from the hero's start (no walking through walls)
  const seen = new Set([MINE_START.join()]), todo = [MINE_START];
  while (todo.length) {
    const [c, r] = todo.pop();
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = [c + dc, r + dr];
      if (cells[n[1] * 32 + n[0]] === 1 || seen.has(n.join())) continue;
      seen.add(n.join()); todo.push(n);
    }
  }
  for (const g of MINE_GEMS) if (!seen.has(g.join())) throw new Error(`gem ${g} cannot be reached`);
  return { w: 32, h: 24, cells };
}

function gemsAssets() {
  const hero = sprite(['..####..', '.######.', '##-##-##', '########', '########', '.#-##-#.', '.######.', '..####..'], { hot: [1, 1, 6, 6], phases: 4 });
  const bat = sprite(['#......#', '##.##.##', '########', '########', '.#-##-#.', '..####..', '..#..#..', '........'], { hot: [0, 0, 8, 7], phases: 8 });
  // brick wall (red mortar-free bricks, solid: sprites never pass over it); floor; a gem. Every tile you can walk over has the same colours (white on black):
  // a sprite takes the colour of the cell under it
  const tiles = [
    tileOf([0, 0, 0, 0, 0, 0, 0, 0], 7, 0),
    tileOf([0xFE, 0xFE, 0xFE, 0x00, 0xEF, 0xEF, 0xEF, 0x00], 2, 0, 1),
    tileOf([0x18, 0x3C, 0x7E, 0xFF, 0x7E, 0x3C, 0x18, 0x00], 7, 0),
  ];
  const sfx = {
    pick: { ticks: ticks(7, (k) => ({ tone: 150 - 12 * k, vol: 13 - k, noise: 0, mix: 6 })) },
    hurt: { ticks: ticks(16, (k) => ({ tone: 300 + 14 * k, vol: Math.max(0, 14 - k), noise: Math.min(31, 4 + 2 * k), mix: 4 })) },
    win: { ticks: ticks(18, (k) => ({ tone: [200, 160, 120][Math.floor(k / 6)], vol: 13 - (k % 6), noise: 0, mix: 6 })) },
    lose: { ticks: ticks(24, (k) => ({ tone: 160 + 14 * k, vol: Math.max(2, 13 - Math.floor(k / 2)), noise: 0, mix: 6 })) },
  };
  return { sprites: { hero, bat }, tilesets: { gfx: { tiles } }, maps: { mine: mineMap() }, sfx };
}

// ── 3. scenes-music: Arrow Rush ──────────────────────────────────────────────────────────────────────────────────────────────────

const ARROW_SOURCE = `REM ARROW RUSH (the starter "Scenes and music", runtime v2): a reaction game in three scenes.
REM Four arrows on a pad; one lights up yellow.  Press its key (Q up, A down, O left, P right, or joystick 1) before the bar
REM runs out.  A right answer scores, and every round gives you less time.  A wrong key or no key costs a life (3 lives).
REM Scenes: TITLE (a song plays) -> PLAY -> OVER (your score and the best one this session) -> PLAY again.
REM Change first: START (the time for the first arrow), the points in RIGHT, the song "tune" (Sounds tab).
GAME "Arrow Rush"
FRAMERATE 30
CONST START = 60                   REM ticks you get for the first arrow (30 ticks are one second)

SPRITE up = "up"                   REM the four arrows, drawn in the Sprites tab
SPRITE down = "down"
SPRITE left = "left"
SPRITE right = "right"
SFX good = "good"                  REM sound effects
SFX buzz = "buzz"
SFX doom = "doom"
MUSIC tune = "tune"                REM a song: PLAY tune starts it, ENTER stops it

REM Variables declared outside a scene belong to the whole game and keep their value when the scene changes.
DIM score, best

SCENE title                        REM the first scene starts by itself; ENTER name goes to another one
  REM The title screen: some coloured text and the song.
  PROC INIT():
    BORDER 0 : PAPER 0 : INK 7 : BRIGHT 0
    FILLC 0, 0, 32, 24 = 32
    PLAY tune
    INK 6 : PRINT AT 4, 11; "ARROW RUSH";
    INK 5 : PRINT AT 8, 4; "PRESS THE LIT ARROW'S KEY";
    PRINT AT 10, 5; "BEFORE THE BAR RUNS OUT";
    INK 4 : PRINT AT 14, 3; "Q UP  A DOWN  O LEFT  P RIGHT";
    PRINT AT 16, 8; "OR USE JOYSTICK 1";
    INK 2 : PRINT AT 21, 7; "PRESS FIRE TO PLAY";
  ENDP

  REM FRAME runs every tick; here it waits for fire.
  PROC FRAME():
    IF KEYPRESS(" ") OR BIT(JOYPRESS(1), 4) THEN ENTER play ENDIF      REM KEYPRESS: true in the tick a key goes down
  ENDP
ENDSCENE

SCENE play
  DIM want, lives, round, lim, pr, w
  TIMER left                       REM ticks left for this arrow; the game counts it down by itself
  DIM ax(3) = 14, 14, 10, 18       REM the pad: the column and row of each arrow (up, down, left, right)
  DIM ay(3) = 6, 12, 9, 9

  REM Colour the cells under each arrow: the lit one yellow, the others blue (a sprite takes the colour of the cells under it).
  PROC LIGHT():
    FOR i = 0 TO 3
      IF i = want THEN INK 6 ELSE INK 1 ENDIF
      FILLC ax(i), ay(i), 2, 2 = 32
    NEXT i
  ENDP

  REM The next arrow: random direction, less time each round (but never less than half a second).
  PROC NEWARROW():
    lim = START - round * 3 : IF lim < 15 THEN lim = 15 ENDIF
    left = lim
    want = RND(4)
    CALL LIGHT()
    REM USING prints a number in a fixed field: "0000" pads with zeros, "##" with blanks
    INK 7 : PRINT AT 0, 0; "SCORE "; score USING "0000"; "  ROUND "; round + 1 USING "##"; "  LIVES "; lives;
  ENDP

  REM INIT runs once when the scene starts (ENTER play): the game is silent, a new game begins, the pad is drawn.
  PROC INIT():
    BORDER 0 : PAPER 0 : INK 7 : BRIGHT 0
    FILLC 0, 0, 32, 24 = 32                                    REM fill the screen with black blanks
    NOMUSIC                                                    REM the title song goes on until it is stopped
    score = 0 : lives = 3 : round = 0
    REM place the four arrows once (pixel x, y): they stay where they are, only their colour changes
    SHOW up AT 112, 48 : SHOW down AT 112, 96 : SHOW left AT 80, 72 : SHOW right AT 144, 72
    CALL NEWARROW()
  ENDP

  REM A wrong key, or no key in time: a life is gone.  With the last one the game is over.
  PROC MISS():
    lives = lives - 1
    PLAY buzz                                                  REM start a sound effect by its name
    IF lives = 0 THEN ENTER over ELSE CALL NEWARROW() ENDIF
  ENDP

  PROC FRAME():
    REM which direction keys went down this tick: bit 0 up, 1 down, 2 left, 3 right (the joystick's bits)
    pr = BAND(JOYPRESS(1), 15)
    IF KEYPRESS("Q") THEN pr = BOR(pr, 1) ENDIF
    IF KEYPRESS("A") THEN pr = BOR(pr, 2) ENDIF
    IF KEYPRESS("O") THEN pr = BOR(pr, 4) ENDIF
    IF KEYPRESS("P") THEN pr = BOR(pr, 8) ENDIF
    REM a key went down: right if it is the lit arrow's, else wrong
    IF pr <> 0 THEN
      IF BIT(pr, want) THEN
        score = score + 10 + left DIV 6                        REM the sooner, the more points
        round = round + 1
        PLAY good
        CALL NEWARROW()
      ELSE
        CALL MISS()
      ENDIF
    ELSE
      IF left = 0 THEN CALL MISS() ENDIF                       REM the bar is empty
    ENDIF
    REM the time bar: w of 20 characters, green, red when it is nearly empty
    w = left * 20 DIV lim
    IF w < 7 THEN INK 2 ELSE INK 4 ENDIF
    FILLC 6, 16, w, 1 = 61
    FILLC 6 + w, 16, 20 - w, 1 = 32
  ENDP
ENDSCENE

SCENE over                         REM shown when the lives are gone
  TIMER wait                       REM fire is ignored for a moment, so a press from the game does not skip this screen
  PROC INIT():
    BORDER 0 : PAPER 0 : INK 7 : BRIGHT 0
    FILLC 0, 0, 32, 24 = 32
    PLAY doom
    wait = 45
    INK 2 : PRINT AT 6, 11; "GAME OVER";
    INK 7 : PRINT AT 10, 10; "SCORE "; score USING "####";
    IF score > best THEN                                       REM best was declared at the top of the game: it keeps its value
      best = score
      INK 6 : PRINT AT 13, 11; "NEW BEST!";
    ELSE
      INK 5 : PRINT AT 13, 11; "BEST "; best USING "####";
    ENDIF
  ENDP

  REM Show the way on once the wait is over, then fire plays again.
  PROC FRAME():
    IF wait = 1 THEN INK 4 : PRINT AT 19, 4; "PRESS FIRE TO PLAY AGAIN"; ENDIF
    IF wait = 0 AND (KEYPRESS(" ") OR BIT(JOYPRESS(1), 4)) THEN ENTER play ENDIF
  ENDP
ENDSCENE
`;

// an arrow pointing up (the left half, mirrored); the other three are its transposed and flipped copies
const ARROW_UP = ['.......#', '......##', '.....###', '....####', '...#####', '..######', '.#######', '########',
  '.....###', '.....###', '.....###', '.....###', '.....###', '.....###', '.....###', '........'].map(mirror);
const flipRows = (rows) => [...rows].reverse();
const flipCols = (rows) => rows.map((r) => [...r].reverse().join(''));
const transpose = (rows) => rows[0].split('').map((_, c) => rows.map((r) => r[c]).join(''));

function arrowAssets() {
  const art = { up: ARROW_UP, down: flipRows(ARROW_UP), left: transpose(ARROW_UP), right: flipCols(transpose(ARROW_UP)) };
  const sprites = {};
  for (const [name, rows] of Object.entries(art)) sprites[name] = sprite(rows, { hot: [0, 0, 16, 16], phases: 1 });
  const sfx = {
    good: { ticks: ticks(8, (k) => ({ tone: 140 - 12 * k, vol: 13 - k, noise: 0, mix: 6 })) },
    buzz: { ticks: ticks(14, (k) => ({ tone: 420 + (k % 2) * 40, vol: Math.max(0, 14 - k), noise: 0, mix: 6 })) },
    doom: { ticks: ticks(30, (k) => ({ tone: 200 + 18 * k, vol: Math.max(2, 13 - Math.floor(k / 3)), noise: 0, mix: 6 })) },
  };
  // the title song: C major pentatonic, a quaver = 8 refreshes (225 beats a minute), 4 bars of 64 refreshes a pattern; the tune on A, the bass on B, drums on C
  const drums = '@drum !9 ' + Array(4).fill('C2:4 -:12 G5:4 -:12 C2:4 -:12 G5:4 -:12').join(' | ');
  const tune = song([
    pattern({
      A: '@organ !11 L8 | E5 G5 A5 G5 E5 D5 C5:16 | D5 E5 G5 E5 D5 C5 A4:16 | E5 G5 A5 C6 A5 G5 E5:16 | D5 E5 D5 C5 A4:32',
      B: '@bass !10 L32 | C3 G3 | A2 E3 | F2 C3 | G2 D3', C: drums,
    }, 'call'),
    pattern({
      A: '@organ !11 L8 | G5 A5 C6 A5 G5 E5 D5:16 | E5 G5 E5 D5 C5 D5 E5:16 | A5 C6 D6 C6 A5 G5 E5:16 | G5 E5 D5 E5 C5:32',
      B: '@bass !10 L32 | C3 G3 | A2 E3 | F2 C3 | G2 G3', C: drums,
    }, 'answer'),
  ], [0, 1], 0);
  return { sprites, sfx, music: { tune } };
}

// ── 4. fine-colour: Rainbow Gold ─────────────────────────────────────────────────────────────────────────────────────────────────

const GOLD_SOURCE = `REM RAINBOW GOLD (the starter "Fine colour", runtime v2): gold coins fall from the sky and you slide the pot along the rainbow to catch them.
REM Keys O and P, or joystick 1, move the pot.  A coin that gets past costs one of your 3 lives, and the coins fall faster and faster.
REM Fire (SPACE or the joystick button) starts the game, and plays again after GAME OVER.
REM FINE COLOUR: both scenes are 8 x 1 colour scenes (in the Studio's scene list the display is "finer colour (8 x 1)"; in the .leapgame file scenes.play.display is "fine").
REM Every pixel row of a tile or a sprite then has its own colour, so the horizon glow, the rainbow road, the logo and the shaded pot and coins are drawn row by row.
REM The price: at most 32 sprite phases, a handful of moving sprites at 20 ticks a second, and text cells are slow, so print only what changed.
REM Change first: the lives (3 in INIT), the speeds (spd in FRAME), and the pictures: the sky map, the pot and the coin sprites.
GAME "Rainbow Gold"
FRAMERATE 20
CONST POTY = 136                   REM the pot stands on the rainbow road (pixel y)

SPRITE pot = "pot"
SPRITE coin(4) = "coin"            REM a pool: up to four coins fall at once
TILESET gfx = "gfx"
MAP sky = "sky"                    REM the first MAP is the background of every scene: stars, the glow and the road
MAP logo = "logo"                  REM the other maps are pictures of tiles with a colour for every pixel row: big letters
MAP gold = "gold"
MAP press = "press"
MAP gameover = "gameover"
SFX ding = "ding"
SFX thud = "thud"
SFX bye = "bye"

SCENE title                        REM the sky map is on the screen already; the title adds the logo, the text and the pot
  PROC INIT():
    BORDER 0 : PAPER 0 : INK 5 : BRIGHT 0
    LOADMAP logo AT 9, 2                                       REM LOADMAP name AT column, row
    LOADMAP gold AT 12, 5
    LOADMAP press AT 7, 13
    PRINT AT 9, 0; "O P OR JOYSTICK 1: MOVE THE POT";
    INK 6 : PRINT AT 10, 5; "CATCH THE FALLING GOLD";
    SHOW pot AT 120, POTY
  ENDP

  REM Fire (the joystick button or SPACE) starts the game; KEYPRESS is true only in the tick a key goes down.
  PROC FRAME():
    IF KEYPRESS(" ") OR BIT(JOYPRESS(1), 4) THEN ENTER play ENDIF
  ENDP
ENDSCENE

SCENE play
  DIM px, lives, score, spd, js, over
  TIMER gap, wait                  REM gap: ticks until the next coin; wait: a pause before fire restarts
  DIM cx(3), cy(3), con(3)         REM each coin: its column (pixel x), its height (pixel y) and whether it is falling

  REM Print the numbers that changed (each text cell costs time in fine colour, so not every tick).
  PROC HUD():
    INK 7 : PRINT AT 0, 6; score USING "000"; : PRINT AT 0, 30; lives;
  ENDP

  REM INIT runs once when the scene starts: a new game, the labels of the score line.
  PROC INIT():
    BORDER 0 : PAPER 0 : INK 7 : BRIGHT 0
    score = 0 : lives = 3 : px = 120 : spd = 2 : gap = 20
    PRINT AT 0, 0; "SCORE"; : PRINT AT 0, 24; "LIVES";
    CALL HUD()
  ENDP

  REM Coin i fell past the pot: a life is gone.  With the last one the game is over.
  PROC MISS(i):
    con(i) = 0 : HIDE coin(i)
    lives = lives - 1 : PLAY thud
    CALL HUD()                                                 REM show the new number of lives
    IF lives = 0 THEN
      over = 1 : wait = 30 : PLAY bye                          REM the game is over; fire counts again after 30 ticks
      FOR k = 0 TO 3 : HIDE coin(k) : NEXT k
      LOADMAP gameover AT 7, 7
      LOADMAP press AT 7, 12
    ENDIF
  ENDP

  REM FRAME runs 20 times a second: move the pot, then every coin slot.
  PROC FRAME():
    js = STICK(1)                                              REM joystick 1 as bits: 4 left, 8 right, 16 fire
    IF over THEN
      IF wait = 0 AND (KEYPRESS(" ") OR BIT(JOYPRESS(1), 4)) THEN ENTER play ENDIF
    ELSE
      IF KEYDOWN("O") OR BIT(js, 2) THEN px = px - 4 ENDIF
      IF KEYDOWN("P") OR BIT(js, 3) THEN px = px + 4 ENDIF
      IF px < 0 THEN px = 0 ENDIF
      IF px > 240 THEN px = 240 ENDIF
      SHOW pot AT px, POTY                                     REM SHOW draws a sprite at pixel x, y
      FOR i = 0 TO 3                                           REM the four coin slots, each either falling or free
        IF con(i) THEN
          cy(i) = cy(i) + spd
          SHOW coin(i) AT cx(i), cy(i)
          IF HIT(pot, coin(i)) THEN                            REM the coin touches the pot: caught
            con(i) = 0 : HIDE coin(i)
            score = score + 1 : PLAY ding : CALL HUD()
            spd = 2 + score DIV 8 : IF spd > 6 THEN spd = 6 ENDIF    REM faster every 8 coins
          ELSE
            IF cy(i) > 144 THEN CALL MISS(i) ENDIF
          ENDIF
        ELSE
          IF gap = 0 THEN                                      REM a free slot and time for a new coin: it starts at the top
            con(i) = 1 : cx(i) = 8 * RND(31) : cy(i) = 8
            gap = 32 - spd * 3
          ENDIF
        ENDIF
      NEXT i
    ENDIF
  ENDP
ENDSCENE
`;

// the pot (a cauldron with a heap of gold) and the coin, 16 x 16 and 8 x 8: '#' lit, '-' covered but unlit (the background's paper shows), '.' transparent. In fine colour a sprite
// takes the INK of each of its pixel rows, so the colours below are one per row, lit from above (white, yellow, then down through the brightnesses)
const POT = ['......##', '....####', '..######', '.#######', '########', '########', '..######', '.#######', '########', '########', '########', '########', '.#######', '..######', '..##....', '..##....'].map(mirror);
const POT_INK = [7, 7, 6, 6, 7, 5, 3, 3, 3, 2, 2, 2, 2, 3, 3, 3];
const COIN = ['..####..', '.######.', '###-####', '###-####', '###-####', '###-####', '.######.', '..####..'];
const COIN_INK = [7, 7, 6, 6, 6, 6, 2, 2];

const RAINBOW = [7, 7, 7, 6, 6, 5, 5, 4, 4, 3, 3, 2, 2, 2, 1, 1];        // the ink of a pixel row of the big letters (white at the top, down the brightnesses)
const GOLDEN = [7, 7, 6, 6, 6, 6, 6, 6, 6, 6, 2, 2, 2, 2, 2, 2];          // the same for GOLD: white glint, yellow, a red shadow
const GRADE = [6, 6, 6, 6, 2, 2, 2, 2];                                   // a pixel row of one-size graded text: yellow over red

function goldAssets() {
  // tiles 0..3 are fixed: the empty sky and three stars (the stars are placed on the map below)
  const T = tiler([
    tileOf([0, 0, 0, 0, 0, 0, 0, 0], 7, 0), tileOf([0, 0, 0, 0, 0, 0x04, 0, 0], 1, 0), tileOf([0, 0, 0x20, 0, 0, 0, 0, 0], 5, 0),
    tileOf([0, 0x10, 0x38, 0x10, 0, 0, 0, 0], [7, 5, 7, 5, 7, 7, 7, 7], 0),
  ]);
  // the background is painted as a picture, pixel by pixel, then cut into tiles: a faint glow above the road goes black -> blue (colours that are neighbours in brightness: a solid
  // band with a checkerboard seam between), the rainbow road below it white, yellow, cyan, green, magenta, red, blue (7 bands of about 3 pixel rows)
  const sky = picture();
  for (let y = 136; y < 152; y++) for (let x = 0; x < 256; x++) set(sky, x, y, dither(x, y, (y - 136 + 0.5) / 16, [0, 1]));
  for (let y = 152; y < 176; y++) for (let x = 0; x < 256; x++) set(sky, x, y, dither(x, y, 6 * (1 - (y - 152 + 0.5) / 24), [1, 2, 3, 4, 5, 6, 7], { seam: 0.25 }));
  let seed = 11;
  const rnd = () => { seed = (seed * 25173 + 13849) & 0xFFFF; return seed / 65536; };
  const skyCells = [...new Array(32).fill(0), ...T.add(sky, 1, 0, 23, 32)];
  skyCells.forEach((t, i) => { const v = rnd(); if (t === 0 && i >= 32 && i < 16 * 32) skyCells[i] = v < 0.02 ? 3 : v < 0.06 ? 1 : v < 0.09 ? 2 : 0; });
  // the big letters: the font at twice its size, each pixel row its own ink, as a map of tiles
  const textMap = (str, colourOf, opts = {}) => {
    const pic = picture(), w = str.length * (opts.scale ?? 1), h = opts.scale ?? 1;
    text(pic, str, 0, 8, colourOf, opts);
    return { w, h, cells: T.add(pic, 1, 0, h, w) };
  };
  const maps = {
    sky: { w: 32, h: 24, cells: skyCells },
    logo: textMap('RAINBOW', (py) => RAINBOW[py], { scale: 2, bold: true }),
    gold: textMap('GOLD', (py) => GOLDEN[py], { scale: 2, bold: true }),
    press: textMap('PRESS FIRE TO PLAY', (py) => GRADE[py]),
    gameover: textMap('GAME OVER', (py) => RAINBOW[py], { scale: 2, bold: true }),
  };
  if (T.count > 128) throw new Error(`${T.count} tiles: a tile set has at most 128`);
  const sfx = {
    ding: { ticks: ticks(8, (k) => ({ tone: 110 - 8 * k, vol: 13 - k, noise: 0, mix: 6 })) },
    thud: { ticks: ticks(12, (k) => ({ tone: 0, vol: Math.max(0, 14 - k), noise: Math.min(31, 10 + 2 * k), mix: 5 })) },
    bye: { ticks: ticks(26, (k) => ({ tone: 180 + 16 * k, vol: Math.max(2, 13 - Math.floor(k / 2)), noise: 0, mix: 6 })) },
  };
  return {
    scenes: { title: { display: 'fine' }, play: { display: 'fine' } },
    sprites: { pot: sprite(POT, { hot: [1, 0, 14, 10], phases: 4, inks: POT_INK }), coin: sprite(COIN, { hot: [1, 1, 6, 6], phases: 1, inks: COIN_INK }) },
    tilesets: { gfx: { tiles: T.tiles } }, maps, sfx,
  };
}

// ── the list ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const STARTERS_A = [
  {
    id: 'blank', title: 'Blank game', about: 'A ball, a star and a clock: the smallest game that still has a point.', runtime: 'v2',
    make: () => exampleProject('Star Dash', BLANK_SOURCE, blankAssets()),
  },
  {
    id: 'sprites-tiles', title: 'Sprites and tiles', about: 'Grab the gems in a tiled mine and dodge the pooled bats: sprites, tiles, sound and a score.', runtime: 'v2',
    make: () => exampleProject('Gem Mine', GEMS_SOURCE, gemsAssets()),
  },
  {
    id: 'scenes-music', title: 'Scenes and music', about: 'A reaction game with a title, play and game over scene, a title song and a session best score.', runtime: 'v2',
    make: () => exampleProject('Arrow Rush', ARROW_SOURCE, arrowAssets()),
  },
  {
    id: 'fine-colour', title: 'Fine colour', about: 'Catch gold on a rainbow road: 8 x 1 colour scenes with row-by-row shaded art.', runtime: 'v2',
    make: () => exampleProject('Rainbow Gold', GOLD_SOURCE, goldAssets()),
  },
];
