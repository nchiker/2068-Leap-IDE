/**
 * src/emulator.js — TSRun TS2068 running Leap V2, driven for the IDE.
 *
 * A slim stand-in for TSRun's host.js (which is wired to the emulator page's
 * desk UI): it owns the machine, the WebGL screen, sound, the keyboard
 * (src/pc-keyboard.js) and the frame loop. On top of that it runs programs by
 * RAM injection:
 *
 *  1. Wait for a safe point: the ROM's key wait (IO_READ_KEY.wait_hit), where
 *     the editor idles, INPUT and PAUSE 0 wait, and a finished run waits for
 *     "press a key". A busy program is first stopped with BREAK; if that does
 *     not land on the key wait, the machine is reset and booted to it.
 *  2. Write the line store at PROG_AREA_START and set PROG_END.
 *  3. Point SP at a return chain on the ROM's own stack and jump in:
 *       V2_CLEAR_ARRAYS -> V2_RESET_EDIT -> V2_RUN_STORED -> V2_COMMAND_LOOP.loop
 *     The first two are what LOAD does after replacing a program; the third is
 *     what typing RUN calls. No code is written to RAM outside the stack.
 *
 * Addresses come from src/leap-roms.js and are checked against the ROM hash.
 *
 * Programs are written in the IDE's editor, never in Leap's own: keys reach
 * the TS2068 only while an injected program is running (INPUT, INKEY$,
 * PAUSE 0) and the screen has focus. When a run ends its output stays up,
 * because no keypress can dismiss it into the Leap editor.
 */

"use strict";

import {
  createMachine, setHomeRom, setExRom, resetMachine, runFrame,
  setVideoOn, enableSound, setSoundRate, takeAudio,
  cpuHz, tStatesPerFrame, homeRomSize, exRomSize,
} from '../tsrun/machine.js';
import { runZ80 } from '../tsrun/z80.js';
import { initScreen, resizeScreen, setCrt, drawScreen } from '../tsrun/screen.js';
import {
  initSound, resumeSound, soundWantsFrame, soundIsRunning,
  setSoundNeedCallback, setSoundStateCallback, pushSound,
} from '../tsrun/sound.js';
import { identifyRoms } from './leap-roms.js';
import { createPcKeyboard } from './pc-keyboard.js';

// TSRun is linked into the project as ./tsrun (see README); fetched files are
// resolved against this module so the page's own location does not matter.
const TSRUN_URL = new URL('../tsrun/', import.meta.url);

const FRAMES_PER_SECOND = cpuHz / tStatesPerFrame;
const FRAME_MS          = 1000 / FRAMES_PER_SECOND;

// The ROM's machine stack starts at $FF00 (manual, Appendix E) and the Leap
// test harness calls V2_RUN_STORED with SP there too. A run that has ended
// (finished, compile error, runtime error, BREAK) waits for a key with SP back
// at STACK_TOP; INPUT and PAUSE 0 wait deeper. Checked on 2.0.2-emu.1.
const STACK_TOP  = 0xFF00;
const CHAIN_BASE = STACK_TOP - 4;   // two return addresses below STACK_TOP's own

const SEEK_FRAMES  = 2;     // frames to wait for the key wait before pressing BREAK
const BREAK_FRAMES = 60;    // frames to hold BREAK before resetting instead
const BOOT_FRAMES  = 300;   // reset to editor takes 66 frames on 2.0.2-emu.1

// TS2068 port bits that page the EXROM into chunk 6 ($C000-$DFFF), where the
// shell routines above live. Both are set whenever the editor or VM runs.
const PORT_F4_CHUNK6 = 0x40;
const PORT_FF_EXROM  = 0x80;

// Matrix rows/bits for BREAK (CAPS SHIFT + SPACE); the matrix is active low.
const CAPS_SHIFT = { row: 0, bit: 0 };
const SPACE      = { row: 7, bit: 0 };

