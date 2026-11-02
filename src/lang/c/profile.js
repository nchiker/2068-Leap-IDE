/**
 * src/lang/c/profile.js — the Leap-C language profile.
 *
 * No DOM or CodeMirror (Node imports it); the editor half is
 * src/lang/c/editor.js. The profile shape: src/lang/profiles.js.
 *
 * Leap-C keeps the program as source in V2's line-store format and compiles
 * it to Z80 code on every RUN, so Leap V2 BASIC's patterns carry over: Run by
 * RAM injection, the ROM's compiler as the editor's checker, keys only while
 * a program runs.
 *
 * Run is the shell path the Leap-C project recommends
 * (docs/requests/LEAP_C_ANSWERS.md Q2): from any shell key wait
 * (RUNNING = 0), write the line store, PROG_END, ARRAYS_END and
 * CUR_EDIT_INDEX, then SP = $FF00, push SH_LOOP, push SH_RUN, A = 7 and
 * PC = GFX_SET_BORDER: the border is set white, SH_RUN compiles, runs and
 * shows its report exactly as a typed RUN, then waits for a key at
 * SH_WAIT_KEY (the word at SP is SH_WAIT_KEY.key_ret). RUNNING <> 0 at the
 * key wait means the program waits for a key (getkey, gets). BREAK ends every
 * wait with run-time error 5, so Stop is BREAK alone.
 */

"use strict";

import { KNOWN_ROMS } from './leapc-roms.js';
import { createChecker } from './leapc-check.js';
import { LEAPC_COMPILE_ERRORS, LEAPC_RUNTIME_ERRORS } from './leapc-errors.js';
import { LEAPC_KEYWORD_ENTRIES, LEAPC_MANUAL_REF } from './leapc-keywords.js';
import { encodeLineStore } from '../basic/profile.js';
import { LEAP_EXTENDED_SYMBOLS } from '../keytables.js';
import { scanC, librariesUsed } from './leapc-scan.js';
import { LEAPC_EXAMPLES } from './examples.js';
import { SPIN_DEMO } from '../spin-demo.js';
import { createLineTable, readGlobals, readCallStack } from './leapc-debug.js';
import { romIdentity, programImage, buildCartridge as packCartridge, isLeapcCartridge } from './cartridge.js';
import { blankOut } from './leapc-scan.js';
import { buildTAP, checkTapeName } from '../basic/export.js';
import { tapeToText } from '../../files.js';

/** Leap-C's tape format word (LEAPC_TAPE_VERSION), in the header's autostart field. */
const LEAPC_TAPE_WORD = 0x8C00;
/** Library function -> its library (LIB "name"), from the manual's Part 6. */
const LIBRARY_FUNCTIONS = new Map(Object.entries(LEAPC_KEYWORD_ENTRIES)
  .filter(([, e]) => e.library).map(([name, e]) => [name, e.library]));
/** The libraries, by name. */
export const LEAPC_LIBRARIES = [...new Set(LIBRARY_FUNCTIONS.values())];

const readCTape = bytes => tapeToText(bytes, { accepts: w => w === LEAPC_TAPE_WORD, language: 'Leap-C' });

const MAX_LINE_CHARS = 127;   // the editor's line, as V2's
const RT_BREAK = 5;
const BORDER_WHITE = 7;

/**
 * Editor text -> the lines the ROM stores (blank lines are never stored, and
 * the compiler counts stored lines from 1, so a map back is kept).
 * @returns {{lines: string[], editorLine: number[], problems: object[]}}
 */
export function prepareSource(text) {
  const lines = [], editorLine = [], problems = [];
  let pos = 0;
  text.split('\n').forEach((raw, i) => {
    const from = pos;
    pos += raw.length + 1;
    const line = raw.replace(/\t/g, '    ').replace(/\s+$/, '');
    if (line === '') return;
    if (line.length > MAX_LINE_CHARS) {
      problems.push({ from, to: from + raw.length, severity: 'error',
        message: `Line is ${line.length} characters; Leap-C allows ${MAX_LINE_CHARS}` });
    }
    const bad = line.search(/[^\x20-\x7E]/);
    if (bad >= 0) {
      problems.push({ from: from + bad, to: from + bad + 1, severity: 'error',
        message: 'Only printable ASCII can be sent to the TS2068' });
    }
    lines.push(line);
    editorLine.push(i);
  });
  return { lines, editorLine, problems };
}

