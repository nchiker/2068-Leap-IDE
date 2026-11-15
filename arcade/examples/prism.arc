REM Prism Catch: the showcase game of fine colour (SCLD mode 2, 8 x 1 colour; docs/ARCADE_FINE_COLOUR_CONTRACT.md section 10) for the v2 runtime.
REM Gems of four colours fall from a sunset sky; your catcher takes one of the four colours: catch a gem of YOUR colour to score, a gem of another colour or a gem you miss
REM costs one of three lives.  Each wave the gems fall faster and more of them are in the air; from wave 3 a gem CHANGES colour as it crosses the glow band of the sky.
REM   Keyboard: O P move; 1 2 3 4 pick the colour, Q and A step through the colours, SPACE steps on.   Joystick 1: left / right and fire (the colour steps on).
REM   Fire starts the game and restarts it after GAME OVER.
REM The play scene is fine colour: the assets file's "scenes" key sets scenes.play.display = "fine" (prism.assets.gen.mjs).  The title and the game over scene are the
REM two-buffer 8 x 8 setup (the same sky tiles, one colour per cell, so you see what 8 x 1 colour adds).  No new words: fine colour is a project setting, the source is ordinary.
REM The sky is a tile a character row (tile r = cell row r); each tile's eight pixel rows have their own paper and BRIGHT.  A sprite's colour in a fine scene is its rows' INK only,
REM so the colours of the gems and the catcher are separate assets (gem0..3, cat0..3: green, cyan, yellow, white), shaded by their row inks.
REM Sprites: 4 catchers + 4 colours x 3 gem slots = 16 instances (the most the v2 runtime has); 4 x 4 + 4 x 1 = 20 sprite phases (a fine game may have 32).
REM   Compile:  node arcade/tools/arcadec.mjs arcade/examples/prism.arc --assets arcade/examples/prism.assets.json --runtime v2
GAME "Prism Catch"
FRAMERATE 20

REM ---- the number of gems that may be in the air at once.  EACH GEM IS A MOVING 16 x 16 SPRITE (about 25,000 T a tick in a fine scene), and a 20 Hz tick is 176,064 T,
REM ---- so this is what the speed allows: 5 holds 20 Hz (6 does not; the measured ticks are in prism.md).  The owner may change it: 1 to 12 (3 slots a colour, 4 colours); more gems = slower ticks.
CONST MAXGEMS = 5

REM the tile numbers of prism.assets.gen.mjs (its --check compares): tile r is the sky of cell row r; stars, the heart, the bursts (6 a kind: 4 gem colours, wrong, splash; 2 a frame)
CONST TSTAR = 24
CONST THEART = 36
CONST TBURST = 40
CONST CY = 168                      REM the catcher's y (cell row 21)
CONST MISSY = 176                   REM a gem whose top reaches this has fallen past the catcher
CONST GLOWY = 64                    REM a gem's top reaching this has entered the glow band (pixel rows 64..79)

SPRITE cat0 = "cat0"
SPRITE cat1 = "cat1"
SPRITE cat2 = "cat2"
SPRITE cat3 = "cat3"
SPRITE gem0(3) = "gem0"
SPRITE gem1(3) = "gem1"
SPRITE gem2(3) = "gem2"
SPRITE gem3(3) = "gem3"
TILESET prism = "prism"
MAP sky = "sky"
SFX chime = "chime"
SFX buzz = "buzz"
SFX splash = "splash"
SFX pick = "pick"
SFX ping = "ping"
SFX over = "over"
MUSIC twilight = "twilight"
MUSIC tide = "tide"
MUSIC jingle = "jingle"

REM The score, the best score and the wave belong to the whole game: the game over scene shows them.  The paper and BRIGHT of each cell row of the sky (what the sky
REM tiles' first pixel rows are: the colours the two-buffer scenes' text takes so that it sits on the sky).
DIM score, best, wv
DIM skyp(23) = 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 1, 1, 1, 1
DIM skyb(23) = 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0

REM Text on the sky of row r in ink k (the cells of the two-buffer scenes have one paper a cell).
PROC SAY(r, k):
  INK k : PAPER skyp(r) : BRIGHT skyb(r)
ENDP

