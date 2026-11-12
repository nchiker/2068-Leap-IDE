REM Vaults: the acceptance game of the raycaster slice (docs/ARCADE_RAYCASTER_CONTRACT.md section 8.1): a first-person maze for the v4 runtime.
REM Find the gold key, open the vault door (a wall of type 4, opened with SETWALL), take the treasure; wraiths (billboards) chase you and can be shot.
REM Assets (the maze, the HUD panel, the title picture, six sprites, the tiles, eight sounds, all named vl_...) are in vaults.assets.json, drawn by vaults.assets.gen.mjs; the level data
REM below (SX0.., EXS.., GXS.., PXS.., TGX..) is printed by  node arcade/examples/vaults.assets.gen.mjs --data  and checked against the maze by tests/arcade-m8-vaults.mjs.
REM   Keyboard: O / P turn left / right, Q / A walk forward / back, SPACE shoots (and starts the game).   Joystick 1: left / right turn, up / down walk, fire shoots.
REM   Angles: 256 to a turn, 0 looks east (+x), 64 south (+y).  Positions are 8.8: 256 units to a cell.
REM Three scenes (docs/ARCADE_LANGUAGE_BATCH7.md):
REM   title  SCENE title NOVIEW: the 3D view is OFF, so the whole 32 x 24 cell screen is a picture (VAULTS in brick letters, the treasure and gems that sparkle by tile swaps, the
REM          locked door) with SPRITES at screen positions (a wraith patrols, the key, two gems and a potion bob).  It is the first scene, so it starts the game.
REM   demo   the view back ON: the colonnade turning slowly on the spot, with the HUD panel.  Title and demo take turns (TITLELEN / DEMOLEN ticks, 9 s each); fire in either one
REM          enters play.
REM   play   the game.  Its INIT reloads the floor plan (WORLD level: every wall and the door as drawn) and puts the HUD up, so a game always starts clean; the treasure and death
REM          return to the title (ENTER title).  The best score of the session is a game-level variable: a scene's own variables start from zero every time it is entered.
REM The state the scenes share (the pose, the wraith posts, the HUD) is game-level, so that the demo and the game see one maze and their HUD code is one set of PROCs.
REM   Compile:  node arcade/tools/arcadec.mjs arcade/examples/vaults.arc --assets arcade/examples/vaults.assets.json --runtime v4
GAME "Vaults"
FRAMERATE 15

REM ---- tuning.  Distances are in 1/256 cell.  The tick is 4 refreshes (15 a second); the picture takes about two thirds of it, so the game's logic stays small, and a billboard
REM costs about 10,000 T-states whenever it is in view (more when it is close: tests/arcade-m8-vaults-perf.mjs), so everything farther than SEER is hidden.
CONST SPD = 44
CONST TURN = 6
CONST RAD = 40
CONST ESTEP = 28
CONST WAKE = 1536
CONST RANGE = 1792
CONST SEER = 1792
CONST NEN = 5
CONST NGM = 5
CONST NPT = 3
REM the player starts facing a little south of east; the title and the demo take turns every 135 ticks (9 seconds)
CONST SPA = 34
CONST TITLELEN = 135
CONST DEMOLEN = 135

