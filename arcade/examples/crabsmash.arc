REM Crabsmash: a single-screen arena game for Leap Arcade (runtime v2, every scene in fine colour).  Design: crabsmash.md.
REM You are the hero in the arena.  Crabs and flies come out of the two pipes at the top and wander down the platforms.  Jump into the UNDERSIDE of a platform to stun everything standing
REM within reach on it, then walk into a stunned one to smash it (200 points for a crab, 300 for a fly; a bump on a stunned one wakes it, angry and faster).  Touch a live one and you lose a life
REM (3 lives).  Smashed enemies leave a coin: grab it for 500.  Smash every enemy of a phase to clear it; each phase has more enemies, flies, quicker legs and shorter stuns.  The left and right
REM edges wrap round; an enemy that walks off the floor goes back into the pipes.
REM   Keyboard: O left, P right, Q or SPACE jump.   Joystick 1: left, right, up or fire jump.   Fire starts the game and restarts it after GAME OVER.
REM The scenes are fine colour (8 x 1 colour): the assets file's "scenes" key says so (crabsmash.assets.gen.mjs); the source is ordinary.  Positions are pixels (y from the top, a sprite's top left);
REM the platforms (surface y and x range) are the DIMs below, which crabsmash.assets.gen.mjs repeats (`--check` compares).  The HUD prints only the numbers that changed (a text cell costs ~1,800 T).
REM The v2 runtime has no FLIP, so every sprite is symmetric: the hero is seen from the front.  Instances: 3 hero forms + 3 crabs x 3 forms + 2 flies x 2 forms = 16.
REM   Compile:  node arcade/tools/arcadec.mjs arcade/examples/crabsmash.arc --assets arcade/examples/crabsmash.assets.json --runtime v2
GAME "Crabsmash"
FRAMERATE 20

CONST TCOIN = 1                     REM the coin's first tile (TL TR BL BR are tiles 1..4)
CONST MAXAL = 3                     REM enemies out at once (measured: with 4 the heaviest ticks took 176,000 T of the 176,064 a tick may; with 3 the hero and three of them are the sprites that move)
CONST STARTX = 120
CONST STARTY = 160

MAP arena = "arena"
MAP logo = "logo"
MAP press = "press"
MAP over = "over"
SPRITE craba(3) = "craba"
SPRITE crabb(3) = "crabb"
SPRITE stun(3) = "stun"
SPRITE flya(2) = "flya"
SPRITE flyb(2) = "flyb"
SPRITE herora(1) = "herora"
SPRITE herorb(1) = "herorb"
SPRITE herojump(1) = "herojump"
TILESET gfx = "gfx"
SFX sjump = "jump"
SFX sbump = "bump"
SFX ssmash = "smash"
SFX scoin = "coin"
SFX sdie = "die"
SFX sphase = "phase"
SFX sover = "over"
MUSIC mscuttle = "scuttle"
MUSIC marena = "arena"

REM The score (in tens), the best score and whether this game made it belong to the whole game: the game over scene shows them.
DIM score, best, nbest, phase

SCENE title
  PROC INIT():
    BORDER 0
    INK 7 : PAPER 0 : BRIGHT 0
    CLS
    PLAY mscuttle
    LOADMAP logo AT 7, 3
    SHOW herora(0) AT 40, 56
    SHOW craba(0) AT 88, 56
    SHOW stun(0) AT 136, 56
    SHOW flya(0) AT 184, 56
    LOADMAP press AT 7, 10
    INK 5 : PRINT AT 12, 1; "BUMP A PLATFORM FROM BELOW TO";
    PRINT AT 13, 1; "STUN CRABS AND FLIES. WALK INTO";
    PRINT AT 14, 1; "A STUNNED ONE TO SMASH IT.";
    INK 2 : PRINT AT 15, 1; "TOUCH A LIVE ONE: LOSE A LIFE.";
    INK 6 : PRINT AT 16, 1; "GRAB THE COINS THEY LEAVE!";
    INK 4 : PRINT AT 18, 3; "O P MOVE    Q OR SPACE JUMP";
    PRINT AT 19, 3; "OR JOYSTICK 1";
    INK 3 : PRINT AT 21, 11; "BEST "; best; "0";
  ENDP

  PROC FRAME():
    IF KEYDOWN(" ") OR BIT(STICK(1), 4) THEN ENTER play ENDIF
  ENDP