/** "ERROR 20: SYNTAX ERROR (a token that cannot appear here)" */
export function describeError(code, runtime = false) {
  const e = (runtime ? LEAPC_RUNTIME_ERRORS : LEAPC_COMPILE_ERRORS)[code];
  const head = `${runtime ? 'RUNTIME ERROR' : 'ERROR'} ${code}`;
  return e ? `${head}: ${e.message} (${e.cause.replace(/\s*\(Phase \d+\)/g, '')})` : head;
}

const read16 = (m, a) => m.bus.read(a) | (m.bus.read(a + 1) << 8);
const poke16 = (m, a, v) => { m.bus.write(a, v & 0xFF); m.bus.write(a + 1, (v >> 8) & 0xFF); };

/** The exit status from the report's text ("EXIT n" in SH_REPORT_BUF), or null. */
function reportExit(m, rom) {
  if (!rom.reportBuf) return null;
  let text = '';
  for (let a = rom.reportBuf; a < rom.reportBuf + 16; a++) {
    const b = m.bus.read(a);
    if (!b) break;
    text += String.fromCharCode(b);
  }
  const e = /^EXIT (-?\d+)/.exec(text);
  return e ? Number(e[1]) : null;
}

const driver = {
  /**
   * BREAK is latched by the interrupt routine (RT_BREAKREQ); after it the
   * report waits for every key to be released, so BREAK is let go after a
   * few frames (src/emulator.js) instead of being held until the run ends.
   */
  breakHold: 5,
  safe: () => true,
  /** RUNNING <> 0: the program waits for a key; otherwise the run is over (report or editor). */
  runState: (m, rom) => (m.bus.read(rom.running) !== 0 ? 'waiting' : 'ended'),
  /** Only the shell's key waits (the editor's, the report's) are a place to start a run. */
  canInject: (m, rom) => m.bus.read(rom.running) === 0,
  inject(m, rom, { store, lineCount, lib = null }) {
    for (let i = 0; i < store.length; i++) m.bus.write(rom.progAreaStart + i, store[i]);
    // A library stays loaded between runs (by design), so every run installs
    // the one the program uses, as LIB "name" does, or unloads it, as LIB does.
    if (lib) for (let i = 0; i < lib.length; i++) m.bus.write(rom.libBase + i, lib[i]);
    m.bus.write(rom.libLoaded, lib ? rom.libBase >> 8 : 0);
    poke16(m, rom.progEnd, rom.progAreaStart + store.length);
    poke16(m, rom.arraysEnd, rom.progAreaStart + store.length);
    poke16(m, rom.curEditIndex, lineCount);
    // The shell's stack base, then GFX_SET_BORDER -> SH_RUN -> SH_LOOP.
    poke16(m, rom.stackTop - 2, rom.shLoop);
    poke16(m, rom.stackTop - 4, rom.shRun);
    m.cpu.sp = rom.stackTop - 4;
    m.cpu.a = BORDER_WHITE;
    m.cpu.pc = rom.gfxSetBorder;
    m.cpu.halted = false;
  },
  /** BREAK ends getkey / gets with run-time error 5: no jump needed. */
  stopWaiting: () => false,
  result(m, rom) {
    const cc = m.bus.read(rom.ccErrNum);
    return {
      compileError: cc,
      compileLine: cc ? read16(m, rom.ccErrLine) : 0,     // 1-based over the stored lines
      compileCol: cc ? read16(m, rom.shErrCol) : -1,
      runtimeError: cc ? 0 : m.bus.read(rom.rtErrNum),
      runtimeLine: cc ? 0 : read16(m, rom.rtErrLine),     // where the failing function's definition starts
      exit: cc ? null : reportExit(m, rom),
    };
  },
};

/**
 * The debugger (stage C4, src/lang/c/leapc-debug.js): a line table built by
 * watching the compiler, so breakpoints stop at a line's statements and Step
 * goes statement by statement (into called functions); the globals with
 * their values; the call stack from the IX frame chain. Store lines are
 * 0-based here, 1-based in the ROM (TOK_LINE).
 */
