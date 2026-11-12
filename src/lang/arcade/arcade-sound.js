/**
 * src/lang/arcade/arcade-sound.js — Leap Arcade: a model of the runtime's shared AY chip (effects and songs), for the reference interpreter (pure; no DOM, no node: imports).
 *
 *   createSoundChip(effects, songs) -> chip
 *     effects  [Uint8Array]  the effect images in SFX declaration order, exactly as the compiler stores them (convertSfx / convertSfxC)
 *     songs    [{patterns: [{bytes}], order, loop}]  convertMusic's parts in MUSIC declaration order (the compiler lays them out as loop, DW patterns, DW 0, streams)
 *   chip.play(i)  chip.silence()  chip.music(k)  chip.nomusic()     the main-thread calls RT_PLAY (A = i), RT_SILENCE, RT_MUSIC (HL = song k), RT_NOMUSIC
 *   chip.refresh()                                                   one frame interrupt (the sound tick)
 *   chip.regs()   -> [R0..R10]   what AY_SHADOW (= the chip) holds          chip.flags() -> V_SFX_ACTIVE (bit 0 SB_FX, 1 SB_MUS, 2 SB_SYNC)
 *   chip.effect() -> index of the effect playing or -1                     chip.song() -> index of the song playing or -1
 *
 * Written from docs/ARCADE_MUSIC_CONTRACT.md (sections 4 and 5a) and the header of arcade/runtime/v3/sound.asm, not from the Z80 code; the differential suites compare it with the
 * machine (tests/arcade-m15-differential.mjs, arcade/tests/m15-runtime-music.mjs has an independent model of its own). The rules it implements:
 *   - Effect types (byte 3 of the image): 3 = a three-channel delta stream, 4 = a channel-C stream (4 + byte 2, the noise flag: type 5 owns R6 too), anything else one channel (4-byte
 *     records, a second byte $FF ends it). Ownership while an effect plays: type 1 R0 R1 R6 R7 R8; type 3 all eleven; type 4 R4 R5 R10 and R7 shared (its bits $24 are the effect's, the others
 *     the song's); type 5 also R6. Type 1 writes a register only when it differs from the shadow, the streams write every pair they hold; a channel-C R7 keeps the chip's bits outside $24.
 *   - SYNC (SND_SYNC): with a song every register no effect owns goes to the song's value (shared R7: the song's bits outside $24 with the chip's $24); with no song the volumes R8-R10 no
 *     effect owns go to 0. Written only where the chip differs (the final state is all that is modelled here).
 *   - RT_PLAY / RT_SILENCE / RT_NOMUSIC sync the chip AT ONCE when nothing else is pending (no song, no request), else they post a request (SB_SYNC) that the next refresh honours first.
 *     RT_MUSIC writes nothing: the song's shadow starts as a copy of the chip and the song's first refresh writes all eleven registers. An index past the table: RT_PLAY changes nothing.
 *   - A refresh: the pending sync, then the effect's entry (its end: no owner, then a sync), then the song unless an effect of type 1 or 3 plays (it pauses the song, position kept): a wait
 *     counts down; else items are read: pairs go to the song's shadow and to every register no effect owns (shared R7 merged), `$80 + k` waits k more refreshes, $FF steps the order list in
 *     the same refresh (past the last entry: to `loop`, or with no loop the song ends: music off, then a sync, so its volumes go to 0).
 */

"use strict";

export const SB_FX = 1, SB_MUS = 2, SB_SYNC = 4;
const OWNED = { 1: [0, 1, 6, 7, 8], 3: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4: [4, 5, 10], 5: [4, 5, 6, 10] };
const C_BITS = 0x24;                                 // the channel-C bits of R7 (tone C off, noise C off)

