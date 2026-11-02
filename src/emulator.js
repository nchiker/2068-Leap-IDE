/**
 * src/emulator.js — TSRun TS2068 running a Leap ROM, driven for the IDE.
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
 *  2. Hand the job to the language profile's driver (src/lang/<id>/profile.js,
 *     driver.inject), which writes the program into RAM and jumps into the ROM
 *     (Leap V2 BASIC: the line store, then a return chain on the ROM's own
 *     stack into what typing RUN calls).
 *
 * The profile also says whether the key wait is a safe point (paging), whether
 * a run has ended or waits for keys, how to end a wait and how to read the
 * result. Addresses come from the profile's ROM table, keyed by the ROM hash.
 *
 * Programs are written in the IDE's editor. In Leap V2 BASIC keys reach the
 * TS2068 only while an injected program is running (INPUT, INKEY$, PAUSE 0)
 * and the screen has focus, so nothing types into the ROM's own editor, and a
 * run's output stays up when it ends. A profile can let keys pass all the
 * time (keyboard.always).
 *
 * Cartridge test (testCartridge): the same machine with the stock TS2068 ROMs
 * and a .dck in the dock, as a real TS2068 with a cartridge. The stock ROM
 * starts the cartridge by itself; keys always reach the machine (the cartridge
 * has no editor, and a key after the end restarts its program). Run, Stop and
 * Reset put the profile's ROMs back.
 */

"use strict";

import {
  createMachine, setHomeRom, setExRom, resetMachine, runFrame,
  setVideoOn, enableSound, setSoundRate, takeAudio,
  cpuHz, tStatesPerFrame, homeRomSize, exRomSize, insertDock, ejectDock,
} from '../tsrun/machine.js';
import { runZ80 } from '../tsrun/z80.js';
import { initScreen, resizeScreen, setCrt, drawScreen } from '../tsrun/screen.js';
import {
  initSound, resumeSound, soundWantsFrame, soundIsRunning,
  setSoundNeedCallback, setSoundStateCallback, pushSound,
} from '../tsrun/sound.js';
import { createPcKeyboard } from './pc-keyboard.js';

// TSRun is linked into the project as ./tsrun (see README); fetched files are
// resolved against this module so the page's own location does not matter.
const TSRUN_URL = new URL('../tsrun/', import.meta.url);

const FRAMES_PER_SECOND = cpuHz / tStatesPerFrame;
const FRAME_MS          = 1000 / FRAMES_PER_SECOND;

const SEEK_FRAMES  = 2;     // frames to wait for the key wait before pressing BREAK
const BREAK_FRAMES = 60;    // frames to hold BREAK before resetting instead
const BOOT_FRAMES  = 300;   // reset to editor takes 66 frames on 2.0.2-emu.1

// Matrix rows/bits for BREAK (CAPS SHIFT + SPACE); the matrix is active low.
const CAPS_SHIFT = { row: 0, bit: 0 };
const SPACE      = { row: 7, bit: 0 };

