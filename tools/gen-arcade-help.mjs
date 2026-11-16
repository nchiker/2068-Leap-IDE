#!/usr/bin/env node
"use strict";
// gen-arcade-help.mjs -- writes src/lang/arcade/arcade-help-data.js, the data of Leap Arcade's Help entries (stage 5, P5).
//
//   node tools/gen-arcade-help.mjs            write src/lang/arcade/arcade-help-data.js; print the words with no example
//   node tools/gen-arcade-help.mjs --check    exit 1 if the file on disk is not what the generator writes now (tests/arcade-help-data.mjs does the same in memory)
//
// For each word of the language table (src/lang/arcade/arcade-words.js) it finds the SECTION of the language documents that defines the word
// (docs/ARCADE_LANGUAGE.md and docs/ARCADE_LANGUAGE_BATCH*.md) and writes the document's name and the section's GitHub heading anchor, so that Help
// links to `<docs URL><document>#<anchor>`, the word's section, not the top of the language document. A section is chosen by the best match, in this order:
//   5  a heading with the word in code (`## `TIMER``, `## 2. `ENTER``)           4  a heading that names the word in capitals
//   3  a table row or a bold paragraph that starts with the word                 2  a mention in code in docs/ARCADE_LANGUAGE.md (not its changelog)
//   1.5 a mention in code in a batch document                                    1  its changelog   0.5  the word in capitals anywhere
// (ties: the earlier document, then the earlier line). A word that starts a line of a code block in a section counts as a table row (3).
// OVERRIDES names the section outright where the language documents say nothing about a word in a section of its own (the contracts that
// define TABLE, MUSIC and the wireframe words, the batch 7 clause words, ...); a clause or closing word (HELP_ALIASES: ENDP, THEN, FLIP, ...) takes
// the section of the word it belongs to.
// The example comes from src/lang/arcade/arcade-help-examples.js (hand-written, every one proved to compile by tests/arcade-help-data.mjs): the language
// documents' code blocks are syntax outlines and assembler notes, not examples that compile, so none is taken from them.
// No dependency; Node only. The pieces (headingAnchors, docFiles, generate) are exported for the test.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(HERE, '..');
export const OUT_FILE = 'src/lang/arcade/arcade-help-data.js';
export const DOCS_BASE = 'https://github.com/nchiker/2068-Leap-IDE/blob/main/docs/';

