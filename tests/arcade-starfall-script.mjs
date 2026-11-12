"use strict";
// arcade-starfall-script.mjs -- the scripted game of tests/arcade-starfall.mjs (keys and joystick of every tick), shared with tests/arcade-codegen-perf.mjs. No side effects.
//
// The script: the title (the song FANFARE) for 40 ticks, fire starts the game (the song DRIVE on channels A and B), play with the ship shooting all the time (PLAY pew borrows channel C), enemy waves,
// lives lost (PLAY hurt), then the ship stands still and stops shooting until it is shot down: GAME OVER (NOMUSIC, then PLAY over), fire held through it (no restart until released and pressed again), a
// new game (DRIVE again).  It is tests/arcade-m4.mjs' shooterInput, 40 ticks later.
export const FULL_TICKS = 1340, QUICK_TICKS = 700;
export const T0 = 40;      // the title lasts this many ticks; fire is down from tick T0 + 1
export const input = (t) => {
  const keys = [];
  let stick = 0;
  if (t > T0) keys.push(32);      // fire, to leave the title (the play script below fires on its own)
  const s = t - T0;
  if (s < 1) return { keys: [], stick: 0 };
  const playing = s < 680 || s >= 1010;
  const out = [];
  if (s >= 940 && s < 1000) out.push(32);
  if (playing) {
    const useStick = (s >= 120 && s < 200) || (s >= 1100 && s < 1200);
    const ph = Math.floor(s / 23) % 4, left = ph === 0 || ph === 3, right = ph === 1 || ph === 2;
    const up = Math.floor(s / 61) % 3 === 0, dn = Math.floor(s / 97) % 3 === 1;
    if (useStick) stick = (left ? 4 : 0) | (right ? 8 : 0) | (up ? 1 : 0) | (dn ? 2 : 0) | 16;
    else { out.push(32); if (left) out.push(79); if (right) out.push(80); if (up) out.push(81); if (dn) out.push(65); }
  }
  return { keys: out, stick };
};
export const keysOf = (t) => input(t).keys;
export const stickOf = (t) => input(t).stick;