REM ---- the level (printed by the generator's --data)
CONST SX0 = 640
CONST SY0 = 7296
CONST KX = 640
CONST KY = 384
CONST TX = 7040
CONST TY = 896
CONST DX0 = 7040
CONST DY0 = 1408
CONST TVX = 3456
CONST TVY = 1408

REM ---- instances: the player's marker (for HIT) 1 + wraiths 5 + gems 5 + potions 3 + key 1 + treasure 1 = 16.  Wraiths 16 x 16, treasure 16 x 16, gems / potion / key 8 x 8.
REM In the title (no 3D view) the same instances are ordinary sprites at screen positions; the wraith asset has 4 phases for its smooth drift there (ray mode ignores phases).
SPRITE me = "vl_marker"
SPRITE wr(5) = "vl_wraith"
SPRITE gem(5) = "vl_gem"
SPRITE pot(3) = "vl_potion"
SPRITE kk = "vl_key"
SPRITE tr = "vl_treasure"
TILESET ts = "vl_tiles"
MAP panel = "vl_panel"
MAP level = "vl_maze"
MAP splash = "vl_title"
SFX shot = "vl_shot"
SFX thud = "vl_thud"
SFX kill = "vl_kill"
SFX pick = "vl_pick"
SFX door = "vl_door"
SFX hurt = "vl_hurt"
SFX win = "vl_win"
SFX lose = "vl_lose"
REM The title song (docs/ARCADE_MUSIC_CONTRACT.md): it starts with the title, plays on through the attract mode (the demo) and stops when a game starts.
MUSIC depths = "vl_depths"

VIEW3D level COLW 4 INK 5 CEIL 0 FLOOR 1

REM ---- game-level state: what the scenes share, and what a game keeps from one scene to the next (best).
REM st: 1 playing, 2 treasure found, 3 dead (0 before the first game).   hud: bit 0 health bar, 1 health number, 2 score, 3 gems, 4 key, 5 print the message (left half), 7 (right half), 6 clear it.
REM fc counts every tick since the start, whatever the scene (the sparkle, the wraiths' floating and which half of them is looked at all go by it); k3 counts 0 1 2 0 1 2.
DIM st, tt, fc, k3, js, lf, rg, fw, bk, fire, pfire, best
DIM px, py, pa, hp, score, keys, gems, kills, inv, cool, bt, msg, mt, hud
DIM ka, kv, tv
DIM exs(4) = 1920, 7040, 4224, 6528, 6528
DIM eys(4) = 640, 1920, 2176, 4992, 7808
DIM gxs(4) = 6528, 7552, 896, 4224, 2176
DIM gys(4) = 1152, 1152, 2176, 3968, 4736
DIM pxs(2) = 896, 6272, 4224
DIM pys(2) = 3200, 7296, 7808
REM the wraiths: x, y, health (0 = dead), awake, flash / burst timer
DIM ex(4), ey(4), eh(4), ea(4), ef(4), ev(4)
REM the things to pick up: still there, and shown (a thing is shown only while the player is within SEER of it)
DIM ga(4), oa(2), gv(4), pv(2)

REM ---------------------------------------------------------------------------------------------------------------- shared by the scenes
REM The start of every tick, in every scene: the stick and the keys, and the tick counters.
PROC READIN():
  js = STICK(1)
  fire = KEYDOWN(" ") OR BIT(js, 4)
ENDP

PROC COUNT():
  fc = fc + 1
  IF fc > 30000 THEN fc = 0 ENDIF
  k3 = k3 + 1
  IF k3 > 2 THEN k3 = 0 ENDIF
ENDP

REM The text of the panel, a piece at a time (stages 0 to 7; the demo puts one up a tick, the game's INIT all of those it keeps): two strips of the panel cleared for the messages, the
REM name, the tagline and the prompt (the demo only), the keys, and the labels of the HUD.
PROC TSTAGE(s):
  INK 7 : PAPER 0 : BRIGHT 1
  SELECT CASE s
    CASE 0
      FILLC 0, 20, 32, 1 = 32
    CASE 1
      FILLC 0, 21, 32, 1 = 32
    CASE 2
      INK 6 : PRINT AT 1, 8; "* V A U L T S *";
    CASE 3
      INK 5 : PRINT AT 3, 1; "FIND THE KEY. OPEN THE VAULT.";
    CASE 4
      INK 7 : PRINT AT 20, 2; "PRESS SPACE OR FIRE TO PLAY";
    CASE 5
      INK 3 : PRINT AT 22, 0; "O P TURN  Q A WALK  SPACE SHOOT";
    CASE 6
      INK 7 : PRINT AT 7, 1; "HEALTH";
      PRINT AT 12, 1; "KEYS";
    CASE 7
      PRINT AT 7, 25; "SCORE";
      PRINT AT 12, 25; "GEMS";
  ENDSEL
ENDP

REM One change a tick (a printed number is 1,000 to 2,500 T and the cells it dirties are repainted by the runtime in the same tick).
PROC HUDTICK():
  LOCAL done
  IF hud <> 0 THEN
    INK 6 : PAPER 0 : BRIGHT 1
    done = 0
    IF BAND(hud, 32) <> 0 THEN
      CALL MSGPRINT(0)
      hud = BOR(BAND(hud, BNOT(32)), 128) : done = 1
    ENDIF
    IF done = 0 AND BAND(hud, 128) <> 0 THEN
      CALL MSGPRINT(1)
      hud = BAND(hud, BNOT(128)) : done = 1
    ENDIF
    IF done = 0 AND BAND(hud, 64) <> 0 THEN
      FILLC 0, 20, 32, 1 = 32
      hud = BAND(hud, BNOT(64)) : done = 1
    ENDIF
    IF done = 0 AND BAND(hud, 1) <> 0 THEN
      CALL HPBAR()
      hud = BAND(hud, BNOT(1)) : done = 1
    ENDIF
    IF done = 0 AND BAND(hud, 2) <> 0 THEN
      PRINT AT 9, 3; hp; " ";
      hud = BAND(hud, BNOT(2)) : done = 1
    ENDIF
    IF done = 0 AND BAND(hud, 4) <> 0 THEN
      PRINT AT 8, 25; score; "   ";
      hud = BAND(hud, BNOT(4)) : done = 1
    ENDIF
    IF done = 0 AND BAND(hud, 8) <> 0 THEN
      CALL GEMROW()
      hud = BAND(hud, BNOT(8)) : done = 1
    ENDIF
    IF done = 0 AND BAND(hud, 16) <> 0 THEN
      IF keys > 0 THEN TILE 3, 13 = 6 ELSE TILE 3, 13 = 7 ENDIF
      hud = BAND(hud, BNOT(16)) : done = 1
    ENDIF
    IF done = 0 THEN hud = 0 ENDIF
  ENDIF
ENDP

REM The health bar: 7 cells of half cells, 100 hit points = 14 halves (any health above 0 shows at least one).
PROC HPBAR():
  LOCAL i, v
  v = (hp * 14 + 99) DIV 100
  FOR i = 0 TO 6
    IF v >= 2 THEN
      TILE i, 8 = 3
    ELSE
      IF v = 1 THEN TILE i, 8 = 4 ELSE TILE i, 8 = 5 ENDIF
    ENDIF
    v = v - 2
  NEXT i
ENDP

PROC GEMROW():
  LOCAL i
  FOR i = 0 TO NGM - 1
    IF i < gems THEN TILE 25 + i, 13 = 8 ELSE TILE 25 + i, 13 = 9 ENDIF
  NEXT i
ENDP

REM A bottom message is printed in two halves of 15 characters, one a tick: a character costs about 550 T-states to print, and the cells it dirties are repainted too.
PROC MSGPRINT(h):
  IF h = 0 THEN
    SELECT CASE msg
      CASE 1
        INK 6 : PRINT AT 20, 1; "    YOU TOOK TH";
      CASE 2
        INK 2 : PRINT AT 20, 1; "THE DOOR IS LOC";
      CASE 3
        INK 6 : PRINT AT 20, 1; " THE VAULT DOOR";
      CASE 4
        INK 5 : PRINT AT 20, 1; "         A GEM!";
      CASE 5
        INK 4 : PRINT AT 20, 1; "      A HEALING";
      CASE ELSE
        INK 7 : PRINT AT 20, 1; "   WRAITH DESTR";
    ENDSEL
  ELSE
    SELECT CASE msg
      CASE 1
        INK 6 : PRINT AT 20, 16; "E GOLD KEY!    ";
      CASE 2
        INK 2 : PRINT AT 20, 16; "KED. FIND A KEY";
      CASE 3
        INK 6 : PRINT AT 20, 16; " GRINDS OPEN!  ";
      CASE 4
        INK 5 : PRINT AT 20, 16; "  +50          ";
      CASE 5
        INK 4 : PRINT AT 20, 16; " DRAUGHT!      ";
      CASE ELSE
        INK 7 : PRINT AT 20, 16; "OYED!  +100    ";
    ENDSEL
  ENDIF
ENDP

REM ---------------------------------------------------------------------------------------------------------------- the title (no 3D view)
REM The picture is the MAP splash (vl_title: letters, goblet, gems, the door); the text goes on it a line a tick and the picture is animated every tick: one gem (or the goblet's top)
REM swaps its tile for the glinting one, the wraith patrols the corridor 2 pixels a tick (4 phases), the key, two gems and a potion bob.  TM counts the ticks of the scene.
SCENE title NOVIEW
  DIM tm
  DIM tgx(5) = 9, 11, 12, 19, 20, 22
  DIM tgy(5) = 12, 11, 13, 13, 11, 12

  PROC INIT():
    PLAY depths
    BORDER 0
    LOADMAP splash
    tm = 0
    pfire = fire
  ENDP

  PROC FRAME():
    LOCAL go
    CALL READIN()
    CALL COUNT()
    tm = tm + 1
    IF tm <= 3 THEN CALL TITLETEXT(tm - 1) ENDIF
    CALL ANIMATE()
    go = fire AND (NOT pfire)
    pfire = fire
    IF go THEN ENTER play ENDIF
    IF tm >= TITLELEN THEN ENTER demo ENDIF
  ENDP

  PROC TITLETEXT(s):
    PAPER 0 : BRIGHT 1
    SELECT CASE s
      CASE 0
        INK 5 : PRINT AT 8, 1; "FIND THE KEY. OPEN THE VAULT.";
      CASE 1
        INK 7 : PRINT AT 21, 2; "PRESS SPACE OR FIRE TO PLAY";
      CASE ELSE
        INK 6 : PRINT AT 23, 9; "BEST SCORE "; best;
    ENDSEL
  ENDP

  REM The wraith goes 24 to 214 and back (96 ticks each way), flapping its hem every 4 ticks and floating a little; the key and the gems (8 x 8, drawn on whole bytes: one phase is
  REM enough) bob on the corridor floor.  One gem tile a tick takes the sparkle of its turn, so the glints run round the goblet.
  PROC ANIMATE():
    LOCAL q, k, b
    q = fc MOD 192
    IF q >= 96 THEN q = 191 - q ENDIF
    SHOW wr(0) AT 24 + 2 * q, 114 + ABS(BAND(SHR(fc, 2), 7) - 4) FRAME BAND(SHR(fc, 2), 1)
    b = ABS(BAND(SHR(fc, 1), 7) - 4)
    SHOW kk AT 24, 140 + b
    SHOW gem(0) AT 80, 144 - b FRAME BAND(SHR(fc, 3), 1)
    SHOW pot(0) AT 128, 140 + b
    SHOW gem(1) AT 176, 144 - b FRAME BAND(SHR(fc, 3), 1)
    k = BAND(fc, 7)
    IF k < 6 THEN
      IF BAND(SHR(fc, 3), 1) THEN TILE tgx(k), tgy(k) = 22 ELSE TILE tgx(k), tgy(k) = 8 ENDIF
    ELSE
      IF k = 6 THEN
        IF BAND(SHR(fc, 3), 1) THEN TILE 15, 10 = 24 ELSE TILE 15, 10 = 23 ENDIF
      ENDIF
    ENDIF
  ENDP
ENDSCENE

REM ---------------------------------------------------------------------------------------------------------------- the demo (the 3D view back on)
REM The picture turns slowly on the spot in the colonnade, where a wraith sleeps among the pillars (what the title used to be).  The text goes up a piece a tick (DTI counts the stages).
REM WORLD level puts the floor plan back, so that a demo after a game does not show the door open.
SCENE demo
  DIM tm, dti

  PROC INIT():
    BORDER 0
    WORLD level
    tm = 0 : dti = 0
    pfire = fire
    hp = 100 : score = 0 : keys = 0 : gems = 0 : msg = 0 : mt = 0 : hud = 31
    px = TVX : py = TVY : pa = 0
    SHOW wr(2) AT exs(2), eys(2) FRAME 0
  ENDP

  PROC FRAME():
    LOCAL go
    CALL READIN()
    CALL COUNT()
    tm = tm + 1
    pa = BAND(pa + 2, 255)
    VIEW px, py, pa
    IF BAND(fc, 3) = 0 THEN SHOW wr(2) AT exs(2), eys(2) FRAME BAND(SHR(fc, 2), 1) ENDIF
    IF dti < 8 THEN
      CALL TSTAGE(dti)
      dti = dti + 1
    ELSE
      CALL HUDTICK()
    ENDIF
    go = fire AND (NOT pfire)
    pfire = fire
    IF go THEN ENTER play ENDIF
    IF tm >= DEMOLEN THEN ENTER title ENDIF
  ENDP
ENDSCENE

REM ---------------------------------------------------------------------------------------------------------------- play
SCENE play
  DIM ei

  REM A new game: the floor plan is loaded again (every wall and the door as drawn), the pose, health, score and every thing in the maze go back to the start, the HUD is up before the
  REM first tick (the reset of ENTER cleared the screen and loaded the panel; the stages are the demo's, less the tagline and the prompt, and the tagline's row is blank) and the view shows the start at once.
  PROC INIT():
    LOCAL k
    NOMUSIC
    WORLD level
    BORDER 0
    st = 1 : tt = 0 : bt = 0
    hp = 100 : score = 0 : keys = 0 : gems = 0 : kills = 0 : inv = 0 : cool = 0 : msg = 0 : mt = 0
    hud = 31
    pa = SPA
    CALL RESETWORLD()
    FOR k = 1 TO 5
      CALL HUDTICK()
    NEXT k
    CALL TSTAGE(0) : CALL TSTAGE(1) : CALL TSTAGE(2) : CALL TSTAGE(5) : CALL TSTAGE(6) : CALL TSTAGE(7)
    FILLC 0, 3, 32, 1 = 32
    VIEW px, py, pa
  ENDP

  REM ---------------------------------------------------------------------------------------------------------------- the tick
  PROC FRAME():
    CALL READIN()
    CALL COUNT()
    tt = tt + 1
    IF tt > 30000 THEN tt = 30000 ENDIF
    SELECT CASE st
      CASE 1
        CALL PLAYTICK()
      CASE ELSE
        CALL ENDTICK()
    ENDSEL
    pfire = fire
  ENDP

  REM Everything in the maze back to how a game starts: the wraiths asleep at their posts, every gem, potion, the key and the treasure in place (all of them hidden: PICKUPS and
  REM ENEMIES show each one when the player comes within SEER of it), the player at the start.  (The door and the walls came back with WORLD level.)
  PROC RESETWORLD():
    LOCAL i
    FOR i = 0 TO NEN - 1
      ex(i) = exs(i) : ey(i) = eys(i) : eh(i) = 3 : ea(i) = 0 : ef(i) = 0 : ev(i) = 0
      HIDE wr(i)
    NEXT i
    FOR i = 0 TO NGM - 1
      ga(i) = 1 : gv(i) = 0
      HIDE gem(i)
    NEXT i
    FOR i = 0 TO NPT - 1
      oa(i) = 1 : pv(i) = 0
      HIDE pot(i)
    NEXT i
    ka = 1 : kv = 0 : tv = 0
    HIDE kk
    HIDE tr
    px = SX0 : py = SY0
    SHOW me AT px, py
  ENDP

  REM ---------------------------------------------------------------------------------------------------------------- play
  PROC PLAYTICK():
    CALL MOVEPLAYER()
    CALL PICKUPS()
    IF st = 1 THEN CALL ENEMIES() ENDIF
    IF st = 1 THEN CALL SHOOT() ENDIF
    CALL EFFECTS()
    CALL HUDTICK()
    VIEW px, py, pa
  ENDP

  REM Turn, then walk along (COSA, SINA) one axis at a time: the move is made when the two leading corners of the player's box (radius RAD) are in empty cells, so
  REM the player slides along a wall.  Every other tick a probe 112 units ahead looks for the locked door (wall type 4): with the key it opens.
  PROC MOVEPLAYER():
    LOCAL mv, sp, c, s, nx, ny, f, qx, qy
    lf = KEYDOWN("O") OR BIT(js, 2)
    rg = KEYDOWN("P") OR BIT(js, 3)
    fw = KEYDOWN("Q") OR BIT(js, 0)
    bk = KEYDOWN("A") OR BIT(js, 1)
    IF lf THEN pa = pa - TURN ENDIF
    IF rg THEN pa = pa + TURN ENDIF
    pa = BAND(pa, 255)
    mv = fw - bk
    IF mv <> 0 THEN
      IF mv > 0 THEN sp = SPD ELSE sp = 0 - SPD ENDIF
      c = COSA(pa) : s = SINA(pa)
      nx = px + FXMUL(c, sp)
      IF nx > px THEN f = nx + RAD ELSE f = nx - RAD ENDIF
      IF WALL(f, py - RAD) = 0 AND WALL(f, py + RAD) = 0 THEN px = nx ENDIF
      ny = py + FXMUL(s, sp)
      IF ny > py THEN f = ny + RAD ELSE f = ny - RAD ENDIF
      IF WALL(px - RAD, f) = 0 AND WALL(px + RAD, f) = 0 THEN py = ny ENDIF
      SHOW me AT px, py
      IF mv > 0 AND BAND(fc, 1) = 0 THEN
        qx = px + FXMUL(c, 112) : qy = py + FXMUL(s, 112)
        IF WALL(qx, qy) = 4 THEN
          IF keys > 0 THEN
            SETWALL qx, qy = 0
            keys = 0 : hud = BOR(hud, 16)
            PLAY door
            CALL SAY(3)
          ELSE
            IF mt = 0 THEN
              PLAY thud
              CALL SAY(2)
            ENDIF
          ENDIF
        ENDIF
      ENDIF
    ENDIF
  ENDP

  REM Gems, potions, the key and the treasure.  Each is looked at only every third tick (the player walks 44 units a tick and a pickup is touched over a stretch of 192;
  REM K, a counter that goes 0 1 2 0 1 2, picks the ones asked this tick: gems K and K + 3, potion K, the key on K = 2, the treasure on K = 1).  A thing farther than SEER is
  REM hidden and one that comes within it is shown (a billboard in view costs at least 10,000 T-states); a cheap distance test comes before HIT.
  PROC PICKUPS():
    LOCAL i, k, ax, ay
    k = k3
    FOR i = k TO NGM - 1 STEP 3
      IF ga(i) THEN
        ax = ABS(gxs(i) - px) : ay = ABS(gys(i) - py)
        IF ax < SEER AND ay < SEER THEN
          IF gv(i) = 0 THEN
            gv(i) = 1
            SHOW gem(i) AT gxs(i), gys(i)
          ENDIF
          IF ax < 112 AND ay < 112 THEN
            IF HIT(me, gem(i)) THEN
              ga(i) = 0 : HIDE gem(i)
              gems = gems + 1 : score = score + 50 : hud = BOR(hud, 12)
              PLAY pick
              CALL SAY(4)
            ENDIF
          ENDIF
        ELSE
          IF gv(i) THEN
            gv(i) = 0
            HIDE gem(i)
          ENDIF
        ENDIF
      ENDIF
    NEXT i
    IF oa(k) THEN
      ax = ABS(pxs(k) - px) : ay = ABS(pys(k) - py)
      IF ax < SEER AND ay < SEER THEN
        IF pv(k) = 0 THEN
          pv(k) = 1
          SHOW pot(k) AT pxs(k), pys(k)
        ENDIF
        IF hp < 100 AND ax < 112 AND ay < 112 THEN
          IF HIT(me, pot(k)) THEN
            oa(k) = 0 : HIDE pot(k)
            hp = hp + 40
            IF hp > 100 THEN hp = 100 ENDIF
            hud = BOR(hud, 3)
            PLAY pick
            CALL SAY(5)
          ENDIF
        ENDIF
      ELSE
        IF pv(k) THEN
          pv(k) = 0
          HIDE pot(k)
        ENDIF
      ENDIF
    ENDIF
    IF k = 2 AND ka THEN
      ax = ABS(KX - px) : ay = ABS(KY - py)
      IF ax < SEER AND ay < SEER THEN
        IF kv = 0 THEN
          kv = 1
          SHOW kk AT KX, KY
        ENDIF
        IF ax < 112 AND ay < 112 THEN
          IF HIT(me, kk) THEN
            ka = 0 : HIDE kk
            keys = 1 : hud = BOR(hud, 16)
            PLAY pick
            CALL SAY(1)
          ENDIF
        ENDIF
      ELSE
        IF kv THEN
          kv = 0
          HIDE kk
        ENDIF
      ENDIF
    ENDIF
    IF k = 1 THEN
      ax = ABS(TX - px) : ay = ABS(TY - py)
      IF ax < SEER AND ay < SEER THEN
        IF tv = 0 THEN
          tv = 1
          SHOW tr AT TX, TY
        ENDIF
        IF ax < 112 AND ay < 112 THEN
          IF HIT(me, tr) THEN CALL WIN() ENDIF
        ENDIF
      ELSE
        IF tv THEN
          tv = 0
          HIDE tr
        ENDIF
      ENDIF
    ENDIF
  ENDP

  REM ---------------------------------------------------------------------------------------------------------------- the wraiths
  REM A sleeping wraith wakes when the player is within WAKE (6 cells) on both axes; an awake one steps toward him every other tick (ESTEP: about 0.4 of the player's
  REM speed) and hurts him on touch (HIT).  A wraith is shown only while the player is within SEER (7 cells) of it: a billboard in view costs at least 10,000 T-states, even
  REM behind a wall.  The wraiths are taken in two halves, the even ones on even ticks and the odd ones on odd ticks (touch, wake and the flash / burst timers count in these
  REM turns), so only two or three are looked at in a tick.
  PROC ENEMIES():
    LOCAL i, ax, ay
    FOR i = BAND(fc, 1) TO NEN - 1 STEP 2
      IF eh(i) > 0 THEN
        ax = ABS(ex(i) - px) : ay = ABS(ey(i) - py)
        IF ea(i) = 0 THEN
          IF ax < WAKE AND ay < WAKE THEN ea(i) = 1 ENDIF
        ELSE
          CALL MOVEEN(i)
          IF ax < 160 AND ay < 160 THEN
            IF HIT(me, wr(i)) THEN CALL HURTME() ENDIF
          ENDIF
        ENDIF
        IF ax < SEER AND ay < SEER THEN
          IF ev(i) = 0 THEN
            ev(i) = 1
            SHOW wr(i) AT ex(i), ey(i) FRAME 0
          ENDIF
        ELSE
          IF ev(i) THEN
            ev(i) = 0
            HIDE wr(i)
          ENDIF
        ENDIF
        IF ef(i) > 0 THEN
          ef(i) = ef(i) - 1
          IF ef(i) = 0 AND ev(i) THEN SHOW wr(i) AT ex(i), ey(i) FRAME BAND(SHR(fc, 2), 1) ENDIF
        ENDIF
      ELSE
        IF ef(i) > 0 THEN
          ef(i) = ef(i) - 1
          IF ef(i) = 0 THEN HIDE wr(i) ENDIF
        ENDIF
      ENDIF
    NEXT i
  ENDP

  REM One step toward the player on each axis (the lead point 3 steps ahead must be in an empty cell); a wraith that cannot move slides sideways along the wall.
  PROC MOVEEN(i):
    LOCAL x, y, sx, sy, mx, my, d, f
    x = ex(i) : y = ey(i) : mx = 0 : my = 0
    sx = px - x : sy = py - y
    IF sx > ESTEP THEN
      IF WALL(x + 3 * ESTEP, y) = 0 THEN x = x + ESTEP : mx = 1 ENDIF
    ELSE
      IF sx < 0 - ESTEP THEN
        IF WALL(x - 3 * ESTEP, y) = 0 THEN x = x - ESTEP : mx = 1 ENDIF
      ENDIF
    ENDIF
    IF sy > ESTEP THEN
      IF WALL(x, y + 3 * ESTEP) = 0 THEN y = y + ESTEP : my = 1 ENDIF
    ELSE
      IF sy < 0 - ESTEP THEN
        IF WALL(x, y - 3 * ESTEP) = 0 THEN y = y - ESTEP : my = 1 ENDIF
      ENDIF
    ENDIF
    IF mx + my = 0 THEN
      IF BAND(SHR(fc, 5) + i, 1) = 0 THEN d = ESTEP ELSE d = 0 - ESTEP ENDIF
      IF ABS(sx) > ABS(sy) THEN
        IF WALL(x, y + 3 * d) = 0 THEN y = y + d : my = 1 ENDIF
      ELSE
        IF WALL(x + 3 * d, y) = 0 THEN x = x + d : mx = 1 ENDIF
      ENDIF
    ENDIF
    IF mx + my > 0 THEN
      ex(i) = x : ey(i) = y
      IF ev(i) THEN
        f = BAND(SHR(fc, 2), 1)
        IF ef(i) > 0 THEN f = 2 ENDIF
        SHOW wr(i) AT x, y FRAME f
      ENDIF
    ENDIF
  ENDP

  PROC HURTME():
    IF inv = 0 THEN
      hp = hp - 10 : inv = 12 : hud = BOR(hud, 3)
      PLAY hurt
      BORDER 2 : bt = 3
      IF hp <= 0 THEN
        hp = 0
        CALL LOSE()
      ENDIF
    ENDIF
  ENDP

  REM ---------------------------------------------------------------------------------------------------------------- shooting
  REM Fire (every 6 ticks while held): the wraith that the last picture drew nearest to the middle column (SEEN within a few columns of 64, the more the closer it is)
  REM and nearer than RANGE (DEPTH) is hit.  A wraith behind a wall was not drawn (SEEN = -1), so a wall protects it.  Three hits destroy one.
  PROC SHOOT():
    LOCAL i, best, bd, c, d, tol
    IF fire AND cool = 0 THEN
      cool = 6
      PLAY shot
      BORDER 7 : bt = 1
      best = -1 : bd = RANGE
      FOR i = 0 TO NEN - 1
        IF eh(i) > 0 THEN
          c = SEEN(wr(i))
          IF c >= 0 THEN
            d = DEPTH(wr(i))
            tol = 8000 DIV (d + 1)
            IF tol < 3 THEN tol = 3 ENDIF
            IF ABS(c - 64) <= tol AND d < bd THEN
              bd = d : best = i
            ENDIF
          ENDIF
        ENDIF
      NEXT i
      IF best >= 0 THEN CALL HITEN(best) ENDIF
    ENDIF
  ENDP

  PROC HITEN(i):
    eh(i) = eh(i) - 1 : ea(i) = 1
    IF eh(i) <= 0 THEN
      eh(i) = 0 : ef(i) = 4
      score = score + 100 : kills = kills + 1 : hud = BOR(hud, 4)
      SHOW wr(i) AT ex(i), ey(i) FRAME 3
      PLAY kill
      CALL SAY(6)
    ELSE
      ef(i) = 3
      SHOW wr(i) AT ex(i), ey(i) FRAME 2
      PLAY thud
    ENDIF
  ENDP

  REM ---------------------------------------------------------------------------------------------------------------- timers, gems that sparkle
  PROC EFFECTS():
    LOCAL k
    IF inv > 0 THEN inv = inv - 1 ENDIF
    IF cool > 0 THEN cool = cool - 1 ENDIF
    IF bt > 0 THEN
      bt = bt - 1
      IF bt = 0 THEN BORDER 0 ENDIF
    ENDIF
    IF mt > 0 THEN
      mt = mt - 1
      IF mt = 0 THEN hud = BOR(BAND(hud, BNOT(160)), 64) ENDIF
    ENDIF
    REM one gem (or the treasure) a tick takes its sparkle frame
    k = BAND(fc, 7)
    IF k < NGM THEN
      IF ga(k) AND gv(k) THEN SHOW gem(k) AT gxs(k), gys(k) FRAME BAND(SHR(fc, 3), 1) ENDIF
    ELSE
      IF k = 5 AND tv THEN SHOW tr AT TX, TY FRAME BAND(SHR(fc, 3), 1) ENDIF
    ENDIF
  ENDP

  REM ---------------------------------------------------------------------------------------------------------------- the HUD
  REM A message for the bottom strip: MSG says which, MT counts it down (45 ticks), then the line is cleared.
  PROC SAY(n):
    msg = n : mt = 45
    hud = BOR(BAND(hud, BNOT(192)), 32)
  ENDP


  REM ---------------------------------------------------------------------------------------------------------------- the end
  REM The score of a finished game is the session's best if it beats it (the title shows it).
  PROC WIN():
    st = 2 : tt = 0 : ei = 0
    score = score + 500 + hp : hud = BOR(hud, 4)
    IF score > best THEN best = score ENDIF
    PLAY win
    BORDER 4 : bt = 0
  ENDP

  PROC LOSE():
    st = 3 : tt = 0 : ei = 0
    IF score > best THEN best = score ENDIF
    PLAY lose
    BORDER 2 : bt = 0
  ENDP

  REM Treasure found (2) or dead (3): the picture turns slowly, the HUD is brought up to date, the message goes up a line a tick, fire goes back to the title.
  PROC ENDTICK():
    IF st = 2 THEN pa = BAND(pa + 3, 255) ENDIF
    CALL HUDTICK()
    VIEW px, py, pa
    IF hud = 0 THEN
      INK 7 : PAPER 0 : BRIGHT 1
      SELECT CASE ei
        CASE 0
          FILLC 0, 20, 32, 1 = 32
          ei = 1
        CASE 1
          IF st = 2 THEN
            INK 6 : PRINT AT 20, 4; "YOU FOUND THE TREASURE!";
          ELSE
            INK 2 : PRINT AT 20, 5; "THE WRAITHS GOT YOU...";
          ENDIF
          ei = 2
        CASE 2
          INK 7 : PRINT AT 21, 6; "PRESS FIRE FOR THE TITLE";
          ei = 3
        CASE ELSE
          IF tt > 20 AND fire AND (NOT pfire) THEN ENTER title ENDIF
      ENDSEL
    ENDIF
  ENDP
ENDSCENE