export function createSoundChip(effects = [], songs = []) {
  const chip = new Array(11).fill(0);                // AY_SHADOW: the boot zeroes the AY and its shadow
  let mus = new Array(11).fill(0);                   // MUS_SHADOW
  let own = new Array(11).fill(0);                   // MUS_OWN: 0 the song's, 1 the effect's, 2 R7 shared with a channel-C effect
  let fx = null;                                     // {index, bytes, type, pos}
  let song = null;                                   // {index, s, ord, pat, at, wait}
  let pending = false;                               // SB_SYNC

  const ownFor = (type) => {
    const o = new Array(11).fill(0);
    for (const r of OWNED[type] ?? []) o[r] = 1;
    if (type >= 4) o[7] = 2;
    return o;
  };
  const sync = () => {
    if (song) {
      for (let r = 0; r <= 10; r++) {
        if (own[r] === 1) continue;
        chip[r] = own[r] === 2 ? (mus[r] & ~C_BITS & 0xFF) | (chip[7] & C_BITS) : mus[r];
      }
    } else for (let r = 8; r <= 10; r++) if (own[r] === 0) chip[r] = 0;
  };
  /** A main-thread call that gives registers back: at once when nothing else is pending, else at the next refresh. */
  const syncOrPost = () => { if (song || pending) pending = true; else sync(); };

  const fxEnd = () => { fx = null; own = ownFor(0); sync(); };
  const fxStep = () => {
    const b = fx.bytes;
    if (fx.type === 1) {
      const p = fx.pos; fx.pos += 4;
      if (b[p + 1] === 0xFF) { fxEnd(); return; }
      const mix = b[p + 2] >> 5;
      chip[0] = b[p]; chip[1] = b[p + 1] & 15; chip[6] = b[p + 2] & 31;
      chip[7] = 0x36 | (mix & 1) | ((mix & 2) << 2);
      chip[8] = b[p + 1] >> 4;
      return;
    }
    const n = b[fx.pos++];
    if (n === 0xFF) { fxEnd(); return; }
    for (let k = 0; k < n; k++) {
      const r = b[fx.pos++];
      let v = b[fx.pos++];
      if (fx.type >= 4 && r === 7) v = (v & C_BITS) | (chip[7] & ~C_BITS & 0xFF);
      chip[r] = v;
    }
  };
  const songStep = () => {
    const g = song;
    if (g.wait > 0) { g.wait--; return; }
    for (;;) {
      const bytes = g.s.patterns[g.pat].bytes, x = bytes[g.at++];
      if (x === 0xFF) {                              // the pattern's end: the next order entry, in this refresh
        if (++g.ord >= g.s.order.length) {
          if (g.s.loop === 0xFF) { song = null; sync(); return; }
          g.ord = g.s.loop;
        }
        g.pat = g.s.order[g.ord]; g.at = 0;
        continue;
      }
      if (x >= 0x80) { g.wait = x - 0x80; return; }  // $80 + k: this refresh and k more with no change
      for (let k = 0; k < x; k++) {
        const r = bytes[g.at++], v = bytes[g.at++];
        mus[r] = v;
        if (own[r] === 1) continue;
        chip[r] = own[r] === 2 ? (v & ~C_BITS & 0xFF) | (chip[7] & C_BITS) : v;
      }
      return;
    }
  };

  return {
    play(i) {
      if (i < 0 || i >= Math.min(effects.length, 8)) return;
      const bytes = effects[i];
      const type = bytes[3] === 3 ? 3 : bytes[3] === 4 ? 4 + (bytes[2] ? 1 : 0) : 1;
      own = ownFor(type);
      fx = null;                                     // (RT_PLAY looks at the other bits with SB_FX cleared)
      syncOrPost();
      fx = { index: i, bytes, type, pos: type === 1 ? 0 : 4 };
    },
    silence() { fx = null; own = ownFor(0); syncOrPost(); },
    music(k) {
      if (k < 0 || k >= songs.length || !songs[k]) return;
      if (!fx) own = ownFor(0);
      mus = chip.slice();
      const s = songs[k];
      song = { index: k, s, ord: 0, pat: s.order[0], at: 0, wait: 0 };
    },
    nomusic() {
      if (!song) return;
      song = null;
      if (fx || pending) pending = true; else sync();
    },
    refresh() {
      if (!fx && !song && !pending) return;
      if (pending) { pending = false; sync(); }
      if (fx) fxStep();
      if (song && !(fx && fx.type < 4)) songStep();
    },
    regs: () => chip.slice(),
    flags: () => (fx ? SB_FX : 0) | (song ? SB_MUS : 0) | (pending ? SB_SYNC : 0),
    effect: () => (fx ? fx.index : -1),
    song: () => (song ? song.index : -1),
  };
}