/**
 * @typedef {'booting'|'ready'|'running'|'waiting'|'ended'|'stopped'|'paused'|'cartridge'|'error'} EmuState
 *
 * @param {{
 *   profile: object,                   // the language profile (src/lang/profiles.js)
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
    kbd:      createPcKeyboard(keyMatrix, opts.profile.keyboard.symbols),
    gfx:      null,
    crt:      false,
    sfx:      null,
    profile:  opts.profile,
    rom:      null,       // the profile's ROM entry for the loaded pair
    romImages: null,      // {home, exrom} of the profile's ROMs
    state:    'booting',
    runActive: false,     // an injected program has not yet ended
    pending:  null,       // {kind: 'run'|'stop', job?, stage, frames}
    job:      null,       // the running job (the driver's; Forth keeps its progress in it)
    paused:   false,      // debugger: the machine holds where it is
    watch:    null,       // debugger: function(machine) -> true to pause before the next instruction
    oneShot:  null,       // debugger: like watch, removed after it fires (pause())
    skipWatch: false,     // let the instruction a pause stopped at run once on resume
    pausedFrom: null,     // the state to return to when a pause ends
    cart:     false,      // a cartridge test: stock ROMs and a .dck in the dock
    stockImages: null,    // {home, exrom} of the stock TS2068, fetched on the first cartridge test
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
    /**
     * Queue a run. The job is the profile's (attach().startRun()); its driver
     * writes it into RAM at the next safe point.
     */
    run(job) {
      unpause(emu);
      // Out of a cartridge test the ROMs boot first: wait for the key wait
      // (stage 'reset') instead of pressing BREAK.
      const stage = emu.cart ? 'reset' : 'seek';
      if (emu.cart) leaveCartridge(emu);
      emu.pending = { kind: 'run', job, stage, frames: 0 };
    },
    /**
     * Switch language: the profile's ROM pair goes in and the machine boots
     * (a cartridge test ends first). Rejects for an unknown ROM pair, and the
     * previous language stays.
     */
    async setProfile(profile) {
      const loaded = await fetchProfileRoms(profile);
      unpause(emu);
      emu.pending = null;
      if (emu.cart) { ejectDock(emu.machine); emu.cart = false; }
      releaseKeys(emu);
      emu.profile = profile;
      emu.rom = loaded.rom;
      emu.romImages = loaded.images;
      emu.kbd.setSymbols(profile.keyboard.symbols);
      restoreRoms(emu);
      hardReset(emu);
      emu.paused = false;
      setState(emu, 'booting');
    },
    get profile() { return emu.profile; },
    /** Stop the running program: BREAK if busy, back to the editor if waiting. A cartridge test ends. */
    stop() {
      unpause(emu);
      if (emu.cart) { leaveCartridge(emu); setState(emu, 'booting'); return; }
      if (emu.runActive) emu.pending = { kind: 'stop', stage: 'seek', frames: 0 };
    },
    /** Hard reset; the ROM boots to its editor. A cartridge test ends. */
    reset() {
      if (emu.cart) leaveCartridge(emu);
      else hardReset(emu);
      emu.paused = false;
      setState(emu, 'booting');
    },
    /**
     * Cartridge test: the stock TS2068 ROMs with this .dck in the dock, then a
     * reset, as switching on a TS2068 with the cartridge in. Rejects with
     * TSRun's message if the dock image cannot be read (the Leap ROMs stay).
     * symbols: the SYMBOL SHIFT table the cartridge's own keyboard decoder
     * expects (a Forth cartridge's), else the active profile's.
     */
    async testCartridge(dck, symbols = null) {
      if (!emu.stockImages) {
        const [home, exrom] = await Promise.all([
          fetchBytes('roms/ts2068-0.rom', homeRomSize),
          fetchBytes('roms/ts2068-1.rom', exRomSize),
        ]);
        emu.stockImages = { home, exrom };
      }
      const m = emu.machine;
      unpause(emu);
      emu.pending = null;
      releaseKeys(emu);
      setHomeRom(m, emu.stockImages.home);
      setExRom(m, emu.stockImages.exrom);
      const err = insertDock(m, dck);
      if (err !== null) {
        restoreRoms(emu);
        resetMachine(m);
        setState(emu, 'booting');
        throw new Error(`Not a cartridge the TS2068 can take: ${err}`);
      }
      emu.cart = true;
      emu.kbd.setSymbols(symbols ?? emu.profile.keyboard.symbols);
      resetMachine(m);
      setState(emu, 'cartridge');
    },
    /** True during a cartridge test. */
    get cartridge() { return emu.cart; },

    // ── Debugger ──
    /**
     * Install a test run before every instruction while it is set (null to
     * remove). Returning true pauses the machine before that instruction.
     */
    setWatch(fn) { emu.watch = fn; },
    /** fn(machine) at every key wait the frame loop notices (the language's ROMs, not a cartridge). */
    onKeyWait(fn) { emu.keyWaitHook = fn; },
    /** Pause at the next instruction outside the frame interrupt handler. */
    pause()      { if (!emu.paused) emu.oneShot = m => m.cpu.iff1; },
    /** Continue from a pause. */
    resume()     { if (emu.paused) { emu.paused = false; emu.skipWatch = true; setState(emu, emu.pausedFrom); } },
    /** While paused, execute exactly one Z80 instruction. */
    stepInstruction() { if (emu.paused) stepOneInstruction(emu); },
    get paused() { return emu.paused; },
    /** TSRun's CRT filter: rounded, slightly blended pixels and scanlines. */
    setCrt(on)   { emu.crt = on; if (emu.gfx) { setCrt(emu.gfx, on); resizeScreen(emu.gfx); } },
    get rom()    { return emu.rom; },
    /** The ROM images in use (for the checker's own machine). */
    get romImages() { return emu.romImages; },
    get machine() { return emu.machine; },
  };
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

/**
 * SHA-256 of HOME followed by EXROM, as hex: the key of a profile's ROM table.
 * @returns {Promise<string>}
 */
