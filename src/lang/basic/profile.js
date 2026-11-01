/**
 * src/lang/basic/profile.js — the Leap V2 BASIC language profile.
 *
 * Everything the IDE core (ide.js, src/emulator.js, src/debugger.js) needs
 * to know about Leap V2 BASIC, and nothing about the DOM or CodeMirror, so
 * Node can import it (tests/rom-checks.mjs). The editor half of the profile
 * (language mode, completion, hover help, structure tools) is
 * src/lang/basic/editor.js. The profile shape is described in
 * src/lang/profiles.js.
 *
 * The profile itself is static data plus functions; attach() binds it to a
 * loaded ROM pair and returns the per-ROM half: the checker machine, the
 * package images, the cartridge build.
 */

"use strict";

import { KNOWN_ROMS } from './leap-roms.js';
import { createChecker } from './leap-check.js';
import { LEAP_COMPILE_ERRORS, LEAP_RUNTIME_ERRORS } from './leap-errors.js';
import { LEAP_KEYWORD_ENTRIES, LEAP_MANUAL_REF } from './leap-keywords.js';
import { LEAP_PACKAGES, packagesUsed, scanSymbols } from './leap-words.js';
import { buildTAP, checkTapeName } from './export.js';
import {
  buildProgramImage, buildCartridge, romIdentity, cartIdentity, cartFormat, pagingWrites, SYM_COUNTS_SIZE, CHUNK,
} from './cartridge.js';
import { createLineTable, vmInstruction, haltVm, readVariables, readCallStack } from './leap-debug.js';
import { EXAMPLES } from './examples.js';
import { tapeToText } from '../../files.js';

// ── Language limits (manual, Appendix D) ──────────────────────────
const MAX_LINE_CHARS = 127;   // characters in a program line; the ROM editor refuses more
const VM_ERROR_BREAK = 66;    // VM_ERROR_CODE after the BREAK key

// ── The run protocol (src/emulator.js calls the driver) ───────────
// The ROM's machine stack starts at $FF00 (manual, Appendix E) and the Leap
// test harness calls V2_RUN_STORED with SP there too. A run that has ended
// (finished, compile error, runtime error, BREAK) waits for a key with SP back
// at STACK_TOP; INPUT and PAUSE 0 wait deeper. Checked on 2.0.2-emu.1.
const STACK_TOP  = 0xFF00;
const CHAIN_BASE = STACK_TOP - 6;   // three return addresses below STACK_TOP's own

// TS2068 port bits that page the EXROM into chunk 6 ($C000-$DFFF), where the
// shell routines live. Both are set whenever the editor or VM runs.
const PORT_F4_CHUNK6 = 0x40;
const PORT_FF_EXROM  = 0x80;

// Leap's KEY_ASCII_TABLE_SYMBOL (kernel/io/io.asm, 2.0.2-emu.1; unchanged in
// 2.1.0-emu.1): the character SYMBOL SHIFT + key produces. Leap has no key for
// ^ [ ] { } \ | ~ `, so those stay unmapped.
const SYMBOLS = {
  ':': 'Z', '?': 'C', '/': 'V', '<': 'R', '>': 'T',
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5',
  '_': '0', ')': '9', '(': '8', "'": '7', '&': '6',
  '"': 'P', ';': 'O', '=': 'L', '+': 'K', '-': 'J',
  '.': 'M', ',': 'N', '*': 'B',
};

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

/**
 * Split editor text into the lines the ROM will store, remembering which
 * editor line each came from. Blank lines are dropped: the ROM's editor never
 * stores an empty line, so the injected store stays one it could have built.
 *
 * @returns {{lines: string[], editorLine: number[], problems: object[]}}
 *   editorLine: 0-based editor line of each stored line; problems: CodeMirror diagnostics
 */
