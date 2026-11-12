REM Leap Runner, four levels: platformer.arc (the one-level reference, kept as it is) with three more worlds, and three SCENEs (language batch 7: a scene without the window).
REM   title  (NOWINDOW)  a full-screen picture, a 32 x 24 screen MAP made of the game's own tiles (runner.assets.gen.mjs makes it: "LEAP RUNNER" in brick tiles, the ground, coins), with the
REM                      high score and PRESS SPACE OR FIRE; SPRITES at screen positions: the hero runs and hops across (and eats the coins), a walker follows him, a bat flies the other way.
REM                      The scene shows no window at all: the cell screen is all of it, as in a game without a WINDOW.
REM   demo   (window)    the attract mode: level 1 scrolls by itself (the camera goes there and back), the title text over it.  The title and the demo take turns (8.5 seconds each).
REM   play   (window)    the game.  Space or fire in the title or the demo starts it (ENTER play); game won and game over go back to the title (ENTER title).
REM The reset of every ENTER loads the game's first screen MAP, the title picture, into the cells; the scenes with the window clear it (CLS) at once: the window is not drawn from the cells, the rows around it are the HUD's.
REM The game is larger than the 16 KB of the game area: the three worlds are MAPs that a WORLD statement loads, so the linker puts them in the cartridge's banked part
REM (docs/ARCADE_BANKING_CONTRACT.md).  Assets are in runner.assets.json, laid out by runner.assets.gen.mjs (level 1 is the platformer's world);
REM the level data below (TABLE lv1 .. lv4: CXS/CYS, SX/SY, WLO/WHI, CKX/CKY, CIX, RCF/RNX and the counts CE / SE, each list indexed from 0 within its level) is
REM printed by  node arcade/examples/runner.assets.gen.mjs --data  and checked against the maps by tests/arcade-runner.mjs; LOADDATA does LOADTABLE lv.
REM   Keyboard: O left, P right, Q or SPACE jump (hold for a higher jump), A drop through a plank, H pause (and H again to go on).   Joystick 1: the stick and fire.
REM   128 x 16 cell worlds, three bands (2 / 3 / 11 rows at 1/4, 1/2, 1/1).  Stomp the walkers and bats by jumping on them (HIT while
REM   falling), touch them from the side and you lose a life (brief invulnerability); spikes and the pit send you to the last checkpoint.
REM   Coins (pickup tiles that spin by tile swaps) and a flag at the far end of each level; the flag shows LEVEL n and loads the next world
REM   (WORLD lv OF level, level2, level3, level4); after the fourth the win screen.  Three lives for the whole game; losing the last one is game over.
REM   Compile:  node arcade/tools/arcadec.mjs arcade/examples/runner.arc --assets arcade/examples/runner.assets.json --runtime v3
GAME "Leap Runner"
FRAMERATE 20

REM level and physics.  Positions are pixels; the player's x also lives in 1/8 pixels (x8) for smooth acceleration.
CONST BX = 3
CONST BY = 2
CONST BW = 10
CONST BH = 22
CONST ACC = 4
CONST VMAX = 20
CONST FRIC = 4
CONST GRAV = 1
CONST VFALL = 7
CONST VJUMP = -9
CONST LZ = 72
CONST RZ = 112
CONST DEADY = 120

REM instances: the hero last (a later instance is drawn on top): 4 + 2 + 1 = 7 of the 16.  The coins are tiles (see SPINCOINS).
SPRITE wk(4) = "pf_walker"
SPRITE fl(2) = "pf_bat"
SPRITE hero = "pf_hero"
TILESET pf = "pf_tiles"
MAP titlepic = "rn_title"
MAP level = "pf_world"
MAP level2 = "rn_world2"
MAP level3 = "rn_world3"
MAP level4 = "rn_world4"
SFX jump = "pf_jump"
SFX coin = "pf_coin"
SFX stomp = "pf_stomp"
SFX hurt = "pf_hurt"
SFX win = "pf_win"
SFX over = "pf_over"
REM The title song (docs/ARCADE_MUSIC_CONTRACT.md): it starts with the title, plays on through the attract mode (the demo) and stops when a game starts.
MUSIC hop = "rn_hop"

WINDOW level
BAND 2, 1, 4
BAND 3, 1, 2
BAND 11, 1, 1

REM ================================================================================================================ the game's own state
REM The scenes share the level data and the coin spin, so they are declared here, outside every scene (a scene's own names are private to it).  HI is the high score: it is not cleared when a game
REM starts (0 at power-on).  FC is the tick counter and CAM the camera the coin spin reads, CF the first coin not left of the camera, LV the level (0..3) whose data and world are loaded.
  DIM hi, fc, cam, cf, lv
  REM the coin tile's four spin frames (tiles 6, 18, 19, 18)
  DIM ct(3) = 6, 18, 19, 18
  REM the bats' vertical path: a sine, +-12 pixels in 16 steps
  DIM sn(15) = 0, 5, 9, 11, 12, 11, 9, 5, 0, -5, -9, -11, -12, -11, -9, -5

  REM ---- the level data of the four levels, one after the other (printed by runner.assets.gen.mjs --data; do not edit)
  REM the coin list and the enemy list of each level are sorted by x; the checkpoints are 3 a level, CIX has 9 and RCF / RNX 4 (the start and the 3 checkpoints) a level;
  REM the arrays are sized to the largest level (50 coins, 11 enemies), CE / SE are the counts, and a table zeroes what its level does not list
  REM @@DATA-BEGIN@@
  DIM cxs(49), cys(49), sx(10), sy(10), wlo(10), whi(10), ckx(2), cky(2), cix(8), rcf(3), rnx(3), ce, se
  DIM cc(49), sd(10)
  TABLE lv1
    cxs = 64, 72, 80, 96, 104, 112, 120, 192, 200, 304, 312, 320, 328, 352, 360, 368, 376, 424, 432, 440, 464, 496, 504, 512, 520, 528, 536, 568, 576, 616, 624, 640, 648, 696, 704, 720, 728, 752, 760, 800, 808, 832, 840, 848, 888, 896, 912, 920, 944, 952
    cys = 104, 104, 104, 88, 80, 80, 88, 104, 104, 80, 80, 80, 80, 80, 80, 80, 80, 96, 88, 96, 96, 80, 80, 64, 64, 64, 64, 96, 96, 80, 80, 96, 96, 88, 88, 72, 72, 88, 88, 96, 96, 104, 104, 96, 96, 96, 80, 80, 104, 104
    sx = 160, 288, 368, 464, 528, 584, 704, 728, 864, 880, 944
    sy = 96, 96, 56, 88, 80, 56, 80, 64, 56, 96, 96
    wlo = 0, 272, 0, 448, 480, 0, 688, 0, 0, 816, 928
    whi = 224, 432, 0, 464, 544, 0, 704, 0, 0, 896, 1008
    ckx = 416, 592, 832
    cky = 88, 88, 88
    cix = 0, 7, 9, 17, 23, 31, 39, 45, 50
    rcf = 0, 13, 24, 38
    rnx = 0, 2, 4, 7
    ce = 50
    se = 11
  ENDTABLE
  TABLE lv2
    cxs = 64, 72, 80, 120, 128, 240, 248, 256, 280, 288, 312, 320, 328, 336, 376, 384, 424, 432, 464, 496, 504, 536, 544, 552, 560, 600, 608, 616, 624, 640, 648, 696, 704, 744, 752, 776, 784, 792, 824, 832, 904, 912, 920, 928, 944, 952
    cys = 104, 104, 104, 88, 88, 96, 88, 96, 96, 96, 96, 88, 88, 96, 64, 64, 64, 64, 88, 88, 88, 96, 88, 88, 96, 88, 80, 80, 88, 96, 96, 88, 88, 80, 80, 88, 80, 88, 80, 80, 88, 80, 80, 88, 104, 104
    sx = 144, 224, 288, 360, 400, 520, 592, 632, 800, 864
    sy = 96, 64, 96, 56, 80, 96, 64, 96, 56, 96
    wlo = 0, 0, 264, 0, 384, 480, 0, 624, 0, 800
    whi = 224, 0, 336, 0, 432, 520, 0, 664, 0, 896
    ckx = 304, 584, 824
    cky = 88, 88, 88
    cix = 0, 4, 7, 15, 21, 29, 35, 40, 46
    rcf = 0, 5, 21, 34
    rnx = 0, 1, 5, 8
    ce = 46
    se = 10
  ENDTABLE
  TABLE lv3
    cxs = 48, 56, 64, 80, 88, 104, 112, 192, 200, 216, 224, 232, 248, 256, 272, 280, 288, 304, 312, 408, 416, 424, 432, 520, 528, 560, 640, 648, 664, 672, 680, 712, 720, 728, 744, 752, 840, 848, 864, 872, 920, 928, 944, 952
    cys = 104, 104, 104, 88, 88, 88, 88, 96, 96, 88, 80, 88, 88, 88, 80, 80, 80, 88, 88, 96, 88, 88, 96, 96, 96, 88, 88, 88, 88, 80, 80, 80, 80, 88, 88, 88, 104, 104, 88, 88, 80, 80, 104, 104
    sx = 64, 224, 392, 480, 552, 640, 672, 832, 880, 952
    sy = 96, 56, 96, 56, 80, 80, 64, 96, 64, 96
    wlo = 0, 0, 368, 0, 544, 632, 0, 816, 0, 936
    whi = 144, 0, 496, 0, 560, 648, 0, 904, 0, 1008
    ckx = 384, 528, 832
    cky = 88, 80, 88
    cix = 0, 7, 13, 19, 23, 26, 36, 40, 44
    rcf = 0, 18, 23, 36
    rnx = 0, 2, 3, 7
    ce = 44
    se = 10
  ENDTABLE
  TABLE lv4
    cxs = 48, 56, 64, 88, 96, 104, 112, 144, 152, 160, 184, 192, 216, 256, 264, 296, 304, 312, 344, 352, 368, 392, 400, 464, 472, 512, 520, 568, 576, 624, 632, 648, 656, 664, 680, 688, 712, 720, 736, 744, 776, 784, 848, 856, 880, 888, 944, 952, 960, 968
    cys = 104, 104, 104, 96, 88, 88, 96, 96, 88, 96, 104, 104, 88, 80, 80, 96, 88, 96, 88, 88, 96, 88, 88, 80, 80, 96, 96, 88, 88, 96, 96, 88, 80, 88, 88, 88, 80, 88, 88, 88, 104, 104, 88, 88, 80, 80, 80, 80, 104, 104
    sx = 120, 224, 328, 376, 392, 528, 544, 680, 784, 832, 904
    sy = 96, 64, 96, 64, 80, 72, 80, 56, 96, 72, 96
    wlo = 0, 0, 320, 0, 384, 0, 528, 0, 776, 0, 896
    whi = 128, 0, 328, 0, 400, 0, 544, 0, 864, 0, 928
    ckx = 328, 512, 832
    cky = 88, 80, 88
    cix = 0, 7, 13, 21, 25, 31, 40, 46, 50
    rcf = 0, 13, 23, 40
    rnx = 0, 1, 4, 8
    ce = 50
    se = 11
  ENDTABLE
  REM coins per level 50 46 44 50; enemies per level 11 10 10 11
  REM @@DATA-END@@

  REM A black row of the screen's cell map under the text (PAPER 0, bright white): the rows the HUD and the title text go on.
  PROC BAR(r):
    INK 7 : PAPER 0 : BRIGHT 1
    FILLC 0, r, 32, 1 = 32
  ENDP

  REM Level lv's world (WORLD puts the camera at 0 and redraws the whole window, so this is one long tick, over its three refreshes).
  PROC LOADWORLD():
    WORLD lv OF level, level2, level3, level4
  ENDP

  REM Level lv's data (LOADTABLE lv: the coin, enemy, checkpoint and respawn lists and the counts CE / SE), nothing taken or killed.
  PROC LOADDATA():
    LOCAL i
    LOADTABLE lv
    cf = 0
    FOR i = 0 TO ce - 1
      cc(i) = 0
    NEXT i
    FOR i = 0 TO se - 1
      sd(i) = 0
    NEXT i
  ENDP

  REM ---------------------------------------------------------------------------------------------------------------- coins
  REM The coins spin as TILES: the pickup tile of each coin in view is swapped through its four spin frames (ct) with SETWORLD, one coin in eight a
  REM tick (coin k when k - CF is the tick's number mod 8; a turn takes 32 ticks), so one or two SETWORLDs a tick (at most 14 coins are ever in view, and the two tries a tick reach 16) and no sprite at all.  (The first version drew
  REM six 8 x 8 sprites over the still tiles: 2,400 T each in the runtime's blitter, 14,000 T on a tick with six coins in view.)  The list is
  REM sorted by x: CF is the first coin not left of the camera.  A taken coin (cc) is left alone.
  PROC SPINCOINS():
    LOCAL k
    WHILE cf < ce AND cxs(cf) + 8 <= cam
      cf = cf + 1
    WEND
    k = cf + BAND(fc, 7)
    CALL SPIN(k)
    CALL SPIN(k + 8)
  ENDP

  REM Coin k, when the list has it, it is not taken and it is in view, gets the spin frame of this tick.
  PROC SPIN(k):
    LOCAL x
    IF k < ce THEN
      x = cxs(k)
      IF cc(k) = 0 AND x < cam + 192 THEN SETWORLD x, cys(k) = ct(BAND(SHR(fc, 3), 3)) ENDIF
    ENDIF
  ENDP

REM ================================================================================================================ the title (no window)
SCENE title NOWINDOW
  REM TT counts the ticks.  The hero (HX, HY) runs 1.5 pixels a tick and hops every 40 ticks; the four pairs of coins (TCC: their cells' columns, row 14) are under the hops, he eats them (NC: the next
  REM coin he may take; the coins he has not reached spin by TILE swaps, one a tick).  A walker follows him 56 pixels behind, a bat flies the other way along its sine.  PF: fire was down in the last tick.
  DIM tt, hx, hy, nc, pf, fr
  DIM tcc(7) = 2, 3, 9, 10, 17, 18, 25, 26

  REM The reset has put the title picture (the first MAP) on the screen: INIT adds the text on two black bars over the ground, and a fire still down from the game that sent us here must be let go first.
  PROC INIT():
    PLAY hop
    CALL BAR(21)
    CALL BAR(22)
    INK 6 : PRINT AT 21, 13; "HI "; hi;
    INK 7 : PRINT AT 22, 6; "PRESS SPACE OR FIRE";
    pf = 1
  ENDP

  PROC FRAME():
    tt = tt + 1
    fr = KEYDOWN(" ") OR BIT(STICK(1), 4)
    IF fr AND (NOT pf) THEN ENTER play ENDIF
    pf = fr
    IF tt > 170 THEN ENTER demo ENDIF
    CALL ACTORS()
    CALL COINS()
  ENDP

  REM The sprites at screen positions: the scene has no window, so SHOW takes the screen's own pixels.
  PROC ACTORS():
    LOCAL p, x, f
    hx = 4 + SHR(tt * 3, 1)
    p = tt MOD 40
    hy = 128
    f = 1 + BAND(SHR(tt, 1), 3)
    IF p < 16 THEN
      hy = 128 - (p * (16 - p)) DIV 3
      f = 5 + (p > 8)
    ENDIF
    IF hx > 240 THEN
      HIDE hero
    ELSE
      SHOW hero AT hx, hy FRAME f
    ENDIF
    x = hx - 56
    IF x >= 0 AND x <= 240 THEN
      SHOW wk(0) AT x, 136 FRAME BAND(SHR(tt, 2), 1)
    ELSE
      HIDE wk(0)
    ENDIF
    x = 250 - 2 * tt
    IF x >= 0 AND x <= 240 THEN
      SHOW fl(0) AT x, 104 + sn(BAND(SHR(tt, 1), 15)) FRAME BAND(SHR(tt, 1), 1)
    ELSE
      HIDE fl(0)
    ENDIF
  ENDP

  REM The hero takes the next coin when his box reaches it in the air (the coin goes, a sound plays); a coin he has passed is left as it is; the others turn.
  PROC COINS():
    LOCAL k, c
    IF nc < 8 THEN
      c = tcc(nc) * 8
      IF hx + 3 >= c + 8 THEN
        nc = nc + 1
      ELSE
        IF hx + 13 > c AND hy < 118 THEN
          TILE tcc(nc), 14 = 0
          nc = nc + 1
          PLAY coin
        ENDIF
      ENDIF
    ENDIF
    k = BAND(tt, 7)
    IF k >= nc THEN TILE tcc(k), 14 = ct(BAND(SHR(tt, 3), 3)) ENDIF
  ENDP
ENDSCENE

REM ================================================================================================================ the demo (the window, level 1 scrolling by itself)
SCENE demo
  REM TT counts the ticks (170 of them, 8.5 seconds, then the title again); TI counts the stages of the text (8 = done).  PF: fire was down in the last tick.
  DIM tt, ti, pf, fr

  REM The reset has put the title picture on the screen and the window is on: blank the cells (the window is not drawn from them), a fresh level 1.
  PROC INIT():
    CLS
    lv = 0
    CALL LOADWORLD()
    CALL LOADDATA()
    pf = 1
  ENDP

  REM Level 1 scrolls by itself (the camera goes along the world 3 pixels a tick), its coins spin; fire starts the game.  Everything that costs
  REM much (clearing and printing the text cells) is done a piece a tick (TSTAGE), so that no tick goes over its three refreshes (loading a world is the exception).
  PROC FRAME():
    LOCAL p
    fr = KEYDOWN(" ") OR BIT(STICK(1), 4)
    IF fr AND (NOT pf) THEN ENTER play ENDIF
    pf = fr
    tt = tt + 1
    fc = fc + 1
    IF fc > 30000 THEN fc = 0 ENDIF
    IF tt > 170 THEN ENTER title ENDIF
    p = (tt * 3) MOD 1664
    IF p > 832 THEN p = 1664 - p ENDIF
    CAMERA p
    cam = CAMX()
    CALL SPINCOINS()
    IF ti < 8 THEN
      CALL TSTAGE(ti)
      ti = ti + 1
    ENDIF
  ENDP

  REM Stages 0..7 redraw the title text (a row of cells is 32 cells to redraw, about 30,000 T in both files: one row a tick); stage 7 is the high score under the title.
  PROC TSTAGE(s):
    SELECT CASE s
      CASE 0
        CALL BAR(1)
      CASE 1
        CALL BAR(2)
      CASE 2
        CALL BAR(21)
      CASE 3
        CALL BAR(22)
      CASE 4
        INK 6 : PRINT AT 1, 10; "LEAP RUNNER";
      CASE 5
        INK 7 : PRINT AT 21, 6; "PRESS SPACE OR FIRE";
      CASE 6
        PRINT AT 22, 4; "O P MOVE   Q OR SPACE JUMP";
      CASE ELSE
        INK 5 : PRINT AT 2, 12; "HI "; hi;
    ENDSEL
  ENDP
ENDSCENE

REM ================================================================================================================ the game
SCENE play
  REM st: 0 starting (the HUD and level 1 are put up a stage a tick), 1 playing, 2 game won, 3 game over, 4 level complete (the next world is loaded when its message has been up a while)
  DIM st, tt, js, lf, rg, up, dn, fire, jmp, pj, pfire
  DIM px, py, x8, vx, vy, face, gnd, cg, anim, fr, inv, dropt, fx, tc, ltc, kq, ka, pk
  DIM lives, score, coins, hud, ck, rx, ry, ti, ei
  REM pause (1 = paused, playing state only)
  DIM paused
  DIM nx, cnx
  REM nl: the level the flag leads to (the level change's message and world); the level lv, its data and the high score HI are the game's
  DIM nl
  REM six enemy slots: 0..3 walkers (sprites wk), 4..5 bats (sprites fl): alive, position, direction, spawn entry, origin x
  DIM en(5), ex(5), ey(5), ed(5), ek(5), e0(5)

  REM The reset has put the title picture on the screen and the window is on: blank the cells (the rows around the window are the HUD's, built by the starting stages) and load a fresh level 1,
  REM so that every game starts on level 1 as it was made, whatever the last game left in the world.
  PROC INIT():
    NOMUSIC
    CLS
    lv = 0
    CALL LOADWORLD()
  ENDP

  REM ---------------------------------------------------------------------------------------------------------------- states
  REM H toggles the pause while playing (state 1; KEYPRESS: one press is one toggle).  A paused tick does nothing else: the logic, the timers, the input reads and the
  REM edge flags (pj, pfire) stand still, so the game goes on exactly where it was; the toggling tick itself runs no logic either.
  PROC FRAME():
    IF KEYPRESS("H") AND st = 1 THEN
      CALL PAUSETOGGLE()
    ELSE
      IF paused = 0 THEN CALL GAMETICK() ENDIF
    ENDIF
  ENDP

  REM Pausing silences the sound once and puts PAUSED in the HUD's message row (6 cells, a piece of a row: not the 32 a whole row costs); going on clears those cells.
  PROC PAUSETOGGLE():
    INK 7 : PAPER 0 : BRIGHT 1
    IF paused = 0 THEN
      paused = 1
      SILENCE
      PRINT AT 21, 13; "PAUSED";
    ELSE
      paused = 0
      PRINT AT 21, 13; "      ";
    ENDIF
  ENDP

  PROC GAMETICK():
    js = STICK(1)
    lf = KEYDOWN("O") OR BIT(js, 2)
    rg = KEYDOWN("P") OR BIT(js, 3)
    REM Q and A are read every other tick (a KEYDOWN is 250 T and a few hundred more to call): the jump key is read through SPACE and the stick every tick
    IF BIT(fc, 0) THEN
      kq = KEYDOWN("Q") : ka = KEYDOWN("A")
    ENDIF
    up = kq OR BIT(js, 0)
    dn = ka OR BIT(js, 1)
    fire = KEYDOWN(" ") OR BIT(js, 4)
    jmp = fire OR up
    tt = tt + 1
    fc = fc + 1
    IF fc > 30000 THEN fc = 0 ENDIF
    SELECT CASE st
      CASE 0
        CALL STARTTICK()
      CASE 1
        CALL PLAYTICK()
      CASE 4
        CALL LEVELTICK()
      CASE ELSE
        CALL ENDTICK()
    ENDSEL
    pj = jmp
    pfire = fire
  ENDP

  REM Starting a game (state 0): TI counts the stages of GSTAGE, the last of which starts the level.
  PROC STARTTICK():
    CALL GSTAGE(ti)
    ti = ti + 1
  ENDP

  REM Starting a game takes seven ticks (the tick that ENTERs the scene is the eighth): 0 the variables, 1 and 2 black bars for the HUD's rows and the end text's, 3 and 4 the HUD's labels (and the controls on row 22),
  REM 5 level 1's data (INIT loaded its world), 6 its HUD and the first respawn.
  PROC GSTAGE(s):
    SELECT CASE s
      CASE 0
        score = 0 : lives = 3 : hud = 0 : lv = 0
      CASE 1
        CALL BAR(1)
        CALL BAR(2)
      CASE 2
        CALL BAR(21)
        CALL BAR(22)
      CASE 3
        PRINT AT 1, 2; "SCORE";
        PRINT AT 1, 16; "LIVES";
      CASE 4
        PRINT AT 2, 2; "COINS";
        PRINT AT 22, 4; "O P MOVE   Q OR SPACE JUMP";
      CASE 5
        CALL LEVELDATA()
      CASE ELSE
        CALL BEGINLEVEL()
    ENDSEL
  ENDP

  REM Level lv: its world (WORLD puts the camera at 0 and redraws the whole window, so this is one long tick, over its three refreshes) and its data.
  PROC LOADLEVEL():
    HIDE hero
    CALL LOADWORLD()
    CALL LEVELDATA()
  ENDP

  REM The level's data (LOADDATA: the coin, enemy, checkpoint and respawn lists and the counts CE / SE, nothing taken or killed), the player's start and the first checkpoint to pass.
  PROC LEVELDATA():
    HIDE hero
    CALL LOADDATA()
    ck = 0 : rx = 24 : ry = 88 : cnx = ckx(0)
    coins = 0 : inv = 0 : dropt = 0 : pj = 1 : pk = 0
  ENDP

  REM The HUD of the level just loaded (its coin total and number are printed here, the other labels once per game), and the player starts.
  PROC BEGINLEVEL():
    INK 7 : PAPER 0 : BRIGHT 1
    PRINT AT 2, 10; "/"; ce;
    PRINT AT 2, 16; "LEVEL "; lv + 1;
    hud = 7
    CALL FLUSHHUD()
    st = 1 : tt = 0 : fc = 0
    CALL RESPAWN()
  ENDP

  REM Put the player at the checkpoint, the camera on him, the enemies and coins back to where the camera is.
  PROC RESPAWN():
    px = rx : py = ry : x8 = px * 8 : vx = 0 : vy = 0 : face = 1 : gnd = 1 : cg = 3
    cam = px - LZ
    CAMERA cam
    cam = CAMX()
    CALL CLEARENEMIES()
    nx = rnx(ck) : cf = rcf(ck)
  ENDP

  PROC PLAYTICK():
    REM a coin the box touched when the last tick asked (the search and the SETWORLD are done one tick later, away from the query's tick)
    IF pk THEN
      pk = 0
      CALL PICKUP()
    ENDIF
    CALL PLAYER()
    IF st = 1 THEN
      CALL FOLLOW()
      CALL DRAWPLAYER()
      CALL ENEMIES()
      CALL SPINCOINS()
      IF inv > 0 THEN
        inv = inv - 1
        IF inv <= 30 AND BIT(inv, 1) THEN HIDE hero ENDIF
      ENDIF
      IF hud <> 0 AND BAND(fc, 3) = 3 THEN CALL SHOWHUD() ENDIF
    ENDIF
  ENDP

  REM What the end of a game and the end of a level share, a piece a tick (EI): the hero cheers (when C is true), the coins go on turning, then 0 the HUD, 1 and 2 the two text rows cleared (BAR).
  PROC ENDROWS(c):
    IF c THEN
      SHOW hero AT px, py FRAME 5 + BAND(SHR(tt, 2), 1)
    ENDIF
    CALL SPINCOINS()
    SELECT CASE ei
      CASE 0
        CALL FLUSHHUD()
      CASE 1
        CALL BAR(21)
      CASE 2
        CALL BAR(22)
    ENDSEL
  ENDP

  REM Game won (2) and game over (3): the world stays up; the end text is put up a piece a tick (EI); fire (after half a second) goes back to the title (the high score is set).
  PROC ENDTICK():
    CALL ENDROWS(st = 2)
    SELECT CASE ei
      CASE 3
        IF st = 2 THEN
          INK 6 : PRINT AT 21, 3; "YOU FINISHED LEAP RUNNER!";
        ELSE
          INK 2 : PRINT AT 21, 11; "GAME OVER";
        ENDIF
      CASE 4
        INK 7
        PRINT AT 22, 7; "PRESS FIRE FOR TITLE";
    ENDSEL
    IF ei < 5 THEN ei = ei + 1 ENDIF
    IF tt > 10 AND ei > 4 AND fire AND (NOT pfire) THEN
      ENTER title
    ENDIF
  ENDP

  REM Level complete (4): the message "LEVEL n" for the level to come (NL: the next one after a flag, the same after game over), then its world is loaded and
  REM played.  EI counts the ticks: 0 the HUD, 1 and 2 clear the end rows, 3 the message, 36 loads the world (one long tick), 37 clears the message, 38 starts.
  PROC LEVELTICK():
    CALL ENDROWS(nl > lv)
    SELECT CASE ei
      CASE 3
        INK 6 : PRINT AT 21, 12; "LEVEL "; nl + 1;
      CASE 36
        lv = nl
        CALL LOADLEVEL()
      CASE 37
        CALL BAR(21)
      CASE 38
        CALL BEGINLEVEL()
    ENDSEL
    ei = ei + 1
  ENDP

  REM ---------------------------------------------------------------------------------------------------------------- the player
  PROC PLAYER():
    LOCAL d, nx2, ny, r, lx, land
    d = rg - lf
    IF d <> 0 THEN
      vx = vx + d * ACC
      IF vx > VMAX THEN vx = VMAX ENDIF
      IF vx < -VMAX THEN vx = -VMAX ENDIF
      face = d
    ELSE
      REM friction: FRIC nearer to 0, and not past it
      IF ABS(vx) <= FRIC THEN vx = 0 ELSE vx = vx - SGN(vx) * FRIC ENDIF
    ENDIF
    REM horizontal: move, then if the box is inside a solid tile put its edge on the tile's face
    x8 = x8 + vx
    nx2 = SHR(x8, 3)
    IF nx2 <> px THEN
      IF SOLID(nx2 + BX, py + BY, BW, BH) THEN
        REM (BAND(x, -8) is the left edge of the tile x is in)
        IF vx > 0 THEN
          nx2 = BAND(nx2 + BX + BW - 1, -8) - BW - BX
        ELSE
          nx2 = BAND(nx2 + BX, -8) + 8 - BX
        ENDIF
        x8 = nx2 * 8 : vx = 0
      ENDIF
      px = nx2
    ENDIF
    REM jump (with a little coyote time), variable height, drop through planks
    IF gnd THEN
      cg = 3
    ELSE
      IF cg > 0 THEN cg = cg - 1 ENDIF
    ENDIF
    IF jmp AND (NOT pj) AND cg > 0 THEN
      vy = VJUMP : cg = 0 : gnd = 0
      PLAY jump
    ENDIF
    IF (NOT jmp) AND vy < -3 THEN vy = -3 ENDIF
    IF dn THEN
      dropt = 5
    ELSE
      IF dropt > 0 THEN dropt = dropt - 1 ENDIF
    ENDIF
    REM vertical.  Standing on the ground and still over the same tiles as last tick (TC: the box's first and last tile column, the first one times 32) nothing can have changed:
    REM no query.  Otherwise: gravity, then land on a solid tile, on a plank the feet cross, or bump the head.  LX is the box's left edge; LAND: the box is in a solid tile, or the feet are on a plank.
    lx = px + BX
    tc = BAND(lx, -8) * 4 + SHR(lx + BW - 1, 3)
    IF gnd AND tc = ltc AND dropt = 0 THEN
      vy = 0
    ELSE
      vy = vy + GRAV
      IF vy > VFALL THEN vy = VFALL ENDIF
      ny = py + vy
      gnd = 0
      IF vy <> 0 THEN land = SOLID(lx, ny + BY, BW, BH) ENDIF
      IF vy > 0 THEN
        REM falling: R is the top of the tile row the feet are in; a plank (flag 8) holds them only when they have just crossed into its row
        r = BAND(ny + BY + BH - 1, -8)
        IF land = 0 AND dropt = 0 AND r > BAND(py + BY + BH - 1, -8) THEN land = TILEHIT(lx, r, BW, 1, 8) ENDIF
        IF land THEN ny = r - BY - BH : vy = 0 : gnd = 1 ENDIF
      ELSE
        IF land THEN ny = BAND(ny + BY, -8) + 8 - BY : vy = 0 ENDIF
      ENDIF
      py = ny
    ENDIF
    ltc = tc
    REM what the box touches: hazard (2), pickup (4), goal (16); asked every fourth tick (a query is 1,300 T; any box overlaps a coin, a spike or the flag for at least 4 ticks)
    fx = 0
    IF BAND(fc, 3) = 0 THEN fx = TILEHIT(lx, py + BY, BW, BH, 22) ENDIF
    IF fx <> 0 THEN
      IF BIT(fx, 4) THEN
        CALL WIN()
      ELSE
        IF BIT(fx, 2) THEN pk = 1 ENDIF
        IF BIT(fx, 1) THEN CALL HURT(1) ENDIF
      ENDIF
    ENDIF
    IF st = 1 AND py > DEADY THEN CALL HURT(1) ENDIF
    IF st = 1 THEN
      IF px >= cnx THEN
        REM (CNX is ckx(ck) here)
        rx = cnx : ry = cky(ck) : ck = ck + 1
        cnx = 32000
        IF ck < 3 THEN cnx = ckx(ck) ENDIF
      ENDIF
    ENDIF
  ENDP

  REM Take the coins the box overlaps (the coins list is sorted by x; CIX(b) is the first coin not left of x = 128 b, so the search starts near the player; the pickup tile goes with SETWORLD).
  PROC PICKUP():
    LOCAL k, x, y, lx, rx, ty, bt
    lx = px + BX : rx = lx + BW : ty = py + BY : bt = ty + BH
    k = cix(SHR(px, 7))
    WHILE k < ce
      x = cxs(k)
      IF x >= rx THEN EXIT WHILE ENDIF
      IF x + 8 > lx THEN
        y = cys(k)
        IF y < bt AND y + 8 > ty AND cc(k) = 0 THEN
          cc(k) = 1
          SETWORLD x, y = 0
          coins = coins + 1 : score = score + 10 : hud = BOR(hud, 5)
          PLAY coin
        ENDIF
      ENDIF
      k = k + 1
    WEND
  ENDP

  PROC DRAWPLAYER():
    IF inv > 30 THEN
      fr = 7
    ELSE
      IF gnd = 0 THEN
        IF vy < 0 THEN fr = 5 ELSE fr = 6 ENDIF
      ELSE
        IF ABS(vx) < 2 THEN
          fr = 0
        ELSE
          anim = anim + ABS(vx)
          IF anim > 20000 THEN anim = 0 ENDIF
          fr = 1 + BAND(SHR(anim, 6), 3)
        ENDIF
      ENDIF
    ENDIF
    IF face > 0 THEN
      SHOW hero AT px, py FRAME fr
    ELSE
      SHOW hero AT px, py FRAME fr FLIP
    ENDIF
  ENDP

  REM The camera follows with a dead zone (LZ..RZ pixels from the window's left edge); CAMERA clamps to the world.
  PROC FOLLOW():
    cam = CAMX()
    IF px - cam < LZ THEN cam = px - LZ ENDIF
    IF px + 16 - cam > RZ THEN cam = px + 16 - RZ ENDIF
    CAMERA cam
    cam = CAMX()
  ENDP

  REM ---------------------------------------------------------------------------------------------------------------- life and death
  REM A life is lost.  R = 0: an enemy's touch (thrown back, 40 ticks of invulnerability); R = 1: a hazard or the pit (back to the last checkpoint).
  PROC HURT(r):
    lives = lives - 1 : hud = BOR(hud, 2)
    IF lives <= 0 THEN
      CALL GAMEOVER()
    ELSE
      PLAY hurt
      IF r THEN
        inv = 30
        CALL RESPAWN()
      ELSE
        inv = 40 : vy = -5 : vx = 0 - face * 16 : gnd = 0
      ENDIF
    ENDIF
  ENDP

  PROC GAMEOVER():
    st = 3 : tt = 0 : ei = 0
    HIDE hero
    CALL CLEARENEMIES()
    CALL SETHI()
    PLAY over
  ENDP

  REM The game has ended (won or over): the score is the high score when it is higher.
  PROC SETHI():
    IF score > hi THEN hi = score ENDIF
  ENDP

  REM The flag: after levels 1 to 3 the next level's message (NL), after the fourth the win screen.
  PROC WIN():
    tt = 0 : ei = 0 : score = score + 500 : hud = BOR(hud, 1) : vx = 0 : vy = 0
    IF lv < 3 THEN
      st = 4 : nl = lv + 1
    ELSE
      st = 2
      CALL SETHI()
    ENDIF
    CALL CLEARENEMIES()
    PLAY win
  ENDP

  PROC CLEARENEMIES():
    LOCAL i
    FOR i = 0 TO 5
      CALL KILL(i)
    NEXT i
  ENDP

  REM Enemy slot i is free again and its sprite hidden (slots 0..3 are the walkers wk, 4..5 the bats fl: a HIDE with an index outside its pool does nothing).
  PROC KILL(i):
    en(i) = 0
    HIDE wk(i) : HIDE fl(i - 4)
  ENDP

  PROC FLUSHHUD():
    WHILE hud <> 0
      CALL SHOWHUD()
    WEND
  ENDP

  REM Prints ONE changed number a call (hud: bit 0 score, 1 lives, 2 coins; the labels are printed once, when a game starts): a number is 1,000 to 2,500 T
  REM to print and the cells it dirties are redrawn by the runtime in the next tick.  While playing it is called on every fourth tick (fc MOD 4 = 3), after
  REM the tick that asks for a coin and the one that takes it.
  PROC SHOWHUD():
    INK 6 : PAPER 0 : BRIGHT 1
    IF BIT(hud, 0) THEN
      PRINT AT 1, 8; score;
      hud = BAND(hud, 6)
    ELSE
      IF BIT(hud, 1) THEN
        PRINT AT 1, 22; lives;
        hud = BAND(hud, 5)
      ELSE
        PRINT AT 2, 8; coins;
        hud = BAND(hud, 3)
      ENDIF
    ENDIF
  ENDP

  REM ---------------------------------------------------------------------------------------------------------------- enemies
  PROC ENEMIES():
    LOCAL i
    CALL SPAWNER()
    IF BAND(fc, 1) = 0 THEN
      FOR i = 0 TO 3
        IF en(i) THEN CALL WALKER(i) ENDIF
      NEXT i
    ELSE
      FOR i = 4 TO 5
        IF en(i) THEN CALL BAT(i) ENDIF
      NEXT i
    ENDIF
  ENDP

  REM At most one new enemy a tick: the next entry of the sorted list when it comes within 216 pixels of the camera
  REM (a walker needs a free walker slot, a bat a free bat slot; killed or passed entries are skipped).
  PROC SPAWNER():
    LOCAL k, lo, hb, d, x
    IF nx < se THEN
      x = sx(nx)
      IF x < cam + 216 THEN
        IF sd(nx) = 0 AND x > cam - 48 THEN
          REM a walker takes one of the slots 0..3 (LO is 0: a LOCAL starts at 0) and sets off to the left; a bat is an entry with no turning points (WHI = 0): slots 4..5, to the right
          hb = 3 : d = -1
          IF whi(nx) = 0 THEN lo = 4 : hb = 5 : d = 1 ENDIF
          FOR k = lo TO hb
            IF en(k) = 0 THEN
              en(k) = 1 : ex(k) = x : ey(k) = sy(nx) : ek(k) = nx : e0(k) = x : ed(k) = d
              nx = nx + 1
              EXIT FOR
            ENDIF
          NEXT k
        ELSE
          nx = nx + 1
        ENDIF
      ENDIF
    ENDIF
  ENDP

  REM A walker patrols its ground 4 pixels every other tick (walkers on the even ticks, bats on the odd ones, which halves their cost per tick) between the two turning points of its spawn entry (WLO / WHI: where a wall or the edge of its
  REM ground is, worked out from the map by the generator and checked by the tests; no run-time query).
  PROC WALKER(i):
    LOCAL f, x, y, d, k, t
    d = ed(i) : k = ek(i)
    x = ex(i) + d * 4
    IF x < cam - 48 THEN
      CALL KILL(i)
    ELSE
      t = wlo(k)
      IF x <= t THEN
        x = t : d = 1
      ELSE
        t = whi(k)
        IF x >= t THEN x = t : d = -1 ENDIF
      ENDIF
      ed(i) = d : ex(i) = x
      f = BAND(SHR(x, 3), 1)
      y = ey(i)
      IF d > 0 THEN
        SHOW wk(i) AT x, y FRAME f
      ELSE
        SHOW wk(i) AT x, y FRAME f FLIP
      ENDIF
      REM (HIT only when the boxes can overlap, and when the touch can matter: falling onto it, or not blinking: HIT is 2,400 T)
      y = y - py
      IF ABS(x - px) < 13 AND y > -15 AND y < 21 AND (inv = 0 OR vy > 0) THEN
        IF HIT(hero, wk(i)) THEN CALL TOUCH(i) ENDIF
      ENDIF
    ENDIF
  ENDP

  REM A bat flies to and fro 56 pixels either side of where it appeared and bobs on the sine table.
  PROC BAT(i):
    LOCAL f, x, y, d
    d = ed(i)
    x = ex(i) + d * 4
    IF x < cam - 80 THEN
      CALL KILL(i)
    ELSE
      IF ABS(x - e0(i)) > 56 THEN ed(i) = 0 - d ENDIF
      ex(i) = x
      f = SHR(fc, 1)
      y = sy(ek(i)) + sn(BAND(f + i * 5, 15))
      ey(i) = y
      f = BAND(f, 1)
      SHOW fl(i - 4) AT x, y FRAME f
      y = y - py
      IF ABS(x - px) < 12 AND y > -12 AND y < 22 AND (inv = 0 OR vy > 0) THEN
        IF HIT(hero, fl(i - 4)) THEN CALL TOUCH(i) ENDIF
      ENDIF
    ENDIF
  ENDP

  REM The player met enemy slot i: falling onto it from above stomps it, anything else hurts.
  PROC TOUCH(i):
    IF vy > 0 AND py <= ey(i) - 12 THEN
      sd(ek(i)) = 1
      CALL KILL(i)
      vy = -6 : gnd = 0 : score = score + 100 : hud = BOR(hud, 1)
      PLAY stomp
    ELSE
      IF inv = 0 THEN CALL HURT(0) ENDIF
    ENDIF
  ENDP
ENDSCENE