ENDSCENE

SCENE play
  REM the platforms, floor first: surface y, left x, right x (exclusive)
  DIM PYS(5) = 176, 144, 144, 104, 64, 64
  DIM PX0(5) = 0, 0, 176, 48, 0, 152
  DIM PX1(5) = 256, 80, 256, 208, 104, 256
  REM the hero
  DIM hx, hy, hvy, hair, hdx, hfm, ho, dv, lf, rt, jm, inv, hs, hl, hp, hh
  REM the enemies, slots 0..2 are crabs and 3..4 flies: state (0 away, 1 walking, 2 stunned), position, direction (-1 / 1), in the air, vertical speed, timer (stun left; hop wait for a fly),
  REM angry (recovered from a stun), platform they stand on, form shown
  DIM est(4), ex(4), ey(4), ed(4), eair(4), evy(4), etm(4), efast(4), ep(4), efm(4)
  DIM lives, sp, stp, eo, isf, fnew, tk, pz, bn, cn, cph, cx, cy, todo, alive, nsp, spt, spgap, stt, pfast, kk, sd

  PROC INIT():
    BORDER 0
    LOADMAP arena
    score = 0 : phase = 1 : nbest = 0
    INK 7 : PAPER 0 : BRIGHT 0
    PRINT AT 0, 1; "P1"; : INK 6 : PRINT AT 0, 12; "HI"; : INK 5 : PRINT AT 0, 22; "PH"; : INK 2 : PRINT AT 0, 28; "X";
    hs = 1 : hl = 1 : hp = 1 : hh = 1
    hx = STARTX : hy = STARTY : hair = 0 : hvy = 0 : hfm = 0 : inv = 0
    PLAY marena
    CALL STARTPHASE()
    lives = 3
  ENDP

  REM Phase n: how many enemies, how often they come, how long a stun lasts, whether they are quick.
  PROC STARTPHASE():
    todo = 4 + phase : IF todo > 12 THEN todo = 12 ENDIF
    stt = 170 - 14 * phase : IF stt < 60 THEN stt = 60 ENDIF
    spgap = 64 - 6 * phase : IF spgap < 26 THEN spgap = 26 ENDIF
    pfast = 0 : IF phase >= 3 THEN pfast = 1 ENDIF
    spt = 60 : alive = 0 : nsp = 0
    IF cn > 0 THEN CALL TAKECOIN() ENDIF
    bn = 50
    INK 7 : PAPER 0 : BRIGHT 0
    PRINT AT 11, 12; "PHASE "; phase;
    hp = 1
  ENDP

  PROC FRAME():
    tk = BAND(tk + 1, 1023)
    REM the HUD numbers that changed last tick are printed first thing in this one (the tick of a smash is already heavy)
    IF hs + hl + hp + hh > 0 THEN CALL SHOWHUD() ENDIF
    IF pz > 0 THEN
      CALL PAUSED()
    ELSE
      CALL MOVEHERO()
      CALL COIN()
      IF inv > 0 THEN inv = inv - 1 ENDIF
      FOR k = 0 TO 4
        IF est(k) > 0 THEN CALL STEPE(k) ENDIF
      NEXT k
      CALL TOUCH()
      IF pz = 0 THEN
        CALL SPAWN()
        IF bn > 0 THEN
          bn = bn - 1
          IF bn = 0 THEN FILLC 12, 11, 12, 1 = 32 ENDIF
        ENDIF
      ENDIF
    ENDIF
    CALL SHOWHERO()
    FOR k = 0 TO 4
      IF est(k) > 0 THEN CALL SHOWE(k) ENDIF
    NEXT k
  ENDP

  REM The numbers that changed (INK / PAPER are set again: ENTER and the banner leave other colours).
  PROC SHOWHUD():
    PAPER 0 : BRIGHT 0
    IF hs THEN INK 7 : PRINT AT 0, 4; score; "0"; : hs = 0 ENDIF
    IF hh THEN INK 6 : PRINT AT 0, 15; best; "0"; : hh = 0 ENDIF
    IF hp THEN INK 5 : PRINT AT 0, 25; phase; : hp = 0 ENDIF
    IF hl THEN INK 2 : PRINT AT 0, 29; lives; : hl = 0 ENDIF
  ENDP

  PROC ADD(n):
    score = score + n : IF score > 30000 THEN score = 30000 ENDIF
    IF score > best THEN best = score : nbest = 1 : hh = 1 ENDIF
    hs = 1
  ENDP

  REM The platform (index in sp, -1 for none) whose surface y lies between feet fo and fn (inclusive) under a sprite at x = px.
  PROC LAND(px, fa, fb):
    sp = -1
    FOR i = 0 TO 5
      IF fa <= PYS(i) AND fb >= PYS(i) AND px + 12 > PX0(i) AND px + 4 < PX1(i) THEN sp = i : EXIT FOR ENDIF
    NEXT i
  ENDP

  PROC MOVEHERO():
    lf = KEYDOWN("O") OR BIT(STICK(1), 2)
    rt = KEYDOWN("P") OR BIT(STICK(1), 3)
    jm = KEYDOWN("Q") OR KEYDOWN(" ") OR BIT(STICK(1), 0) OR BIT(STICK(1), 4)
    hdx = 0
    IF lf AND rt = 0 THEN hdx = -4 ENDIF
    IF rt AND lf = 0 THEN hdx = 4 ENDIF
    hx = hx + hdx
    IF hx < 0 THEN hx = 236 ENDIF
    IF hx > 236 THEN hx = 0 ENDIF
    IF hair = 0 THEN
      CALL LAND(hx, hy + 16, hy + 16)
      IF sp < 0 THEN
        hair = 1 : hvy = 0
      ELSE
        IF jm THEN hvy = -10 : hair = 1 : PLAY sjump ENDIF
      ENDIF
    ENDIF
    IF hair THEN
      ho = hy : dv = hvy
      hy = hy + dv
      IF hvy < 8 THEN hvy = hvy + 1 ENDIF
      IF dv >= 0 THEN
        CALL LAND(hx, ho + 16, hy + 16)
        IF sp >= 0 THEN hy = PYS(sp) - 16 : hair = 0 : hvy = 0 ENDIF
      ELSE
        FOR i = 1 TO 5
          IF hy < PYS(i) + 8 AND ho >= PYS(i) + 8 AND hx + 12 > PX0(i) AND hx + 4 < PX1(i) THEN
            hy = PYS(i) + 8 : hvy = 1
            CALL BUMP(i)
            EXIT FOR
          ENDIF
        NEXT i
        IF hy < 8 THEN hy = 8 : hvy = 1 ENDIF
      ENDIF
    ENDIF
  ENDP

  REM The hero's head hits the underside of platform p: everything standing on it within 24 pixels is stunned (a stunned one wakes, angry) and hops.
  PROC BUMP(p):
    PLAY sbump
    FOR k = 0 TO 4
      IF est(k) > 0 AND eair(k) = 0 AND ep(k) = p AND ABS(ex(k) - hx) < 24 THEN
        IF est(k) = 1 THEN
          est(k) = 2 : etm(k) = stt
        ELSE
          est(k) = 1 : efast(k) = 1
        ENDIF
        eair(k) = 1 : evy(k) = -5
      ENDIF
    NEXT k
  ENDP

  REM One step of enemy k: walking (crabs 2 pixels a tick, 4 on every other tick when angry or from phase 3; flies 2 more, hopping), falling off a platform end, the wrap, the stun running out.
  PROC STEPE(k):
    isf = 0 : IF k >= 3 THEN isf = 1 ENDIF
    IF est(k) = 2 THEN
      etm(k) = etm(k) - 1
      IF etm(k) <= 0 THEN est(k) = 1 : efast(k) = 1 ENDIF
    ELSE
      IF eair(k) = 0 OR isf = 1 THEN
        stp = 2
        IF BAND(tk, 1) = 1 AND (efast(k) > 0 OR pfast > 0) THEN stp = 4 ENDIF
        IF isf = 1 THEN stp = stp + 2 ENDIF
        ex(k) = ex(k) + ed(k) * stp
        IF ex(k) < 0 OR ex(k) > 238 THEN
          IF ey(k) > 150 THEN
            REM off the end of the floor: back into the pipe on that side
            IF ex(k) < 0 THEN ex(k) = 10 : ed(k) = 1 ELSE ex(k) = 226 : ed(k) = -1 ENDIF
            ey(k) = 44 : eair(k) = 1 : evy(k) = 0 : ep(k) = -1
          ELSE
            IF ex(k) < 0 THEN ex(k) = 238 ELSE ex(k) = 0 ENDIF
          ENDIF
        ENDIF
      ENDIF
    ENDIF
    IF eair(k) THEN
      dv = evy(k) : eo = ey(k) + 16
      ey(k) = ey(k) + dv
      IF evy(k) < 6 THEN evy(k) = evy(k) + 1 ENDIF
      IF dv >= 0 THEN
        CALL LAND(ex(k), eo, ey(k) + 16)
        IF sp >= 0 THEN ey(k) = PYS(sp) - 16 : eair(k) = 0 : evy(k) = 0 : ep(k) = sp ENDIF
      ENDIF
    ELSE
      CALL LAND(ex(k), ey(k) + 16, ey(k) + 16)
      IF sp < 0 THEN
        eair(k) = 1 : evy(k) = 0
      ELSE
        ep(k) = sp
        IF isf = 1 AND est(k) = 1 THEN
          etm(k) = etm(k) - 1
          IF etm(k) <= 0 THEN eair(k) = 1 : evy(k) = -6 : etm(k) = 6 + RND(10) ENDIF
        ENDIF
      ENDIF
    ENDIF
  ENDP

  REM The hero against every enemy: a stunned one is smashed, a live one costs a life (unless the hero has just come back).
  PROC TOUCH():
    FOR k = 0 TO 4
      IF est(k) > 0 THEN
        IF ABS(ex(k) - hx) < 11 AND ABS(ey(k) - hy) < 12 THEN
          IF est(k) = 2 THEN
            CALL SMASH(k)
          ELSE
            IF inv = 0 THEN
              CALL LOSELIFE()
              EXIT FOR
            ENDIF
          ENDIF
        ENDIF
      ENDIF
    NEXT k
  ENDP

  REM Enemy k is smashed: points, a crunch, a coin where it stood; the last one of the phase starts the next phase.
  PROC SMASH(k):
    CALL HIDEE(k)
    est(k) = 0 : efm(k) = 0
    IF k >= 3 THEN CALL ADD(30) ELSE CALL ADD(20) ENDIF
    PLAY ssmash
    alive = alive - 1
    IF cn = 0 AND cph = 0 AND ep(k) >= 0 AND bn = 0 THEN
      REM the coin lands 5 cells beyond the enemy, away from the hero (so it has to be fetched), on the platform's level
      cx = SHR(ex(k) + 4, 3) : cy = SHR(PYS(ep(k)), 3) - 2
      IF hx <= ex(k) THEN cx = cx + 5 ELSE cx = cx - 5 ENDIF
      IF cx < 1 THEN cx = 1 ENDIF
      IF cx > 29 THEN cx = 29 ENDIF
      REM (the coin is drawn over two ticks, the top row now and the bottom row in COIN: four cells at once would make this the heaviest tick of the game)
      TILE cx, cy = TCOIN : TILE cx + 1, cy = TCOIN + 1
      cph = 1 : cn = 170
    ENDIF
    IF alive = 0 AND todo = 0 THEN
      CALL ADD(100)
      phase = phase + 1 : IF phase > 99 THEN phase = 99 ENDIF
      PLAY sphase
      CALL STARTPHASE()
    ENDIF
  ENDP

  REM The coin: the hero takes it (500 points), or it fades after a few seconds; its bottom row is drawn or cleared one tick after its top row.
  PROC COIN():
    IF cph > 0 THEN
      IF cph = 1 THEN
        TILE cx, cy + 1 = TCOIN + 2 : TILE cx + 1, cy + 1 = TCOIN + 3
      ELSE
        TILE cx, cy + 1 = 0 : TILE cx + 1, cy + 1 = 0
      ENDIF
      cph = 0
    ENDIF
    IF cn > 0 THEN
      cn = cn - 1
      IF ABS(hx - 8 * cx) < 13 AND ABS(hy - 8 * cy) < 14 THEN
        CALL ADD(50)
        PLAY scoin
        CALL TAKECOIN()
      ELSE
        IF cn = 0 THEN CALL TAKECOIN() ENDIF
      ENDIF
    ENDIF
  ENDP

  PROC TAKECOIN():
    TILE cx, cy = 0 : TILE cx + 1, cy = 0
    cph = 2 : cn = 0
  ENDP

  REM An enemy comes out of a pipe (alternating sides): every fourth is a fly from phase 2 on, else a crab, while fewer than MAXAL are out.
  PROC SPAWN():
    IF todo > 0 THEN
      IF spt > 0 THEN
        spt = spt - 1
      ELSE
        IF alive < MAXAL THEN
          kk = -1
          IF phase >= 2 AND BAND(nsp, 3) = 3 THEN
            FOR j = 3 TO 4
              IF est(j) = 0 AND kk < 0 THEN kk = j ENDIF
            NEXT j
          ENDIF
          IF kk < 0 THEN
            FOR j = 0 TO 2
              IF est(j) = 0 AND kk < 0 THEN kk = j ENDIF
            NEXT j
          ENDIF
          IF kk >= 0 THEN
            sd = BAND(nsp, 1)
            ex(kk) = 10 + 216 * sd : ed(kk) = 1 - 2 * sd : ey(kk) = 44
            est(kk) = 1 : eair(kk) = 1 : evy(kk) = 0 : efast(kk) = 0 : ep(kk) = -1 : etm(kk) = 8 + RND(10)
            todo = todo - 1 : alive = alive + 1 : nsp = nsp + 1 : spt = spgap
          ENDIF
        ENDIF
      ENDIF
    ENDIF
  ENDP

  REM A live enemy touches the hero: a life is lost, everything stops for a moment.
  PROC LOSELIFE():
    lives = lives - 1
    hl = 1
    pz = 40
    PLAY sdie
  ENDP

  REM The pause after a lost life: at its end the game is over, or the hero is back on the floor and cannot be hurt for a while.
  PROC PAUSED():
    pz = pz - 1
    IF pz = 0 THEN
      IF lives <= 0 THEN
        ENTER over
      ELSE
        hx = STARTX : hy = STARTY : hair = 0 : hvy = 0 : inv = 50
      ENDIF
    ENDIF
  ENDP

  REM The hero's form: jumping (or hurt), running (a second leg position every other 2 ticks) or standing; it blinks while it cannot be hurt.
  PROC SHOWHERO():
    fnew = 0
    IF hair = 1 OR pz > 0 THEN
      fnew = 2
    ELSE
      IF hdx <> 0 AND BAND(tk, 2) = 2 THEN fnew = 1 ENDIF
    ENDIF
    IF fnew <> hfm THEN
      CALL HIDEHERO()
      hfm = fnew
    ENDIF
    IF inv > 0 AND BAND(inv, 2) = 0 THEN
      CALL HIDEHERO()
    ELSE
      SELECT CASE hfm
        CASE 0
          SHOW herora(0) AT hx, hy
        CASE 1
          SHOW herorb(0) AT hx, hy
        CASE ELSE
          SHOW herojump(0) AT hx, hy
      ENDSEL
    ENDIF
  ENDP

  PROC HIDEHERO():
    SELECT CASE hfm
      CASE 0
        HIDE herora(0)
      CASE 1
        HIDE herorb(0)
      CASE ELSE
        HIDE herojump(0)
    ENDSEL
  ENDP

  REM Enemy k in its form: a crab walks in two legs positions (changing every 4 ticks), a stunned crab lies on its back (flickering to the walking form as it wakes); a fly flaps, a stunned
  REM fly blinks.
  PROC SHOWE(k):
    IF k < 3 THEN
      fnew = 2
      IF est(k) = 1 THEN fnew = BAND(SHR(tk, 2), 1) ENDIF
      IF est(k) = 2 AND etm(k) < 30 AND BAND(tk, 2) = 0 THEN fnew = 0 ENDIF
      IF fnew <> efm(k) THEN
        CALL HIDEE(k)
        efm(k) = fnew
      ENDIF
      SELECT CASE fnew
        CASE 0
          SHOW craba(k) AT ex(k), ey(k)
        CASE 1
          SHOW crabb(k) AT ex(k), ey(k)
        CASE ELSE
          SHOW stun(k) AT ex(k), ey(k)
      ENDSEL
    ELSE
      fnew = 0
      IF est(k) = 1 THEN fnew = BAND(SHR(tk, 1), 1) ENDIF
      IF fnew <> efm(k) THEN
        CALL HIDEE(k)
        efm(k) = fnew
      ENDIF
      IF est(k) = 2 AND BAND(tk, 4) = 0 THEN
        CALL HIDEE(k)
      ELSE
        IF fnew = 0 THEN SHOW flya(k - 3) AT ex(k), ey(k) ELSE SHOW flyb(k - 3) AT ex(k), ey(k) ENDIF
      ENDIF
    ENDIF
  ENDP

  PROC HIDEE(k):
    IF k < 3 THEN
      SELECT CASE efm(k)
        CASE 0
          HIDE craba(k)
        CASE 1
          HIDE crabb(k)
        CASE ELSE
          HIDE stun(k)
      ENDSEL
    ELSE
      IF efm(k) = 0 THEN HIDE flya(k - 3) ELSE HIDE flyb(k - 3) ENDIF
    ENDIF
  ENDP
ENDSCENE

SCENE over
  DIM ow, rel, fire
  PROC INIT():
    BORDER 0
    INK 6 : PAPER 0 : BRIGHT 0
    CLS
    NOMUSIC
    PLAY sover
    LOADMAP over AT 7, 3
    PRINT AT 8, 11; "SCORE "; score; "0";
    INK 5 : PRINT AT 10, 11; "PHASE "; phase;
    INK 4 : PRINT AT 12, 11; "BEST "; best; "0";
    IF nbest THEN
      INK 7 : PRINT AT 14, 11; "NEW BEST!";
    ENDIF
    LOADMAP press AT 7, 18
  ENDP

  REM Fire restarts once it has been released and pressed again (it is usually still down when the scene starts).
  PROC FRAME():
    ow = ow + 1
    fire = KEYDOWN(" ") OR BIT(STICK(1), 4)
    IF fire = 0 THEN rel = 1 ENDIF
    IF fire AND rel AND ow > 20 THEN ENTER play ENDIF
  ENDP
ENDSCENE
