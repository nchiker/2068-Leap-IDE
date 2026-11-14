"use strict";
// fast-boot.mjs -- the Arcade test machines: a stock TS2068 (TSRun) with a cartridge, built fast.
//
// V9 (boot once): the stock ROM's boot is the same for every cartridge until it first writes port $F4 or $FF (that
// is when it pages the dock in).  The ROM is booted once per process, with no cartridge, up to the start of the
// frame in which that first write happens (found dynamically, not hard-coded); the whole machine state is
// snapshotted there.  A machine for a case is a fresh TSRun machine restored from the snapshot with the case's DCK
// inserted.  A DCK with a HOME-bank block (it would change RAM or the HOME ROM before the boot) is booted cold.
//
// V8 (no picture unless a check looks at it): machines are made with video off (TSRun then advances the beam but paints
// nothing, which does not change the CPU's timing: no contention, no raster stall).  A check that reads the drawn
// screen (pixelsOf(m)) makes its machine with { video: true }; on a machine with video off, pixelsOf(m) throws.
//
// No dependencies besides TSRun.  Node can import this; nothing here touches the DOM.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const TSRUN = join(HERE, '../../tsrun');
export const M = await import(pathToFileURL(join(TSRUN, 'machine.js')).href);
const { parseDck } = await import(pathToFileURL(join(TSRUN, 'dock.js')).href);

const HOME_ROM = readFileSync(join(TSRUN, 'roms/ts2068-0.rom'));
const EX_ROM = readFileSync(join(TSRUN, 'roms/ts2068-1.rom'));
const must = (e) => { if (e) throw new Error(e); };

/** Machine fields that are not part of the state to restore: ROM images and the caller's key / stick arrays. */
const NOT_RESTORED = new Set(['homeRom', 'exRom', 'keyMatrix', 'joystick', 'dock', 'dockRam', 'exCart', 'exCartRam', 'homeCart', 'homeCartRam', 'homeRamSave']);

// ---- pixel guard (V8) ------------------------------------------------------------------------------------------
/**
 * The drawn screen of a machine (TSRun's frame buffer, one palette index per pixel, 640 x 240).  Every check that reads the picture goes
 * through this; it throws on a machine made with video off, which paints nothing, so a forgotten { video: true } fails loudly.
 * (The guard is a function, not an accessor on the machine: a property defined on the machine object slows TSRun's hot paths.)
 */
export function pixelsOf(m) {
  if (!m.videoOn) throw new Error('the screen was read on a machine with video off: create it with { video: true }');
  return m.pixels;
}

// ---- deep copy / in-place restore ------------------------------------------------------------------------------
/** Copy of a state value: typed arrays and arrays and plain objects recursively; functions are left out. */
function copyOf(v) {
  if (ArrayBuffer.isView(v)) return v.slice();
  if (Array.isArray(v)) return v.map(copyOf);
  if (v !== null && typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new Error(`fast-boot: cannot snapshot a ${proto.constructor?.name} (add it to copyOf)`);
    const o = {};
    for (const k of Object.keys(v)) if (typeof v[k] !== 'function') o[k] = copyOf(v[k]);
    return o;
  }
  return v;
}

/** Snapshot of a machine: every non-function field, recursively, but the ROMs, the caller's arrays and the cartridge. */
export function snapshotMachine(m) {
  const s = {};
  for (const k of Object.keys(m)) {
    if (NOT_RESTORED.has(k) || typeof m[k] === 'function') continue;
    s[k] = copyOf(m[k]);
  }
  return s;
}

/** Write a snapshot into machine `t` in place (typed arrays by .set, objects field by field), so closures stay bound. */
function restoreInto(t, s) {
  for (const k of Object.keys(s)) {
    const sv = s[k], tv = t[k];
    if (ArrayBuffer.isView(sv)) {
      if (ArrayBuffer.isView(tv) && tv.constructor === sv.constructor && tv.length === sv.length) tv.set(sv);
      else t[k] = sv.slice();
    } else if (Array.isArray(sv)) {
      t[k] = copyOf(sv);
    } else if (sv !== null && typeof sv === 'object') {
      if (tv !== null && typeof tv === 'object' && !Array.isArray(tv) && !ArrayBuffer.isView(tv)) restoreInto(tv, sv);
      else t[k] = copyOf(sv);
    } else {
      t[k] = sv;
    }
  }
}

// ---- machines --------------------------------------------------------------------------------------------------
const SKIPPED = new WeakMap();         // machine -> frames the snapshot had already run (0 for a cold boot)
/** Frames of the boot that were skipped by the snapshot: a cold boot counts frames from reset, add this to match it. */
export const bootSkip = (m) => SKIPPED.get(m) ?? 0;

function newBare(keyMatrix, joystick) {
  const m = M.createMachine(keyMatrix ?? new Uint8Array(9).fill(0x1F), joystick ?? new Uint8Array(2).fill(0xFF));
  must(M.setHomeRom(m, HOME_ROM));
  must(M.setExRom(m, EX_ROM));
  return m;
}

/** A machine booted from reset with the DCK inserted, the slow way: the reference of the snapshot path. */
export function coldMachine(dck, { keyMatrix, joystick, video = false } = {}) {
  const m = newBare(keyMatrix, joystick);
  must(M.insertDock(m, dck));
  M.resetMachine(m);
  M.setVideoOn(m, video);
  SKIPPED.set(m, 0);
  return m;
}

let _base = null;
/**
 * The snapshot, made once per process: boot with no cartridge, video off, one frame at a time, keeping the state at the
 * start of the previous frame; stop in the frame whose code first writes port $F4 or $FF and keep the state at its start.
 */
function baseSnapshot() {
  if (_base) return _base;
  const m = newBare();
  M.resetMachine(m);
  M.setVideoOn(m, false);
  let wrote = false;
  const ioWrite = m.bus.ioWrite;
  m.bus.ioWrite = (port, value) => {
    const p = port & 0xFF;
    if (p === 0xF4 || p === 0xFF) wrote = true;
    ioWrite(port, value);
  };
  let before = snapshotMachine(m), frames = 0;
  for (let f = 0; f < 400; f++) {
    before = snapshotMachine(m);
    frames = f;
    M.runFrame(m);
    if (wrote) return (_base = { state: before, frames });
  }
  throw new Error('fast-boot: the stock ROM never wrote port $F4 / $FF in 400 frames');
}

/** The frame (counted from reset) in whose run the stock ROM first writes port $F4 or $FF; the snapshot is its start. */
export const snapshotFrame = () => baseSnapshot().frames;

/** Can the DCK be inserted into a snapshot (no HOME-bank block, which would change memory the boot has already used)? */
function snapshotable(dck) {
  const parsed = parseDck(dck);
  return parsed.err === null && parsed.blocks.every((b) => b.bank === 0 || b.bank === 254);
}

/**
 * A machine as `coldMachine(dck)` would be after `snapshotFrame()` frames of boot, restored from the snapshot.  Same options
 * (a DCK the snapshot cannot take is booted cold: its machine then starts at frame 0 and bootSkip(m) is 0).
 */
export function bootedMachine(dck, { keyMatrix, joystick, video = false } = {}) {
  if (!snapshotable(dck)) return coldMachine(dck, { keyMatrix, joystick, video });
  const base = baseSnapshot();
  const m = newBare(keyMatrix, joystick);
  restoreInto(m, base.state);
  must(M.insertDock(m, dck));
  M.setVideoOn(m, video);
  SKIPPED.set(m, base.frames);
  return m;
}
