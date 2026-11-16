/**
 * src/starters/starters-b.js — three of the Studio's starter projects (stage 4, N1; pure, no DOM, Node can import it):
 * the wireframe 3D game (v2), the scrolling platformer (v3) and the first-person maze (v4).
 *
 * Each entry is {id, title, about, runtime, make()}; make() builds a NEW project object every call (src/arcade-project.js: newProject, then the
 * source, the framerate, the assets and the per-scene settings). Every asset is built by code here: small, original, the same every time, and no
 * file is read (the module ships to the browser). Every starter is a small game with a point, under 150 lines of commented source, that compiles
 * with no warning and no asset finding on its own runtime; tests/arcade-starters-b.mjs runs each on the real runtime against the interpreter.
 */

"use strict";

import { newProject, MAIN_FILE } from '../arcade-project.js';

// ── shared helpers ───────────────────────────────────────────────────────────────────────────────────────────

const hex = (v, digits) => v.toString(16).toUpperCase().padStart(digits, '0');
const ticks = (n, f) => Array.from({ length: n }, (_, k) => f(k));

/**
 * A sprite from ASCII art. '#' is a lit pixel, '-' a covered pixel with no ink (it hides what is behind the sprite), '.' is transparent.
 * (A sprite takes the ink and paper of the screen cell under it, so every sprite is a one-colour shape; `ink` and `paper` only say how the
 * sprite editors show it: the colours it has in the game's own scene.)
 */
function spriteAsset(frames, { hot, phases = 1, ink = 7, paper = 0 } = {}) {
  const h = frames[0].length, w = frames[0][0].length;
  const digits = w / 4;
  const out = frames.map((art) => {
    if (art.length !== h || art.some((r) => r.length !== w)) throw new Error('sprite frames differ in size');
    return {
      rows: art.map((r) => {
        let bits = 0, mask = 0;
        for (const ch of r) { bits = bits * 2 + (ch === '#' ? 1 : 0); mask = mask * 2 + (ch === '#' || ch === '-' ? 1 : 0); }
        return { bits: hex(bits, digits), mask: hex(mask, digits), ink, paper, bright: 0 };
      }),
    };
  });
  const a = { w, h, frames: out, phases };
  if (hot) a.hot = hot;
  return a;
}

/** An 8 x 8 tile from ASCII art with its colours ('#' = ink) and flags (the games use 1 solid, 2 hazard, 4 pickup, 16 goal). `fg`: sprites never pass over it. */
function tileAsset(art, ink, paper, bright, flags = 0, fg = false) {
  if (art.length !== 8 || art.some((r) => r.length !== 8)) throw new Error('a tile is 8 x 8');
  const t = { flags, rows: art.map((r) => ({ bits: hex(parseInt([...r].map((c) => (c === '#' ? '1' : '0')).join(''), 2), 2), ink, paper, bright })) };
  if (fg) t.fg = true;
  return t;
}

