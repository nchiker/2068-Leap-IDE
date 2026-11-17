"use strict";
// crabsmash-bot.mjs -- the bot that plays Crabsmash (arcade/examples/crabsmash.arc) in tests/arcade-crabsmash.mjs: it reads the game's variables and arrays out of the machine's RAM
// after every tick and decides the keys for the next one.  It does what a player does: it goes to the level BELOW the platform an enemy walks on, stands under it and jumps (a bump stuns),
// then walks into the stunned one; it climbs by jumping from the edge of a platform towards the next one, walks off an end to go down, and hops over live enemies that come close.
// Keys: O P (left, right), Q (jump); every fifth tick the joystick instead (left, right, up); SPACE or the joystick's fire on the title and the game over scene.
const S16 = (v) => ((v & 0xFFFF) ^ 0x8000) - 0x8000;
const PYS = [176, 144, 144, 104, 64, 64], PX0 = [0, 0, 176, 48, 0, 152], PX1 = [256, 80, 256, 208, 104, 256];
const LEVEL_OF = [0, 1, 1, 2, 3, 3];                 // the level (0 floor .. 3 top) of each platform
const PLAT_OF = [[0], [1, 2], [3], [4, 5]];          // the platforms of each level
const HY_OF = [160, 128, 88, 48];                    // the hero's y standing on each level

export function makeCrabsmashBot(res, { restartAt = 25, idleFrom = Infinity } = {}) {
  const VAR = (n) => res.map.vars[n], ARR = (n) => res.map.arrays[n].addr;
  const script = [];
  const st = { m: null, hold: 0, dir: 0, climbing: false };
  const rd = (m, a) => S16(m.ram[a] | (m.ram[a + 1] << 8));
  const v = (m, n) => rd(m, VAR(n)), arr = (m, n, i) => rd(m, ARR(n) + 2 * i);
  const platformOf = (hx, lvl) => PLAT_OF[lvl].find((p) => hx + 12 > PX0[p] && hx + 4 < PX1[p]) ?? -1;

  const decide = (k) => {
    const m = st.m, out = { keys: [], stick: 0 };
    if (!m) return out;
    if (k >= 6 && k <= 8) { out.keys.push(32); return out; }                                         // the title: fire starts the game
    if (rd(m, VAR('OVER.OW')) >= restartAt) { if (st.hold < 3) { st.hold++; out.stick = 16; } return out; }   // the game over scene: the joystick's fire
    if (k >= idleFrom) return out;
    if (v(m, 'PLAY.PZ') > 0) return out;
    const hx = v(m, 'PLAY.HX'), hy = v(m, 'PLAY.HY'), hair = v(m, 'PLAY.HAIR');
    let left = 0, right = 0, jump = 0;
    if (hair) {                                                                                       // in the air: go on in the direction chosen at the jump
      if (st.dir < 0) left = 1; else if (st.dir > 0) right = 1;
    } else {
      st.dir = 0;
      const lvl = Math.max(0, HY_OF.indexOf(hy)), hp = platformOf(hx, lvl);
      const en = [];
      for (let e = 0; e < 5; e++) {
        const s = arr(m, 'PLAY.EST', e);
        if (s > 0) en.push({ e, s, x: arr(m, 'PLAY.EX', e), y: arr(m, 'PLAY.EY', e), air: arr(m, 'PLAY.EAIR', e), p: arr(m, 'PLAY.EP', e), d: arr(m, 'PLAY.ED', e) });
      }
      // a live enemy about to touch: hop over it
      const danger = en.find((q) => q.s === 1 && Math.abs(q.y - hy) < 20 && Math.abs(q.x - hx) < 36 && ((q.x - hx) * (q.d) < 0 || Math.abs(q.x - hx) < 20));
      // the target: a stunned enemy on a platform, else a live one on a platform above the floor (the level below it is where to stand)
      const reach = (q) => {
        if (q.air && q.s === 1) return false;
        if (q.p < 1) return false;
        return true;
      };
      const stunned = en.filter((q) => q.s === 2 && reach(q)).sort((a, b) => Math.abs(LEVEL_OF[a.p] - lvl) - Math.abs(LEVEL_OF[b.p] - lvl) || Math.abs(a.x - hx) - Math.abs(b.x - hx));
      const live = en.filter((q) => q.s === 1 && q.p >= 1 && !q.air).sort((a, b) => Math.abs(LEVEL_OF[a.p] - 1 - lvl) - Math.abs(LEVEL_OF[b.p] - 1 - lvl) || Math.abs(a.x - hx) - Math.abs(b.x - hx));
      const tgt = stunned[0] ?? live[0];
      const goto_ = (x) => { if (hx < x) right = 1; else if (hx > x) left = 1; return hx === x; };
      const hop = (dir) => { jump = 1; st.dir = dir; if (dir < 0) left = 1; else if (dir > 0) right = 1; };
      const descend = () => {                                                                         // walk off the end that leads down
        const d = hp === 1 || hp === 4 ? 1 : hp === 2 || hp === 5 ? -1 : hp === 3 ? (hx < 128 ? -1 : 1) : (hx < 128 ? -1 : 1);
        if (d < 0) left = 1; else right = 1;
      };
      const climb = () => {
        if (lvl === 0) { if (hx < 128) { if (goto_(88)) hop(-1); } else if (goto_(164)) hop(1); }
        else if (lvl === 1) { if (hp === 1 || (hp < 0 && hx < 128)) { if (goto_(16)) hop(1); } else if (goto_(232)) hop(-1); }
        else if (lvl === 2) { if (hx < 130) { if (goto_(120)) hop(-1); } else if (goto_(140)) hop(1); }
      };
      if (danger && Math.abs(danger.x - hx) < 30 && Math.abs(danger.y - hy) < 16) {
        hop(danger.x > hx ? 1 : -1);                                                                  // over it (towards its side; it goes on past)
        st.dir = danger.x > hx ? 1 : -1;
      } else if (!tgt) {
        if (lvl > 0) descend(); else goto_(120);
      } else if (tgt.s === 2) {
        const tl = LEVEL_OF[tgt.p];
        if (tl > lvl) climb();
        else if (tl < lvl) descend();
        else if (hp === tgt.p) goto_(tgt.x); else descend();                                          // not on its platform (the other tier-3 side): go round
      } else {
        const tl = LEVEL_OF[tgt.p] - 1;                                                               // stand on the level below its platform, under it
        if (tl > lvl) climb();
        else if (tl < lvl) descend();
        else {
          // stand within 12 pixels of it, under its platform, and jump
          if (Math.abs(tgt.x - hx) <= 12 && PLAT_OF[LEVEL_OF[tgt.p]].includes(tgt.p) && hx + 12 > PX0[tgt.p] && hx + 4 < PX1[tgt.p]) jump = 1;
          else if (tgt.x > hx) right = 1; else left = 1;
        }
      }
    }
    const useStick = k % 5 === 0;
    if (useStick) { out.stick = (left ? 4 : 0) | (right ? 8 : 0) | (jump ? 1 : 0); } else { if (left) out.keys.push(79); if (right) out.keys.push(80); if (jump) out.keys.push(81); }
    return out;
  };
  return {
    script,
    hooks: { afterTick: (k, m) => { st.m = m; } },
    keys: (k) => { script[k - 1] ??= decide(k); return script[k - 1].keys; },
    stick: (k) => { script[k - 1] ??= decide(k); return script[k - 1].stick; },
  };
}