function createDebugAdapter(rom) {
  if (!rom.statement || !rom.rtRun || !rom.symGlo) return null;     // a ROM entry from before C4
  const t = createLineTable(rom);
  return {
    reset: () => t.reset(),
    observe: m => t.observe(m),
    position: m => t.position(m),
    isStart: pos => t.isStart(pos),
    lineOf: pos => { const l = t.lineOf(pos); return l > 0 ? l - 1 : -1; },
    breakPositions: (m, line0) => t.breakPositions(line0 + 1),
    /** A run-time error's statement: RT_ERRPC (the program's address it came from). */
    stopLine(m) {
      if (!rom.rtErrPc) return -1;
      const pc = m.bus.read(rom.rtErrPc) | (m.bus.read(rom.rtErrPc + 1) << 8);
      const l = t.lineOf(pc - 1);
      return pc && l > 0 ? l - 1 : -1;
    },
    halt: () => false,                 // Stop while paused: BREAK, as when running
    variables: m => readGlobals(m, t),
    callStack: (m, toEditorLine) => readCallStack(m, t, toEditorLine),
    labels: { variables: 'Globals', step: 'statement' },
  };
}

/** Before C4 (or an entry without its fields): registers, memory and Z80 breakpoints only. */
const NO_DEBUG = {
  reset() {}, observe() {},
  position: () => -1, isStart: () => false, lineOf: () => -1,
  breakPositions: () => [], stopLine: () => -1, halt: () => false,
  variables: () => null, callStack: () => null,
};

function symbolGroups(text) {
  const s = scanC(text);
  return [
    ['Functions', s.functions.map(f => [`${f.name}()`, f.line])],
    ['Globals', s.globals.map(g => [g.name, g.line])],
    ['Macros', s.macros.map(d => [d.name, d.line])],
    ['Types', s.types.map(t => [t.name, t.line])],
  ];
}

const help = {
  entries: LEAPC_KEYWORD_ENTRIES,
  first: 'printf',
  manualUrl: `https://github.com/nchiker/2068-Leap-C/blob/${LEAPC_MANUAL_REF}/docs/manual/`,
  link(name, e) {
    const anchor = name.toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/ /g, '-');
    return `${help.manualUrl}${e.part}#${anchor}`;
  },
  kindText: e => e.library ? `${e.kind} · the ${e.library} library (LIB "${e.library}")` : e.kind,
  groups: [
    { title: 'Keywords', test: e => e.kind === 'keyword' },
    { title: 'Operators', test: e => e.kind === 'operator' },
    { title: 'Preprocessor', test: e => e.kind === 'directive' },
    { title: 'Library functions', test: e => e.kind === 'function' },
    { title: 'Loadable libraries', test: e => e.kind === 'library function' },
    { title: 'Commands (typed in the Leap-C editor, not in programs)', test: e => e.kind === 'command' },
  ],
  shortcuts: {
    step: 'Step to the next statement (into called functions)',
    pause: 'Pause / Continue',
    open: 'Open a .c / .txt program, a Leap-C .tap, or a .dck',
    definition: 'Go to where a function, global or macro is defined',
    rename: 'Rename the function, global or macro at the cursor everywhere',
  },
  tips: [
    'Leap-C compiles the program on every Run, as typing RUN does; the report (EXIT n, an error and its line) appears at the bottom of the TS2068 screen. Errors are underlined about half a second after you stop typing: they come from the Leap-C ROM\'s own compiler.',
    'While a program runs, click the TS2068 screen to type into it (getkey, gets). Keys work as labelled on your keyboard, including [ ] { } | ~ ^ \\.',
    'Click left of a line number to set a breakpoint: the program pauses at that line\'s statements, and the debugger shows the globals with their values and the call stack; Step (F10) goes statement by statement. The status bar gives the exit status (Finished: exit n), and a run-time error\'s own line.',
    '⬇ DCK makes a cartridge for a stock TS2068 from the compiled program (and its library), on Leap-C\'s own cartridge build: it runs at power-on, and a key after the report runs it again. ▶ Test DCK runs it here on the stock ROMs; Stop goes back to Leap-C.',
    'A program that calls a library function (circle, box, isqrt: the shapes library) gets the library loaded for its check and Run, as LIB "shapes" does on the TS2068. One library at a time.',
    '⬇ TAP saves the program as Leap-C\'s SAVE does: on the TS2068, LOAD "name" then RUN. Open reads a Leap-C tape back.',
  ],
};

