/**
 * src/lang/forth/profile.js — the Leap-Forth (2068 FORTH V2) language profile.
 *
 * No DOM or CodeMirror (Node imports it); the editor half is
 * src/lang/forth/editor.js. The profile shape: src/lang/profiles.js.
 *
 * Interaction model (owner, 2026-10-31: "console first"): the Forth prompt is
 * live all the time, as on the real machine. Keys reach it whenever the screen
 * has focus; Run sends the editor's text to the running session, without a
 * reset, exactly as if it had been typed: definitions accumulate. Reset gives
 * a fresh Forth.
 *
 * The run protocol is the one 2068-Forth documents for hosts
 * (docs/requests/LEAP_FORTH_ANSWERS.md, Q1): one line at a time, at the
 * prompt, written into EDIT_BUF / EDIT_LEN / EDIT_CURSOR, the key wait's
 * return address dropped and PC = EDITOR_LOOP_LIVE.enter. The ROM stores the
 * line, runs it, prints OK or the error and waits for the next key. "At the
 * prompt" is the key wait with EDITOR_LOOP_LIVE.key_ret at SP; any other
 * return address is a word waiting in KEY / ACCEPT / INPUT / EDIT. LAST_ERROR
 * holds the code the line ended with (0: OK). Sending stops at the first line
 * that did not end in OK.
 */

"use strict";

import { KNOWN_ROMS } from './forth-roms.js';
import { FORTH_WORD_ENTRIES, FORTH_MANUAL_REF, FORTH_GROUPS } from './forth-words.js';
import { FORTH_EXAMPLES } from './examples.js';
import { scanDefinitions } from './forth-scan.js';
import { checkForth, readSessionWords } from './forth-check.js';
import { buildForthTap, forthTapeToText, isForthTape, textStore, LOAD_TEXT_MAX } from './tape.js';
import { LEAP_EXTENDED_SYMBOLS } from '../keytables.js';

// ── Errors (LAST_ERROR, ANS numbering; LEAP_FORTH_ANSWERS.md Q2.2) ──
const THROW_BREAK = -28;
const THROW_UNKNOWN = -13;
const ERRORS = {
  [-1]: 'ABORT',
  [-3]: 'STACK? (a stack overflowed)',
  [-4]: 'STACK? (a stack underflowed)',
  [-5]: 'RETURN STACK FULL (recursion too deep)',
  [-8]: 'DICTIONARY FULL',
  [-13]: 'unknown word',
  [-16]: 'MISSING NAME (a word that takes a name had none)',
  [-28]: 'BREAK',
  [-37]: 'TAPE ERROR',
  [-42]: 'DIVISION BY ZERO',
  [-43]: 'OUT OF RANGE',
  [-46]: 'INVALID ARGUMENT',
  [-56]: 'QUIT',
};

/** "DIVISION BY ZERO (THROW -42)"; an unknown word names the word. */
export function describeThrow(code, word = '') {
  if (code === THROW_UNKNOWN) return `${word ? word + ' ?' : 'unknown word'} (THROW -13: not a word Forth knows here)`;
  const text = ERRORS[code];
  return text ? `${text} (THROW ${code})` : `ERROR ${code} (the program's own THROW)`;
}


const LINE_LIMIT = 128;   // EDIT_MAX_LEN: the prompt's line, and EDIT's

/**
 * Editor text -> the lines to send. Blank lines are skipped (the prompt
 * stores no empty line); tabs become two spaces.
 * @returns {{lines: string[], editorLine: number[], problems: object[]}}
 */
