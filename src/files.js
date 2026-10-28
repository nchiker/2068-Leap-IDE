/**
 * src/files.js — program files: browser auto-save, text files, Leap tapes,
 * share links.
 *
 * No DOM or CodeMirror here (Node can import it): the toolbar wiring is in
 * ide.js, the editor reads the auto-save at start-up (src/editor.js).
 */

"use strict";

const AUTOSAVE_KEY = 'leap-ide.document';

/**
 * The document kept in this browser: what is in the editor, its file name,
 * and the text as last saved to (or opened from) a file, for the unsaved mark.
 * @typedef {{name: string, text: string, savedText: string}} StoredDocument
 */

/** @returns {StoredDocument | null} */
export function loadAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const doc = JSON.parse(raw);
    return typeof doc.text === 'string' && typeof doc.name === 'string' ? doc : null;
  } catch {
    return null;            // storage blocked or corrupt: start fresh
  }
}

/** @param {StoredDocument} doc */
export function storeAutosave(doc) {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(doc));
  } catch {
    // storage blocked or full: the editor still works, it just won't survive a reload
  }
}

/** Line endings to \n (files from Windows or old Macs). */
export function normalizeText(text) {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * Read the first Leap V2 program on a .tap (as written by Leap's SAVE or by
 * src/export.js buildTAP) back into source text.
 *
 * @param {Uint8Array} bytes
 * @returns {{name: string, text: string, warning: string | null}}
 * @throws {Error} with a message for the user when there is no Leap program
 */
export function tapeToText(bytes) {
  const blocks = [];
  for (let p = 0; p + 2 <= bytes.length;) {
    const len = bytes[p] | (bytes[p + 1] << 8);
    if (len < 2 || p + 2 + len > bytes.length) break;
    const block = bytes.subarray(p + 2, p + 2 + len);
    let check = 0;
    for (const b of block) check ^= b;
    blocks.push({ flag: block[0], data: block.subarray(1, len - 1), ok: check === 0 });
    p += 2 + len;
  }
  if (blocks.length === 0) throw new Error('Not a .tap file');

  let sawStock = false;
  for (let i = 0; i + 1 < blocks.length; i++) {
    const h = blocks[i];
    if (h.flag !== 0x00 || h.data.length !== 17 || h.data[0] !== 0) continue;   // program headers only
    const word = h.data[13] | (h.data[14] << 8);
    // Leap's LOAD accepts its own format word ($81xx) only; anything else is a
    // stock Sinclair/Timex BASIC tape (an autostart line), which is tokenised.
    if ((word >> 8) !== 0x81) { sawStock = true; continue; }
    const name = String.fromCharCode(...h.data.subarray(1, 11)).trimEnd();
    const length = h.data[11] | (h.data[12] << 8);
    const progLength = h.data[15] | (h.data[16] << 8);   // smaller than length on a SAVE ... ALL tape
    const d = blocks[i + 1];
    if (d.flag !== 0xFF || d.data.length < length) throw new Error(`The data for "${name}" is missing or short`);
    const lines = [];
    const store = d.data.subarray(0, progLength);
    for (let p = 0; p + 2 <= store.length;) {
      const n = store[p] | (store[p + 1] << 8);       // text length + 1 (the $0D)
      if (n < 1 || p + 2 + n > store.length) throw new Error(`"${name}" has a damaged line store`);
      lines.push(String.fromCharCode(...store.subarray(p + 2, p + 1 + n)));
      p += 2 + n;
    }
    const warning = h.ok && d.ok ? null : 'The tape has a checksum error; check the program';
    return { name, text: lines.join('\n') + '\n', warning };
  }
  throw new Error(sawStock
    ? 'This tape holds a Sinclair/Timex BASIC program, not a Leap V2 one'
    : 'No program found on this tape');
}

// ── Share links ───────────────────────────────────────────────────
// The program travels in the URL's fragment (#…), which the browser never
// sends to a server: #v1=<text, deflate-raw, base64url>&name=<file name>.
// Leap programs are at most about 9 KB, which compresses to a few KB.

const SHARE_VERSION = 'v1';

async function pipeBytes(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

/**
 * The URL fragment (without '#') that carries a program.
 * @param {string} text
 * @param {string} [name]  file name, e.g. "game.leap"
 */
export async function encodeShare(text, name = '') {
  const packed = await pipeBytes(new TextEncoder().encode(text), new CompressionStream('deflate-raw'));
  const params = new URLSearchParams();
  params.set(SHARE_VERSION, toBase64Url(packed));
  if (name) params.set('name', name);
  return params.toString();
}

/**
 * The program a URL fragment carries, or null if it carries none.
 * @param {string} hash  location.hash, with or without the '#'
 * @returns {Promise<{text: string, name: string} | null>}
 * @throws if the fragment has a program that cannot be read (cut short, damaged)
 */
export async function decodeShare(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const data = params.get(SHARE_VERSION);
  if (data === null) return null;
  let text;
  try {
    const bytes = await pipeBytes(fromBase64Url(data), new DecompressionStream('deflate-raw'));
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('The shared link is damaged or cut short: the program could not be read');
  }
  return { text: normalizeText(text), name: params.get('name') ?? '' };
}