/**
 * @typedef {'booting'|'ready'|'running'|'waiting'|'ended'|'stopped'|'paused'|'error'} EmuState
 * @typedef {{compileError: number, vmError: number, line: number}} RunResult
 *
 * @param {{
 *   canvas: HTMLCanvasElement,
 *   focusEl: HTMLElement,              // receives keys while focused
 *   onState: function(EmuState, object=): void,
 * }} opts
 */
export async function createEmulator(opts) {
  const keyMatrix = new Uint8Array(8).fill(0x1F);
  const joystick  = new Uint8Array(2).fill(0xFF);   // no gamepads in the IDE

  const emu = {
    machine:  createMachine(keyMatrix, joystick),
    keyMatrix,
    kbd:      createPcKeyboard(keyMatrix),
    gfx:      null,
    sfx:      null,
    rom:      null,       // entry from KNOWN_ROMS
    state:    'booting',
    runActive: false,     // an injected program has not yet ended
    pending:  null,       // {kind: 'run'|'stop', store?, stage, frames}
    paused:   false,      // debugger: the machine holds where it is
    watch:    null,       // debugger: function(machine) -> true to pause before the next instruction
    oneShot:  null,       // debugger: like watch, removed after it fires (pause())
    skipWatch: false,     // let the instruction a pause stopped at run once on resume
    pausedFrom: null,     // the state to return to when a pause ends
    lastNow:  0,
    carryMs:  0,
    onState:  opts.onState,
  };

  await loadRoms(emu);
  initDisplay(emu, opts.canvas);
  initAudio(emu);
  initKeys(emu, opts.focusEl);

  resetMachine(emu.machine);
  requestAnimationFrame(now => onFrame(emu, now));

  return {
    /** Queue a run of an encoded line store (see encodeLineStore). */
    run(store)   { unpause(emu); emu.pending = { kind: 'run', store, stage: 'seek', frames: 0 }; },
    /** Stop the running program: BREAK if busy, back to the editor if waiting. */
    stop()       { unpause(emu); if (emu.runActive) emu.pending = { kind: 'stop', stage: 'seek', frames: 0 }; },
    /** Hard reset; the ROM boots to its editor. */
    reset()      { hardReset(emu); emu.paused = false; setState(emu, 'booting'); },

    // ── Debugger ──
    /**
     * Install a test run before every instruction while it is set (null to
     * remove). Returning true pauses the machine before that instruction.
     */
    setWatch(fn) { emu.watch = fn; },
    /** Pause at the next instruction outside the frame interrupt handler. */
    pause()      { if (!emu.paused) emu.oneShot = m => m.cpu.iff1; },
    /** Continue from a pause. */
    resume()     { if (emu.paused) { emu.paused = false; emu.skipWatch = true; setState(emu, emu.pausedFrom); } },
    /** While paused, execute exactly one Z80 instruction. */
    stepInstruction() { if (emu.paused) stepOneInstruction(emu); },
    get paused() { return emu.paused; },
    get rom()    { return emu.rom; },
    get machine() { return emu.machine; },
  };
}

/**
 * Leap V2's line store: per line, LE16 (length + 1), the text, then $0D.
 * This is exactly what the ROM's editor stores (V2_TOKENIZE copies verbatim).
 *
 * @param {string[]} lines
 * @returns {Uint8Array}
 */
export function encodeLineStore(lines) {
  let size = 0;
  for (const l of lines) size += l.length + 3;
  const out = new Uint8Array(size);
  let p = 0;
  for (const l of lines) {
    out[p++] = (l.length + 1) & 0xFF;
    out[p++] = (l.length + 1) >> 8;
    for (let i = 0; i < l.length; i++) out[p++] = l.charCodeAt(i);
    out[p++] = 0x0D;
  }
  return out;
}

// ── Setup ──────────────────────────────────────────────────────────

