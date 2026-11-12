/**
 * src/tools/sound-editor.js — the sound editor of the Leap Arcade Studio.
 *
 *   createSoundEditor(container, host) -> { refresh(), render(), select(name), destroy(), getState() }
 *
 * `host` is the asset-editor host of docs/ARCADE_STUDIO.md ("Asset editor host interface") with the S2 additions of
 * docs/ARCADE_STUDIO_S2_CONTRACT.md section 7.  Used members: getProject(), listAssets(kind), getAsset(kind, name), setAsset(kind, name, value),
 * deleteAsset, renameAsset, onProjectChange, onSelectAsset, status(text), id and the optional assetWarnings(kind, name), soundCount() and
 * usedBy(kind, name).  Every one is optional except one way to read the effects and setAsset; a missing member switches its feature off.
 * The editor never touches the project object, localStorage for project data (only its own zoom), the code editor or the emulator.
 *
 * The data model, every operation and the AY renderer are in sound-model.js (pure); this file is the UI: lanes over the tick timeline
 * (volume bars, tone curve on a log pitch axis, noise period, tone-on / noise-on rows) on one canvas, painting by pointer, a range
 * selection with the operations of contract section 6, a numeric row editor, presets, Play (Web Audio), a waveform thumbnail,
 * size / count readouts and the effect's warnings.  A stroke or an operation is one undo step and one host.setAsset().
 *
 * Three tracks (language batch 5): tabs A / B / C pick the AY channel being edited (B and C start empty and are stored only when they hold ticks); every
 * lane, operation and the row editor work on the selected track; the timeline is as long as the longest track and its tone lane shows all three
 * curves, the selected one bright; painting a track past its end extends it with silent ticks; Play mixes the channels.
 *
 * Songs (docs/ARCADE_MUSIC_CONTRACT.md section 7; the model is music-model.js): the buttons Effects / Songs switch the editor between the project's `sfx`
 * and `music` assets.  A song is a list of patterns (each one a three-channel effect, edited here exactly as an effect is), an order list of pattern
 * indices and a loop position.  In song mode a song panel above the lanes holds the pattern list (pick, add, duplicate, delete, move, label), the
 * order list (append, insert, set, move, remove; the loop) and the song's size and length; Play plays the pattern shown, "Song" the whole song (the
 * loop once more).  Note entry (both modes) writes a note of an instrument into the selected track at a tick.  One undo history per asset: in song mode
 * it covers the whole song (a pattern edit and an order edit alike), and every edit writes the whole song with one host.setAsset('music', ...).
 * The host's select(name, kind) / onSelectAsset({kind: 'music'}) open a song; select(name) alone keeps the mode.
 */

"use strict";

import * as M from './sound-model.js';
import * as MM from './music-model.js';

const PREF_KEY = 'leap-studio.sfxed';
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,30}$/;
const ZOOMS = [2, 3, 4, 6, 8, 12, 16, 24];
const UNDO_STEPS = 200;
const BLANK_TICK = { tone: 200, vol: 0, noise: 0, mix: 6 };
const TRACK_NAMES = M.TRACKS.map((t) => t.name);
const TRACK_COLOUR = ['ok', 'blue', 'amber'];          // the tone lane's curve colour of channel A, B, C (CSS variable families of the theme)
const PRESET_LABELS = { beep: 'beep', laser: 'laser', blip: 'blip', explosion: 'explosion (noise)', powerup: 'power-up', hurt: 'hurt' };

// Lane geometry (canvas pixels, top to bottom); labels in the label column use the same numbers.
const LANES = {
  ruler: { y: 0, h: 18 },
  vol: { y: 22, h: 72 },
  tone: { y: 98, h: 150 },
  noise: { y: 252, h: 48 },
  tmix: { y: 304, h: 16 },
  nmix: { y: 322, h: 16 },
};
const LANE_ORDER = ['ruler', 'vol', 'tone', 'noise', 'tmix', 'nmix'];
const LANES_H = 338;
const LABEL_W = 44;
const LANE_LABELS = { vol: 'volume', tone: 'tone', noise: 'noise', tmix: 'tone on', nmix: 'noise on' };
const LANE_FIELD = { vol: 'vol', tone: 'tone', noise: 'noise' };
// The tone lane's log pitch axis runs from tone TONE_TOP (the top, about 6.9 kHz) to 4095 (the bottom, 27 Hz): 8 octaves, 150 px.
const TONE_TOP = 16;
const LN_SPAN = Math.log(4095 / TONE_TOP);

// ── DOM helpers (no innerHTML anywhere: user data only goes through textContent / value) ─────────────────────────
function el(tag, cls, text, attrs) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}
function button(label, title, onClick, cls = '', role = '') {
  const b = el('button', 'sfxed-btn ' + cls, label, { type: 'button' });
  if (title) b.title = title;
  if (role) b.dataset.role = role;
  b.addEventListener('click', onClick);
  return b;
}
function select(options, value, onChange, title, role = '') {
  const s = el('select', 'sfxed-select');
  for (const [v, label] of options) { const o = el('option', null, label); o.value = String(v); s.append(o); }
  s.value = String(value);
  if (title) s.title = title;
  if (role) s.dataset.role = role;
  s.addEventListener('change', () => onChange(s.value));
  return s;
}
function input(value, title, width, role, type = 'number', attrs = {}) {
  const i = el('input', 'sfxed-num', null, { type, ...attrs });
  i.value = String(value);
  i.style.width = width + 'px';
  if (title) i.title = title;
  if (role) i.dataset.role = role;
  return i;
}
const label = (text, title) => { const l = el('span', 'sfxed-label', text); if (title) l.title = title; return l; };
const sep = () => el('span', 'sfxed-sep');

const STYLE_ID = 'sfxed-style';
const CSS = `
.sfxed { display: flex; flex-direction: column; gap: 8px; box-sizing: border-box; padding: 8px 10px; color: var(--fg, #cdd9e5); background: var(--bg-panel, #13171f);
  font: 12px var(--font-ui, system-ui, sans-serif); outline: none; position: relative; min-width: 0; }
.sfxed * { box-sizing: border-box; }
.sfxed [hidden] { display: none !important; }
.sfxed-bar, .sfxed-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.sfxed-btn { font: 11px var(--font-ui, system-ui, sans-serif); color: var(--fg, #cdd9e5); background: var(--bg-surface, #1c2128); border: 1px solid var(--border-hi, #444c56);
  border-radius: 4px; padding: 3px 8px; cursor: pointer; }
.sfxed-btn:hover { background: var(--bg-hover, #22292f); }
.sfxed-btn:disabled { opacity: .45; cursor: default; }
.sfxed-btn.on { border-color: var(--amber-fg, #e3b341); color: var(--amber-fg, #e3b341); background: var(--bg-active, #2d333b); }
.sfxed-btn.sm { padding: 1px 6px; }
.sfxed-select, .sfxed-num { font: 11px var(--font-ui, system-ui, sans-serif); color: var(--fg, #cdd9e5); background: var(--bg, #0d1117); border: 1px solid var(--border-hi, #444c56); border-radius: 4px; padding: 2px 4px; }
.sfxed-label { color: var(--fg-muted, #768390); font-size: 11px; }
.sfxed-sep { width: 1px; align-self: stretch; background: var(--border, #2d333b); margin: 0 2px; }
.sfxed-warn { margin: 0; padding: 0; list-style: none; font-size: 11px; line-height: 1.45; }
.sfxed-warn li { padding: 2px 6px; border-left: 3px solid var(--amber-fg, #e3b341); color: var(--fg, #cdd9e5); background: var(--bg-surface, #1c2128); margin-bottom: 2px; }
.sfxed-warn li.err { border-left-color: var(--red-fg, #f78166); color: var(--red-fg, #f78166); cursor: pointer; }
.sfxed-body { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.sfxed-lanes { display: flex; width: fit-content; max-width: 100%; align-items: flex-start; min-width: 0; border: 1px solid var(--border-hi, #444c56); border-radius: 4px; background: var(--bg, #0d1117); }
.sfxed-labels { position: relative; flex: none; width: ${LABEL_W}px; height: ${LANES_H}px; color: var(--fg-muted, #768390); font: 10px var(--font-ui, system-ui, sans-serif); }
.sfxed-labels span { position: absolute; left: 4px; white-space: nowrap; line-height: 12px; }
.sfxed-labels span.note { left: auto; right: 3px; color: var(--fg-dim, #3d444c); }
.sfxed-scroll { flex: 1 1 auto; min-width: 0; overflow-x: auto; overflow-y: hidden; }
.sfxed-canvas { display: block; cursor: crosshair; touch-action: none; }
.sfxed-hint { height: 30px; overflow: hidden; font: 11px var(--font-code, monospace); color: var(--fg-muted, #768390); white-space: pre-wrap; }
.sfxed-ops { display: flex; flex-direction: column; gap: 5px; padding: 6px 8px; border: 1px solid var(--border, #2d333b); border-radius: 6px; background: var(--bg-surface, #1c2128); }
.sfxed-ops .sfxed-row b { font-weight: 600; font-size: 11px; min-width: 52px; }
.sfxed-foot { display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-start; }
.sfxed-wave { display: block; border: 1px solid var(--border-hi, #444c56); border-radius: 3px; background: var(--bg, #0d1117); }
.sfxed-info { font: 11px/1.5 var(--font-code, monospace); color: var(--fg, #cdd9e5); margin: 0; white-space: pre-wrap; }
.sfxed-info .over { color: var(--amber-fg, #e3b341); }
.sfxed-msg { min-height: 16px; color: var(--fg-muted, #768390); font-size: 11px; }
.sfxed-msg.err { color: var(--red-fg, #f78166); }
.sfxed-msg.warn { color: var(--amber-fg, #e3b341); }
.sfxed-tab.empty { color: var(--fg-muted, #768390); }
.sfxed-tab.t0.on { border-color: var(--ok-fg, #8ddb8c); color: var(--ok-fg, #8ddb8c); }
.sfxed-tab.t1.on { border-color: var(--blue-fg, #79c0ff); color: var(--blue-fg, #79c0ff); }
.sfxed-tab.t2.on { border-color: var(--amber-fg, #e3b341); color: var(--amber-fg, #e3b341); }
.sfxed-empty { color: var(--fg-muted, #768390); padding: 24px 8px; }
.sfxed-song { display: flex; flex-direction: column; gap: 5px; padding: 6px 8px; border: 1px solid var(--border, #2d333b); border-radius: 6px; background: var(--bg-surface, #1c2128); }
.sfxed-song .sfxed-row b, .sfxed-notes b { font-weight: 600; font-size: 11px; min-width: 52px; }
.sfxed-chips { display: flex; flex-wrap: wrap; gap: 3px; max-width: 100%; }
.sfxed-chip { font: 11px var(--font-code, monospace); color: var(--fg, #cdd9e5); background: var(--bg, #0d1117); border: 1px solid var(--border-hi, #444c56); border-radius: 3px; padding: 1px 5px; cursor: pointer; }
.sfxed-chip:hover { background: var(--bg-hover, #22292f); }
.sfxed-chip.on { border-color: var(--amber-fg, #e3b341); color: var(--amber-fg, #e3b341); }
.sfxed-chip.cur { box-shadow: inset 0 -2px 0 var(--blue-fg, #79c0ff); }
.sfxed-chip.loop::before { content: '↻ '; color: var(--ok-fg, #8ddb8c); }
.sfxed-chip.playing { background: var(--bg-active, #2d333b); border-color: var(--ok-fg, #8ddb8c); }
.sfxed-chip.unused { color: var(--fg-muted, #768390); border-style: dashed; }
.sfxed-notes { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 8px; border: 1px solid var(--border, #2d333b); border-radius: 6px; background: var(--bg-surface, #1c2128); }
`;
function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = el('style');
  st.id = STYLE_ID;
  st.textContent = CSS;
  document.head.append(st);
}