export async function romPairHash(home, exrom) {
  const both = new Uint8Array(home.length + exrom.length);
  both.set(home);
  both.set(exrom, home.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', both));
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}

/** Fetch a profile's ROM pair and find its entry; an unknown pair is refused. */
async function fetchProfileRoms(profile) {
  const [home, exrom] = await Promise.all([
    fetchBytes(profile.romFiles.home, homeRomSize),
    fetchBytes(profile.romFiles.exrom, exRomSize),
  ]);
  const hash = await romPairHash(home, exrom);
  const rom = profile.knownRoms[hash];
  if (!rom) throw new Error(`Unknown ${profile.name} ROM pair (SHA-256 ${hash}). ${profile.romHint}`);
  return { rom, images: { home, exrom } };
}

async function loadRoms(emu) {
  const loaded = await fetchProfileRoms(emu.profile);
  emu.rom = loaded.rom;
  emu.romImages = loaded.images;
  restoreRoms(emu);
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
      setCrt(gfx, emu.crt);
      resizeScreen(gfx);
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
  // and (unless the profile lets them pass always) a program is running, so
  // nothing types into Leap V2's own editor. A cartridge has no editor: there
  // keys always pass.
  focusEl.addEventListener('keydown', e => {
    if (emu.runActive || emu.cart || emu.profile.keyboard.always) emu.kbd.keyDown(e);
  });
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
  // A cartridge test has no key wait to look for; it single-steps only for
  // the debugger (Z80 breakpoints, Pause).
  const seen = emu.cart && !emu.watch && !emu.oneShot ? 'busy' : runWatched(emu);
  if (seen === 'paused') return;     // stopped part way through the frame
  if (seen !== 'wait' && !emu.cart) {
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
    if (seen === 'busy' && !emu.cart && cpu.pc >= rom.keyWait && cpu.pc < rom.keyWaitEnd &&
        emu.profile.driver.safe(m, rom)) {
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
  const p = emu.pending, m = emu.machine, drv = emu.profile.driver;
  if (emu.keyWaitHook) emu.keyWaitHook(m);
  const ended = emu.runActive && drv.runState(m, emu.rom) === 'ended';

  if (p && p.kind === 'run' && drv.canInject && !drv.canInject(m, emu.rom)) {
    // Not a key wait the profile can start from (Forth: a word waiting in
    // KEY): BREAK it first, as for a busy program.
    if (p.stage === 'seek') { pressBreak(emu); p.stage = 'break'; p.frames = 0; }
    else advancePending(emu);
    return;
  }
  if (p && p.kind === 'run') {
    if (p.stage === 'break') releaseBreak(emu);
    emu.pending = null;
    emu.job = p.job;
    drv.inject(m, emu.rom, p.job);
    emu.runActive = true;
    setState(emu, 'running');
    return;
  }
  if (p && p.kind === 'stop') {
    if (emu.runActive && !ended) {
      // Waiting for keys: the profile ends the wait directly (Leap V2 BASIC),
      // or BREAK is held until the run ends (advancePending resets after
      // BREAK_FRAMES if it never does).
      if (drv.stopWaiting(m, emu.rom)) {
        if (p.stage === 'break') releaseBreak(emu);
        emu.pending = null;
        endRun(emu);
        setState(emu, 'stopped');
      } else if (p.stage !== 'break') {
        pressBreak(emu);
        p.stage = 'break';
        p.frames = 0;
      } else {
        advancePending(emu);
      }
      return;
    }
    if (p.stage === 'break') releaseBreak(emu);
    emu.pending = null;
  }
  if (emu.runActive) {
    // A driver that sends its job in parts (Forth: one line at a time) goes on.
    if (ended && !p && drv.next && drv.next(m, emu.rom, emu.job)) {
      setState(emu, 'running');
      return;
    }
    if (ended) {
      endRun(emu);
      setState(emu, 'ended', drv.result(m, emu.rom, emu.job));
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
  } else if (p.stage === 'break' && p.frames === emu.profile.driver.breakHold) {
    // The ROM latched BREAK in its interrupt (Leap-C, Forth): let go, so a
    // wait for all keys to be released (Leap-C's report) can end.
    releaseBreak(emu);
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

/** Let go of every key and stop passing them on. */
function releaseKeys(emu) {
  emu.runActive = false;
  emu.kbd.releaseAll();
}

function restoreRoms(emu) {
  setHomeRom(emu.machine, emu.romImages.home);
  setExRom(emu.machine, emu.romImages.exrom);
}

/** End a cartridge test: empty the dock, put the profile's ROMs back and reset. */
function leaveCartridge(emu) {
  releaseKeys(emu);
  emu.kbd.setSymbols(emu.profile.keyboard.symbols);
  ejectDock(emu.machine);
  restoreRoms(emu);
  emu.cart = false;
  emu.pending = null;
  resetMachine(emu.machine);
}

/**
 * The program is over: stop passing keys, let go of any still held, and drop
 * a key the ROM latched during the run (e.g. the user's BREAK), which would
 * otherwise dismiss the final screen into the Leap editor.
 */
function endRun(emu) {
  releaseKeys(emu);
  emu.machine.bus.write(emu.rom.kbdKeyHit, 0);
}

function setState(emu, state, detail) {
  if (state === emu.state && detail === undefined) return;
  emu.state = state;
  emu.onState(state, detail);
}