/** The language documents, in the order the matches are tried: the language document, then the batches (batch 1 ... 7). GAPS is a wish list, not a definition. */
export function docFiles(root = DEFAULT_ROOT) {
  const all = readdirSync(join(root, 'docs'));
  const batches = all.filter((f) => /^ARCADE_LANGUAGE_BATCH\d+\.md$/.test(f)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  return ['ARCADE_LANGUAGE.md', ...batches];
}

/** GitHub's heading slug: lower case, everything but letters, digits, `_`, `-` and spaces removed, each space a hyphen. */
export function slug(text) {
  const plain = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim().toLowerCase();
  return plain.replace(/[^\p{L}\p{N}_\- ]/gu, '').replace(/ /g, '-');
}

/**
 * The headings of a markdown text outside code fences, with GitHub's anchors (a repeated slug gets -1, -2, ...).
 * @returns {{level: number, text: string, anchor: string, line: number}[]}  line is 0-based
 */
export function headingAnchors(md) {
  const seen = new Map();
  const out = [];
  let fence = false;
  md.split('\n').forEach((line, i) => {
    if (/^\s*```/.test(line)) { fence = !fence; return; }
    if (fence) return;
    const m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (!m) return;
    const base = slug(m[2]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push({ level: m[1].length, text: m[2], anchor: n === 0 ? base : `${base}-${n}`, line: i });
  });
  return out;
}

/** Sections named outright: word -> [document, heading text]; the heading must exist (generate() throws otherwise). */
export const OVERRIDES = {
  TABLE: ['ARCADE_TABLES_CONTRACT.md', '2. Language'], LOADTABLE: ['ARCADE_TABLES_CONTRACT.md', '2. Language'],
  MUSIC: ['ARCADE_MUSIC_CONTRACT.md', '2. Language'], NOMUSIC: ['ARCADE_MUSIC_CONTRACT.md', '2. Language'],
  WIRE3D: ['ARCADE_WIREFRAME_CONTRACT.md', '1. The language'], MODEL: ['ARCADE_WIREFRAME_CONTRACT.md', '1. The language'],
  EYE: ['ARCADE_WIREFRAME_CONTRACT.md', '1. The language'], DRAWMODEL: ['ARCADE_WIREFRAME_CONTRACT.md', '1. The language'],
  ROWS: ['ARCADE_WIREFRAME_CONTRACT.md', '1. The language'], YAW: ['ARCADE_WIREFRAME_CONTRACT.md', '1. The language'],
  PITCH: ['ARCADE_WIREFRAME_CONTRACT.md', '1. The language'], SCALE: ['ARCADE_WIREFRAME_CONTRACT.md', '1. The language'],
  NOWINDOW: ['ARCADE_LANGUAGE_BATCH7.md', '1. The language'], NOVIEW: ['ARCADE_LANGUAGE_BATCH7.md', '1. The language'],
  PRINT: ['ARCADE_LANGUAGE_BATCH5.md', 'Part B. PRINT formatting (item 7)'], USING: ['ARCADE_LANGUAGE_BATCH5.md', 'Part B. PRINT formatting (item 7)'],
  REM: ['ARCADE_LANGUAGE.md', 'Kept from Leap V2 (unchanged meaning)'],
  FOR: ['ARCADE_LANGUAGE.md', 'Kept from Leap V2 (unchanged meaning)'], NEXT: ['ARCADE_LANGUAGE.md', 'Kept from Leap V2 (unchanged meaning)'],
  STEP: ['ARCADE_LANGUAGE.md', 'Kept from Leap V2 (unchanged meaning)'], TO: ['ARCADE_LANGUAGE.md', 'Kept from Leap V2 (unchanged meaning)'],
};

/** The identifier-like tokens of every code span in a text: `PROC INIT()` -> PROC, INIT. */
function codeTokens(text) {
  const toks = [];
  for (const m of text.matchAll(/`([^`]+)`/g)) for (const t of m[1].match(/[A-Za-z][A-Za-z0-9]*\$?/g) ?? []) toks.push(t);
  return toks;
}
const hasWord = (text, w) => new RegExp(`(?<![A-Za-z0-9$])${w.replace(/\$/g, '\\$')}(?![A-Za-z0-9])`).test(text);

/** Every section of every document: {doc, anchor, heading, start, end, lines}; text outside code fences only is searched. */
function sections(root) {
  const out = [];
  docFiles(root).forEach((doc, docIndex) => {
    const md = readFileSync(join(root, 'docs', doc), 'utf8');
    const lines = md.split('\n');
    const heads = headingAnchors(md);
    heads.forEach((h, k) => {
      const end = k + 1 < heads.length ? heads[k + 1].line : lines.length;
      const body = [], code = [];
      let fence = false;
      for (let i = h.line + 1; i < end; i++) {
        if (/^\s*```/.test(lines[i])) { fence = !fence; continue; }
        (fence ? code : body).push(lines[i]);
      }
      out.push({ doc, docIndex, anchor: h.anchor, heading: h.text, line: h.line, body, code, changelog: /changelog/i.test(h.text) });
    });
  });
  return out;
}

/** The best section for a word: {doc, anchor, score} or null. */
export function findSection(word, secs) {
  let best = null;
  const offer = (s, score) => {
    if (!best || score > best.score || (score === best.score && (s.docIndex < best.docIndex || (s.docIndex === best.docIndex && s.line < best.line)))) {
      best = { doc: s.doc, anchor: s.anchor, score, docIndex: s.docIndex, line: s.line };
    }
  };
  for (const s of secs) {
    if (codeTokens(s.heading).includes(word)) offer(s, 5);
    else if (hasWord(s.heading, word)) offer(s, 4);
    let mention = false, plain = false, row = false;
    for (const line of s.body) {
      const t = line.trim();
      if (t.startsWith('|')) {
        const first = t.split('|')[1] ?? '';
        if (codeTokens(first).includes(word)) row = true;
      } else if (new RegExp(`^\\*\\*\`?${word.replace(/\$/g, '\\$')}\\b`).test(t)) row = true;
      if (codeTokens(line).includes(word)) mention = true;
      if (hasWord(line, word)) plain = true;
    }
    if (s.code.some((l) => new RegExp(`^\\s*${word.replace(/\$/g, '\\$')}(?![A-Za-z0-9$])`).test(l))) row = true;
    if (row) offer(s, 3);
    else if (mention) offer(s, s.changelog ? 1 : s.docIndex === 0 ? 2 : 1.5);
    else if (plain) offer(s, 0.5);
  }
  return best;
}

/** Everything the generator knows: the entries (word -> {doc, anchor, example}) and the words with no example. */
export async function load(root = DEFAULT_ROOT) {
  const { ARCADE_WORDS } = await import(pathToFileURL(join(root, 'src/lang/arcade/arcade-words.js')).href);
  const { HELP_EXAMPLES, HELP_ALIASES } = await import(pathToFileURL(join(root, 'src/lang/arcade/arcade-help-examples.js')).href);
  return { words: [...ARCADE_WORDS.values()].map((w) => w.name), examples: HELP_EXAMPLES, aliases: HELP_ALIASES };
}

/** The text of arcade-help-data.js, synchronously from the inputs (for the test, which loads the modules itself). */
export function render(entries) {
  const lines = [
    '/**',
    ' * src/lang/arcade/arcade-help-data.js — GENERATED by tools/gen-arcade-help.mjs; never hand-edit.',
    ' *',
    ' * For each word of the Leap Arcade language table (src/lang/arcade/arcade-words.js): the language document and the heading anchor of the section that',
    ' * defines it (docs/ARCADE_LANGUAGE.md, docs/ARCADE_LANGUAGE_BATCH*.md), so that Help links to the word\'s section, and its example (from the',
    ' * hand-written src/lang/arcade/arcade-help-examples.js; null when the word has none). Regenerate after changing a language document or an example:',
    ' *   node tools/gen-arcade-help.mjs',
    ' */',
    '',
    '"use strict";',
    '',
    `export const DOCS_BASE = ${JSON.stringify(DOCS_BASE)};`,
    '',
    'export const ARCADE_HELP = {',
  ];
  for (const [w, e] of Object.entries(entries)) lines.push(`  ${JSON.stringify(w)}: { doc: ${JSON.stringify(e.doc)}, anchor: ${JSON.stringify(e.anchor)}, example: ${JSON.stringify(e.example)} },`);
  lines.push('};', '');
  return lines.join('\n');
}

/** The section an override names: {doc, anchor}; throws when the heading is not in the document. */
function overrideSection(root, [doc, heading]) {
  const md = readFileSync(join(root, 'docs', doc), 'utf8');
  const h = headingAnchors(md).find((x) => x.text === heading);
  if (!h) throw new Error(`gen-arcade-help: no heading "${heading}" in docs/${doc}`);
  return { doc, anchor: h.anchor };
}

/** Build the data from the documents and the examples of the tree at `root`. Returns {text, entries, noExample, noSection}. */
export function generateFrom({ root, words, examples, aliases }) {
  const secs = sections(root);
  const entries = {};
  const noExample = [], noSection = [];
  const sectionOf = (w) => (OVERRIDES[w] ? overrideSection(root, OVERRIDES[w]) : null) ?? (aliases[w] ? sectionOf(aliases[w]) : null) ?? findSection(w, secs);
  for (const w of words) {
    const s = sectionOf(w);
    if (!s) noSection.push(w);
    const ex = examples[w] ?? (aliases[w] ? examples[aliases[w]] : null) ?? null;
    if (ex === null) noExample.push(w);
    entries[w] = { doc: s?.doc ?? 'ARCADE_LANGUAGE.md', anchor: s?.anchor ?? '', example: ex };
  }
  return { text: render(entries), entries, noExample, noSection };
}

/** Load the inputs of the tree at `root` and build the data (the test awaits this as `generate`). */
export async function generateAsync(root = DEFAULT_ROOT) {
  const inputs = await load(root);
  return generateFrom({ root, ...inputs });
}
export { generateAsync as generate };

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const check = process.argv.includes('--check');
  const root = DEFAULT_ROOT;
  const res = await generateAsync(root);
  const path = join(root, OUT_FILE);
  if (check) {
    let disk = '';
    try { disk = readFileSync(path, 'utf8'); } catch { /* missing */ }
    if (disk !== res.text) { console.error(`${OUT_FILE} is out of date: run node tools/gen-arcade-help.mjs`); process.exit(1); }
    console.log(`${OUT_FILE} is current`);
  } else {
    writeFileSync(path, res.text);
    console.log(`wrote ${OUT_FILE}: ${Object.keys(res.entries).length} words`);
    if (res.noSection.length) console.log(`words with no section (link goes to the top of ARCADE_LANGUAGE.md): ${res.noSection.join(' ')}`);
    console.log(`words with no example (${res.noExample.length}): ${res.noExample.join(' ')}`);
  }
}