SCENE title
  DIM ow
  PROC INIT():
    PLAY twilight
    CALL SAY(3, 6) : PRINT AT 3, 10; "PRISM CATCH";
    CALL SAY(5, 7) : PRINT AT 5, 4; "GEMS FALL FROM THE SUNSET";
    CALL GEMDECK(0, 5) : CALL GEMDECK(1, 10) : CALL GEMDECK(2, 15) : CALL GEMDECK(3, 20)
    CALL SAY(12, 7) : PRINT AT 12, 3; "CATCH THE COLOUR YOU HOLD";
    CALL SAY(14, 6) : PRINT AT 14, 3; "WRONG COLOUR OR A MISS = LOSE";
    CALL SAY(15, 6) : PRINT AT 15, 3; "A LIFE.  3 LIVES.";
    CALL SAY(17, 7) : PRINT AT 17, 2; "O P MOVE   1 2 3 4 PICK COLOUR";
    CALL SAY(18, 7) : PRINT AT 18, 2; "Q A OR SPACE STEP THE COLOUR";
    CALL SAY(19, 7) : PRINT AT 19, 2; "OR JOYSTICK 1: STICK AND FIRE";
    CALL SAY(21, 5) : PRINT AT 21, 12; "BEST "; best; "  ";
  ENDP

  REM A gem of colour c over two cells of cell rows 9 and 10 at column col (cell colour = the gem's colour: in the two-buffer setup a sprite has the colour of its cells).
  PROC GEMDECK(c, col):
    CALL SAY(9, 4 + c)
    FILLC col, 9, 2, 2 = 32
    SELECT CASE c
      CASE 0
        SHOW gem0(0) AT col * 8, 72
      CASE 1
        SHOW gem1(0) AT col * 8, 72
      CASE 2
        SHOW gem2(0) AT col * 8, 72
      CASE ELSE
        SHOW gem3(0) AT col * 8, 72
    ENDSEL
  ENDP

  PROC FRAME():
    ow = ow + 1
    IF ow MOD 24 = 0 THEN
      CALL SAY(21, 6)
      PRINT AT 22, 7; "PRESS FIRE TO PLAY";
    ENDIF
    IF ow MOD 24 = 12 THEN
      CALL SAY(22, 6)
      PRINT AT 22, 7; "                  ";
    ENDIF
    IF KEYDOWN(" ") OR BIT(STICK(1), 4) THEN ENTER play ENDIF
  ENDP
ENDSCENE

SCENE play
  DIM px, cc, js, lf, rg, spd, conc, left, act, sg, wt, bt, hud, streak, mult, lives
  DIM bt2, bcol, bcl, brow, bf
  DIM g, c, k, nc, o, t
  REM the gems: position, colour (0 green, 1 cyan, 2 yellow, 3 white), the slot in its colour's pool, on, has changed colour; occ: which pool slots are used (colour * 3 + slot)
  DIM gx(11), gy(11), gc(11), gk(11), gon(11), gch(11)
  DIM occ(11)

  PROC INIT():
    score = 0 : wv = 0
    px = 120 : cc = 0 : streak = 0 : mult = 1
    lives = 3
    CALL SHOWCAT()
    CALL NEXTWAVE()
  ENDP

  REM Start wave wv + 1: its gems, their speed, how many fall at once, the banner and the jingle.
  PROC NEXTWAVE():
    wv = wv + 1
    left = 6 + wv * 2 : IF left > 30 THEN left = 30 ENDIF
    spd = 3 + wv DIV 3 : IF spd > 7 THEN spd = 7 ENDIF
    conc = 2 + wv * (MAXGEMS - 2) DIV 7 : IF conc > MAXGEMS THEN conc = MAXGEMS ENDIF
    wt = 0 : sg = 12
    bt = 36
    hud = 1
    CALL SAY(14, 6)
    PRINT AT 14, 12; " WAVE "; wv; " ";
    PLAY jingle
  ENDP

  PROC SHOWHUD():
    INK 6 : PAPER 0 : BRIGHT 0
    PRINT AT 0, 1; "SCORE "; score; "  ";
    PRINT AT 0, 13; "WAVE "; wv; " ";
    IF mult > 1 THEN
      INK 5 : PRINT AT 0, 20; "x"; mult; " ";
    ELSE
      PRINT AT 0, 20; "   ";
    ENDIF
    FOR t = 0 TO 2
      IF t < lives THEN TILE 29 + t, 0 = THEART ELSE TILE 29 + t, 0 = 0 ENDIF
    NEXT t
    hud = 0
  ENDP

  PROC FRAME():
    js = STICK(1)
    lf = KEYDOWN("O") OR BIT(js, 2)
    rg = KEYDOWN("P") OR BIT(js, 3)
    CALL READCOLOUR()
    IF lf THEN px = px - 6 ENDIF
    IF rg THEN px = px + 6 ENDIF
    IF px < 0 THEN px = 0 ENDIF
    IF px > 240 THEN px = 240 ENDIF
    CALL SHOWCAT()
    IF bt > 0 THEN
      CALL BANNER()
    ELSE
      CALL SPAWNER()
    ENDIF
    CALL GEMS()
    CALL BURST()
    IF hud = 1 THEN CALL SHOWHUD() ENDIF
  ENDP

  REM The colour keys: 1 2 3 4 pick, Q steps back, A and SPACE (and the joystick's fire) step on.
  PROC READCOLOUR():
    nc = cc
    IF KEYPRESS("1") THEN nc = 0 ENDIF
    IF KEYPRESS("2") THEN nc = 1 ENDIF
    IF KEYPRESS("3") THEN nc = 2 ENDIF
    IF KEYPRESS("4") THEN nc = 3 ENDIF
    IF KEYPRESS("Q") THEN nc = (cc + 3) MOD 4 ENDIF
    IF KEYPRESS("A") OR KEYPRESS(" ") OR BIT(JOYPRESS(1), 4) THEN nc = (cc + 1) MOD 4 ENDIF
    IF nc <> cc THEN
      CALL HIDECAT()
      cc = nc
      PLAY pick
    ENDIF
  ENDP

  PROC SHOWCAT():
    SELECT CASE cc
      CASE 0
        SHOW cat0 AT px, CY
      CASE 1
        SHOW cat1 AT px, CY
      CASE 2
        SHOW cat2 AT px, CY
      CASE ELSE
        SHOW cat3 AT px, CY
    ENDSEL
  ENDP

  PROC HIDECAT():
    SELECT CASE cc
      CASE 0
        HIDE cat0
      CASE 1
        HIDE cat1
      CASE 2
        HIDE cat2
      CASE ELSE
        HIDE cat3
    ENDSEL
  ENDP

  REM The wave banner counts down; when it is gone the wave's music starts and the gems come.
  PROC BANNER():
    bt = bt - 1
    IF bt = 0 THEN
      FILL 11, 14, 10, 1 = 14
      PLAY tide
    ENDIF
  ENDP

  REM Place the next gem when fewer than `conc` are in the air and the gap since the last has passed.
  PROC SPAWNER():
    IF left > 0 THEN
      IF sg > 0 THEN sg = sg - 1 ENDIF
      IF sg = 0 AND act < conc THEN CALL NEWGEM() ENDIF
    ELSE
      IF act = 0 THEN
        wt = wt + 1
        IF wt > 24 THEN
          score = score + 25 * wv : IF score > 30000 THEN score = 30000 ENDIF
          CALL NEXTWAVE()
        ENDIF
      ENDIF
    ENDIF
  ENDP

  REM A free pool slot of colour c: k = 0..2, or -1 when its three are used.
  PROC FREESLOT(cl):
    k = -1
    FOR o = 0 TO 2
      IF occ(cl * 3 + o) = 0 THEN k = o : EXIT FOR ENDIF
    NEXT o
  ENDP

  PROC NEWGEM():
    g = -1
    FOR o = 0 TO MAXGEMS - 1
      IF gon(o) = 0 THEN g = o : EXIT FOR ENDIF
    NEXT o
    IF g >= 0 THEN
      nc = RND(4)
      FOR o = 0 TO 3
        CALL FREESLOT(nc)
        IF k >= 0 THEN EXIT FOR ENDIF
        nc = (nc + 1) MOD 4
      NEXT o
      IF k >= 0 THEN
        gon(g) = 1 : gch(g) = 0 : gc(g) = nc : gk(g) = k
        occ(nc * 3 + k) = 1
        gx(g) = 8 + 8 * RND(29) : gy(g) = 8
        act = act + 1 : left = left - 1 : sg = 10 - wv : IF sg < 4 THEN sg = 4 ENDIF
        CALL PUTGEM(g)
      ENDIF
    ENDIF
  ENDP

  PROC PUTGEM(n):
    SELECT CASE gc(n)
      CASE 0
        SHOW gem0(gk(n)) AT gx(n), gy(n)
      CASE 1
        SHOW gem1(gk(n)) AT gx(n), gy(n)
      CASE 2
        SHOW gem2(gk(n)) AT gx(n), gy(n)
      CASE ELSE
        SHOW gem3(gk(n)) AT gx(n), gy(n)
    ENDSEL
  ENDP

  PROC HIDEGEM(n):
    SELECT CASE gc(n)
      CASE 0
        HIDE gem0(gk(n))
      CASE 1
        HIDE gem1(gk(n))
      CASE 2
        HIDE gem2(gk(n))
      CASE ELSE
        HIDE gem3(gk(n))
    ENDSEL
  ENDP

  REM Gem n is gone (caught or fallen): its sprite and its pool slot are free.
  PROC GONE(n):
    CALL HIDEGEM(n)
    occ(gc(n) * 3 + gk(n)) = 0
    gon(n) = 0
    act = act - 1
  ENDP

  PROC GEMS():
    FOR g = 0 TO MAXGEMS - 1
      IF gon(g) = 1 THEN
        gy(g) = gy(g) + spd
        IF wv >= 3 AND gch(g) = 0 AND gy(g) >= GLOWY THEN CALL RECOLOUR(g) ENDIF
        IF gy(g) + 16 >= CY AND gy(g) < CY + 8 AND ABS(gx(g) - px) < 12 THEN
          CALL CATCH(g)
        ELSE
          IF gy(g) >= MISSY THEN
            CALL MISS(g)
          ELSE
            CALL PUTGEM(g)
          ENDIF
        ENDIF
      ENDIF
    NEXT g
  ENDP

  REM Gem n crosses the glow band: it becomes another colour (one that has a free sprite in its pool), with a ping.
  PROC RECOLOUR(n):
    gch(n) = 1
    nc = (gc(n) + 1 + RND(3)) MOD 4
    FOR o = 0 TO 2
      CALL FREESLOT(nc)
      IF k >= 0 THEN EXIT FOR ENDIF
      nc = (nc + 1) MOD 4
      IF nc = gc(n) THEN nc = (nc + 1) MOD 4 ENDIF
    NEXT o
    IF k >= 0 THEN
      CALL HIDEGEM(n)
      occ(gc(n) * 3 + gk(n)) = 0
      gc(n) = nc : gk(n) = k
      occ(nc * 3 + k) = 1
      PLAY ping
    ENDIF
  ENDP

  PROC CATCH(n):
    c = gc(n)
    CALL GONE(n)
    IF c = cc THEN
      streak = streak + 1
      mult = 1 + streak DIV 5 : IF mult > 4 THEN mult = 4 ENDIF
      score = score + 10 * mult : IF score > 30000 THEN score = 30000 ENDIF
      CALL STARTBURST(c, 20, gx(n))
      PLAY chime
    ELSE
      CALL STARTBURST(4, 20, gx(n))
      CALL LOSELIFE()
      PLAY buzz
    ENDIF
    hud = 1
  ENDP

  PROC MISS(n):
    CALL GONE(n)
    CALL STARTBURST(5, 22, gx(n))
    CALL LOSELIFE()
    PLAY splash
    hud = 1
  ENDP

  PROC LOSELIFE():
    lives = lives - 1
    streak = 0 : mult = 1
    IF lives <= 0 THEN
      IF score > best THEN best = score ENDIF
      ENTER over
    ENDIF
  ENDP

  REM A burst of kind b (0..3 a gem colour, 4 wrong, 5 splash) over cell row r, at the cells of column x DIV 8 and the next: 3 frames of 2 refreshes.  One at a time.
  PROC STARTBURST(b, r, x):
    IF bt2 > 0 THEN CALL ENDBURST() ENDIF
    bcl = b : brow = r : bcol = (x + 4) DIV 8
    IF bcol > 30 THEN bcol = 30 ENDIF
    bt2 = 6
    CALL DRAWBURST()
  ENDP

  PROC DRAWBURST():
    bf = (6 - bt2) DIV 2
    TILE bcol, brow = TBURST + bcl * 6 + bf * 2
    TILE bcol + 1, brow = TBURST + bcl * 6 + bf * 2 + 1
  ENDP

  PROC ENDBURST():
    TILE bcol, brow = brow
    TILE bcol + 1, brow = brow
    bt2 = 0
  ENDP

  PROC BURST():
    IF bt2 > 0 THEN
      bt2 = bt2 - 1
      IF bt2 = 0 THEN
        CALL ENDBURST()
      ELSE
        IF bt2 MOD 2 = 0 THEN CALL DRAWBURST() ENDIF
      ENDIF
    ENDIF
  ENDP
ENDSCENE

SCENE over
  DIM ow, rel, fire
  PROC INIT():
    NOMUSIC
    PLAY over
    CALL SAY(3, 2) : PRINT AT 3, 11; "GAME OVER";
    CALL SAY(6, 6) : PRINT AT 6, 9; "SCORE "; score;
    CALL SAY(8, 6) : PRINT AT 8, 9; "WAVE "; wv;
    CALL SAY(10, 5) : PRINT AT 10, 9; "BEST "; best;
    IF score >= best AND score > 0 THEN
      CALL SAY(12, 7) : PRINT AT 12, 9; "A NEW BEST!";
    ENDIF
    CALL SAY(17, 6) : PRINT AT 17, 7; "PRESS FIRE TO PLAY";
  ENDP

  REM Fire restarts once it has been released and pressed again (it is usually still down when the scene starts).
  PROC FRAME():
    ow = ow + 1
    fire = KEYDOWN(" ") OR BIT(STICK(1), 4)
    IF fire = 0 THEN rel = 1 ENDIF
    IF fire AND rel AND ow > 20 THEN ENTER play ENDIF
  ENDP
ENDSCENE