/** A project from a starter's pieces: the new-project document with the source, the frame rate, the assets and the scene settings put in. */
function projectOf(title, source, framerate, assets, scenes = {}) {
  const p = newProject(title);
  p.files = { [MAIN_FILE]: source };
  p.framerate = framerate;
  p.assets = { sprites: {}, tilesets: {}, maps: {}, sfx: {}, music: {}, models: {}, ...assets };
  p.scenes = scenes;
  return p;
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 1. Wireframe 3D (runtime v2): "Ring Run"
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════

const WIRE_SOURCE = `REM RING RUN: a wireframe 3D starter.  Everything in the 3D area is drawn with lines only.
REM GOAL: fly through the square rings.  Each ring you pass scores a point.  Dodge the tumbling rocks!
REM A ring you miss or a rock you hit costs a shield; with no shields left the game is over.
REM KEYS: O P steer left and right, Q A up and down (or joystick 1).  SPACE or FIRE starts a game.
REM CHANGE FIRST: the speed and the shields in PROC INIT, the SCALE of a model, INK in the WIRE3D line.
REM The two models, ring and rock, are in the Models tab: open one and move its points.
GAME "Ring Run"
FRAMERATE 12

REM WIRE3D: character rows 2 to 21 show 3D lines in one colour (INK 5 is cyan).  Rows 0, 1, 22, 23 are for text.
WIRE3D ROWS 2 TO 21 INK 5 PAPER 0 BRIGHT 0
MODEL ring = "ring"
MODEL rock = "rock"
SFX ding = "ding"
SFX bump = "bump"

REM Variables outside every scene belong to the whole game, so they survive a change of scene.
DIM score, best, played

REM The title is a NOVIEW scene: no 3D area, the whole screen is text.
SCENE title NOVIEW
  REM A TIMER counts down to 0 by itself every tick.  Here it makes PRESS FIRE blink.
  TIMER bl

  PROC INIT():
    BORDER 0
    PAPER 0 : INK 7 : BRIGHT 0 : CLS
    IF score > best THEN best = score ENDIF
    INK 6 : PRINT AT 4, 12; "RING RUN";
    INK 7 : PRINT AT 7, 3; "FLY THROUGH THE SQUARE RINGS";
    PRINT AT 9, 8; "DODGE THE ROCKS";
    PRINT AT 11, 3; "THREE SHIELDS, THEN GAME OVER";
    INK 4 : PRINT AT 14, 2; "O P LEFT RIGHT   Q A UP DOWN";
    IF played THEN
      INK 2 : PRINT AT 17, 11; "GAME OVER";
      INK 6 : PRINT AT 18, 11; "SCORE "; score USING "000";
    ENDIF
    INK 5 : PRINT AT 19, 11; "BEST  "; best USING "000";
  ENDP

  PROC FRAME():
    IF bl = 0 THEN bl = 20 ENDIF
    IF bl > 8 THEN
      INK 6 : PRINT AT 21, 11; "PRESS FIRE";
    ELSE
      INK 0 : PRINT AT 21, 11; "          ";
    ENDIF
    REM KEYPRESS and JOYPRESS are true only in the tick a key went down, so a fire still held does not restart.
    IF KEYPRESS(" ") OR BIT(JOYPRESS(1), 4) THEN ENTER play ENDIF
  ENDP
ENDSCENE

SCENE play
  REM px, py: where you are.  rx, ry, rz: the ring.  kx, ky, kz: the rock.  rz and kz count down to the eye.
  DIM px, py, rx, ry, rz, kx, ky, kz, spd, wid, lvl, shd, t, hud, js
  REM fl: the border flashes red for a few ticks after a mistake.
  TIMER fl

  PROC INIT():
    BORDER 0
    PAPER 0 : INK 6 : BRIGHT 0 : CLS
    score = 0 : shd = 3 : px = 0 : py = 0 : t = 0 : rz = 0
    CALL NEWRING()
    hud = 1
  ENDP

  REM A new ring 1400 units further on, somewhere within wid units of the middle.  Harder every 4 rings:
  REM faster (spd), and the rings can be further from the middle (wid).  A rock guards each ring: it comes
  REM 400 units before it, up to 50 units off its middle, so fly through the part of the ring the rock leaves free.
  PROC NEWRING():
    lvl = 1 + score DIV 4
    spd = 30 + lvl * 5 : IF spd > 70 THEN spd = 70 ENDIF
    wid = 90 + lvl * 30 : IF wid > 330 THEN wid = 330 ENDIF
    rz = rz + 1400
    rx = RND(2 * wid + 1) - wid
    ry = RND(2 * wid + 1) - wid
    kz = rz - 400
    kx = rx + RND(101) - 50
    ky = ry + RND(101) - 50
  ENDP

  PROC FRAME():
    t = t + 1
    js = STICK(1)
    REM Steer 20 units a tick, but never further than 400 from the middle.
    IF (KEYDOWN("O") OR BIT(js, 2)) AND px > -400 THEN px = px - 20 ENDIF
    IF (KEYDOWN("P") OR BIT(js, 3)) AND px < 400 THEN px = px + 20 ENDIF
    IF (KEYDOWN("Q") OR BIT(js, 0)) AND py < 400 THEN py = py + 20 ENDIF
    IF (KEYDOWN("A") OR BIT(js, 1)) AND py > -400 THEN py = py - 20 ENDIF
    REM Everything flies towards the eye: its z shrinks.  At the eye (z below 60) we see if it was a hit.
    rz = rz - spd
    kz = kz - spd
    IF rz < 60 THEN CALL TESTRING() ENDIF
    IF kz < 60 THEN CALL TESTROCK() ENDIF
    CALL DRAW()
    IF fl > 0 THEN BORDER 2 ELSE BORDER 0 ENDIF
    IF hud THEN CALL SHOWHUD() ENDIF
    IF shd <= 0 THEN played = 1 : ENTER title ENDIF
  ENDP

  PROC TESTRING():
    IF ABS(px - rx) < 110 AND ABS(py - ry) < 110 THEN
      score = score + 1 : PLAY ding
    ELSE
      shd = shd - 1 : fl = 6 : PLAY bump
    ENDIF
    hud = 1
    CALL NEWRING()
  ENDP

  REM A rock that has gone by is parked far away (20000: too far to be drawn) until the next ring brings a new one.
  PROC TESTROCK():
    IF ABS(px - kx) < 90 AND ABS(py - ky) < 90 THEN
      shd = shd - 1 : fl = 6 : hud = 1 : PLAY bump
    ENDIF
    kz = 20000
  ENDP

  REM EYE puts the viewer at (px, py, 0) looking along z.  DRAWMODEL draws a model at a place in the world;
  REM YAW and PITCH turn it, SCALE (1, 2, 4 or 8) makes it bigger.  LINE draws a plain 2D line on the screen.
  PROC DRAW():
    EYE px, py, 0, 0
    DRAWMODEL ring AT rx, ry, rz SCALE 2
    DRAWMODEL rock AT kx, ky, kz YAW t * 7 PITCH t * 5 SCALE 2
    LINE 120, 96 TO 124, 96 : LINE 132, 96 TO 136, 96 : LINE 128, 88 TO 128, 92 : LINE 128, 100 TO 128, 104
  ENDP

  REM Text goes outside the 3D rows, and only when something changed (printing is slow).
  PROC SHOWHUD():
    INK 6 : PRINT AT 0, 1; "SCORE "; score USING "000"; : PRINT AT 0, 19; "LEVEL "; lvl USING "00";
    INK 5 : PRINT AT 23, 1; "SHIELDS "; shd; : PRINT AT 23, 19; "BEST "; best USING "000";
    hud = 0
  ENDP
ENDSCENE
`;

function wireAssets() {
  const sq = (z) => [[-64, -64, z], [64, -64, z], [64, 64, z], [-64, 64, z]];
  // the ring: a square tunnel, a square at the front and one behind it, joined at the corners
  const ring = { points: [...sq(16), ...sq(-16)], edges: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]] };
  // the rock: an octahedron, a point 40 out on each axis, an edge between every two points that are not opposite
  const rock = {
    points: [[40, 0, 0], [-40, 0, 0], [0, 40, 0], [0, -40, 0], [0, 0, 40], [0, 0, -40]],
    edges: [[0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [1, 3], [1, 4], [1, 5], [2, 4], [2, 5], [3, 4], [3, 5]],
  };
  const sfx = {
    ding: { ticks: ticks(12, (k) => ({ tone: [200, 150, 120, 100][Math.floor(k / 3)], vol: 14 - (k % 3), noise: 0, mix: 6 })) },
    bump: { ticks: ticks(14, (k) => ({ tone: 500 + 30 * k, vol: Math.max(0, 15 - k), noise: Math.min(31, 4 + 2 * k), mix: k < 5 ? 4 : 5 })) },
  };
  return { models: { ring, rock }, sfx };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 2. Scrolling platformer (runtime v3): "Coin Hop"
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════

const PLAT_SOURCE = `REM COIN HOP: a scrolling platformer starter (a WINDOW on a map, SOLID tiles, gravity, the camera).
REM GOAL: collect the coins and reach the flag.  Every lap the walker is faster.  Land on it to squash it;
REM touching it, a spike or a pit costs a life.  Three lives, then game over.
REM KEYS: O P run, Q or SPACE jump (or joystick 1).  Jump or FIRE starts.  CHANGE FIRST: GRAV, JUMP, RUN, the lives.
REM Draw your own level in the Maps tab: a tile's flags say what is solid, a spike, a coin or the flag.
GAME "Coin Hop"
FRAMERATE 20
REM Physics in pixels a tick: gravity, the jump's first speed (up is negative) and the running speed.
CONST GRAV = 1
CONST JUMP = -9
CONST RUN = 3
SPRITE hero = "hero"
SPRITE walker = "walker"
TILESET tiles = "tiles"
MAP level = "level"
SFX coin = "coin"
SFX jump = "jump"
SFX hurt = "hurt"
REM WINDOW shows the map through a scrolling window of 24 x 16 cells.  The first BAND is the top 4 map rows,
REM far hills that scroll at 1/4 of the camera's speed; the second is where you play (1/1).
WINDOW level
BAND 4, 1, 4
BAND 12, 1, 1
REM Variables outside every scene belong to the whole game and survive a change of scene (even ENTER play again).
DIM score, best, played, lap, lives

REM A NOWINDOW scene has no scrolling window: the whole screen is text, and a sprite goes where you SHOW it.
SCENE title NOWINDOW
  TIMER bl
  PROC INIT():
    BORDER 0
    PAPER 0 : INK 7 : BRIGHT 0 : CLS
    IF score > best THEN best = score ENDIF
    INK 6 : PRINT AT 3, 12; "COIN HOP";
    INK 7 : PRINT AT 6, 1; "COLLECT COINS, REACH THE FLAG";
    PRINT AT 8, 2; "SQUASH THE WALKER FROM ABOVE";
    REM CLS leaves the cells with no ink, and a sprite takes the ink of the cell it is over: FILLC gives rows 18 and 19 ink 7.
    FILLC 0, 18, 32, 2 = 32
    INK 4 : PRINT AT 17, 4; "O P RUN     Q OR SPACE JUMP";
    IF played THEN INK 2 : PRINT AT 12, 11; "GAME OVER"; : INK 6 : PRINT AT 13, 9; "SCORE "; score USING "0000"; ENDIF
    INK 5 : PRINT AT 14, 10; "BEST  "; best USING "0000";
  ENDP
  PROC FRAME():
    IF bl = 0 THEN bl = 20 ENDIF
    SHOW hero AT 96, 144 FRAME 1 + BAND(SHR(bl, 2), 1)
    SHOW walker AT 144, 144 FRAME BAND(SHR(bl, 2), 1)
    IF bl > 8 THEN INK 6 : PRINT AT 21, 10; "PRESS JUMP"; ELSE PRINT AT 21, 10; "          "; ENDIF
    REM KEYPRESS and JOYPRESS are true only in the tick a key went down, so a key still held does not restart.
    IF KEYPRESS(" ") OR KEYPRESS("Q") OR JOYPRESS(1) > 0 THEN
      score = 0 : lives = 3 : lap = 1 : played = 0
      ENTER play
    ENDIF
  ENDP
ENDSCENE

SCENE play
  REM px, py: the hero's place in the world (pixels, y from the top of the window); vy its speed down;
  REM gnd: standing on something solid.  ex, ey, ed, ws: the walker's place, direction and speed.
  DIM px, py, vy, face, gnd, mv, fr, ex, ey, ed, ws, ea, hud, js, fx, cy
  REM inv: no new hurt for a while after one.  rs: the squashed walker is back when this counts down to 0.
  TIMER inv, rs
  REM Every lap (a lap ends at the flag with ENTER play again) starts here.  WORLD level loads the map afresh,
  REM so the coins are back, and the walker is quicker every second lap.
  PROC INIT():
    BORDER 0
    PAPER 0 : INK 6 : BRIGHT 0 : CLS
    WORLD level
    ws = 1 + lap DIV 2 : IF ws > 3 THEN ws = 3 ENDIF
    hud = 1 : PLAY coin
    CALL RESPAWN()
  ENDP
  PROC RESPAWN():
    px = 16 : py = 88 : vy = 0 : face = 1 : inv = 30
    CAMERA 0
  ENDP
  PROC FRAME():
    js = STICK(1)
    CALL MOVE()
    CALL WALKER()
    IF gnd = 0 THEN fr = 3 ELSE IF mv = 0 THEN fr = 0 ELSE fr = 1 + BAND(SHR(px, 2), 1) ENDIF ENDIF
    IF face > 0 THEN SHOW hero AT px, py FRAME fr ELSE SHOW hero AT px, py FRAME fr FLIP ENDIF
    IF inv = 0 THEN CALL TOUCH() ENDIF
    CAMERA px - 88
    IF hud THEN CALL SHOWHUD() ENDIF
  ENDP
  REM Run (stopped by solid tiles), jump when standing, fall with gravity.  SOLID(x, y, w, h) asks if a box
  REM touches a solid tile; falling and rising are checked a pixel at a time so you never sink into the floor.
  PROC MOVE():
    LOCAL k
    mv = 0
    IF KEYDOWN("P") OR BIT(js, 3) THEN mv = RUN : face = 1 ENDIF
    IF KEYDOWN("O") OR BIT(js, 2) THEN mv = 0 - RUN : face = -1 ENDIF
    IF mv <> 0 AND NOT SOLID(px + 2 + mv, py, 12, 16) THEN px = px + mv ENDIF
    gnd = SOLID(px + 2, py + 1, 12, 16)
    IF gnd AND (KEYDOWN("Q") OR KEYDOWN(" ") OR BIT(js, 0) OR BIT(js, 4)) THEN vy = JUMP : PLAY jump ENDIF
    vy = vy + GRAV
    IF vy > 7 THEN vy = 7 ENDIF
    FOR k = 1 TO ABS(vy)
      IF SOLID(px + 2, py + SGN(vy), 12, 16) THEN vy = 0 : EXIT FOR ENDIF
      py = py + SGN(vy)
    NEXT k
  ENDP
  REM The walker patrols the ground and turns round at a wall or an edge.
  PROC WALKER():
    IF ea = 0 AND rs = 0 THEN ea = 1 : ex = 420 : ey = 88 : ed = -1 ENDIF
    IF ea THEN
      IF SOLID(ex + ed * ws, ey, 16, 16) OR NOT SOLID(ex + 8 + ed * 12, ey + 16, 1, 1) THEN ed = 0 - ed ENDIF
      ex = ex + ed * ws
      SHOW walker AT ex, ey FRAME BAND(SHR(ex, 3), 1)
    ELSE
      HIDE walker
    ENDIF
  ENDP
  REM TILEHIT asks which flags the tiles under a box have: 2 spikes, 4 a coin, 16 the flag.
  PROC TOUCH():
    LOCAL i
    fx = TILEHIT(px + 2, py, 12, 16, 22)
    IF BAND(fx, 16) THEN
      score = score + 50 : lap = lap + 1
      ENTER play
    ELSE
      REM Coins: look at 3 points down the hero's middle; a coin tile (5) there becomes sky (0).
      IF BAND(fx, 4) THEN
        FOR i = 0 TO 2
          cy = py + i * 7 + 1
          IF WORLDTILE(px + 8, cy) = 5 THEN SETWORLD px + 8, cy = 0 : score = score + 10 : hud = 1 : PLAY coin ENDIF
        NEXT i
      ENDIF
      IF BAND(fx, 2) OR py > 120 THEN CALL DIE() ENDIF
      IF ea AND HIT(hero, walker) THEN
        REM Falling onto the walker from above squashes it (and bounces you); any other touch hurts.
        IF vy > 0 AND py < ey - 4 THEN ea = 0 : rs = 90 : vy = -6 : score = score + 20 : hud = 1 : PLAY coin ELSE CALL DIE() ENDIF
      ENDIF
    ENDIF
  ENDP
  PROC DIE():
    lives = lives - 1 : hud = 1 : PLAY hurt
    IF lives <= 0 THEN played = 1 : ENTER title ENDIF
    CALL RESPAWN()
  ENDP
  REM Text only when something changed (printing is slow).  The HUD is on the rows outside the window.
  PROC SHOWHUD():
    INK 6 : PRINT AT 1, 2; "SCORE "; score USING "0000"; : PRINT AT 1, 15; "LIVES "; lives; : PRINT AT 1, 25; "LAP "; lap;
    hud = 0
  ENDP
ENDSCENE
`;

// the tiles: 0 sky, 1 grass, 2 dirt, 3 brick (solid), 4 spikes, 5 coin, 6 pole, 7 flag, then the far hills 8 sky, 9 slope up, 10 fill, 11 slope down.
// Flags: bit 0 solid, bit 1 hazard (spikes), bit 2 pickup (coin), bit 4 goal (pole and flag). Tile 0 is blank. Every colour has BRIGHT 0.
const PT = { SKY: 0, GRASS: 1, DIRT: 2, BRICK: 3, SPIKES: 4, COIN: 5, POLE: 6, FLAG: 7, F_SKY: 8, F_UP: 9, F_FILL: 10, F_DOWN: 11 };
function platTiles() {
  const none = ['........', '........', '........', '........', '........', '........', '........', '........'];
  const fill = ['########', '########', '########', '########', '########', '########', '########', '########'];
  return {
    tiles: [
      tileAsset(none, 0, 5, 0),
      tileAsset(['########', '########', '########', '#.#.##.#', '........', '.....#..', '........', '..#.....'], 4, 2, 0, 1),
      tileAsset(['........', '..#...#.', '........', '#....#..', '........', '...#...#', '.#......', '........'], 6, 2, 0, 1),
      tileAsset(['########', '...#....', '...#....', '...#....', '########', '#.......', '#.......', '#.......'], 7, 2, 0, 1),
      tileAsset(['........', '........', '........', '..#...#.', '..#...#.', '.###.###', '.###.###', '########'], 0, 5, 0, 2, true),
      tileAsset(['..####..', '.#.##.#.', '#..##..#', '#..##..#', '#..##..#', '#..##..#', '.#.##.#.', '..####..'], 6, 5, 0, 4, true),
      tileAsset(['...##...', '...##...', '...##...', '...##...', '...##...', '...##...', '...##...', '...##...'], 7, 5, 0, 16, true),
      tileAsset(['...#####', '...#####', '...####.', '...###..', '...##...', '...##...', '...##...', '...##...'], 2, 5, 0, 16, true),
      tileAsset(none, 5, 1, 0, 0, true),
      tileAsset(['.......#', '......##', '.....###', '....####', '...#####', '..######', '.#######', '########'], 5, 1, 0, 0, true),
      tileAsset(fill, 5, 1, 0, 0, true),
      tileAsset(['#.......', '##......', '###.....', '####....', '#####...', '######..', '#######.', '########'], 5, 1, 0, 0, true),
    ],
  };
}

/** The world: 80 x 16 cells. Rows 0..3 are the far hills, rows 4..15 the play area with the ground at row 13. */
function platWorld() {
  const W = 80, H = 16;
  const g = Array.from({ length: H }, () => new Array(W).fill(PT.SKY));
  const put = (c, r, t) => { g[r][c] = t; };
  const run = (c0, c1, r, t) => { for (let c = c0; c <= c1; c++) put(c, r, t); };
  const ground = (c0, c1) => { for (let c = c0; c <= c1; c++) { put(c, 13, PT.GRASS); put(c, 14, PT.DIRT); put(c, 15, PT.DIRT); } };
  for (let c = 0; c < W; c++) for (let r = 0; r < 4; r++) put(c, r, PT.F_SKY);
  for (let c = 0; c + 5 < W; c += 9) { put(c, 3, PT.F_UP); put(c + 1, 3, PT.F_FILL); put(c + 2, 3, PT.F_DOWN); put(c + 1, 2, PT.F_UP); put(c + 2, 2, PT.F_DOWN); }      // hills, 9 cells apart
  ground(0, 19); ground(23, 39); ground(44, 79);                      // pits at columns 20..22 and 40..43
  run(9, 11, 10, PT.BRICK); run(27, 30, 9, PT.BRICK); run(48, 51, 10, PT.BRICK); run(55, 58, 8, PT.BRICK);
  [14, 33, 62].forEach((c) => put(c, 12, PT.SPIKES));
  const coin = (c, r) => put(c, r, PT.COIN);
  [4, 5, 6].forEach((c) => coin(c, 12));
  [9, 10, 11].forEach((c) => coin(c, 9));
  [20, 21, 22].forEach((c) => coin(c, 10));
  [28, 29].forEach((c) => coin(c, 8));
  [36, 37].forEach((c) => coin(c, 12));
  [41, 42].forEach((c) => coin(c, 10));
  [49, 50].forEach((c) => coin(c, 9));
  [56, 57].forEach((c) => coin(c, 7));
  [66, 67, 68].forEach((c) => coin(c, 12));
  put(76, 10, PT.FLAG); put(76, 11, PT.POLE); put(76, 12, PT.POLE);      // the flag at the end, on the ground
  return { w: W, h: H, tileset: 'tiles', cells: g.flat() };
}

function platAssets() {
  const HEAD = ['................', '.....######.....', '....########....', '....##-##-##....', '....##-##-##....', '....########....', '.....######.....', '..############..'];
  const BODY = ['.##.########.##.', '.##.########.##.', '.##..######..##.'];
  const ARMS_UP = ['.##.########.##.', '.#..########..#.', '.#..########..#.'];
  const STAND = ['.....######.....', '.....##..##.....', '.....##..##.....', '....###..###....', '....###..###....'];
  const WALK_A = ['.....######.....', '....##....##....', '...##......##...', '..###......###..', '..###......###..'];
  const WALK_B = ['.....######.....', '.....######.....', '......####......', '......####......', '.....######.....'];
  const JUMP = ['....########....', '....##....##....', '...##......##...', '................', '................'];
  const make = (body, legs) => [...HEAD, ...body, ...legs.slice(0, 5)];
  const frames = [make(BODY, STAND), make(BODY, WALK_A), make(BODY, WALK_B), make(ARMS_UP, JUMP)];
  const top = ['................', '................', '................', '................', '................', '................', '....########....', '..############..', '.##############.', '.##--##--##--##.', '.##############.', '.##############.', '..############..'];
  const beetle = [[...top, '...##.####.##...', '..##........##..', '.##..........##.'], [...top, '..##.####.##....', '...##......##...', '..##........##..']];
  return {
    sprites: {
      hero: spriteAsset(frames, { hot: [2, 0, 12, 16], phases: 4, ink: 0, paper: 5 }),
      walker: spriteAsset(beetle, { hot: [1, 6, 14, 10], phases: 4, ink: 0, paper: 5 }),
    },
    tilesets: { tiles: platTiles() },
    maps: { level: platWorld() },
    sfx: {
      coin: { ticks: ticks(8, (k) => ({ tone: k < 3 ? 120 : 80, vol: 14 - k, noise: 0, mix: 6 })) },
      jump: { ticks: ticks(8, (k) => ({ tone: 300 - 25 * k, vol: 12 - k, noise: 0, mix: 6 })) },
      hurt: { ticks: ticks(16, (k) => ({ tone: 500 + 30 * k, vol: Math.max(0, 15 - k), noise: Math.min(31, 4 + 2 * k), mix: k < 5 ? 4 : 5 })) },
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════
// 3. First-person maze (runtime v4): "Gem Maze"
// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════

const RAY_SOURCE = `REM GEM MAZE: a first-person maze starter (VIEW3D turns a floor plan into a 3D view; sprites become billboards).
REM GOAL: collect the 3 found before the time runs out.  Each level adds time, but the ghost gets quicker and sharper.
REM The ghost costs you 5 seconds each time it catches you.  When the time is up, the game is over.
REM KEYS: O P turn, Q A walk forward and back (or joystick 1).  SPACE or FIRE starts a game.
REM CHANGE FIRST: SPD and TURN, the seconds in PROC INIT, the gem places in the DIM lines.  Edit the maze in the Maps tab.
GAME "Gem Maze"
FRAMERATE 12
REM Places are in 1/256 of a cell.  SPD is how far you walk in a tick, TURN how far you turn (256 is a full turn).
REM TPS: ticks a second, for the clock.  RAD: how close to a wall your middle may come.
CONST SPD = 48
CONST TURN = 7
CONST TPS = 12
CONST RAD = 48
SPRITE gem(3) = "gem"
SPRITE guard = "guard"
MAP plan = "plan"
SFX pick = "pick"
SFX caught = "caught"
REM VIEW3D draws the map (wall types 0 to 4) as a 3D maze in the middle of the screen.
VIEW3D plan COLW 4 INK 6 CEIL 0 FLOOR 1
REM Whole-game variables survive a change of scene.  Then the 8 places a gem can be (a cell's middle is
REM column * 256 + 128, row * 256 + 128) and the four ways the ghost can go: east, south, west, north.
DIM score, best, played, lvl
DIM sx(7) = 896, 2432, 3456, 384, 2432, 2944, 1408, 3456
DIM sy(7) = 384, 896, 384, 1408, 1920, 2432, 2944, 3456
DIM dx(3) = 1, 0, -1, 0
DIM dy(3) = 0, 1, 0, -1

SCENE title NOVIEW
  TIMER bl
  PROC INIT():
    BORDER 0
    PAPER 0 : INK 7 : BRIGHT 0 : CLS
    IF score > best THEN best = score ENDIF
    INK 6 : PRINT AT 3, 12; "GEM MAZE";
    INK 7 : PRINT AT 6, 2; "FIND ALL THE GEMS IN THE MAZE";
    PRINT AT 8, 4; "BEFORE THE TIME RUNS OUT";
    REM CLS leaves the cells with no ink, and a sprite takes the ink of the cell it is over: FILLC gives rows 18 and 19 ink 7.
    FILLC 0, 18, 32, 2 = 32
    INK 4 : PRINT AT 17, 4; "O P TURN     Q A WALK";
    IF played THEN INK 2 : PRINT AT 12, 11; "GAME OVER"; : INK 6 : PRINT AT 13, 9; "SCORE "; score USING "0000"; ENDIF
    INK 5 : PRINT AT 14, 10; "BEST  "; best USING "0000";
  ENDP
  PROC FRAME():
    IF bl = 0 THEN bl = 20 ENDIF
    REM Without the 3D view a sprite goes where you SHOW it on the screen, in pixels.
    SHOW gem(0) AT 96, 144 FRAME BAND(SHR(bl, 2), 1)
    SHOW guard AT 144, 144 FRAME BAND(SHR(bl, 2), 1)
    IF bl > 8 THEN INK 6 : PRINT AT 21, 10; "PRESS FIRE"; ELSE PRINT AT 21, 10; "          "; ENDIF
    REM KEYPRESS and JOYPRESS are true only in the tick a key went down, so a key still held does not restart.
    IF KEYPRESS(" ") OR BIT(JOYPRESS(1), 4) THEN
      score = 0 : lvl = 1 : played = 0
      ENTER play
    ENDIF
  ENDP
ENDSCENE

SCENE play
  REM px, py, pa: where you stand and where you look.  gx, gy, gd, gs: the ghost's place, way and speed.
  DIM px, py, pa, gx, gy, gd, gs, found, gi(2), ga(2), js, hud, sec, t
  REM clock counts the ticks left by itself, down to 0: then the game is over.
  TIMER clock
  PROC INIT():
    BORDER 0
    PAPER 0 : INK 6 : BRIGHT 0 : CLS
    px = 384 : py = 3712 : pa = 192 : clock = 40 * TPS
    CALL NEWLEVEL()
  ENDP
  REM A level: 3 found at 3 of the 8 places, the ghost back in its corner, quicker with every level.
  PROC NEWLEVEL():
    LOCAL i, r
    r = RND(8)
    FOR i = 0 TO 2
      gi(i) = BAND(r + i * 3, 7) : ga(i) = 1
    NEXT i
    found = 0 : gd = 2 : CALL HAUNT()
    gs = 20 + lvl * 5 : IF gs > 45 THEN gs = 45 ENDIF
    hud = 1
  ENDP
  REM The ghost starts, and starts again after it has caught you, in the corner furthest from you.
  PROC HAUNT():
    IF px > 2048 THEN gx = 384 ELSE gx = 3712 ENDIF : IF py > 2048 THEN gy = 384 ELSE gy = 3712 ENDIF
  ENDP
  PROC FRAME():
    t = t + 1
    js = STICK(1)
    CALL WALK()
    CALL GEMS()
    CALL GHOST()
    VIEW px, py, pa
    IF clock DIV TPS <> sec THEN sec = clock DIV TPS : hud = 1 ENDIF
    IF hud THEN CALL SHOWHUD() ENDIF
    IF clock = 0 THEN played = 1 : ENTER title ENDIF
  ENDP
  REM Turn, then walk the way you face (COSA, SINA: cosine and sine; FXMUL multiplies).  WALL(x, y) is the wall
  REM type at a place, 0 is free: a step is made only if the two corners it leads with are free.
  PROC WALK():
    LOCAL sp, nx, ny, f
    IF KEYDOWN("O") OR BIT(js, 2) THEN pa = pa - TURN ENDIF
    IF KEYDOWN("P") OR BIT(js, 3) THEN pa = pa + TURN ENDIF
    pa = BAND(pa, 255)
    sp = 0
    IF KEYDOWN("Q") OR BIT(js, 0) THEN sp = SPD ENDIF
    IF KEYDOWN("A") OR BIT(js, 1) THEN sp = 0 - SPD ENDIF
    nx = px + FXMUL(COSA(pa), sp) : ny = py + FXMUL(SINA(pa), sp)
    IF nx > px THEN f = nx + RAD ELSE f = nx - RAD ENDIF
    IF WALL(f, py - RAD) = 0 AND WALL(f, py + RAD) = 0 THEN px = nx ENDIF
    IF ny > py THEN f = ny + RAD ELSE f = ny - RAD ENDIF
    IF WALL(px - RAD, f) = 0 AND WALL(px + RAD, f) = 0 THEN py = ny ENDIF
  ENDP
  REM A gem is picked up when you are within 110 units of it.  All three: the next level, 20 more seconds.
  PROC GEMS():
    LOCAL i
    FOR i = 0 TO 2
      IF ga(i) THEN
        SHOW gem(i) AT sx(gi(i)), sy(gi(i)) FRAME BAND(SHR(t, 3), 1)
        IF ABS(sx(gi(i)) - px) < 110 AND ABS(sy(gi(i)) - py) < 110 THEN
          ga(i) = 0 : found = found + 1 : score = score + 10 * lvl : hud = 1 : HIDE gem(i) : PLAY pick
        ENDIF
      ENDIF
    NEXT i
    IF found = 3 THEN lvl = lvl + 1 : clock = clock + 20 * TPS : CALL NEWLEVEL() ENDIF
  ENDP
  REM The ghost walks on until a wall is ahead, then goes any way.  Every 16 ticks it may turn towards you
  REM instead, more and more likely at higher levels.
  PROC GHOST():
    LOCAL nx, ny
    IF BAND(t, 15) = 0 AND RND(4) <= lvl THEN
      IF ABS(px - gx) > ABS(py - gy) THEN gd = 2 - 2 * (px > gx) ELSE gd = 3 - 2 * (py > gy) ENDIF
    ENDIF
    nx = gx + dx(gd) * gs : ny = gy + dy(gd) * gs
    IF WALL(nx + dx(gd) * 100, ny + dy(gd) * 100) = 0 THEN gx = nx : gy = ny ELSE gd = RND(4) ENDIF
    SHOW guard AT gx, gy FRAME BAND(SHR(t, 2), 1)
    REM Caught: 5 seconds off the clock, and the ghost goes back to its corner.
    IF ABS(gx - px) < 150 AND ABS(gy - py) < 150 THEN
      IF clock > 6 * TPS THEN clock = clock - 5 * TPS ELSE clock = 5 ENDIF
      CALL HAUNT()
      PLAY caught
    ENDIF
  ENDP
  REM Text only when something changed (printing is slow).  The HUD is on the rows outside the 3D view.
  PROC SHOWHUD():
    INK 6 : PRINT AT 1, 2; "SCORE "; score USING "0000"; : PRINT AT 1, 16; "LEVEL "; lvl; : PRINT AT 1, 26; "GEMS "; found;
    PRINT AT 20, 12; "TIME "; sec USING "00";
    hud = 0
  ENDP
ENDSCENE
`;

// the floor plan: 16 x 16 cells of wall types 1..4 ('.' empty); the outer ring is wall type 1, walls inside are 2, 3 and 4 so the maze shows where you are
const RAY_PLAN = [
  '1111111111111111',
  '1.......2......1',
  '1.222.2.2.3333.1',
  '1.2...2...3....1',
  '1.2.4.22222.33.1',
  '1...4.......3..1',
  '1.222.3333..3.21',
  '1.2....3.......1',
  '1.2.44.3.222.2.1',
  '1......3.2...2.1',
  '1.3333.3.2.222.1',
  '1.3....2222....1',
  '1.3.4....2.444.1',
  '1....2.4...4...1',
  '1.2222222.2..2.1',
  '1111111111111111',
];

function rayAssets() {
  const gem = (facets) => ['................', '.......##.......', '......####......', '.....######.....', '....########....', '...##########...', '..############..', '.##############.',
    '..############..', '...##########...', '....########....', '.....######.....', '......####......', '.......##.......', '................', '................']
    .map((r, y) => (facets && y >= 5 && y <= 9 ? r.replace(/#/g, (c, i) => (i === 7 || i === 8 ? '-' : c)) : r));
  const ghost = (hem) => ['.....######.....', '...##########...', '..############..', '..##--####--##..', '..##--####--##..', '..############..', '..############..', '..############..',
    '..############..', '..############..', '..############..', '..############..', ...hem, '................', '................'].slice(0, 16);
  return {
    sprites: {
      gem: spriteAsset([gem(false), gem(true)], { hot: [2, 1, 12, 13], ink: 6 }),
      guard: spriteAsset([ghost(['..##.##.##.##...', '..#..##..##..#..']), ghost(['...##.##.##.##..', '..#..##..##..#..'])], { hot: [2, 0, 12, 14], ink: 6 }),
    },
    maps: { plan: { w: 16, h: 16, cells: RAY_PLAN.flatMap((r) => [...r].map((c) => (c === '.' ? 0 : Number(c)))) } },
    sfx: {
      pick: { ticks: ticks(10, (k) => ({ tone: [160, 120, 90][Math.floor(k / 4)], vol: 14 - k, noise: 0, mix: 6 })) },
      caught: { ticks: ticks(14, (k) => ({ tone: 500 + 30 * k, vol: Math.max(0, 15 - k), noise: Math.min(31, 4 + 2 * k), mix: k < 5 ? 4 : 5 })) },
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════════════════════════════════════

export const STARTERS_B = Object.freeze([
  Object.freeze({
    id: 'wireframe', title: 'Ring Run', runtime: 'v2',
    about: 'Wireframe 3D: fly through the rings and dodge the rocks (WIRE3D, MODEL, EYE, DRAWMODEL).',
    make: () => projectOf('Ring Run', WIRE_SOURCE, 12, wireAssets()),
  }),
  Object.freeze({
    id: 'platformer', title: 'Coin Hop', runtime: 'v3',
    about: 'A scrolling platformer: run, jump, collect coins, squash the walker, reach the flag (WINDOW, BAND, SOLID, CAMERA).',
    make: () => projectOf('Coin Hop', PLAT_SOURCE, 20, platAssets()),
  }),
  Object.freeze({
    id: 'raycaster', title: 'Gem Maze', runtime: 'v4',
    about: 'A first-person maze: find the gems before the time runs out, dodge the ghost (VIEW3D, billboards, WALL).',
    make: () => projectOf('Gem Maze', RAY_SOURCE, 12, rayAssets()),
  }),
]);