function loadPrefs() {
  try { const p = JSON.parse(localStorage.getItem(PREF_KEY) ?? 'null'); if (p && typeof p === 'object') return p; } catch { /* storage blocked or damaged */ }
  return {};
}
function savePrefs(p) { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* storage blocked */ } }

const deepCopy = (v) => JSON.parse(JSON.stringify(v));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const centsText = (c) => (c >= 0 ? '+' : '-') + Math.abs(c) + 'c';
const NOTE_RE = /^[A-Ga-g][#b]?-?\d$/;
/** A tone period typed as a number or a note name ('A4'); NaN when it is neither. */
function parseTone(text) {
  const s = String(text).trim();
  if (s === '') return NaN;
  if (NOTE_RE.test(s)) { try { return M.toneOfNote(s); } catch { return NaN; } }
  return Number(s);
}
const parseNum = (text) => (String(text).trim() === '' ? NaN : Number(text));

export function createSoundEditor(container, host) {
  injectStyle();
  const prefs = loadPrefs();
  const hostId = host?.id ?? 'sound-editor';

  // ── host access (every call guarded: a missing member degrades, it does not throw) ──
  // `k` defaults to the editor's mode: 'sfx' (effects) or 'music' (songs)
  const H = {
    list(k = kind) {
      try {
        if (host.listAssets) return host.listAssets(k);
        return Object.keys(host.getProject()?.assets?.[k] ?? {}).sort();
      } catch { return []; }
    },
    get(name, k = kind) {
      try {
        if (host.getAsset) return host.getAsset(k, name);
        const a = host.getProject()?.assets?.[k]?.[name];
        return a ? deepCopy(a) : null;
      } catch { return null; }
    },
    set(name, asset, k = kind) { try { return host.setAsset(k, name, asset) ?? { ok: true }; } catch (e) { return { ok: false, error: e.message }; } },
    del(name, k = kind) { try { return host.deleteAsset ? host.deleteAsset(k, name) !== false : false; } catch { return false; } },
    rename(a, b, k = kind) {
      try {
        if (host.renameAsset) return host.renameAsset(k, a, b) ?? { ok: true };
        const v = H.get(a, k);
        const r = H.set(b, v, k);
        if (r.ok) H.del(a, k);
        return r;
      } catch (e) { return { ok: false, error: e.message }; }
    },
    warnings(name) {
      if (typeof host?.assetWarnings !== 'function') return null;
      try { const w = host.assetWarnings(kind, name); return Array.isArray(w) ? w : null; } catch { return null; }
    },
    count() {
      const fn = kind === 'music' ? host?.songCount : host?.soundCount;
      if (typeof fn !== 'function') return null;
      try { const n = fn.call(host); return Number.isInteger(n) ? n : null; } catch { return null; }
    },
    usedBy(name) { try { const u = host?.usedBy?.(kind, name); return Array.isArray(u) ? u : []; } catch { return []; } },
  };

  // ── state ──
  let kind = 'sfx';                     // 'sfx': effects; 'music': songs (the pattern shown is edited as an effect)
  let name = null;                      // the effect / song being edited (an asset name) or null
  let sfx = null;                       // its editing form (sound-model); in song mode the pattern shown: song.patterns[pat] (the same object)
  let song = null;                      // song mode: the song's editing form (music-model)
  let pat = 0;                          // song mode: the pattern shown
  let opos = 0;                         // song mode: the selected order position
  const lastNames = { sfx: null, music: null };     // the asset last shown in each mode
  let noteAt = 0, noteCur = -1, noteNext = null;     // note entry: the tick the next note goes to (follows the cursor, then the end of the last note)
  let hist = null;                      // undo / redo of the effect, or of the whole song
  let stats = {};                       // song mode: songInfo / validateSong of the song as of the last render, worked out once (they convert the whole song)
  let lastStored = '';                  // JSON of the asset as last read from / written to the host
  let track = 0;                        // the channel being edited: 0 = A, 1 = B, 2 = C
  let cur = 0;                          // the tick the row editor shows
  let rng = [0, 0];                     // the selected range (inclusive); operations act on it
  let anchor = 0;                       // the end of the range that stays put while it is extended
  let zoom = Number.isInteger(prefs.zoom) && prefs.zoom >= 0 ? prefs.zoom : 0;     // 0 = fit
  let colW = 8;
  let stroke = null;                    // {mode: 'paint' | 'select', lane, last: {i, v}, target, changed, msg}
  let hostMarks = new Set();            // ticks the host's warnings mark
  let hoverTick = -1;
  let prefillKey = '';
  let destroyed = false;
  const cleanups = [];

  // playback
  let actx = null, src = null, playing = false, playStart = 0, playDur = 0, raf = 0, playX = -1;
  let playWhat = 'effect', playPos = -1;        // what is playing: 'effect' | 'pattern' | 'song'; the order position playing (a song)

  const keepPrefs = () => savePrefs({ zoom });

  // ── skeleton ──
  const root = el('div', 'sfxed', null, { tabindex: '0' });
  root.dataset.role = 'sound-editor';
  container.append(root);

  const bar = el('div', 'sfxed-bar');
  const btnModeSfx = button('Effects', 'Edit the sound effects (SFX)', () => setMode('sfx'), 'sfxed-tab', 'mode-sfx');
  const btnModeMusic = button('Songs', 'Edit the songs (MUSIC): patterns, an order list and a loop', () => setMode('music'), 'sfxed-tab', 'mode-music');
  const nameSel = el('select', 'sfxed-select', null, { 'aria-label': 'Sound effect' });
  nameSel.style.minWidth = '110px';
  nameSel.dataset.role = 'name';
  nameSel.addEventListener('change', () => { if (nameSel.value) loadEffect(nameSel.value); });
  const presetSel = select([['blank', 'blank'], ...M.PRESETS.map((p) => [p, PRESET_LABELS[p] ?? p])], 'beep', () => {}, 'The effect New starts from', 'preset');
  const presetLabel = label('preset');
  const btnNew = button('New', 'Create an effect from the preset', () => newCmd(), '', 'new');
  const btnDup = button('Duplicate', 'Copy this effect under a new name', () => duplicateCmd(), '', 'dup');
  const btnRen = button('Rename', 'Rename this effect', () => renameCmd(), '', 'rename');
  const btnDel = button('Delete', 'Delete this effect', () => deleteCmd(), '', 'delete');
  bar.append(btnModeSfx, btnModeMusic, sep(), nameSel, presetLabel, presetSel, btnNew, btnDup, btnRen, btnDel);

  // the song panel (song mode only): patterns, the order list and the loop, the song's size and length
  const songBox = el('div', 'sfxed-song');
  songBox.dataset.role = 'song';
  const patChips = el('div', 'sfxed-chips');
  patChips.dataset.role = 'patterns';
  const ordChips = el('div', 'sfxed-chips');
  ordChips.dataset.role = 'order';
  const loopSel = el('select', 'sfxed-select', null, { 'aria-label': 'Loop' });
  loopSel.dataset.role = 'loop';
  loopSel.title = 'Where the song continues after the last order entry (none: it stops)';
  loopSel.addEventListener('change', () => edit(() => MM.setLoop(song, loopSel.value === 'none' ? null : Number(loopSel.value))));
  const songInfoEl = label('', 'The size of the song on the cartridge (patterns, order list and loop) and its length');
  songInfoEl.dataset.role = 'song-info';
  const songRow = (...kids) => { const r = el('div', 'sfxed-row'); r.append(...kids); return r; };
  songBox.append(
    songRow(el('b', null, 'Patterns'), patChips),
    songRow(el('b', null, ''),
      button('Add', 'Add a silent pattern after this one (as long as this one)', () => edit(() => MM.addPattern(song, pat + 1, null, MM.patternLength(sfx) || MM.DEFAULT_PATTERN_TICKS)), 'sm', 'pat-add'),
      button('Duplicate', 'Copy this pattern; the copy goes right after it', () => edit(() => MM.duplicatePattern(song, pat)), 'sm', 'pat-dup'),
      button('Delete', 'Delete this pattern (its order entries go too)', () => edit(() => MM.deletePattern(song, pat)), 'sm', 'pat-del'),
      button('◀', 'Move this pattern one place earlier in the list (the order list still plays the same music)', () => edit(() => MM.movePattern(song, pat, pat - 1)), 'sm', 'pat-left'),
      button('▶', 'Move this pattern one place later in the list', () => edit(() => MM.movePattern(song, pat, pat + 1)), 'sm', 'pat-right'),
      button('Label', 'Give this pattern a label (only for you: the game does not store it)', () => labelCmd(), 'sm', 'pat-label')),
    songRow(el('b', null, 'Order'), ordChips),
    songRow(el('b', null, ''),
      button('Append', 'Play this pattern after the last order entry', () => edit(() => MM.orderAppend(song, pat)), 'sm', 'ord-append'),
      button('Insert', 'Play this pattern before the selected order entry', () => edit(() => MM.orderInsert(song, opos, pat)), 'sm', 'ord-insert'),
      button('Set', 'The selected order entry plays this pattern', () => edit(() => MM.orderSet(song, opos, pat)), 'sm', 'ord-set'),
      button('◀', 'Move the selected order entry earlier', () => edit(() => MM.orderMove(song, opos, opos - 1)), 'sm', 'ord-left'),
      button('▶', 'Move the selected order entry later', () => edit(() => MM.orderMove(song, opos, opos + 1)), 'sm', 'ord-right'),
      button('Remove', 'Remove the selected order entry', () => edit(() => MM.orderRemove(song, opos)), 'sm', 'ord-remove'),
      label('loop'), loopSel),
    songRow(songInfoEl));

  const transport = el('div', 'sfxed-bar');
  const btnPlay = button('▶ Play', 'Play the effect (Space)', () => play(false), 'on', 'play');
  const btnPlaySong = button('▶ Song', 'Play the whole song: the order list, then from the loop to the end once more', () => playSong(), '', 'play-song');
  const btnPlayR = button('▶ Range', 'Play the selected ticks only', () => play(true), '', 'play-range');
  const btnStop = button('■ Stop', 'Stop playing (Space)', () => stopPlay(), '', 'stop');
  const btnUndo = button('Undo', 'Undo (Ctrl+Z)', () => undo(), '', 'undo');
  const btnRedo = button('Redo', 'Redo (Ctrl+Y)', () => redo(), '', 'redo');
  const zoomLabel = label('', 'Pixels per tick');
  zoomLabel.dataset.role = 'zoom';
  transport.append(btnPlay, btnPlaySong, btnPlayR, btnStop, sep(), btnUndo, btnRedo, sep(), button('−', 'Zoom out', () => setZoom(-1), 'sm', 'zoom-out'), zoomLabel,
    button('+', 'Zoom in', () => setZoom(1), 'sm', 'zoom-in'), button('Fit', 'Fit the whole effect in the width', () => { zoom = 0; keepPrefs(); renderAll(); }, 'sm', 'zoom-fit'));

  const trackBar = el('div', 'sfxed-bar');
  trackBar.dataset.role = 'tracks';
  const trackBtns = TRACK_NAMES.map((n, ch) => {
    const b = button(n, `Edit channel ${n} (the AY plays the three channels together)`, () => setTrack(ch), `sfxed-tab t${ch}`, `track-${n.toLowerCase()}`);
    b.setAttribute('aria-pressed', 'false');
    return b;
  });
  const btnClearTrack = button('Clear track', 'Remove every tick of this channel (B and C are not stored when empty)', () => edit(() => { if (track === 0) return { message: 'channel A keeps at least one tick' }; sfx[M.TRACKS[track].key].length = 0; return { message: null }; }), '', 'track-clear');
  const trackNote = label('', 'The length of each channel; the effect lasts as long as the longest');
  trackNote.dataset.role = 'track-note';
  trackBar.append(label('channel'), ...trackBtns, btnClearTrack, trackNote);

  const warnList = el('ul', 'sfxed-warn');
  warnList.dataset.role = 'warnings';
  const emptyNote = el('div', 'sfxed-empty', '');
  emptyNote.dataset.role = 'empty';
  const body = el('div', 'sfxed-body');
  body.dataset.role = 'body';
  const msg = el('div', 'sfxed-msg');
  msg.dataset.role = 'message';
  root.append(bar, songBox, transport, trackBar, warnList, emptyNote, body, msg);

  // lanes: a label column and the scrolling canvas
  const lanesBox = el('div', 'sfxed-lanes');
  const labelCol = el('div', 'sfxed-labels');
  for (const k of LANE_ORDER) {
    if (!LANE_LABELS[k]) continue;
    const s_ = el('span', null, LANE_LABELS[k]);
    s_.style.top = (k === 'tmix' || k === 'nmix' ? LANES[k].y + (LANES[k].h - 12) / 2 : LANES[k].y + 1) + 'px';
    labelCol.append(s_);
  }
  const noteLabels = [];
  for (const midi of [33, 45, 57, 69, 81, 93, 105]) {                      // A1 .. A7 guides on the tone lane
    const s = el('span', 'note', M.noteOfTone(M.toneOfNote(midi)).name);
    s.style.top = (LANES.tone.y + toneToF(M.toneOfNote(midi)) * LANES.tone.h - 6) + 'px';
    labelCol.append(s); noteLabels.push(s);
  }
  const scroller = el('div', 'sfxed-scroll');
  scroller.dataset.role = 'scroller';
  const canvas = el('canvas', 'sfxed-canvas');
  canvas.dataset.role = 'lanes';
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  scroller.append(canvas);
  lanesBox.append(labelCol, scroller);
  const hint = el('div', 'sfxed-hint', '');
  hint.dataset.role = 'hint';

  // the row editor for the tick under the cursor
  const rowEd = el('div', 'sfxed-row');
  rowEd.dataset.role = 'row-editor';
  const tickIn = input(0, 'The tick shown (0-based)', 54, 'tick-index', 'number', { min: '0', step: '1' });
  const fIn = {
    tone: input(0, 'Tone period 0..4095 (higher = lower pitch; frequency = 110250 / period)', 58, 'f-tone', 'number', { min: '0', max: '4095', step: '1' }),
    vol: input(0, 'Volume 0..15', 44, 'f-vol', 'number', { min: '0', max: '15', step: '1' }),
    noise: input(0, 'Noise period 0..31', 44, 'f-noise', 'number', { min: '0', max: '31', step: '1' }),
    mix: input(0, 'Mixer 0..7: bit 0 = tone off, bit 1 = noise off. 6 tone only, 4 tone + noise, 5 noise only, 7 silent', 44, 'f-mix', 'number', { min: '0', max: '7', step: '1' }),
  };
  const noteOut = label('', 'The nearest note to the tone');
  noteOut.dataset.role = 'note';
  const mixOut = label('', '');
  mixOut.dataset.role = 'mix-text';
  tickIn.addEventListener('change', () => { const v = parseNum(tickIn.value); if (Number.isFinite(v)) selectTick(Math.round(v)); else syncRow(); });
  for (const f of M.FIELD_NAMES) {
    fIn[f].addEventListener('change', () => {
      const v = parseNum(fIn[f].value);
      edit(() => {
        const c = M.clampField(f, v);
        if (c.value === null) return c;
        M.padTrack(sfx, track, cur + 1);                       // a tick past the track's end: the track grows to it
        return M.setTick(V(), cur, f, v);
      });
    });
  }
  rowEd.append(label('tick'), button('◀', 'Previous tick (Left)', () => selectTick(cur - 1), 'sm', 'tick-prev'), tickIn, button('▶', 'Next tick (Right)', () => selectTick(cur + 1), 'sm', 'tick-next'),
    sep(), label('tone'), fIn.tone, noteOut, label('vol'), fIn.vol, label('noise'), fIn.noise, label('mix'), fIn.mix, mixOut);

  // note entry: a note of an instrument into the selected track, from a tick (the cursor; after an entry, the tick after the note)
  const notes = el('div', 'sfxed-notes');
  notes.dataset.role = 'notes';
  const noteSel = select(MM.NOTE_LETTERS.map((n) => [n, n]), 'C', () => {}, 'The note', 'note-name');
  const noteOct = input(4, 'The octave (4 is the middle octave: C4 = middle C, A4 = 440 Hz)', 44, 'note-oct', 'number', { min: '0', max: '8', step: '1' });
  const noteLen = input(8, 'How many refreshes the note lasts (60 a second)', 52, 'note-len', 'number', { min: '1', max: String(MM.MAX_PATTERN_TICKS), step: '1' });
  const noteInst = select(MM.INSTRUMENTS.map((x) => [x.id, x.label]), 'pluck', () => {}, 'The instrument: a volume envelope (the drum plays noise)', 'note-inst');
  const noteVol = input('', 'The loudest volume 1..15 (empty: the instrument\'s own)', 44, 'note-vol', 'number', { min: '1', max: '15', step: '1' });
  const noteAtIn = input(0, 'The tick the note starts at', 54, 'note-at', 'number', { min: '0', step: '1' });
  noteAtIn.addEventListener('change', () => { const v = parseNum(noteAtIn.value); if (Number.isFinite(v)) noteAt = clamp(Math.round(v), 0, MM.MAX_PATTERN_TICKS - 1); noteAtIn.value = String(noteAt); });
  /** Tell now (status line) when the note and octave chosen are below the AY's lowest note, instead of when Enter is pressed. */
  const warnLowNote = () => {
    const oct = parseNum(noteOct.value);
    if (!(Number.isInteger(oct) && oct >= 0 && oct <= 8)) return;
    const low = MM.noteRefusal(`${noteSel.value}${oct}`, noteInst.value);
    if (low) say(low, 'err');
  };
  for (const c of [noteSel, noteOct, noteInst]) c.addEventListener('change', warnLowNote);
  notes.append(el('b', null, 'Note'), noteSel, label('octave'), noteOct, label('length'), noteLen, noteInst, label('peak'), noteVol, label('at tick'), noteAtIn,
    button('Enter', 'Write the note into the selected channel from that tick (it overwrites, and extends the channel when needed)', () => noteCmd(false), '', 'note-enter'),
    button('Rest', 'Write silence of that length into the selected channel', () => noteCmd(true), '', 'note-rest'));

  // range operations
  const ops = el('div', 'sfxed-ops');
  ops.dataset.role = 'ops';
  const rangeLabel = label('', 'The ticks the operations below act on');
  rangeLabel.dataset.role = 'range';
  const insN = input(1, 'How many ticks to insert (copies of the last selected tick)', 44, 'ins-n', 'number', { min: '1', max: String(MM.MAX_PATTERN_TICKS), step: '1' });
  const scaleF = input(0.5, 'Volume factor', 52, 'scale-f', 'number', { min: '0', step: '0.1' });
  const swFrom = input(0, 'First tone (a number, or a note name such as A4)', 58, 'sw-from', 'text');
  const swTo = input(0, 'Last tone (a number, or a note name such as A5)', 58, 'sw-to', 'text');
  const swMode = select([['tone', 'linear in tone'], ['semitones', 'linear in semitones']], 'semitones', () => {}, 'Linear in the period, or in pitch (musical)', 'sw-mode');
  const repN = input(2, 'Play the range this many times in all', 44, 'rep-n', 'number', { min: '1', max: String(MM.MAX_PATTERN_TICKS), step: '1' });
  const setField = select(M.FIELD_NAMES.map((f) => [f, f]), 'vol', () => {}, 'The field to set', 'set-field');
  const setVal = input(8, 'The value', 52, 'set-val', 'number', { step: '1' });
  const rangeOf = () => [rng[0], rng[1]];
  const opRow = (...kids) => { const r = el('div', 'sfxed-row'); r.append(...kids); return r; };
  const selAll = button('All', 'Select every tick (Ctrl+A)', () => { anchor = 0; rng = [0, tickCount() - 1]; cur = rng[1]; renderAll(); }, 'sm', 'select-all');
  ops.append(
    opRow(el('b', null, 'Range'), rangeLabel, selAll),
    opRow(el('b', null, 'Ticks'), button('Insert', 'Insert ticks after the range', () => edit(() => M.insertTicks(V(), rng[1] + 1, parseNum(insN.value) || 0)), '', 'op-insert'), insN,
      button('Delete', 'Delete the selected ticks (channel A keeps at least one)', () => edit(() => M.deleteTicks(V(), ...rangeOf())), '', 'op-delete'),
      button('Duplicate', 'Copy the range and insert the copy right after it', () => edit(() => M.duplicateRange(V(), ...rangeOf())), '', 'op-duplicate'),
      button('Reverse', 'Play the range backwards', () => edit(() => M.reverseRange(V(), ...rangeOf())), '', 'op-reverse'),
      label('repeat'), repN, button('Repeat', 'Play the range this many times in all', () => edit(() => M.repeatRange(V(), ...rangeOf(), parseNum(repN.value))), '', 'op-repeat')),
    opRow(el('b', null, 'Volume'), button('Scale', 'Multiply the volume of the range', () => edit(() => M.scaleVolume(V(), ...rangeOf(), parseNum(scaleF.value))), '', 'op-scale'), label('×'), scaleF,
      button('Fade in', 'Volume rises from 0 to what it was over the range', () => edit(() => M.fade(V(), ...rangeOf(), 'in')), '', 'op-fade-in'),
      button('Fade out', 'Volume falls from what it was to 0 over the range', () => edit(() => M.fade(V(), ...rangeOf(), 'out')), '', 'op-fade-out')),
    opRow(el('b', null, 'Pitch'), button('Sweep', 'Glide the tone from the first value to the last over the range', () => edit(() => M.sweep(V(), ...rangeOf(), parseTone(swFrom.value), parseTone(swTo.value), swMode.value, 'tone')), '', 'op-sweep'),
      label('from'), swFrom, label('to'), swTo, swMode),
    opRow(el('b', null, 'Set'), button('Set', 'Set one field of every tick in the range', () => edit(() => M.setRange(V(), ...rangeOf(), setField.value, parseNum(setVal.value))), '', 'op-set'), setField, label('='), setVal));

  // thumbnail and information
  const foot = el('div', 'sfxed-foot');
  const wave = el('canvas', 'sfxed-wave');
  wave.dataset.role = 'wave';
  wave.width = 280; wave.height = 48;
  const infoEl = el('pre', 'sfxed-info');
  infoEl.dataset.role = 'info';
  foot.append(wave, infoEl);
  body.append(lanesBox, hint, rowEd, notes, ops, foot);

  // ── messages ──
  function say(text, kind = '') {
    msg.textContent = text;
    msg.className = 'sfxed-msg ' + kind;
    if (text) { try { host?.status?.(text); } catch { /* the host's status bar is optional */ } }
  }

  // ── geometry ──
  function toneToF(tone) { return clamp(Math.log(Math.max(tone, TONE_TOP) / TONE_TOP) / LN_SPAN, 0, 1); }
  const tickCount = () => (sfx ? M.effectLength(sfx) : 0);                    // the effect: its longest track
  const V = () => M.trackView(sfx, track);                                     // the editing functions' view of the selected track
  const tr = () => sfx[M.TRACKS[track].key] ?? [];                              // the selected track's ticks (may be shorter than the effect)
  const trackName = () => TRACK_NAMES[track];
  const secs = (i) => i / M.REFRESH_HZ;
  const fitColW = () => {
    const avail = (root.clientWidth ? root.clientWidth - LABEL_W - 26 : 0) || 600;      // the root's width, not the scroller's: that one follows the canvas
    return clamp(Math.floor(avail / Math.max(1, tickCount())), 3, 24);
  };
  const zoomed = () => (zoom > 0 ? zoom : fitColW());
  function setZoom(dir) {
    const here = zoomed();
    let idx = ZOOMS.findIndex((v) => v >= here);
    if (idx < 0) idx = ZOOMS.length - 1;
    if (dir < 0 && ZOOMS[idx] >= here) idx--; else if (dir > 0 && ZOOMS[idx] <= here) idx++;
    zoom = ZOOMS[clamp(idx, 0, ZOOMS.length - 1)];
    keepPrefs();
    renderAll();
  }
  function laneAt(y) {
    let best = 'vol', bd = Infinity;
    for (const k of LANE_ORDER) {
      const L = LANES[k];
      const d = y < L.y ? L.y - y : y > L.y + L.h ? y - (L.y + L.h) : 0;
      if (d < bd) { bd = d; best = k; }
    }
    return best;
  }
  function valueAt(lane, y) {
    const L = LANES[lane];
    const f = clamp((y - L.y) / L.h, 0, 1);
    if (lane === 'vol') return Math.round((1 - f) * 15);
    if (lane === 'noise') return Math.round((1 - f) * 31);
    return clamp(Math.round(TONE_TOP * Math.exp(f * LN_SPAN)), 1, 4095);          // tone: the top of the lane is the highest pitch
  }
  function pointerInfo(e) {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const i = clamp(Math.floor(x / colW), 0, Math.max(0, tickCount() - 1));
    return { x, y, i, lane: laneAt(y) };
  }

  // ── effect / song loading and saving ──
  const doc = () => (kind === 'music' ? song : sfx);          // what the history and the host store
  /** Take `d` (from the history or the host) as what is edited: the effect, or the song and its pattern `pat`. */
  function adopt(d) {
    stats = {};
    if (kind === 'music') {
      song = d;
      pat = song ? clamp(pat, 0, song.patterns.length - 1) : 0;
      opos = song ? clamp(opos, 0, song.order.length - 1) : 0;
      sfx = song ? song.patterns[pat] : null;
    } else sfx = d;
  }
  function setEffect(d) {
    adopt(d);
    hist = MM.createHistory(doc(), UNDO_STEPS + 1);      // music-model's: bounded by size too (a song's snapshot is large)
  }
  function clampSel() {
    const n = tickCount();
    if (!n) { cur = 0; rng = [0, 0]; anchor = 0; return; }
    cur = clamp(cur, 0, n - 1);
    rng = [clamp(rng[0], 0, n - 1), clamp(rng[1], 0, n - 1)];
    if (rng[0] > rng[1]) rng = [rng[1], rng[0]];
    anchor = clamp(anchor, 0, n - 1);
  }
  const what = () => (kind === 'music' ? 'song' : 'sound effect');
  function clearAsset() { stopPlay(); name = null; sfx = null; song = null; hist = null; lastStored = ''; }
  /** Load the effect (or song, in song mode) `n`; keepSel keeps the cursor, the range, the track and the pattern (a reload after an outside change). */
  function loadEffect(n, keepSel = false) {
    const asset = H.get(n);
    if (asset === null || asset === undefined) { say(`The ${what()} "${n}" is not in the project`, 'err'); return false; }
    let d;
    try { d = kind === 'music' ? MM.fromSong(asset) : M.fromAsset(asset); } catch (e) { name = n; sfx = null; song = null; hist = null; lastStored = ''; say(`Cannot read the ${what()} "${n}": ${e.message}`, 'err'); renderAll(); return false; }
    stopPlay();
    name = n;
    lastNames[kind] = n;
    lastStored = JSON.stringify(asset);
    if (!keepSel) { cur = 0; rng = [0, 0]; anchor = 0; prefillKey = ''; noteCur = -1; noteNext = null; track = 0; pat = 0; opos = 0; if (kind === 'music') pat = d.order[0] ?? 0; }
    setEffect(d);
    clampSel();
    renderAll();
    return true;
  }
  /** Write the effect (or the whole song) to the host; false (with the host's reason in the status line) when it refuses. */
  function save() {
    if (!name || !doc()) return true;
    const asset = kind === 'music' ? MM.toSong(song) : M.toAsset(sfx);
    const r = H.set(name, deepCopy(asset));
    if (r && r.ok === false) { say(`The Studio did not accept the ${what()}: ${r.error ?? 'unknown reason'}`, 'err'); return false; }
    lastStored = JSON.stringify(asset);
    return true;
  }
  /**
   * Apply an edit (fn mutates `sfx` or `song` and returns {message?, range?, pattern?, pos?}), record it for undo, store it in the project and redraw.
   * A refusal by the model (a message and no change) goes to the status line in red; a clamp (a message and a change) in amber.
   * In song mode `pattern` / `pos` pick the pattern shown and the order position selected afterwards.
   */
  function edit(fn) {
    if (!sfx || stroke) return false;
    let res;
    const patBefore = pat;
    try { res = fn() ?? {}; } catch (e) { say(e.message, 'err'); adopt(hist.current); clampSel(); renderAll(); return false; }
    if (kind === 'music') {
      if (Number.isInteger(res.pos)) opos = res.pos;
      if (Number.isInteger(res.pattern)) pat = res.pattern;
      adopt(song);
      if (pat !== patBefore && !res.range) { cur = 0; rng = [0, 0]; anchor = 0; prefillKey = ''; noteCur = -1; }
    }
    if (res.range) { rng = [res.range[0], res.range[1]]; anchor = rng[0]; cur = rng[0]; }
    clampSel();
    const changed = hist.commit(doc());
    if (changed && !save()) { adopt(hist.undo() ?? hist.current); clampSel(); renderAll(); return false; }
    renderAll();
    if (res.message) say(res.message, changed ? 'warn' : 'err');
    else say('');
    return changed;
  }
  function undo() {
    if (!hist?.canUndo || stroke) return;
    adopt(hist.undo());
    clampSel();
    save();
    renderAll();
  }
  function redo() {
    if (!hist?.canRedo || stroke) return;
    adopt(hist.redo());
    clampSel();
    if (!save()) adopt(hist.undo());
    clampSel();
    renderAll();
  }

  // ── modes and patterns ──
  /** Switch between effects ('sfx') and songs ('music'); shows the asset last shown in that mode, else the first. */
  function setMode(k, show = null) {
    if (k !== 'sfx' && k !== 'music') return;
    if (k === kind && !show) return;
    if (stroke) stroke = null;
    if (k !== kind) { clearAsset(); kind = k; track = 0; }
    const names = H.list();
    const want = show ?? (names.includes(lastNames[k]) ? lastNames[k] : names[0]);
    if (want && names.includes(want)) loadEffect(want);
    else renderAll();
  }
  /** Song mode: show pattern i (the order position stays unless `pos` is given). */
  function showPattern(i, pos = null) {
    if (kind !== 'music' || !song || stroke) return;
    if (Number.isInteger(pos)) opos = clamp(pos, 0, song.order.length - 1);
    if (i !== pat) { pat = clamp(i, 0, song.patterns.length - 1); sfx = song.patterns[pat]; cur = 0; rng = [0, 0]; anchor = 0; prefillKey = ''; noteCur = -1; noteNext = null; }
    renderAll();
  }
  function labelCmd() {
    if (kind !== 'music' || !song) return;
    const v = window.prompt?.(`Label of pattern ${pat} (empty: none)`, song.patterns[pat].name ?? '');
    if (v === null || v === undefined) return;
    edit(() => MM.labelPattern(song, pat, v));
  }
  /** Note entry: the note (or a rest) of the note row into the selected track from tick noteAt; the next entry goes after it. */
  function noteCmd(rest) {
    if (!sfx) return;
    const len = parseNum(noteLen.value);
    if (!Number.isFinite(len) || len < 1) { say('The length is a number of refreshes, 1 or more', 'err'); return; }
    const oct = parseNum(noteOct.value);
    if (!rest && !(Number.isInteger(oct) && oct >= 0 && oct <= 8)) { say('The octave is a whole number 0..8', 'err'); return; }
    if (!rest) { const low = MM.noteRefusal(`${noteSel.value}${oct}`, noteInst.value); if (low) { say(low, 'err'); return; } }
    const pk = parseNum(noteVol.value);
    const opts = Number.isFinite(pk) ? { peak: clamp(Math.round(pk), 1, 15) } : {};
    const at = noteAt;
    edit(() => {
      const r = rest ? MM.enterRest(V(), at, len) : MM.enterNote(V(), at, `${noteSel.value}${oct}`, len, noteInst.value, opts);
      noteNext = r.next;
      return r;
    });
  }

  // ── commands: new, duplicate, rename, delete ──
  function uniqueName(base) {
    const have = new Set(H.list().map((n) => n.toUpperCase()));
    let n = base, i = 1;
    while (have.has(n.toUpperCase())) n = base.replace(/\d+$/, '') + (++i);
    return n;
  }
  function askName(question, dflt) {
    const v = (window.prompt?.(question, dflt) ?? '').trim();
    if (!v) return null;
    if (!NAME_RE.test(v)) { say('A sound name is a letter followed by up to 30 letters, digits or _', 'err'); return null; }
    if (v.toUpperCase() !== (name ?? '').toUpperCase() && H.list().some((n) => n.toUpperCase() === v.toUpperCase())) { say(`There is already a ${what()} called "${v}"`, 'err'); return null; }
    return v;
  }
  function newCmd() {
    if (kind === 'music') {
      const n = askName('Name of the new song', uniqueName('song1'));
      if (!n) return;
      const r = H.set(n, MM.toSong(MM.newSong()));
      if (r.ok === false) { say(r.error ?? 'The Studio did not accept the song', 'err'); return; }
      loadEffect(n);
      say(`New song "${n}": one pattern, played in a loop. Press Song to hear it, then enter notes or draw on the lanes`);
      return;
    }
    const preset = presetSel.value;
    const n = askName('Name of the new sound effect', uniqueName(preset === 'blank' ? 'sound1' : preset));
    if (!n) return;
    const value = preset === 'blank' ? { ticks: [{ ...BLANK_TICK }] } : M.newSfx(preset);
    const r = H.set(n, M.toAsset(value));
    if (r.ok === false) { say(r.error ?? 'The Studio did not accept the sound effect', 'err'); return; }
    loadEffect(n);
    say(`New sound effect "${n}" (${preset}): press Play, then draw on the lanes`);
  }
  function duplicateCmd() {
    if (!sfx) return;
    const n = askName('Name of the copy', uniqueName(name + '2'));
    if (!n) return;
    const r = H.set(n, kind === 'music' ? MM.toSong(song) : M.toAsset(sfx));
    if (r.ok === false) { say(r.error ?? `The Studio did not accept the ${what()}`, 'err'); return; }
    loadEffect(n);
    say(`Copied to "${n}"`);
  }
  function renameCmd() {
    if (!sfx) return;
    const n = askName(`Rename "${name}" to`, name);
    if (!n || n === name) return;
    const r = H.rename(name, n);
    if (r.ok === false) { say(r.error ?? 'Could not rename', 'err'); return; }
    name = n;
    lastNames[kind] = n;
    lastStored = JSON.stringify(kind === 'music' ? MM.toSong(song) : M.toAsset(sfx));
    renderAll();
    say(`Renamed to "${n}". Source lines that name the old ${kind === 'music' ? 'song' : 'effect'} are not changed`);
  }
  function deleteCmd() {
    if (!sfx && !name) return;
    const users = H.usedBy(name);
    const extra = users.length ? ` The source still uses it (${users.slice(0, 3).join(', ')}).` : '';
    if (window.confirm && !window.confirm(`Delete the ${what()} "${name}"?${extra}`)) return;
    const old = name;
    if (!H.del(old)) { say('Could not delete', 'err'); return; }
    const rest = H.list();
    name = null; sfx = null; song = null; hist = null;
    if (rest.length) loadEffect(rest[0]); else renderAll();
    say(`Deleted "${old}"`);
  }

  // ── tracks ──
  function setTrack(ch) {
    if (!sfx || ch === track || stroke) return;
    track = ch;
    prefillKey = '';
    renderAll();
    say(tr().length ? `Editing channel ${trackName()}` : `Channel ${trackName()} is empty: draw on a lane, or press Insert, to add ticks`);
  }

  // ── selection ──
  function selectTick(i) {
    if (!sfx) return;
    cur = clamp(i, 0, tickCount() - 1);
    rng = [cur, cur]; anchor = cur;
    ensureVisible(cur);
    renderAll();
  }
  function extendTo(i) {
    cur = clamp(i, 0, tickCount() - 1);
    rng = [Math.min(anchor, cur), Math.max(anchor, cur)];
    ensureVisible(cur);
    renderAll();
  }
  function ensureVisible(i) {
    const x0 = i * colW, x1 = x0 + colW;
    if (x0 < scroller.scrollLeft) scroller.scrollLeft = x0;
    else if (x1 > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = x1 - scroller.clientWidth;
  }

  // ── painting ──
  const tracksJson = () => JSON.stringify(M.TRACKS.map(({ key }) => sfx[key] ?? []));
  /** Apply a value to ticks between the last painted tick and tick i (a drag fast enough to skip ticks leaves no gaps). */
  function paintTo(i, v) {
    const s = stroke, prev = s.last;
    if (M.padTrack(sfx, track, Math.max(i, prev ? prev.i : i) + 1)) s.padded = true;          // painting past the track's end extends it with silent ticks
    const from = prev ? prev.i : i, step = i >= from ? 1 : -1;
    const view = V();
    const v0 = prev ? prev.v : v;
    for (let k = prev && i !== from ? from + step : from; ; k += step) {
      const frac = i === from ? 1 : (k - from) / (i - from);
      let r;
      if (s.lane === 'tmix' || s.lane === 'nmix') {
        const t = view.ticks[k];
        r = M.setTick(view, k, 'mix', s.lane === 'tmix' ? M.mixOf(s.target, M.noiseOn(t.mix)) : M.mixOf(M.toneOn(t.mix), s.target));
      } else if (s.lane === 'tone') {                              // the tone axis is logarithmic, so a drag glides in pitch
        r = M.setTick(view, k, 'tone', Math.exp(Math.log(Math.max(1, v0)) + (Math.log(Math.max(1, v)) - Math.log(Math.max(1, v0))) * frac));
      } else r = M.setTick(view, k, LANE_FIELD[s.lane], v0 + (v - v0) * frac);
      if (r.message) s.msg = r.message;
      if (k === i) break;
    }
    s.last = { i, v };
    cur = i;
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (!sfx || e.button !== 0) return;
    root.focus({ preventScroll: true });
    e.preventDefault();
    const p = pointerInfo(e);
    if (p.lane === 'ruler' || e.shiftKey) {
      anchor = p.i; cur = p.i; rng = [p.i, p.i];
      stroke = { mode: 'select', lane: p.lane };
      canvas.setPointerCapture?.(e.pointerId);
      drawLanes(); syncRow(); syncRange();
      return;
    }
    const before = tracksJson();
    stroke = { mode: 'paint', lane: p.lane, last: null, target: false, msg: null, before };
    if (p.lane === 'tmix') stroke.target = !M.toneOn((tr()[p.i] ?? BLANK_TICK).mix);
    else if (p.lane === 'nmix') stroke.target = !M.noiseOn((tr()[p.i] ?? BLANK_TICK).mix);
    canvas.setPointerCapture?.(e.pointerId);
    rng = [p.i, p.i]; anchor = p.i;
    paintTo(p.i, valueAt(p.lane, p.y));
    drawLanes(); syncRow(); syncRange();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!sfx) return;
    const p = pointerInfo(e);
    hoverTick = p.i;
    if (stroke?.mode === 'select') { cur = p.i; rng = [Math.min(anchor, p.i), Math.max(anchor, p.i)]; syncRow(); syncRange(); }
    else if (stroke?.mode === 'paint') {
      const v = LANE_FIELD[stroke.lane] ? valueAt(stroke.lane, p.y) : 0;
      if (!stroke.last || stroke.last.i !== p.i || stroke.last.v !== v) paintTo(p.i, v);
      rng = [p.i, p.i]; anchor = p.i;
      syncRow(); syncRange();
    }
    showHint(p);
    drawLanes();
  });
  canvas.addEventListener('pointerleave', () => { hoverTick = -1; if (!stroke) { hint.textContent = ''; if (sfx) drawLanes(); } });
  const endStroke = () => {
    const s = stroke;
    if (!s) return;
    stroke = null;
    if (s.mode === 'select') { renderAll(); return; }
    let changed = false;
    if (tracksJson() !== s.before) {
      changed = hist.commit(doc());
      if (changed && !save()) { adopt(hist.undo() ?? hist.current); clampSel(); }
    }
    renderAll();
    if (s.msg && changed) say(s.msg, 'warn');
  };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);

  function showHint(p) {
    const t = tr()[p.i];
    if (!t) { hint.textContent = `tick ${p.i} (${secs(p.i).toFixed(3)} s)   channel ${trackName()} has no tick here: painting adds it`; return; }
    let s = `tick ${p.i} (${secs(p.i).toFixed(3)} s)   tone ${t.tone}   vol ${t.vol}   noise ${t.noise}   mix ${t.mix} (${mixName(t.mix)})`;
    if (p.lane === 'tone') {
      const n = M.noteOfTone(valueAt('tone', p.y));
      s += `\npointer: ${n.name} ${centsText(n.cents)}  (${n.freq.toFixed(1)} Hz, tone ${valueAt('tone', p.y)})`;
    }
    hint.textContent = s;
  }
  const mixName = (mix) => { const f = M.MIX_FORMS.find((x) => x.tone === M.toneOn(mix) && x.noise === M.noiseOn(mix)); return f ? f.label : '?'; };

  // ── drawing ──
  function drawLanes() {
    if (!sfx) return;
    const n = tickCount();
    colW = zoomed();
    const W = Math.max(1, n * colW);
    if (canvas.width !== W || canvas.height !== LANES_H) { canvas.width = W; canvas.height = LANES_H; }
    canvas.style.width = W + 'px'; canvas.style.height = LANES_H + 'px';
    zoomLabel.textContent = `${colW} px/tick`;
    const ctx = canvas.getContext('2d');
    const cs = getComputedStyle(root);
    const col = (v, fb) => cs.getPropertyValue(v).trim() || fb;
    const C = {
      bg: col('--bg', '#0d1117'), panel: col('--bg-surface', '#1c2128'), border: col('--border', '#2d333b'), borderHi: col('--border-hi', '#444c56'),
      fg: col('--fg', '#cdd9e5'), muted: col('--fg-muted', '#768390'), amber: col('--amber-fg', '#e3b341'), ok: col('--ok-fg', '#8ddb8c'),
      blue: col('--blue-fg', '#79c0ff'), red: col('--red-fg', '#f78166'), dim: col('--fg-dim', '#3d444c'),
    };
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, LANES_H);
    for (const k of ['vol', 'tone', 'noise', 'tmix', 'nmix']) { const L = LANES[k]; ctx.fillStyle = C.panel; ctx.globalAlpha = .55; ctx.fillRect(0, L.y, W, L.h); ctx.globalAlpha = 1; }
    // ruler and vertical grid
    const steps = [1, 2, 5, 10, 20, 50, 100, 200];
    const stepT = steps.find((s) => s * colW >= 30) ?? 200;
    ctx.font = '10px sans-serif'; ctx.textBaseline = 'middle';
    for (let i = 0; i < n; i += stepT) {
      const x = i * colW;
      ctx.fillStyle = C.border; ctx.globalAlpha = .8; ctx.fillRect(x, LANES.vol.y, 1, LANES_H - LANES.vol.y); ctx.globalAlpha = 1;
      ctx.fillStyle = C.muted; ctx.fillText(String(i), x + 3, LANES.ruler.y + 9);
      ctx.fillRect(x, LANES.ruler.h - 5, 1, 5);
    }
    // tone guide lines (A1 .. A7)
    ctx.fillStyle = C.border;
    for (const midi of [33, 45, 57, 69, 81, 93, 105]) ctx.fillRect(0, Math.round(LANES.tone.y + toneToF(M.toneOfNote(midi)) * LANES.tone.h), W, 1);
    // selection
    ctx.fillStyle = C.amber; ctx.globalAlpha = .16;
    ctx.fillRect(rng[0] * colW, 0, (rng[1] - rng[0] + 1) * colW, LANES_H);
    ctx.globalAlpha = 1;
    // the other tracks' tone curves, dim (the selected track draws its own below, bright)
    const isBad = (t) => t.vol === 15 && t.tone >= M.UNSTORABLE_TONE_FROM && t.tone <= 4095;
    for (let ch = 0; ch < 3; ch++) {
      if (ch === track) continue;
      const list = sfx[M.TRACKS[ch].key] ?? [];
      ctx.strokeStyle = ctx.fillStyle = C[TRACK_COLOUR[ch]]; ctx.lineWidth = 1.5; ctx.globalAlpha = .4;
      let pv = null;
      for (let i = 0; i < list.length; i++) {
        const t = list[i], cx = i * colW + colW / 2, cy = LANES.tone.y + toneToF(t.tone) * LANES.tone.h;
        if (M.toneOn(t.mix)) {
          if (pv) { ctx.beginPath(); ctx.moveTo(pv.x, pv.y); ctx.lineTo(cx, cy); ctx.stroke(); }
          ctx.fillRect(Math.round(cx - 1.5), Math.round(cy - 1.5), 3, 3);
          pv = { x: cx, y: cy };
        } else pv = null;
        if (isBad(t)) { ctx.globalAlpha = 1; ctx.fillStyle = C.red; ctx.fillRect(i * colW, 0, colW, 3); ctx.fillStyle = C[TRACK_COLOUR[ch]]; ctx.globalAlpha = .4; }
      }
      ctx.globalAlpha = 1;
    }
    // lanes of the selected track
    const bw = Math.max(1, colW - (colW > 3 ? 1 : 0));
    const mine = tr();
    let prev = null;
    for (let i = 0; i < mine.length; i++) {
      const t = mine[i], x = i * colW;
      const bad = isBad(t) || hostMarks.has(i);
      if (bad) { ctx.fillStyle = C.red; ctx.globalAlpha = .22; ctx.fillRect(x, LANES.vol.y, colW, LANES_H - LANES.vol.y); ctx.globalAlpha = 1; ctx.fillStyle = C.red; ctx.fillRect(x, 0, colW, 3); }
      const tOn = M.toneOn(t.mix), nOn = M.noiseOn(t.mix);
      // volume bar
      const vh = Math.round(clamp(t.vol, 0, 15) / 15 * LANES.vol.h);
      ctx.fillStyle = bad ? C.red : C.amber;
      ctx.globalAlpha = tOn || nOn ? 1 : .35;
      ctx.fillRect(x, LANES.vol.y + LANES.vol.h - vh, bw, vh);
      ctx.globalAlpha = 1;
      // noise bar
      const nh = Math.round(clamp(t.noise, 0, 31) / 31 * LANES.noise.h);
      ctx.fillStyle = C.blue; ctx.globalAlpha = nOn ? 1 : .3;
      ctx.fillRect(x, LANES.noise.y + LANES.noise.h - nh, bw, nh);
      ctx.globalAlpha = 1;
      // mix rows
      ctx.fillStyle = C.ok; ctx.globalAlpha = tOn ? 1 : .18; ctx.fillRect(x, LANES.tmix.y + 1, bw, LANES.tmix.h - 2); ctx.globalAlpha = 1;
      ctx.fillStyle = C.blue; ctx.globalAlpha = nOn ? 1 : .18; ctx.fillRect(x, LANES.nmix.y + 1, bw, LANES.nmix.h - 2); ctx.globalAlpha = 1;
      // tone curve
      const cx = x + colW / 2, cy = LANES.tone.y + toneToF(t.tone) * LANES.tone.h;
      const tc = C[TRACK_COLOUR[track]];
      if (tOn) {
        ctx.strokeStyle = tc; ctx.fillStyle = tc; ctx.lineWidth = 1.5;
        if (prev) { ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(cx, cy); ctx.stroke(); }
        ctx.fillRect(Math.round(cx - 1.5), Math.round(cy - 1.5), 3, 3);
        prev = { x: cx, y: cy };
      } else {
        prev = null;
        ctx.strokeStyle = C.muted; ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(cx - 1.5) + .5, Math.round(cy - 1.5) + .5, 3, 3);
      }
    }
    // where the selected track has no ticks: shaded, and a note when it is empty
    if (mine.length < n) {
      ctx.fillStyle = C.bg; ctx.globalAlpha = .55;
      ctx.fillRect(mine.length * colW, LANES.vol.y, W - mine.length * colW, LANES_H - LANES.vol.y);
      ctx.globalAlpha = 1;
      if (mine.length === 0) {
        ctx.fillStyle = C.muted; ctx.font = '12px sans-serif'; ctx.textBaseline = 'middle';
        ctx.fillText(`channel ${trackName()} is empty (not stored): draw here to add ticks`, 8, LANES.vol.y + LANES.vol.h / 2);
      }
    }
    // the tick under the cursor and under the pointer
    ctx.lineWidth = 1;
    ctx.strokeStyle = C.fg;
    ctx.strokeRect(cur * colW + .5, LANES.vol.y - 3.5, Math.max(1, colW - 1), LANES_H - LANES.vol.y + 3);
    if (hoverTick >= 0 && hoverTick !== cur) { ctx.strokeStyle = C.muted; ctx.strokeRect(hoverTick * colW + .5, LANES.vol.y - 3.5, Math.max(1, colW - 1), LANES_H - LANES.vol.y + 3); }
    for (const k of LANE_ORDER.slice(1)) { ctx.fillStyle = C.borderHi; ctx.fillRect(0, LANES[k].y - 2, W, 1); }
    if (playX >= 0) { ctx.fillStyle = C.fg; ctx.fillRect(Math.round(playX), 0, 2, LANES_H); }
  }

  function drawWave() {
    const ctx = wave.getContext('2d');
    const cs = getComputedStyle(root);
    const col = (v, fb) => cs.getPropertyValue(v).trim() || fb;
    ctx.fillStyle = col('--bg', '#0d1117'); ctx.fillRect(0, 0, wave.width, wave.height);
    ctx.fillStyle = col('--border', '#2d333b'); ctx.fillRect(0, wave.height / 2, wave.width, 1);
    if (!sfx || !tickCount()) return;
    const data = M.renderSfx(sfx, { rate: 8000 });
    const per = data.length / wave.width;
    ctx.fillStyle = col('--amber-fg', '#e3b341');
    for (let x = 0; x < wave.width; x++) {
      let lo = 0, hi = 0;
      const a = Math.floor(x * per), b = Math.max(a + 1, Math.floor((x + 1) * per));
      for (let k = a; k < b && k < data.length; k++) { if (data[k] < lo) lo = data[k]; if (data[k] > hi) hi = data[k]; }
      const y0 = wave.height / 2 - hi * 2 * (wave.height / 2 - 2), y1 = wave.height / 2 - lo * 2 * (wave.height / 2 - 2);
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }

  // ── controls ──
  function syncRow() {
    if (!sfx) return;
    if (noteNext !== null) { noteAt = clamp(noteNext, 0, MM.MAX_PATTERN_TICKS - 1); noteNext = null; noteCur = cur; }      // after a note: the tick after it
    else if (cur !== noteCur) { noteAt = cur; noteCur = cur; }                                                            // the cursor moved: from there
    noteAtIn.value = String(noteAt);
    const t = tr()[cur];
    tickIn.value = String(cur);
    tickIn.max = String(Math.max(0, tickCount() - 1));
    if (!t) {                                                   // past the end of this track: nothing to show (an edit grows the track to here)
      for (const f of M.FIELD_NAMES) fIn[f].value = '';
      noteOut.textContent = `no tick in channel ${trackName()}`;
      mixOut.textContent = '';
      return;
    }
    for (const f of M.FIELD_NAMES) fIn[f].value = String(t[f]);
    const nt = M.noteOfTone(t.tone);
    noteOut.textContent = M.toneOn(t.mix) ? `${nt.name} ${centsText(nt.cents)}` : 'tone off';
    mixOut.textContent = `= ${mixName(t.mix)}`;
  }
  function syncRange() {
    if (!sfx) return;
    const n = rng[1] - rng[0] + 1;
    rangeLabel.textContent = n === 1 ? `tick ${rng[0]}` : `ticks ${rng[0]}..${rng[1]} (${n})`;
    const key = `${name}:${track}:${rng[0]}-${rng[1]}`;
    if (key !== prefillKey) {                                   // the sweep starts and ends where the range does
      prefillKey = key;
      swFrom.value = String(tr()[rng[0]]?.tone ?? 0);
      swTo.value = String(tr()[rng[1]]?.tone ?? 0);
    }
  }
  function syncControls() {
    const has = !!sfx;
    btnUndo.disabled = !hist?.canUndo;
    btnRedo.disabled = !hist?.canRedo;
    btnDup.disabled = btnRen.disabled = btnDel.disabled = !has && !name;
    btnPlay.disabled = btnPlayR.disabled = !has;
    btnStop.disabled = !playing;
    const lens = sfx ? M.trackLengths(sfx) : [0, 0, 0];
    trackBtns.forEach((b, ch) => {
      b.classList.toggle('on', has && ch === track);
      b.classList.toggle('empty', ch > 0 && lens[ch] === 0);
      b.setAttribute('aria-pressed', String(has && ch === track));
      b.textContent = ch > 0 && lens[ch] === 0 ? `${TRACK_NAMES[ch]} (empty)` : TRACK_NAMES[ch];
      b.disabled = !has;
    });
    btnClearTrack.disabled = !has || track === 0 || lens[track] === 0;
    trackNote.textContent = has ? `ticks: A ${lens[0]}, B ${lens[1]}, C ${lens[2]}; the effect lasts ${Math.max(...lens)}` : '';
    const music = kind === 'music';
    btnPlay.textContent = playing && playWhat !== 'song' ? '▶ Again' : music ? '▶ Pattern' : '▶ Play';
    btnPlay.title = music ? 'Play the pattern shown (Space)' : 'Play the effect (Space)';
    btnPlaySong.hidden = !music;
    btnPlaySong.disabled = !has;
    btnPlaySong.textContent = playing && playWhat === 'song' ? '▶ Again' : '▶ Song';
    if (has) trackNote.textContent = `ticks: A ${lens[0]}, B ${lens[1]}, C ${lens[2]}; the ${music ? `pattern` : 'effect'} lasts ${Math.max(...lens)}`;
    for (const [b, k] of [[btnModeSfx, 'sfx'], [btnModeMusic, 'music']]) { b.classList.toggle('on', kind === k); b.setAttribute('aria-pressed', String(kind === k)); }
    presetLabel.hidden = presetSel.hidden = music;
    nameSel.setAttribute('aria-label', music ? 'Song' : 'Sound effect');
    btnNew.title = music ? 'Create a song (one pattern, played in a loop)' : 'Create an effect from the preset';
    btnDup.title = `Copy this ${music ? 'song' : 'effect'} under a new name`;
    btnRen.title = `Rename this ${music ? 'song' : 'effect'}`;
    btnDel.title = `Delete this ${music ? 'song' : 'effect'}`;
    const names = H.list();
    nameSel.replaceChildren();
    for (const n of names) { const o = el('option', null, n); o.value = n; nameSel.append(o); }
    if (name && names.includes(name)) nameSel.value = name;
    syncSong();
  }
  const songInfo = () => (stats.info ??= MM.songInfo(song));
  const songValidation = () => (stats.val ??= MM.validateSong(song));
  /** The song panel: pattern chips, order chips (the loop marked), the loop select, the song's size and length. */
  function syncSong() {
    songBox.hidden = !(kind === 'music' && song);
    if (songBox.hidden) return;
    const info = songInfo();
    const played = new Set(song.order);
    patChips.replaceChildren();
    song.patterns.forEach((p, i) => {
      const c = el('button', 'sfxed-chip' + (i === pat ? ' on' : '') + (played.has(i) ? '' : ' unused'), MM.patternTitle(song, i), { type: 'button' });
      c.dataset.role = `pat-${i}`;
      c.title = `pattern ${i}: ${info.lengths[i]} refreshes (${(info.lengths[i] / M.REFRESH_HZ).toFixed(2)} s), ${info.patternBytes[i]} bytes${played.has(i) ? '' : '; not in the order list'}`;
      c.addEventListener('click', () => showPattern(i));
      patChips.append(c);
    });
    ordChips.replaceChildren();
    song.order.forEach((p, pos) => {
      const playingHere = playWhat === 'song' && playing && playPos === pos;
      const c = el('button', 'sfxed-chip' + (pos === opos ? ' on' : '') + (p === pat ? ' cur' : '') + (song.loop === pos ? ' loop' : '') + (playingHere ? ' playing' : ''), MM.patternTitle(song, p), { type: 'button' });
      c.dataset.role = `ord-${pos}`;
      c.title = `order position ${pos}: pattern ${p}${song.loop === pos ? ' (the loop starts here)' : ''}`;
      c.addEventListener('click', () => showPattern(p, pos));
      ordChips.append(c);
    });
    loopSel.replaceChildren();
    const none = el('option', null, 'none (stop)'); none.value = 'none'; loopSel.append(none);
    song.order.forEach((p, pos) => { const o = el('option', null, `position ${pos} (pattern ${p})`); o.value = String(pos); loopSel.append(o); });
    loopSel.value = song.loop === null || song.loop === undefined ? 'none' : String(song.loop);
    const loopText = song.loop === null || song.loop === undefined ? 'then stops' : `then loops from position ${song.loop} (${info.loopSeconds.toFixed(2)} s a loop)`;
    songInfoEl.textContent = `${info.patterns} pattern${info.patterns === 1 ? '' : 's'}, order ${info.orderLength}: ${info.refreshes} refreshes, ${info.seconds.toFixed(2)} s, ${loopText}; ` +
      (info.bytes === null ? 'size: not known (the song cannot be converted)' : `${info.bytes} bytes on the cartridge`);
  }
  function renderInfo() {
    if (!sfx) { infoEl.textContent = ''; return; }
    infoEl.replaceChildren();
    if (kind === 'music') {
      const si = songInfo(), n = MM.patternLength(sfx);
      infoEl.append(document.createTextNode(`pattern ${pat}: ${n} tick${n === 1 ? '' : 's'}, ${(n / M.REFRESH_HZ).toFixed(2)} s, ${si.patternBytes[pat]} bytes\n` +
        `song: ${si.seconds.toFixed(2)} s a pass${si.loop === null ? '' : `, the loop ${si.loopSeconds.toFixed(2)} s`}\n${si.bytes === null ? '?' : si.bytes} bytes on the cartridge (patterns with waits, order list, loop)\n`));
      const c = H.count();
      if (c !== null) {
        const line = el('span', c > MM.MAX_SONGS ? 'over' : '', `songs in this program: ${c} of ${MM.MAX_SONGS}`);
        line.dataset.role = 'count';
        infoEl.append(line);
      }
      return;
    }
    const i = M.sfxInfo(sfx);
    const sizeRule = i.channels === 3 ? '(delta stream: three channels)' : '((ticks + 1) × 4)';
    infoEl.append(document.createTextNode(`${i.ticks} tick${i.ticks === 1 ? '' : 's'}, ${i.seconds.toFixed(2)} s\n${i.bytes} bytes on the cartridge ${sizeRule}\n`));
    const c = H.count();
    if (c !== null) {
      const line = el('span', c > M.MAX_SFX ? 'over' : '', `effects in this project: ${c} of ${M.MAX_SFX}`);
      line.dataset.role = 'count';
      infoEl.append(line);
    }
  }
  function renderWarnings() {
    warnList.replaceChildren();
    hostMarks = new Set();
    if (!sfx) return;
    if (kind === 'music') { renderSongWarnings(); return; }
    const items = [];
    const hw = H.warnings(name);
    const v = M.validateSfx(sfx);
    const multi = M.isMulti(sfx);
    const chIndex = (c) => Math.max(0, TRACK_NAMES.indexOf(c));
    if (hw) {
      for (const w of hw) {
        if (w.kind && w.kind !== 'sfx') continue;
        const ch = chIndex(w.channel ?? 'A');                      // a finding without a channel is channel A's
        items.push({ sev: w.severity === 'error' ? 'err' : 'warn', text: w.message, ticks: Array.isArray(w.ticks) ? w.ticks : [], id: w.id, ch });
        if (Array.isArray(w.ticks) && ch === track) for (const t of w.ticks) hostMarks.add(t);
      }
    }
    for (const [k, nm] of TRACK_NAMES.entries()) {
      const bad = v.byChannel[nm];
      if (!bad.length || items.some((x) => x.id === 'sfx-unstorable' && x.ch === k)) continue;
      const first = `${multi ? `channel ${nm} ` : ''}tick ${bad[0]}:`;
      items.push({ sev: 'err', text: v.errors.find((e) => /\$FF/.test(e) && e.startsWith(first)) ?? 'a tick cannot be stored', ticks: bad, id: 'sfx-unstorable', ch: k });
    }
    if (!hw) for (const e of v.errors) if (!/\$FF/.test(e)) items.push({ sev: 'err', text: e, ticks: [], id: 'local', ch: 0 });
    for (const w of v.warnings) items.push({ sev: 'warn', text: w, ticks: [], id: 'local', ch: 0 });
    for (const it of items) {
      const li = el('li', it.sev, it.text);
      li.dataset.id = it.id ?? '';
      if (it.ticks.length) {
        li.title = 'Click to go to the first marked tick';
        li.addEventListener('click', () => { if (it.ch !== undefined && it.ch !== track) setTrack(it.ch); selectTick(it.ticks[0]); });
      }
      warnList.append(li);
    }
    for (const t of v.byChannel[trackName()]) hostMarks.add(t);
  }
  /** Song mode: the song's own validation (music-model validateSong: the compiler's rules); a click on an unstorable tick goes to its pattern and channel. */
  function renderSongWarnings() {
    const v = songValidation();
    const items = [];
    for (const u of v.unstorable) {
      const first = `pattern ${u.pattern}: ${u.channel === 'A' && !M.isMulti(song.patterns[u.pattern]) ? '' : `channel ${u.channel} `}tick ${u.ticks[0]}:`;
      items.push({ sev: 'err', text: v.errors.find((e) => e.startsWith(first)) ?? `pattern ${u.pattern} channel ${u.channel}: a tick cannot be stored`, go: u });
      if (u.pattern === pat && u.channel === trackName()) for (const t of u.ticks) hostMarks.add(t);
    }
    for (const e of v.errors) if (!/\$FF/.test(e)) items.push({ sev: 'err', text: e });
    for (const w of v.warnings) items.push({ sev: 'warn', text: w });
    for (const it of items) {
      const li = el('li', it.sev, it.text);
      li.dataset.id = it.go ? 'music-unstorable' : 'local';
      if (it.go) {
        li.title = 'Click to go to the first marked tick';
        li.addEventListener('click', () => { showPattern(it.go.pattern); const ch = TRACK_NAMES.indexOf(it.go.channel); if (ch >= 0 && ch !== track) setTrack(ch); selectTick(it.go.ticks[0]); });
      }
      warnList.append(li);
    }
  }
  function renderAll() {
    if (destroyed) return;
    stats = {};                                         // the song may have changed: size and checks are worked out again, once, for this render
    const has = !!sfx;
    const names = H.list();
    emptyNote.textContent = kind === 'music' ? 'No songs in this project yet. Press New to make one.' : 'No sound effects in this project yet. Pick a preset and press New.';
    emptyNote.hidden = has || names.length > 0 || !!name;
    body.hidden = !has;
    warnList.hidden = !has;
    if (has) { clampSel(); renderWarnings(); syncRow(); syncRange(); }
    else warnList.replaceChildren();
    syncControls();
    if (has) { layoutLanes(); drawLanes(); drawWave(); renderInfo(); }
    else infoEl.textContent = '';
  }
  function layoutLanes() {
    colW = zoomed();
    zoomLabel.textContent = `${colW} px/tick`;
  }

  // ── playback (Web Audio; the AudioContext is made on the first Play, which is a user gesture) ──
  /** Play mono samples; `onFrame(f)` (0..1 of the way through) is called on every animation frame while they play. */
  function startAudio(data, rate, onFrame) {
    if (!data.length) { say('Nothing to play'); return false; }
    try { actx.resume?.(); } catch { /* the context may already run */ }
    const buf = actx.createBuffer(1, data.length, rate);
    if (typeof buf.copyToChannel === 'function') buf.copyToChannel(data, 0); else buf.getChannelData(0).set(data);
    const node = actx.createBufferSource();
    node.buffer = buf;
    node.connect(actx.destination);
    src = node;
    node.onended = () => { if (src === node) endPlay(); };
    node.start();
    playing = true;
    playStart = performance.now();
    playDur = data.length / rate * 1000;
    const tick = () => {
      if (!playing || destroyed) return;
      const f = (performance.now() - playStart) / playDur;
      onFrame(Math.min(1, f));
      if (f >= 1) return;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    syncControls();
    return true;
  }
  function audioContext() {
    const AC = window.AudioContext ?? window.webkitAudioContext;
    if (!AC) { say('This browser has no Web Audio: the preview cannot play', 'err'); return false; }
    try { if (!actx) actx = new AC(); } catch (e) { say(`Could not start audio: ${e.message}`, 'err'); return false; }
    return true;
  }
  function play(rangeOnly) {
    if (!sfx) return;
    stopPlay();
    if (!audioContext()) return;
    const asset = rangeOnly ? M.sliceRange(sfx, rng[0], rng[1]) : sfx;
    const rate = actx.sampleRate || 44100;
    const x0 = rangeOnly ? rng[0] * colW : 0, x1 = rangeOnly ? (rng[1] + 1) * colW : tickCount() * colW;
    playWhat = kind === 'music' ? 'pattern' : 'effect';
    startAudio(M.renderSfx(asset, { rate }), rate, (f) => { playX = f >= 1 ? -1 : x0 + (x1 - x0) * f; drawLanes(); });
  }
  /** Song mode: the whole song (the order list, then from the loop to the end once more); the order entry playing is marked. */
  function playSong() {
    if (kind !== 'music' || !song) return;
    stopPlay();
    if (!audioContext()) return;
    const rate = actx.sampleRate || 44100;
    const tl = MM.songTimeline(song);
    playWhat = 'song';
    playPos = -1;
    if (startAudio(M.renderSfx(tl.asset, { rate }), rate, (f) => {
      const t = f * tl.refreshes;
      const sec = f >= 1 ? null : tl.sections.find((x) => t >= x.start && t < x.start + x.length);
      const pos = sec ? sec.pos : -1;
      if (pos !== playPos) { playPos = pos; syncSong(); }
    })) say(`Playing the song: ${tl.refreshes} refreshes, ${(tl.refreshes / M.REFRESH_HZ).toFixed(2)} s${song.loop === null ? '' : ' (the loop played once more)'}${tl.truncated ? ' (cut at 5 minutes)' : ''}`);
  }
  function endPlay() {
    playing = false; src = null; playX = -1; playPos = -1;
    cancelAnimationFrame(raf);
    if (!destroyed) { syncControls(); if (sfx) drawLanes(); }
  }
  function stopPlay() {
    if (!playing && !src) return;
    const node = src;
    src = null;
    try { if (node) { node.onended = null; node.stop(); } } catch { /* it may have ended */ }
    endPlay();
  }

  // ── keyboard ──
  root.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod && k === 'a') { if (sfx) { e.preventDefault(); anchor = 0; rng = [0, tickCount() - 1]; cur = rng[1]; renderAll(); } return; }
    if (mod || e.altKey || !sfx) return;
    if (k === ' ' || k === 'spacebar') { if (t && t.tagName === 'BUTTON') return; e.preventDefault(); if (playing) stopPlay(); else play(false); }
    else if (k === 'arrowleft') { e.preventDefault(); e.shiftKey ? extendTo(cur - 1) : selectTick(cur - 1); }
    else if (k === 'arrowright') { e.preventDefault(); e.shiftKey ? extendTo(cur + 1) : selectTick(cur + 1); }
    else if (k === 'home') { e.preventDefault(); e.shiftKey ? extendTo(0) : selectTick(0); }
    else if (k === 'end') { e.preventDefault(); e.shiftKey ? extendTo(tickCount() - 1) : selectTick(tickCount() - 1); }
  });

  // ── host events ──
  const unsub = [];
  try {
    const u = host?.onProjectChange?.((ev) => {
      if (destroyed || !ev || ev.source === hostId) return;
      if (ev.type === 'source') { if (sfx) renderInfo(); return; }
      if (ev.type === 'asset' && ev.kind && ev.kind !== kind) { if (ev.kind === 'sfx' || ev.kind === 'music') renderAll(); return; }    // the other mode's assets: only the lists
      outsideChange(ev);
    });
    if (typeof u === 'function') unsub.push(u);
  } catch { /* no change events */ }
  try {
    const u = host?.onSelectAsset?.((ev) => { if (!destroyed && (ev?.kind === 'sfx' || ev?.kind === 'music') && ev.name) select_(ev.name, ev.kind); });
    if (typeof u === 'function') unsub.push(u);
  } catch { /* no selection events */ }
  // the colours come from CSS variables, so a theme switch needs a redraw
  try {
    const mo = new MutationObserver(() => { if (!destroyed && sfx) { drawLanes(); drawWave(); } });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    cleanups.push(() => mo.disconnect());
  } catch { /* no MutationObserver */ }

  function reconcile() {
    const names = H.list();
    if (name && names.includes(name)) {
      const cur_ = H.get(name);
      if (cur_ && JSON.stringify(cur_) !== lastStored) loadEffect(name, true);
      else renderAll();
    } else if (names.length) loadEffect(names[0]);
    else { clearAsset(); renderAll(); }
  }
  function outsideChange(ev) {
    if (stroke) stroke = null;
    const names = H.list();
    if (ev.type === 'asset' && ev.oldName && ev.oldName === name && names.includes(ev.name)) name = ev.name;
    reconcile();
  }
  /** Show the asset `n` of kind `k` ('sfx' or 'music'; default: the mode shown), switching the mode when needed. */
  function select_(n, k = kind) {
    if (k !== 'sfx' && k !== 'music') return;
    if (!n || !H.list(k).includes(n)) return;
    if (k !== kind) { setMode(k, n); return; }
    if (n === name && sfx) { renderAll(); return; }
    loadEffect(n);
  }

  // ── public ──
  function refresh() {
    if (destroyed) return;
    reconcile();
  }
  function destroy() {
    destroyed = true;
    stopPlay();
    try { actx?.close?.(); } catch { /* ignore */ }
    for (const u of unsub) { try { u(); } catch { /* ignore */ } }
    for (const c of cleanups) c();
    root.remove();
  }

  refresh();
  return {
    refresh, render: refresh, destroy, select: select_,
    /** For tests and debugging: a copy of what is being edited. */
    getState: () => ({
      kind, name, track, trackLengths: sfx ? M.trackLengths(sfx) : [0, 0, 0], cur, range: [...rng], zoom: sfx ? colW : 0, colW, playing, playWhat, canUndo: !!hist?.canUndo, canRedo: !!hist?.canRedo,
      asset: sfx ? M.toAsset(sfx) : null, lanes: LANES, toneTop: TONE_TOP, labelWidth: LABEL_W, marks: [...hostMarks],
      song: song ? MM.toSong(song) : null, pattern: pat, orderPos: opos, noteAt,
    }),
  };
}