async function fetchBytes(name, size) {
  const url = new URL(name, TSRUN_URL);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Could not load ${url} (HTTP ${resp.status})`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (size !== undefined && bytes.length !== size) {
    throw new Error(`${url}: expected ${size} bytes, got ${bytes.length}`);
  }
  return bytes;
}

async function loadRoms(emu) {
  const [home, exrom] = await Promise.all([
    fetchBytes('roms/leap-0.rom', homeRomSize),
    fetchBytes('roms/leap-1.rom', exRomSize),
  ]);
  const { hash, rom } = await identifyRoms(home, exrom);
  if (rom === null) {
    throw new Error(`Unknown Leap ROM pair (SHA-256 ${hash}). ` +
      'Add it to src/leap-roms.js with tools/leap-rom-entry.py.');
  }
  emu.rom = rom;
  setHomeRom(emu.machine, home);
  setExRom(emu.machine, exrom);
}

function initDisplay(emu, canvas) {
  Promise.all([
    fetch(new URL('screen.vert.glsl', TSRUN_URL)).then(r => r.text()),
    fetch(new URL('screen.frag.glsl', TSRUN_URL)).then(r => r.text()),
  ]).then(([vert, frag]) => {
    initScreen(canvas, { vert, frag }, (err, gfx) => {
      if (err !== null || gfx === null) {
        setState(emu, 'error', { message: err ?? 'No graphics context' });
        return;
      }
      emu.gfx = gfx;
      setCrt(gfx, false);   // sharp pixels read better next to an editor
    });
  });
  // screen.js fits the canvas to its parent box.
  new ResizeObserver(() => { if (emu.gfx) resizeScreen(emu.gfx); })
    .observe(canvas.parentElement);
}

function initAudio(emu) {
  initSound(FRAMES_PER_SECOND, (err, sfx) => {
    if (err !== null || sfx === null) {
      console.warn('[emulator] no sound:', err);
      return;
    }
    emu.sfx = sfx;
    setSoundNeedCallback(sfx, () => fillSoundQueue(emu));
    setSoundRate(emu.machine, sfx.context.sampleRate);
    setSoundStateCallback(sfx, running => enableSound(emu.machine, running));
    enableSound(emu.machine, soundIsRunning(sfx));
  });
  // Browsers keep audio suspended until a user gesture.
  const resume = () => { if (emu.sfx) resumeSound(emu.sfx); };
  window.addEventListener('pointerdown', resume);
  window.addEventListener('keydown', resume);
}

function initKeys(emu, focusEl) {
  // Unlike TSRun's page, keys reach the TS2068 only while the screen has focus
  // and a program is running, so nothing ever types into Leap's own editor.
  focusEl.addEventListener('keydown', e => { if (emu.runActive) emu.kbd.keyDown(e); });
  focusEl.addEventListener('keyup',   e => emu.kbd.keyUp(e));
  focusEl.addEventListener('blur',    () => emu.kbd.releaseAll());
  focusEl.addEventListener('pointerdown', () => focusEl.focus());
}

// ── Frame loop (after host.js onFrame / stepMachine) ──────────────

function onFrame(emu, now) {
  requestAnimationFrame(next => onFrame(emu, next));
  if (emu.lastNow === 0) {
    emu.lastNow = now;
    emu.carryMs = FRAME_MS;
  }
  // Cap the catch-up so a backgrounded tab does not fast-forward on return.
  emu.carryMs += Math.min(now - emu.lastNow, 80);
  emu.lastNow = now;
  let ran = 0;
  while (emu.carryMs >= FRAME_MS && ran < 4) {
    stepMachine(emu);
    emu.carryMs -= FRAME_MS;
    ran++;
  }
  if (emu.gfx) drawScreen(emu.gfx, emu.machine.pixels);
}

// The audio worklet asks for frames when its queue runs low; they count
// against the wall-clock budget so the display loop does not run them twice.
function fillSoundQueue(emu) {
  if (!emu.sfx || !soundIsRunning(emu.sfx) || emu.paused) return;
  for (let ran = 0; ran < 4 && soundWantsFrame(emu.sfx); ran++) {
    stepMachine(emu);
    emu.carryMs = Math.max(emu.carryMs - FRAME_MS, -4 * FRAME_MS);
  }
}

function stepMachine(emu) {
  if (emu.paused) return;
  const m = emu.machine;
  const seen = runWatched(emu);
  if (seen === 'paused') return;     // stopped part way through the frame
  if (seen !== 'wait') {
    if (emu.pending) advancePending(emu);
    else if (emu.runActive) setState(emu, 'running');
  }
  setVideoOn(m, true);
  enableSound(m, emu.sfx !== null && soundIsRunning(emu.sfx));
  runFrame(m);   // runs the rest of the frame, then takes the frame interrupt
  const chunk = takeAudio(m);
  if (chunk.n > 0 && emu.sfx && soundIsRunning(emu.sfx)) pushSound(emu.sfx, chunk);
}

/**
 * Execute this frame one instruction at a time (runZ80 with a budget of 1
 * executes exactly one), so that:
 *  - the ROM's key wait is noticed (atKeyWait: run/stop/state), and
 *  - the debugger's watch can pause before any instruction.
 * Without a watch the frame is handed to runFrame() as soon as the key wait
 * has been seen; runFrame() always finishes the frame and takes the interrupt.
 *
 * @returns {'wait'|'busy'|'paused'}
 */
function runWatched(emu) {
  const m = emu.machine, cpu = m.cpu, rom = emu.rom;
  const end = m.frameStart + tStatesPerFrame;
  let seen = 'busy';
  while (m.tstates < end) {
    if (seen === 'busy' && cpu.pc >= rom.keyWait && cpu.pc < rom.keyWaitEnd &&
        (m.portF4 & PORT_F4_CHUNK6) && (m.portFF & PORT_FF_EXROM)) {
      seen = 'wait';
      atKeyWait(emu);
      if (!emu.watch && !emu.oneShot) return seen;
    }
    if (cpu.halted || cpu.nmiPending) break;           // leave these to runFrame
    if (!emu.skipWatch && ((emu.oneShot && emu.oneShot(m)) || (emu.watch && emu.watch(m)))) {
      emu.oneShot = null;
      enterPause(emu);
      return 'paused';
    }
    emu.skipWatch = false;
    runZ80(cpu, m.bus, 1, m);
  }
  return seen;
}

/** Leave a pause without announcing a state; the caller's action decides it. */
function unpause(emu) {
  if (!emu.paused) return;
  emu.paused = false;
  emu.skipWatch = true;
  emu.state = emu.pausedFrom;
}

function enterPause(emu) {
  emu.paused = true;
  emu.pausedFrom = emu.state === 'paused' ? emu.pausedFrom : emu.state;
  setState(emu, 'paused', { pc: emu.machine.cpu.pc });
}

/** One instruction while paused; finishes the frame if that crossed its end. */
function stepOneInstruction(emu) {
  const m = emu.machine;
  runZ80(m.cpu, m.bus, 1, m);
  if (m.tstates >= m.frameStart + tStatesPerFrame) {
    runFrame(m);       // nothing left to run: paints, mixes and takes the interrupt
    takeAudio(m);
  }
  setState(emu, 'paused', { pc: m.cpu.pc });
}

function atKeyWait(emu) {
  const p = emu.pending;
  if (p && p.stage === 'break') releaseBreak(emu);
  const ended = emu.machine.cpu.sp === STACK_TOP;

  if (p && p.kind === 'run') {
    emu.pending = null;
    inject(emu, p.store);
    emu.runActive = true;
    setState(emu, 'running');
    return;
  }
  if (p && p.kind === 'stop') {
    emu.pending = null;
    if (emu.runActive && !ended) {
      // Waiting at INPUT / PAUSE 0: return to the editor directly.
      jumpTo(emu, emu.rom.commandLoop, STACK_TOP + 2);
      endRun(emu);
      setState(emu, 'stopped');
      return;
    }
  }
  if (emu.runActive) {
    if (ended) {
      endRun(emu);
      setState(emu, 'ended', readResult(emu));
    } else {
      setState(emu, 'waiting');
    }
  } else if (emu.state === 'booting') {
    setState(emu, 'ready');
  }
}

/** Not at the key wait while a run or stop is queued: escalate. */
function advancePending(emu) {
  const p = emu.pending;
  p.frames++;
  if (p.stage === 'seek' && p.frames >= SEEK_FRAMES) {
    pressBreak(emu);
    p.stage = 'break';
    p.frames = 0;
  } else if (p.stage === 'break' && p.frames >= BREAK_FRAMES) {
    releaseBreak(emu);
    hardReset(emu);
    p.stage = 'reset';
    p.frames = 0;
  } else if (p.stage === 'reset' && p.frames >= BOOT_FRAMES) {
    emu.pending = null;
    setState(emu, 'error', { message: 'The ROM did not reach its editor after a reset' });
  }
}

function pressBreak(emu) {
  emu.keyMatrix[CAPS_SHIFT.row] &= ~(1 << CAPS_SHIFT.bit);
  emu.keyMatrix[SPACE.row]      &= ~(1 << SPACE.bit);
}

function releaseBreak(emu) {
  emu.kbd.sync();   // rebuild the matrix from the keys the user actually holds
  // The ROM latched BREAK as a keypress; drop it, or it would dismiss the
  // BREAK message the moment it appears.
  emu.machine.bus.write(emu.rom.kbdKeyHit, 0);
}

function hardReset(emu) {
  endRun(emu);
  resetMachine(emu.machine);
}

/**
 * The program is over: stop passing keys, let go of any still held, and drop
 * a key the ROM latched during the run (e.g. the user's BREAK), which would
 * otherwise dismiss the final screen into the Leap editor.
 */
function endRun(emu) {
  emu.runActive = false;
  emu.kbd.releaseAll();
  emu.machine.bus.write(emu.rom.kbdKeyHit, 0);
}

// ── Injection ──────────────────────────────────────────────────────

function poke16(m, addr, value) {
  m.bus.write(addr, value & 0xFF);
  m.bus.write(addr + 1, (value >> 8) & 0xFF);
}

function inject(emu, store) {
  const m = emu.machine, rom = emu.rom;
  // Writes go through the bus so they land where the CPU would see them.
  for (let i = 0; i < store.length; i++) m.bus.write(rom.progAreaStart + i, store[i]);
  poke16(m, rom.progEnd, rom.progAreaStart + store.length);
  // Return chain: CLEAR_ARRAYS returns into RESET_EDIT, which returns into
  // RUN_STORED, which returns into the command loop.
  poke16(m, CHAIN_BASE,     rom.resetEdit);
  poke16(m, CHAIN_BASE + 2, rom.runStored);
  poke16(m, STACK_TOP,      rom.commandLoop);
  jumpTo(emu, rom.clearArrays, CHAIN_BASE);
}

function jumpTo(emu, pc, sp) {
  const cpu = emu.machine.cpu;
  cpu.sp = sp;
  cpu.pc = pc;
  cpu.halted = false;
}

function readResult(emu) {
  const m = emu.machine, rom = emu.rom;
  return {
    compileError: m.bus.read(rom.compileErrorCode),
    vmError:      m.bus.read(rom.vmErrorCode),
    // After a compile error the ROM moves the edit cursor to the failing line
    // (an index into the store; the line count for end-of-source errors).
    line:         m.bus.read(rom.curEditIndex) | (m.bus.read(rom.curEditIndex + 1) << 8),
  };
}

function setState(emu, state, detail) {
  if (state === emu.state && detail === undefined) return;
  emu.state = state;
  emu.onState(state, detail);
}