export function prepareSource(text) {
  const lines = [], editorLine = [], problems = [];
  let pos = 0;
  text.split('\n').forEach((raw, i) => {
    const from = pos;
    pos += raw.length + 1;
    const line = raw.replace(/\t/g, '  ').replace(/\s+$/, '');
    if (line.trim() === '') return;
    if (line.length > LINE_LIMIT) {
      problems.push({ from, to: from + raw.length, severity: 'error',
        message: `Line is ${line.length} characters; the Forth prompt takes ${LINE_LIMIT}` });
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

const read16 = (m, a) => m.bus.read(a) | (m.bus.read(a + 1) << 8);
const signed16 = v => (v & 0x8000 ? v - 0x10000 : v);

/** At the key wait, is it the prompt's (not a word's KEY / ACCEPT / INPUT / EDIT)? */
const atPrompt = (m, rom) => read16(m, m.cpu.sp) === rom.promptReturn;

/** One line, as typed and ENTER pressed (the protocol in the header). */
function sendLine(m, rom, line) {
  for (let i = 0; i < line.length; i++) m.bus.write(rom.editBuf + i, line.charCodeAt(i));
  m.bus.write(rom.editLen, line.length);
  m.bus.write(rom.editCursor, line.length);
  m.cpu.sp = (m.cpu.sp + 2) & 0xFFFF;       // drop the key wait's return address
  m.cpu.pc = rom.enterLine;
  m.cpu.halted = false;
}

/**
 * The emulator's half (src/emulator.js). A job is {lines, index}: the lines
 * to send and the one being run.
 */
const driver = {
  /** BREAK is noticed by the interrupt routine: a short press is enough (src/emulator.js). */
  breakHold: 5,
  safe: () => true,                     // Forth never pages the prompt's code out
  runState: (m, rom) => (atPrompt(m, rom) ? 'ended' : 'waiting'),
  /** Only at the prompt: a word waiting in KEY must be ended (BREAK) first. */
  canInject: (m, rom) => atPrompt(m, rom),
  inject(m, rom, job) {
    job.index = 0;
    sendLine(m, rom, job.lines[0]);
  },
  /** Back at the prompt: send the next line unless this one ended in an error. */
  next(m, rom, job) {
    if (read16(m, rom.lastError) !== 0 || job.index + 1 >= job.lines.length) return false;
    job.index++;
    sendLine(m, rom, job.lines[job.index]);
    return true;
  },
  /** BREAK ends KEY / ACCEPT / INPUT waits (THROW -28), so no jump is needed. */
  stopWaiting: () => false,
  result(m, rom, job) {
    const srcPtr = read16(m, rom.srcPtr);
    const len = m.bus.read(rom.wordBuf);
    let word = '';
    for (let i = 1; i <= len && i < 32; i++) word += String.fromCharCode(m.bus.read(rom.wordBuf + i));
    return {
      lastError: signed16(read16(m, rom.lastError)),
      index: job ? job.index : -1,
      lineText: job ? job.lines[job.index] ?? '' : '',
      // SRC_PTR is just past the failing token and one delimiter, if the
      // error came from the line itself (not from text LOAD-TEXT / EDIT ran).
      col: srcPtr >= rom.editBuf && srcPtr <= rom.editBuf + rom.editMaxLen ? srcPtr - rom.editBuf : -1,
      word,
    };
  },
};

/** The token that ends at or just before column col (SRC_PTR is past it and one delimiter). */
function tokenBefore(line, col) {
  let end = Math.min(col, line.length);
  if (end > 0 && end <= line.length && /\s/.test(line[end - 1])) end--;
  let start = end;
  while (start > 0 && !/\s/.test(line[start - 1])) start--;
  return start < end ? { from: start, to: end } : null;
}

/** The debugger: no Forth line table yet (stage F4); registers, memory and Z80 breakpoints work. */
function createDebugAdapter() {
  return {
    reset() {}, observe() {},
    position: () => -1,
    isStart: () => false,
    lineOf: () => -1,
    breakPositions: () => [],
    stopLine: () => -1,
    halt: () => false,
    variables: () => null,
    callStack: () => null,
  };
}

function symbolGroups(text) {
  const d = scanDefinitions(text);
  return [
    ['Words (:)', d.filter(x => x.kind === ':').map(x => [x.name, x.line])],
    ['Variables', d.filter(x => /VARIABLE$/.test(x.kind)).map(x => [x.name, x.line])],
    ['Constants', d.filter(x => /CONSTANT$/.test(x.kind)).map(x => [x.name, x.line])],
    ['Arrays and strings', d.filter(x => x.kind === 'ARRAY' || x.kind === 'STRING').map(x => [x.name, x.line])],
    ['Created', d.filter(x => x.kind === 'CREATE').map(x => [x.name, x.line])],
  ];
}

const help = {
  entries: FORTH_WORD_ENTRIES,
  first: 'DUP',
  manualUrl: `https://github.com/nchiker/2068-Leap-Forth/blob/${FORTH_MANUAL_REF}/docs/manual/`,
  /** The entry's section of the manual on GitHub (its part file and heading anchor). */
  link(name, e) {
    const anchor = name.toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/ /g, '-');
    return `${help.manualUrl}${e.part}#${anchor}`;
  },
  kindText: e => `${e.kind} · ${e.group}`,
  /** The lines under the entry's name: the word and its stack effect. */
  forms: (name, e) => [`${name}  ${e.stack}`],
  groups: FORTH_GROUPS.map(g => ({ title: g, test: e => e.group === g })),
  shortcuts: {
    step: 'Step (not yet in Forth)',
    pause: 'Pause / Continue',
    open: 'Open a .fs / .4th / .txt program, a Forth or Leap .tap, or a .dck',
    definition: 'Go to where a word is defined',
    rename: 'Rename the word at the cursor everywhere',
  },
  tips: [
    'Forth\'s OK prompt is live: click the TS2068 screen and type, as on the real machine. Run (F5) sends the editor\'s text to that session line by line, as if typed; words you define stay defined until Reset.',
    'Sending stops at the first line that ends in an error; the line is marked in the editor. A word that waits for a key (KEY, ACCEPT) gets the keys you type in the screen; Stop (F6) or Escape is BREAK.',
    'Ctrl+Enter sends just the line at the cursor, or the lines you have selected, to the prompt.',
    'Reset gives a fresh Forth with an empty dictionary.',
    '⬇ TAP saves the program as a TEXT tape, as SAVE-TEXT writes it: on the TS2068 type LOAD-TEXT NAME. Open reads a Forth TEXT tape back.',
    'Import (above the screen) opens everything typed or sent at the prompt, the session\'s line store, as a new document, so work done at the prompt is not lost.',
    'The editor checks the program as Forth would read it: a word that is neither a Forth word, nor defined above, nor in the session is marked, and so are unbalanced IF / DO / BEGIN and : ;.',
  ],
};

export const forthProfile = {
  id: 'forth',
  name: 'Leap-Forth',
  extensions: ['.fs', '.4th', '.fth'],
  untitled: 'untitled.fs',
  romFiles: { home: 'roms/leapforth-0.rom', exrom: 'roms/leapforth-1.rom' },
  knownRoms: KNOWN_ROMS,
  romHint: 'Add it to src/lang/forth/forth-roms.js with tools/forth-rom-entry.py.',
  romLabel: rom => 'Forth ' + rom.version,
  lineLimit: LINE_LIMIT,
  /** The prompt is live: keys pass whenever the screen has focus (owner: console first). */
  keyboard: { symbols: LEAP_EXTENDED_SYMBOLS, always: true },
  driver,
  createDebugAdapter,
  symbolGroups,
  symbolsEmpty: 'No words, variables or constants defined yet.',
  help,
  examples: FORTH_EXAMPLES,
  tools: { udg: false, draw: false },
  /** ⬇ TAP: a TEXT tape, as SAVE-TEXT writes it (src/lang/forth/tape.js). */
  hasTape: true,
  hasCartridge: false,
  /** A live session whose typed lines can be imported (attach().importSession). */
  hasSession: true,
  readyText: 'OK prompt: type in the TS2068 screen, or Run (F5) sends the program',
  waitingText: 'Waiting for a key — click the screen to type',
  /** A Forth TEXT tape on Open (throws for anything else). */
  tapeToText: forthTapeToText,
  /** True if this tape holds a Forth TEXT file (header type 0, parameter 1 $8000). */
  ownsTape: isForthTape,

  async attach({ rom }) {
    // The session's own words, read at the prompt's key wait (there the EXROM
    // is paged out, so the whole dictionary is visible): keyWait(m) is called
    // by the emulator at every key wait (ide.js wires it).
    let sessionWords = new Set();
    let sessionLatest = -1;
    return {
      /** Storage problems, then the static check (forth-check.js) against the session's words. */
      lint(text) {
        return [...prepareSource(text).problems, ...checkForth(text, sessionWords)];
      },

      /** At a key wait of the live machine: re-read the session's words if LATEST moved. */
      keyWait(m) {
        if (!atPrompt(m, rom)) return;
        const latest = read16(m, rom.latest);
        if (latest === sessionLatest) return;
        sessionLatest = latest;
        sessionWords = readSessionWords(a => m.bus.read(a), rom);
      },

      /**
       * Changes when the session's dictionary does (a word typed at the
       * prompt, a Reset), so the IDE can check the editor again.
       */
      sessionStamp: () => sessionLatest,

      /**
       * Import session: the ROM's line store (STORE_START to STORE_END: every
       * line typed or sent at the prompt, source only; command lines such as
       * SAVE-TEXT are taken off it) as text. The store is RAM the EXROM never
       * covers, so it can be read at any time.
       * @returns {{text: string, lines: number} | {error: string}}
       */
      importSession(m) {
        const end = read16(m, rom.storeEnd);
        if (end < rom.storeStart || end > rom.storeLimit) return { error: 'The session\'s line store is damaged (STORE_END is outside it)' };
        let text = '';
        for (let a = rom.storeStart; a < end; a++) {
          const b = m.bus.read(a);
          text += b === 0x0D ? '\n' : String.fromCharCode(b);
        }
        if (text.length > 0 && !text.endsWith('\n')) text += '\n';
        const lines = text.split('\n').length - 1;
        return lines === 0 ? { error: 'The session is empty: nothing has been typed or sent since the last Reset' } : { text, lines };
      },

      startRun(text) {
        const prepared = prepareSource(text);
        if (prepared.problems.length > 0) return { problems: prepared.problems };
        if (prepared.lines.length === 0) return null;
        const bytes = prepared.lines.reduce((n, l) => n + l.length + 1, 0);
        return {
          job: { lines: prepared.lines, index: 0 },
          editorLine: prepared.editorLine,
          bytes,
          message: `Sending ${prepared.lines.length} line${prepared.lines.length === 1 ? '' : 's'} to Forth…`,
        };
      },

      /** ⬇ TAP: the question for the tape name. */
      tapePrompt: 'Tape name (up to 10 characters, no spaces; on the TS2068: LOAD-TEXT name):',
      tapeNameMax: 10,

      /**
       * The program as a TEXT tape that LOAD-TEXT reads (byte-identical to
       * what SAVE-TEXT writes after the same lines were sent). The name is
       * upper-cased, as the ROM's own name reading does.
       * @returns {{error: string} | {tap: Uint8Array, fileName: string, message: string}}
       */
      exportTape(text, name) {
        const prepared = prepareSource(text);
        if (prepared.lines.length === 0) return { error: 'Nothing to save' };
        if (prepared.problems.length > 0) return { error: prepared.problems[0].message };
        const tapeName = name.trim().toUpperCase();
        if (tapeName === '') return { error: 'The name is empty' };
        if (tapeName.length > 10) return { error: 'The name is longer than 10 characters' };
        if (/[^\x21-\x7E]/.test(tapeName)) return { error: 'The name must be printable ASCII without spaces (LOAD-TEXT reads one word)' };
        const size = textStore(prepared.lines).length;
        if (size > LOAD_TEXT_MAX) return { error: `The program is ${size} bytes; LOAD-TEXT takes ${LOAD_TEXT_MAX}` };
        const tap = buildForthTap(prepared.lines, tapeName);
        const fileName = tapeName.replace(/[^A-Za-z0-9_-]+/g, '_') + '.tap';
        return { tap, fileName, message: `Saved ${fileName}: on the TS2068, LOAD-TEXT ${tapeName}` };
      },

      progInfo(bytes) {
        return `SENT: ${bytes}B`;
      },

      /**
       * @param {{lastError: number, index: number, lineText: string, col: number, word: string}} r  driver.result()
       * @param {number[]} editorLine  sent line -> 0-based editor line
       * @returns {{text: string, mode: string, mark: {line0: number, message: string, cols: {from, to}|null}|null}}
       */
      describeResult(r, editorLine) {
        if (r.lastError === 0) return { text: 'OK', mode: 'idle', mark: null };
        const line0 = editorLine && r.index >= 0 ? editorLine[Math.min(r.index, editorLine.length - 1)] : undefined;
        const where = line0 === undefined ? '' : ` on line ${line0 + 1}`;
        if (r.lastError === THROW_BREAK) return { text: `Stopped (BREAK)${where}`, mode: 'idle', mark: null };
        const message = describeThrow(r.lastError, r.word);
        const cols = r.col >= 0 ? tokenBefore(r.lineText, r.col) : null;
        return {
          text: `${message}${where}`,
          mode: 'error',
          mark: line0 === undefined ? null : { line0, message, cols },
        };
      },
    };
  },
};