export const leapcProfile = {
  id: 'c',
  name: 'Leap-C',
  extensions: ['.c', '.h'],
  untitled: 'untitled.c',
  romFiles: { home: 'roms/leapc-0.rom', exrom: 'roms/leapc-1.rom' },
  knownRoms: KNOWN_ROMS,
  romHint: 'Add it to src/lang/c/leapc-roms.js with tools/leapc-rom-entry.py.',
  romLabel: rom => 'Leap-C ' + rom.version,
  lineLimit: MAX_LINE_CHARS,
  keyboard: { symbols: LEAP_EXTENDED_SYMBOLS, always: false },
  driver,
  createDebugAdapter: rom => createDebugAdapter(rom) ?? NO_DEBUG,
  symbolGroups,
  symbolsEmpty: 'No functions, globals, macros or types yet.',
  help,
  examples: [...LEAPC_EXAMPLES, SPIN_DEMO.c],   // + the speed test shared by the three languages
  tools: { udg: false, draw: false },
  /** ⬇ TAP: the program as Leap-C's SAVE writes it (V2's two blocks, format word $8C00). */
  hasTape: true,
  /** ⬇ DCK / ▶ Test DCK: the compiled program on Leap-C's cartridge build (src/lang/c/cartridge.js). */
  hasCartridge: true,
  /** A Leap-C program cartridge ("LCPG" at DOCK $8000). */
  ownsCartridge: isLeapcCartridge,
  waitingText: 'Waiting for a key — click the screen to type',
  /** A Leap-C program tape on Open (throws for anything else). */
  tapeToText: readCTape,
  /** True if this tape holds a Leap-C program ($8C00 in its header). */
  ownsTape(bytes) {
    try { readCTape(bytes); return true; } catch { return false; }
  },

  /**
   * @param {{rom: object, romImages: object, fetchAsset?: (path: string) => Promise<Uint8Array>}} opts
   *   fetchAsset loads the library images (libs/c/<version>/<name>.bin)
   */
  async attach({ rom, romImages, fetchAsset = null }) {
    const checker = createChecker(rom, romImages);
    let cart = null;                     // {home, exrom, identity} of the cartridge build, on first use
    const libImages = new Map();         // library name -> image
    if (fetchAsset) {
      await Promise.all(LEAPC_LIBRARIES.map(async name => {
        try {
          libImages.set(name, await fetchAsset(`libs/c/${rom.version}/${name}.bin`));
        } catch { /* reported when a program needs it */ }
      }));
    }

    /**
     * The library a program needs (one at a time, as LIB "name" replaces the
     * one before). problem.line is 1-based in the editor text.
     * @returns {{name: string|null, image: Uint8Array|null, problem: {line: number, message: string}|null}}
     */
    function libraryFor(text) {
      const used = librariesUsed(text, LIBRARY_FUNCTIONS);
      if (used.length === 0) return { name: null, image: null, problem: null };
      if (used.length > 1) {
        return { name: null, image: null, problem: { line: used[1].line,
          message: `Leap-C loads one library at a time: this program uses ${used[0].library} (${used[0].fn}, line ${used[0].line}) and ${used[1].library} (${used[1].fn})` } };
      }
      const [{ library, line }] = used;
      const image = libImages.get(library) ?? null;
      return image ? { name: library, image, problem: null }
        : { name: library, image: null, problem: { line, message: `The ${library} library is not available for Leap-C ${rom.version} (libs/c/${rom.version}/${library}.bin)` } };
    }
    const room = rom.progAreaMax - rom.progAreaStart;
    const tooBig = store => store.length > room ? `Program is ${store.length} bytes; the Leap-C source area holds ${room}` : null;
    const editorLineOf = (editorLine, line1) => editorLine[Math.max(0, Math.min(line1 - 1, editorLine.length - 1))];

    /** A compile error's diagnostic: the token at the column, else the line. */
    const errorMark = (editorLine, lines, line1, col, code) => {
      const line0 = editorLineOf(editorLine, line1);
      const text = lines?.[Math.max(0, Math.min(line1 - 1, lines.length - 1))] ?? '';
      let cols = null;
      if (col >= 0 && col < text.length) {
        // The 0-based column of the token the compiler stopped at (SH_ERR_COL).
        const from = col;
        const m = /^([A-Za-z_]\w*|\d[\w.]*|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|\S)/.exec(text.slice(from));
        cols = { from, to: from + (m ? m[0].length : 1) };
      }
      return { line0, message: describeError(code), cols };
    };

    return {
      checker,

      lint(text) {
        const prepared = prepareSource(text);
        if (prepared.problems.length > 0 || prepared.lines.length === 0) return prepared.problems;
        const store = encodeLineStore(prepared.lines);
        const big = tooBig(store);
        if (big) return [{ from: 0, to: 0, severity: 'error', message: big }];
        const lib = libraryFor(text);
        if (lib.problem) return [{ line0: lib.problem.line - 1, message: lib.problem.message }];
        const r = checker.check(store, prepared.lines.length, lib.image);
        if (!r || r.code === 0) return [];
        const mark = errorMark(prepared.editorLine, prepared.lines, r.line, r.col, r.code);
        return [{ line0: mark.line0, cols: mark.cols, message: mark.message }];
      },

      startRun(text) {
        const prepared = prepareSource(text);
        if (prepared.problems.length > 0) return { problems: prepared.problems };
        if (prepared.lines.length === 0) return null;
        const store = encodeLineStore(prepared.lines);
        const big = tooBig(store);
        if (big) return { error: big };
        const lib = libraryFor(text);
        if (lib.problem) return { error: `Line ${lib.problem.line}: ${lib.problem.message}` };
        return {
          job: { store, lineCount: prepared.lines.length, lines: prepared.lines, lib: lib.image },
          editorLine: prepared.editorLine,
          bytes: store.length,
          message: lib.name ? `Compiling (with LIB "${lib.name}")…` : 'Compiling…',
        };
      },

      /**
       * ⬇ DCK / ▶ Test DCK (stage C9): the program compiled by the ROM's own
       * compiler on the checker machine (with its library, as for Run), read
       * back region by region and packed on Leap-C's runtime cartridge build
       * (the ROM entry's cartridgeDir). The stock ROM starts it from the dock;
       * a key after the report restarts it from cold.
       * @param {{confirm: (q: string) => boolean}} ui
       * @returns {Promise<{error: string, line0?: number}|null|{dck: Uint8Array, bin: Uint8Array, summary: string}>}
       */
      async buildCartridge(text, ui) {
        const prepared = prepareSource(text);
        if (prepared.problems.length > 0) return { error: prepared.problems[0].message };
        if (prepared.lines.length === 0) return { error: 'Nothing to put on a cartridge' };
        if (!rom.cartridgeDir || !rom.runMain) return { error: `There is no cartridge build for Leap-C ${rom.version}` };
        if (!fetchAsset) return { error: 'The cartridge build cannot be fetched here' };
        const store = encodeLineStore(prepared.lines);
        const big = tooBig(store);
        if (big) return { error: big };
        const lib = libraryFor(text);
        if (lib.problem) return { error: `Line ${lib.problem.line}: ${lib.problem.message}`, line0: lib.problem.line - 1 };
        if (!cart) {
          try {
            const [home, exrom, info] = await Promise.all([
              fetchAsset(rom.cartridgeDir + 'leapc_cart_home.bin'),
              fetchAsset(rom.cartridgeDir + 'leapc_exrom.bin'),
              fetchAsset(rom.cartridgeDir + 'cartridge.json'),
            ]);
            cart = { home, exrom, identity: parseInt(JSON.parse(new TextDecoder().decode(info)).identity, 16) };
          } catch (e) {
            return { error: `The cartridge build in ${rom.cartridgeDir} could not be loaded: ${e.message}` };
          }
        }
        const identity = romIdentity(romImages.home, romImages.exrom);
        if (identity !== cart.identity || cart.exrom.length !== romImages.exrom.length || cart.exrom.some((b, i) => b !== romImages.exrom[i])) {
          return { error: `The cartridge build accepts identity $${cart.identity.toString(16).toUpperCase()}; these ROMs are $${identity.toString(16).toUpperCase()}` };
        }
        const port = blankOut(text).split('\n').findIndex(l => /\boutp\s*\(\s*(0x[fF]4|244|0x[fF][fF]|255)\s*,/.test(l));
        if (port >= 0 && !ui.confirm(`Line ${port + 1} writes to port 244 or 255 (outp), which can switch the cartridge's ROMs out. Make the cartridge anyway?`)) return null;
        const r = checker.compileImage(store, prepared.lines.length, lib.image);
        if (!r) return { error: 'The compiler did not finish' };
        if (r.code !== 0) {
          const mark = errorMark(prepared.editorLine, prepared.lines, r.line, r.col, r.code);
          return { error: `Compile error ${r.code} on line ${mark.line0 + 1}: fix it first`, line0: mark.line0 };
        }
        let image;
        try {
          image = programImage({ ...r, identity });
        } catch (e) {
          return { error: e.message };
        }
        const { dck, bin } = packCartridge({ home: cart.home, exrom: cart.exrom, image });
        const code = r.blocks.reduce((n, [, d]) => n + d.length, 0);
        return { dck, bin, summary: `${code} bytes of program${lib.name ? ` and the ${lib.name} library` : ''}` };
      },

      /** ⬇ TAP: the question for the tape name. */
      tapePrompt: 'Tape name (up to 10 characters; LOAD "name" must match it exactly):',
      tapeNameMax: 10,

      /**
       * The program as a .tap that Leap-C's LOAD reads (what SAVE "name"
       * writes: tools/c2tape.py in 2068-Leap-C; checked against the ROM's
       * SH_SAVE in tests/rom-checks.mjs). On the TS2068: LOAD "name", RUN.
       * @returns {{error: string} | {tap: Uint8Array, fileName: string, message: string}}
       */
      exportTape(text, name) {
        const prepared = prepareSource(text);
        if (prepared.lines.length === 0) return { error: 'Nothing to save' };
        if (prepared.problems.length > 0) return { error: prepared.problems[0].message };
        const problem = checkTapeName(name) ?? (name.includes('"') ? 'A tape name cannot contain "' : null);
        if (problem) return { error: problem };
        const store = encodeLineStore(prepared.lines);
        const big = tooBig(store);
        if (big) return { error: big };
        const tap = buildTAP(store, name, rom.tapeFormatWord ?? LEAPC_TAPE_WORD);
        const fileName = name.trim().replace(/[^A-Za-z0-9_-]+/g, '_') + '.tap';
        const lib = libraryFor(text).name;
        const first = lib ? `LIB "${lib}", then ` : '';
        return { tap, fileName, message: `Saved ${fileName}: on the TS2068, ${first}LOAD "${name}" then RUN` };
      },

      progInfo(bytes) {
        const hex = n => n.toString(16).toUpperCase();
        return `SOURCE: $${hex(rom.progAreaStart)}–$${hex(rom.progAreaStart + bytes)} · ${bytes}B`;
      },

      /**
       * @param {object} r  driver.result()
       * @param {number[]} editorLine  stored line -> 0-based editor line
       * @param {*} stopLine  unused (Leap-C reports its own lines)
       * @param {object} job  the run's job (its lines, for the error's column)
       */
      describeResult(r, editorLine, stopLine, job) {
        if (r.compileError !== 0) {
          const mark = editorLine ? errorMark(editorLine, job?.lines, r.compileLine, r.compileCol, r.compileError) : null;
          const where = mark ? ` on line ${mark.line0 + 1}` : '';
          return { text: `Compile error ${r.compileError}${where}`, mode: 'error', mark };
        }
        if (r.runtimeError !== 0) {
          // The statement, from the debugger's line table (RT_ERRPC), else the
          // function's definition line (RT_ERRLINE).
          const exact = stopLine ? stopLine(r.runtimeError === RT_BREAK) : -1;
          const line0 = exact > 0 ? exact - 1
            : editorLine && r.runtimeLine > 0 ? editorLineOf(editorLine, r.runtimeLine) : undefined;
          const where = line0 === undefined ? '' : exact > 0 ? ` on line ${line0 + 1}` : ` in the function on line ${line0 + 1}`;
          if (r.runtimeError === RT_BREAK) return { text: `Stopped (BREAK)${where}`, mode: 'idle', mark: null };
          const message = describeError(r.runtimeError, true);
          return { text: `Runtime error ${r.runtimeError}${where}`, mode: 'error',
            mark: line0 === undefined ? null : { line0, message } };
        }
        return { text: r.exit === null || r.exit === undefined ? 'Finished' : `Finished: exit ${r.exit}`, mode: 'idle', mark: null };
      },
    };
  },
};