export function prepareSource(text) {
  const lines = [], editorLine = [], problems = [];
  let pos = 0;
  text.split('\n').forEach((raw, i) => {
    const from = pos;
    pos += raw.length + 1;
    const line = raw.replace(/\t/g, '  ').replace(/\s+$/, '');
    if (line.trim() === '') return;
    if (line.length > MAX_LINE_CHARS) {
      problems.push({ from, to: from + raw.length, severity: 'error',
        message: `Line is ${line.length} characters; Leap V2 allows ${MAX_LINE_CHARS}` });
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

/** "SYNTAX ERROR 3: an expression could not start where it did (…)" */
export function describeError(code, table) {
  const e = table[code];
  if (!e) return `error ${code}`;
  // Give the code for every error. The 2.1 manual writes some messages with the
  // placeholder ("RUNTIME ERROR n"); 2.0.2's has none.
  return `${e.message.replace(/ n$/, '')} ${code}: ${e.cause}`;
}

function poke16(m, addr, value) {
  m.bus.write(addr, value & 0xFF);
  m.bus.write(addr + 1, (value >> 8) & 0xFF);
}

function jumpTo(m, pc, sp) {
  m.cpu.sp = sp;
  m.cpu.pc = pc;
  m.cpu.halted = false;
}

/**
 * The emulator's half of Run and Stop (src/emulator.js): when the machine is
 * at a safe point, what state it is in, how to start a run and how to end a
 * wait. A job is what ide.js passed to emulator.run(): {store, pkg}.
 */
const driver = {
  /** At the key wait with the EXROM paged in (the PC is already in rom.keyWait..keyWaitEnd). */
  safe(m) {
    return (m.portF4 & PORT_F4_CHUNK6) !== 0 && (m.portFF & PORT_FF_EXROM) !== 0;
  },

  /** At the key wait during a run: 'ended' (the run is over) or 'waiting' (INPUT, PAUSE 0). */
  runState(m) {
    return m.cpu.sp === STACK_TOP ? 'ended' : 'waiting';
  },

  /**
   * Write the line store and PROG_END, then jump into a return chain on the
   * ROM's own stack:
   *   V2_CLEAR_ARRAYS -> V2_RESET_EDIT -> V2_RESET_DISPLAY -> V2_RUN_STORED -> V2_COMMAND_LOOP.loop
   * The first two are what LOAD does after replacing a program; RUN_STORED is
   * what typing RUN calls. RESET_DISPLAY puts back INK 0, PAPER 7,
   * BRIGHT/FLASH/INVERSE/OVER 0, a white border and video mode 0, as Leap does
   * on every return to its editor: the IDE never goes back to the editor, so
   * without it one run's colours carried into the next. No code is written to
   * RAM outside the stack.
   */
  inject(m, rom, { store, pkg }) {
    // Writes go through the bus so they land where the CPU would see them.
    for (let i = 0; i < store.length; i++) m.bus.write(rom.progAreaStart + i, store[i]);
    poke16(m, rom.progEnd, rom.progAreaStart + store.length);
    poke16(m, CHAIN_BASE,     rom.resetEdit);
    poke16(m, CHAIN_BASE + 2, rom.resetDisplay);
    poke16(m, CHAIN_BASE + 4, rom.runStored);
    poke16(m, STACK_TOP,      rom.commandLoop);
    if (!pkg) {
      jumpTo(m, rom.clearArrays, CHAIN_BASE);
      return;
    }
    // A package goes in first, as LOAD "NAME" EXT does it (package ABI 2.0):
    // clear the registry, image and length in the window, then its install
    // entry at the window start registers the statements. EXT2_CLEAR_ALL
    // returns into the install, which returns into CLEAR_ARRAYS.
    for (let i = 0; i < pkg.length; i++) m.bus.write(rom.packageBase + i, pkg[i]);
    poke16(m, rom.packageLen, pkg.length);
    poke16(m, CHAIN_BASE - 4, rom.packageBase);
    poke16(m, CHAIN_BASE - 2, rom.clearArrays);
    jumpTo(m, rom.ext2ClearAll, CHAIN_BASE - 4);
  },

  /**
   * Stop a run that waits at INPUT / PAUSE 0. BREAK alone does not end an
   * INPUT wait (2.0.2 and 2.1.0-emu.1; 2.1's VM latches error 66 and stops
   * only after ENTER), so jump straight back to the command loop.
   * @returns {boolean} true: stopped here; false: press BREAK instead
   */
  stopWaiting(m, rom) {
    jumpTo(m, rom.commandLoop, STACK_TOP + 2);
    return true;
  },

  /** The ended run's result, for describeResult. */
  result(m, rom) {
    return {
      compileError: m.bus.read(rom.compileErrorCode),
      vmError:      m.bus.read(rom.vmErrorCode),
      // After a compile error the ROM moves the edit cursor to the failing line
      // (an index into the store; the line count for end-of-source errors).
      line:         m.bus.read(rom.curEditIndex) | (m.bus.read(rom.curEditIndex + 1) << 8),
    };
  },
};

/**
 * The debugger's view of a V2 run (src/debugger.js): statements are VM
 * instructions, found by watching the compiler (src/lang/basic/leap-debug.js).
 * A "position" is the VM_IP of the instruction about to run.
 */
function createDebugAdapter(rom) {
  const table = createLineTable(rom);
  return {
    reset: () => table.reset(),
    /** Called before every instruction while watched: the compiler builds the line table. */
    observe: m => table.observe(m),
    /** The VM instruction about to run, or -1 when the CPU is elsewhere. */
    position: m => vmInstruction(m, rom),
    isStart: pos => table.isStart(pos),
    lineOf: pos => table.lineOf(pos),
    /** Positions where a breakpoint on this store line stops (the next line with code). */
    breakPositions(m, storeLine) {
      const code = table.nextCodeLine(storeLine);
      return code >= 0 ? table.breakAddrs(m, code) : [];
    },
    /**
     * Store line where the last run stopped, or -1: after a runtime error
     * VM_IP is just past the failing instruction; after BREAK it is the
     * instruction that would have run next.
     */
    stopLine(m, isBreak) {
      if (table.size === 0) return -1;
      const ip = m.bus.read(rom.vmIp) | (m.bus.read(rom.vmIp + 1) << 8);
      return table.lineOf(isBreak ? ip : ip - 1);
    },
    /** End a paused program as BREAK does (VM_ERROR_CODE 66); false if not inside the VM. */
    halt(m) {
      if (vmInstruction(m, rom) < 0) return false;
      haltVm(m, rom);
      return true;
    },
    variables: m => readVariables(m, rom),
    /**
     * Innermost first: where the program is, then each active call and loop.
     * @param {(storeLine: number) => number} toEditorLine
     */
    callStack(m, toEditorLine) {
      const lineOf = a => toEditorLine(table.lineOf(a));
      const frames = readCallStack(m, rom, lineOf);
      const ip = vmInstruction(m, rom);
      const where = ip >= 0 ? lineOf(ip) : -1;
      const firstCall = frames.find(f => f.kind === 'call');
      const out = [{ label: firstCall ? firstCall.name : 'main program', line: where, current: true }];
      for (const f of frames) {
        out.push(f.kind === 'call' ? { label: 'called from', line: f.line } : { label: f.name, line: -1 });
      }
      return out;
    },
    labels: { variables: 'Variables', step: 'statement' },
  };
}

/** The Symbols tab's groups: [title, [[name, 1-based line], …]]. */
function symbolGroups(text) {
  const { procs, fns, labels, vars } = scanSymbols(text);
  return [
    ['Procedures', [...procs].map(([n, v]) => [`${n}(${v.param})`, v.line])],
    ['Functions', [...fns].map(([n, v]) => [`FN ${n}(${v.param})`, v.line])],
    ['Labels', [...labels].map(([n, v]) => [`${n}:`, v.line])],
    ['Variables', [...vars].map(([n, line]) => [n, line])],
  ];
}

// ── Help (src/help.js) ────────────────────────────────────────────

// ALL, ARRAY and EXT are parts of SAVE / LOAD, which are commands.
const isCommandPart = e => e.kind === 'part of' && /SAVE|LOAD/.test(e.syntax);

const help = {
  entries: LEAP_KEYWORD_ENTRIES,
  first: 'PRINT',
  manualUrl: `https://github.com/nchiker/2068-Leap/blob/${LEAP_MANUAL_REF}/docs/manual/03_keywords.md`,
  /** GitHub's heading anchor for a manual entry ("CIRCLE  [package: shapes]" -> "circle--package-shapes"). */
  anchor(name, e) {
    const heading = e.package ? `${name}  [package: ${e.package}]` : name;
    return heading.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-');
  },
  /** Under an entry's forms: what kind of word it is. */
  kindText(e) {
    return e.package ? `statement · ${e.package} package` : e.kind;
  },
  groups: [
    { title: 'Statements', test: e => !e.package && (e.kind === 'statement' || e.kind === 'part of') && !isCommandPart(e) },
    { title: 'Functions', test: e => e.kind === 'function' },
    { title: 'Operators', test: e => e.kind === 'operator' },
    { title: 'Package statements', test: e => !!e.package },
    { title: 'Commands (typed at the Leap prompt, not in programs)', test: e => e.kind === 'command' || isCommandPart(e) },
  ],
  shortcuts: {
    step: 'Step: run one statement',
    pause: 'Pause at the next statement / Continue',
    open: 'Open a .leap / .txt program, a Leap .tap or a .dck',
    definition: 'Go to where a PROC, FN, label or variable is defined',
    rename: 'Rename the PROC, FN, label or variable at the cursor everywhere',
  },
  tips: [
    'Type programs in the editor; keywords become upper case as you finish them. Errors are underlined about half a second after you stop typing — they come from the Leap ROM\'s own compiler, so they are exactly what Run would report.',
    'While a program runs, click the TS2068 screen to type into it (INPUT, INKEY$). Keys work as labelled on your keyboard: " is " — no SYMBOL SHIFT needed.',
    'Click left of a line number to set a breakpoint. When the program stops there, the debugger shows its variables and call stack; Step (F10) runs one statement.',
    'Package statements (CIRCLE, FILL, GRAB, MODE, …) work directly: the IDE loads the package the program uses. On a real TS2068, type LOAD "NAME" EXT first. ⬇ DCK puts the package on the cartridge with the program.',
    '▶ Test DCK runs the program as a cartridge on a stock TS2068 in the emulator, exactly as ⬇ DCK would save it: the stock ROM starts it from the dock after about two seconds. Open also takes a .dck file. Keys go to the cartridge; Stop or Run goes back to Leap.',
  ],
};

// ── The profile ───────────────────────────────────────────────────

export const basicProfile = {
  id: 'basic',
  name: 'Leap V2 BASIC',
  /** Open picks this language for these file extensions. */
  extensions: ['.leap', '.bas'],
  untitled: 'untitled.leap',
  romFiles: { home: 'roms/leap-0.rom', exrom: 'roms/leap-1.rom' },
  knownRoms: KNOWN_ROMS,
  romHint: 'Add it to src/lang/basic/leap-roms.js with tools/leap-rom-entry.py.',
  romLabel: rom => 'Leap ' + rom.version,
  lineLimit: MAX_LINE_CHARS,
  /** Keys reach the TS2068 only while a program runs (owner: typing never reaches Leap's editor). */
  keyboard: { symbols: SYMBOLS, always: false },
  driver,
  createDebugAdapter,
  symbolGroups,
  symbolsEmpty: 'No procedures, functions, labels or variables yet.',
  help,
  examples: EXAMPLES,
  /** Right-panel tools that generate this language's code (src/tools/udg.js, draw.js). */
  tools: { udg: true, draw: true },
  /** ⬇ TAP and ⬇ DCK / ▶ Test DCK apply (attach() has exportTape / buildCartridge). */
  hasTape: true,
  hasCartridge: true,
  /** Messages for the status bar while running. */
  waitingText: 'Waiting for input — click the screen to type',
  /** A Leap V2 tape on Open (throws for anything else). */
  tapeToText,
  /** True if this tape holds a Leap V2 program (the $81xx format word in its header). */
  ownsTape(bytes) {
    try { tapeToText(bytes); return true; } catch { return false; }
  },

  /**
   * Bind the profile to a loaded ROM pair (an entry of knownRoms). Fetches the
   * package images with fetchAsset(path) -> Promise<Uint8Array>.
   */
  async attach({ rom, romImages, fetchAsset }) {
    const checker = createChecker(rom, romImages);
    const packageImages = new Map();     // package name -> image
    let cartImages = null;               // {home, exrom} of the release's cartridge build, on first use
    await Promise.all(LEAP_PACKAGES.map(async name => {
      try {
        packageImages.set(name, await fetchAsset(rom.packageDir + name + '.bin'));
      } catch { /* reported when a program needs it */ }
    }));
    const room = rom.sourceEnd - rom.progAreaStart;
    const tooBig = store => store.length > room ? `Program is ${store.length} bytes; the Leap pool holds ${room}` : null;

    /**
     * The package a program needs (Leap loads one at a time).
     * @returns {{name: string|null, image: Uint8Array|null, problem: {line: number, message: string}|null}}
     */
    function packageFor(text) {
      const used = [...packagesUsed(text)];
      if (used.length === 0) return { name: null, image: null, problem: null };
      if (used.length > 1) {
        const [[first, firstLine], [second, secondLine]] = used;
        return { name: null, image: null, problem: { line: secondLine,
          message: `Leap loads one package at a time: this program uses ${first} (line ${firstLine}) and ${second}` } };
      }
      const [[name, line]] = used;
      const image = packageImages.get(name) ?? null;
      return image
        ? { name, image, problem: null }
        : { name, image: null, problem: { line, message: `The ${name} package could not be loaded` } };
    }

    /** The store line's 0-based editor line (end-of-source errors have the line count: the last line). */
    const editorLineOf = (prepared, storeLine) =>
      prepared.editorLine[Math.min(storeLine, prepared.editorLine.length - 1)];

    async function loadCartridgeImages() {
      if (cartImages) return cartImages;
      const dir = rom.cartridgeDir;
      const get = async (name, size) => {
        const bytes = await fetchAsset(dir + name);
        if (bytes.length !== size) throw new Error(`${dir}${name}: expected ${size} bytes, got ${bytes.length}`);
        return bytes;
      };
      const [home, exrom] = await Promise.all([
        get('leap_v2_cart_home.bin', 2 * CHUNK),
        get('leap_v2_cart_exrom.bin', CHUNK),
      ]);
      cartImages = { home, exrom };
      return cartImages;
    }

    return {
      checker,
      packageFor,

      /**
       * The editor's diagnostics: storage problems, a package problem, then
       * the ROM compiler's first error (it stops at the first).
       * @returns {{line0: number, message: string}[] | object[]}  CodeMirror diagnostics,
       *   or {line0, message} for a whole editor line (ide.js turns them into ranges)
       */
      lint(text) {
        const prepared = prepareSource(text);
        if (prepared.problems.length > 0 || prepared.lines.length === 0) return prepared.problems;
        const store = encodeLineStore(prepared.lines);
        const big = tooBig(store);
        if (big) return [{ from: 0, to: 0, severity: 'error', message: big }];
        const pkg = packageFor(text);
        if (pkg.problem) return [{ line0: pkg.problem.line - 1, message: pkg.problem.message }];
        const result = checker.check(store, pkg.image);
        if (!result || result.code === 0) return [];
        return [{ line0: editorLineOf(prepared, result.line), message: describeError(result.code, LEAP_COMPILE_ERRORS) }];
      },

      /**
       * Prepare a run.
       * @returns {{error: string}|{problems: object[]}|null|
       *   {job: object, editorLine: number[], bytes: number, message: string}}
       *   null: nothing to run
       */
      startRun(text) {
        const prepared = prepareSource(text);
        if (prepared.problems.length > 0) return { problems: prepared.problems };
        if (prepared.lines.length === 0) return null;
        const store = encodeLineStore(prepared.lines);
        const big = tooBig(store);
        if (big) return { error: big };
        const pkg = packageFor(text);
        if (pkg.problem) return { error: pkg.problem.message };
        return {
          job: { store, pkg: pkg.image },
          editorLine: prepared.editorLine,
          bytes: store.length,
          message: pkg.name ? `Starting… (with the ${pkg.name} package)` : 'Starting…',
        };
      },

      /** "PROG: $825A–$8270 · 22B" for the display caption. */
      progInfo(bytes) {
        const hex = n => n.toString(16).toUpperCase();
        return `PROG: $${hex(rom.progAreaStart)}–$${hex(rom.progAreaStart + bytes)} · ${bytes}B`;
      },

      /**
       * The status bar for an ended run.
       * @param {{compileError: number, vmError: number, line: number}} r  driver.result()
       * @param {number[]} editorLine  the run's store line -> 0-based editor line
       * @param {(isBreak: boolean) => number} stopLine  1-based editor line where the VM stopped, or -1
       * @returns {{text: string, mode: string, mark: {line0: number, message: string}|null}}
       */
      describeResult(r, editorLine, stopLine) {
        if (r.compileError !== 0) {
          const line0 = editorLine ? editorLine[Math.min(r.line, editorLine.length - 1)] : undefined;
          const where = line0 === undefined ? '' : ` on line ${line0 + 1}`;
          return { text: `Compile error ${r.compileError}${where}`, mode: 'error',
            mark: line0 === undefined ? null : { line0, message: describeError(r.compileError, LEAP_COMPILE_ERRORS) } };
        }
        if (r.vmError !== 0) {
          // Leap reports no line for these; the debugger's line table knows where the VM was.
          const at = stopLine(r.vmError === VM_ERROR_BREAK);
          const where = at > 0 ? ` at line ${at}` : '';
          if (r.vmError === VM_ERROR_BREAK) return { text: `Stopped (BREAK)${where}`, mode: 'idle', mark: null };
          return { text: `Runtime error ${r.vmError}${where}`, mode: 'error',
            mark: at > 0 ? { line0: at - 1, message: describeError(r.vmError, LEAP_RUNTIME_ERRORS) } : null };
        }
        return { text: 'Finished', mode: 'idle', mark: null };
      },

      /** ⬇ TAP: the question for the tape name. */
      tapePrompt: 'Tape name (up to 10 characters; LOAD "name" must match it exactly):',
      tapeNameMax: 10,

      /**
       * The program as a .tap that Leap's LOAD reads (byte-identical to what
       * SAVE "name" writes). Load it with LOAD "" or LOAD "name", then RUN.
       * @returns {{error: string} | {tap: Uint8Array, fileName: string, message: string}}
       */
      exportTape(text, name) {
        const prepared = prepareSource(text);
        if (prepared.lines.length === 0) return { error: 'Nothing to save' };
        if (prepared.problems.length > 0) return { error: prepared.problems[0].message };
        const problem = checkTapeName(name);
        if (problem) return { error: problem };
        const store = encodeLineStore(prepared.lines);
        const big = tooBig(store);
        if (big) return { error: big };
        const tap = buildTAP(store, name, rom.tapeFormatWord);
        const fileName = name.trim().replace(/[^A-Za-z0-9_-]+/g, '_') + '.tap';
        const pkg = packageFor(text).name;
        const first = pkg ? `LOAD "${pkg.toUpperCase()}" EXT, then ` : '';
        return { tap, fileName, message: `Saved ${fileName}: on the TS2068, ${first}LOAD "${name}" then RUN` };
      },

      /**
       * The program as a cartridge for a stock TS2068: Leap's runtime
       * (cartridge build, no editor) plus the bytecode compiled by the ROM's
       * own compiler on the checker machine. The stock ROM starts it from the
       * dock and it runs at once; a key after the end restarts it.
       *
       * @param {string} text
       * @param {{confirm: (question: string) => boolean}} ui
       * @returns {Promise<{error: string, line0?: number}|null|
       *   {dck: Uint8Array, bin: Uint8Array, summary: string}>}  null: the user declined
       */
      async buildCartridge(text, ui) {
        const prepared = prepareSource(text);
        if (prepared.lines.length === 0) return { error: 'Nothing to export' };
        if (prepared.problems.length > 0) return { error: prepared.problems[0].message };
        if (!rom.cartridgeDir) return { error: `There is no cartridge build for Leap ${rom.version}` };
        // A package goes on the cartridge with the program (image format 2).
        const pkg = packageFor(text);
        if (pkg.problem) return { error: pkg.problem.message };
        const store = encodeLineStore(prepared.lines);
        const big = tooBig(store);
        if (big) return { error: big };
        const result = checker.compile(store, SYM_COUNTS_SIZE, pkg.image);
        if (!result) return { error: 'The compiler did not finish' };
        if (result.code !== 0) {
          const line0 = editorLineOf(prepared, result.line);
          return { error: `Compile error ${result.code} on line ${line0 + 1}: fix it first`, line0 };
        }
        const images = await loadCartridgeImages();
        // The cartridge accepts only bytecode from the ROMs it was built from.
        const identity = romIdentity(romImages.home, romImages.exrom);
        if (identity !== cartIdentity(images.home)) {
          return { error: `The cartridge build does not match the loaded Leap ${rom.version} ROMs` };
        }
        const format = cartFormat(images.home);
        if (pkg.image && format < 2) {
          return { error: `This cartridge build cannot carry packages: the program uses ${pkg.name.toUpperCase()}` };
        }
        const writes = pagingWrites(text);
        if (writes.length > 0) {
          const w = writes[0];
          const ok = ui.confirm(`Line ${w.line} writes to port ${w.port}, which pages the TS2068's memory: ` +
            'on a cartridge it can switch Leap itself out and crash the program. Make the cartridge anyway?');
          if (!ok) return null;
        }
        const program = buildProgramImage({
          bytecode: result.bytecode, symCounts: result.symCounts, identity, pkg: pkg.image, format,
        });
        const out = buildCartridge({ home: images.home, exrom: images.exrom, program });
        const withPkg = pkg.image ? ` and the ${pkg.name.toUpperCase()} package` : '';
        return { ...out, summary: `${result.bytecode.length} bytes of bytecode${withPkg}` };
      },
    };
  },
};
