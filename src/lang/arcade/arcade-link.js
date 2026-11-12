/**
 * src/lang/arcade/arcade-link.js — Leap Arcade linker for milestone M2 (pure; no DOM, no node: imports).
 *
 *   link(gen, runtime, image) -> {errors, memory, dck, map, usage}
 *
 *   gen      the result of generate() (arcade-codegen.js): code at gen.base, entries, frameDiv, sprites, symbols, srcMap
 *   runtime  the parsed arcade/build/runtime.json ({symbols, constants, ...})
 *   image    the runtime's 65,536-byte memory image (arcade/build/runtime.bin; chunks 0-1 filled)
 *
 * Writes the game image at GAME_BASE as docs/ARCADE_RUNTIME_API.md lays it out:
 *   +0 DW init_entry   +2 DW frame_entry   +4 DB frame_div   +5 DB sprite_count   +6 DW sprite_table
 *   +8 sprite descriptors (6 bytes each: DB width, DB height, DW data, DW 0), then the code (gen.base), then the
 *   sprite data (height rows of 4 bytes: mask_hi, mask_lo, image_hi, image_lo).
 * The rest of $8000-$BFFF is cleared to 0. `memory` is the full 64 KB image; `dck` is a TS2068 DCK with one bank-0
 * block, kinds 0 and 2 only, chunks 0, 1, 4 and 5 shipped (a port of arcade/tools/mkdck.mjs's buildDck).
 *
 * Language batch 1 (gen.headerLen 18, docs/ARCADE_RUNTIME_API_V2.md "As built: language batch 1"): when a program has a LOADMAP or several maps, frame_div gets bit 7 ($80)
 * and the header continues +16 DW map_table; the map_ptr word +12 is 0 and the sprite descriptors start at +18.
 *
 * Runtime API v2 (gen.headerLen 16, gen.descLen 8, docs/ARCADE_RUNTIME_API_V2.md): the header continues +14 DW inst_table (inside the code
 * area: `DB ninst`, then one asset index per instance); `sprite_count` is the number of ASSETS; each descriptor is
 * `DB w, DB h, DW data, DW hot, DB phases, DB 0`.
 *
 * Runtime API v1 (gen.headerLen 14, docs/ARCADE_RUNTIME_API_V1.md): the header continues
 *   +8 DW tileset_ptr   +10 DW sfx_table   +12 DW map_ptr   (0 = none; the data is inside gen.code, see arcade-codegen.js)
 * and the last word of each sprite descriptor is the hot-box pointer (`DB x, y, w, h`; 0 in v0 images). The sprite descriptors
 * follow the header at +14 (the header's sprite_table pointer says where).
 *
 * Language batch 2 (gen.window set; docs/ARCADE_PLATFORMER_CONTRACT.md 3b): the header is 20 bytes (frame_div | $C0, map_table at +16, window_desc at +18) and
 * the image gets, after the sprite data, world_src (the 2,048-byte map byte-RLE encoded: pairs count 1..255 / value, a count of 0 ends), the 32 tile flags, tilerows (256) and window_desc (14 + 2 per band), and at the very end of the
 * game area the 14 scroll-table pages (3,584 bytes, so `tables` is $B200, page aligned). A v3 sprite descriptor carries `nframes` in its last byte.
 * The linker fails with the number of bytes missing when the game does not fit, and when the runtime's phase-pool plan (arcade-window.js planPhasePool: FTABs,
 * min(nframes, instances) frame slots per asset, first fit over POOL_A / B / C of runtime.json) does not fit: exactly when the runtime would stop at boot with
 * the magenta border. The code generator warns for each asset whose frames do not all stay cached.
 *
 * Wireframe 3D (gen.wire set; docs/ARCADE_WIREFRAME_CONTRACT.md 3.3): the header is 20 bytes (frame_div | DIV_EXT | DIV_WIRE, map_table at +16, wire_desc at +18); wire_desc (4 bytes) and every model's image
 * are inside the code area (gen.wire.descAt, gen.wire.models[].at). The linker refuses a game whose sprite assets have more than 45 phases in all.
 *
 * Language batch 3 (gen.view set; docs/ARCADE_RAYCASTER_CONTRACT.md section 2): the header is 20 bytes (frame_div | DIV_EXT | DIV_VIEW, map_table at +16, view_desc at +18) and the image gets,
 * after the sprite data, map_src (the w x h map, row stride w, byte-RLE encoded as world_src), the 16 wall pattern bytes when the program has a PATTERNS clause, and view_desc (10 bytes).
 * There are no scroll tables and no phase pool in ray mode; the ray tables are the runtime's own memory.
 *
 * `map` (for the debugger and the Studio): {lines: [{addr, line, col}] sorted by address, vars: {NAME: addr},
 * slots: [{name, addr}], procs, fns, sprites, entries}; findSource(map, addr) returns the last line entry at or
 * before an address.
 */

"use strict";

import { buildWindowDesc } from './arcade-window.js';
import { buildViewDesc, VIEW_DESC_BYTES, VIEW_RAM_BYTES } from './arcade-view.js';
import { layoutOf, shippedChunks, BANK_BASE, BANK_BYTES, GAME_AREA_BYTES, CHUNK } from './arcade-bank.js';

export { CHUNK };
/** A WIRE3D game's sprite assets may have this many phases in all (contract 3.2): above it the phase slots would reach the runtime's wireframe RAM. */
export const WIRE_MAX_PHASES = 45;
/** The chunks every build ships; a build with banked assets also ships chunk 2 (and 3 past 8,192 banked bytes): see shippedChunks() in arcade-bank.js and `link().shipped`. */
export const SHIPPED_CHUNKS = [0, 1, 4, 5];

/** Build a TS2068 DCK from 8 KB chunks (bank 0 = DOCK only, every chunk kind 2). chunks: index -> Uint8Array(8192). */
export function buildDck(chunks) {
  const idx = Object.keys(chunks).map(Number).sort((a, b) => a - b);
  const head = new Uint8Array(9);                 // bank id 0, then 8 chunk kinds
  for (const c of idx) {
    if (!(c >= 0 && c < 8)) throw new Error(`bad chunk index ${c}`);
    if (chunks[c].length !== CHUNK) throw new Error(`chunk ${c} is ${chunks[c].length} bytes, not ${CHUNK}`);
    head[1 + c] = 2;                              // kind 2 = ROM from file
  }
  const out = new Uint8Array(9 + idx.length * CHUNK);
  out.set(head, 0);
  idx.forEach((c, k) => out.set(chunks[c], 9 + k * CHUNK));
  return out;
}

/** The last source-map entry whose address is <= addr, or null. */
export function findSource(map, addr) {
  const lines = map.lines;
  let lo = 0, hi = lines.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].addr <= addr) { best = lines[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

export function link(gen, runtime, image) {
  const errors = [];
  const fail = (message) => { errors.push({ line: 1, col: 0, endCol: 0, severity: 'error', message }); return { errors, memory: null, dck: null, map: null, usage: null, shipped: null }; };
  if (!gen || !gen.code) return fail('nothing to link');
  if (!(image instanceof Uint8Array) || image.length !== 65536) return fail('the runtime image must be 65,536 bytes');
  const cst = runtime.constants ?? {};
  const GAME_BASE = cst.GAME_BASE ?? 0x8000;
  const n = gen.sprites.length;
  // the banked cartridge map: what lives in the window $4000-$7FFF (empty for a game that banks nothing), and the sizes of the mapped part
  const banked = gen.bank?.banked ?? [], bankedKeys = gen.bank?.keys ?? new Set();
  const lay = layoutOf(gen, runtime, bankedKeys);
  const { GAME_END, headerLen, descLen, codeEnd, spriteBytes, descBytes, winData, worldRle, viewData, viewRle, viewPatterns, streamsBytes, tableRecBytes, tablesBytes, end } = lay;
  if (gen.base !== GAME_BASE + headerLen + descLen) return fail(`code was generated for base $${gen.base.toString(16)} but the image needs $${(GAME_BASE + headerLen + descLen).toString(16)}`);
  const bankedBytes = banked.reduce((a, b) => a + b.bytes, 0);
  if (bankedBytes > BANK_BYTES) return fail(`banked assets need ${bankedBytes} of ${BANK_BYTES} bytes`);

  const memory = Uint8Array.from(image);
  memory.fill(0, GAME_BASE, GAME_END);
  // language batch 2: the window's data; batch 3: the 3D view's data
  const win = gen.window ?? null, view = gen.view ?? null;
  if (end + tablesBytes > GAME_END) {
    return fail(`the game does not fit: ${end + tablesBytes - GAME_BASE} bytes (code ${gen.code.length}, sprites ${spriteBytes}${win ? `, window data ${winData} and scroll tables ${tablesBytes}` : ''}${view ? `, 3D view data ${viewData}` : ''}${streamsBytes ? `, worlds and plans ${streamsBytes}` : ''}) in the ${GAME_END - GAME_BASE}-byte game area, ${end + tablesBytes - GAME_END} too many`);
  }
  // the window: chunk 2 (and 3 past 8,192 banked bytes) is shipped; its unused bytes are $FF, the banked assets sit at their addresses
  const shipped = shippedChunks(bankedBytes);
  if (bankedBytes > 0) {
    memory.fill(0xFF, BANK_BASE, BANK_BASE + CHUNK * (shipped.includes(3) ? 2 : 1));
    for (const b of banked) memory.set(b.data, b.at);
  }
  const addrOf = new Map(banked.map((b) => [b.key, b.at]));      // where each world / plan is: the window, or (below) the mapped part
  const warnings = [];
  // wireframe 3D (docs/ARCADE_WIREFRAME_CONTRACT.md 3.2): the runtime keeps the projected points in W_REC $F500-$F9FF and its variables in $FA00-$FA7F, which is the top of the phase pool POOL_B; the boot hands out the
  // phase slots in order (slot n = the n-th phase of all the assets), and slot 44 ends at $F4DF, so a game with at most WIRE_MAX_PHASES phases in all never writes there
  if (gen.wire) {
    const phases = gen.sprites.reduce((a, sp) => a + (sp.phases ?? 8), 0);
    if (phases > WIRE_MAX_PHASES) return fail(`sprite art too large for a WIRE3D game: ${phases} phases, at most ${WIRE_MAX_PHASES}; use fewer phases`);
  }
  if (gen.phase && !gen.phase.ok) {
    return fail(`${gen.phase.miss} bytes of sprite art do not fit in the phase pool (${runtime.constants?.PHASE_POOL_BYTES ?? gen.phase.pieces.reduce((n, [, l]) => n + l, 0)} bytes): the runtime would stop at boot with a magenta border; use fewer phases, fewer instances or smaller sprites (the frame tables and one frame slot per instance must fit)`);
  }
  if (gen.noviewPhase && !gen.noviewPhase.ok) {
    return fail(`${gen.noviewPhase.miss} bytes of sprite art do not fit in the phase pool of a scene without the 3D view (SCENE ... NOVIEW: ${gen.noviewPhase.pieces.reduce((n, [, l]) => n + l, 0)} bytes, smaller than the ${runtime.constants?.PHASE_POOL_BYTES ?? 5888} of a normal game): use fewer phases, fewer instances or smaller sprites (the frame tables and one frame slot per instance must fit)`);
  }
  const w16 = (a, v) => { memory[a] = v & 0xFF; memory[a + 1] = (v >> 8) & 0xFF; };
  w16(GAME_BASE, gen.entries.init);
  w16(GAME_BASE + 2, gen.entries.frame);
  memory[GAME_BASE + 4] = gen.frameDiv | (gen.mapFlag ?? 0);                 // language batch 1: bit 7 says the header is extended (the map table); batch 2: bit 6, the window
  memory[GAME_BASE + 5] = n;
  w16(GAME_BASE + 6, GAME_BASE + headerLen);
  if (headerLen >= 14) {
    w16(GAME_BASE + 8, gen.v1?.tileset ?? 0);
    w16(GAME_BASE + 10, gen.v1?.sfxTable ?? 0);
    w16(GAME_BASE + 12, gen.v1?.map ?? 0);
  }
  if (headerLen >= 16) w16(GAME_BASE + 14, gen.v2?.instTable ?? 0);      // v2: inst_table -> DB ninst, ninst x DB asset
  if (headerLen >= 18) w16(GAME_BASE + (gen.mapTableAt ? gen.mapTableAt - GAME_BASE : 16), gen.v2?.mapTable ?? 0);   // batch 1: map_table -> DB count, count x DW map (DB w, DB h, cells)
  if (gen.wire) w16(GAME_BASE + 18, gen.wire.descAt);                          // wireframe 3D: wire_desc -> DB r0, DB r1, DB attr, DB 0 (inside the code area, with the models' images)
  let dataAt = codeEnd;
  gen.sprites.forEach((s, i) => {
    const d = GAME_BASE + headerLen + (gen.descLen ?? 6) * i;
    memory[d] = s.w; memory[d + 1] = s.h;
    w16(d + 2, dataAt);
    w16(d + 4, s.hotAddr ?? 0);
    if ((gen.descLen ?? 6) >= 8) { memory[d + 6] = s.phases ?? 8; memory[d + 7] = s.nframes ?? 0; }     // v2: DB phases, DB 0; v3: DB nframes
    memory.set(s.data, dataAt);
    dataAt += s.data.length;
  });
  memory.set(gen.code, gen.base);
  let winLayout = null;
  if (win) {
    let at = codeEnd + spriteBytes;
    let worldSrc = addrOf.get(win.key);                          // banked: the descriptor points into the window and the stream is not in the game image
    if (worldSrc === undefined) { worldSrc = at; memory.set(worldRle, at); at += worldRle.length; addrOf.set(win.key, worldSrc); }
    const tileFlags = at; memory.set(win.tileFlags, at); at += win.tileFlags.length;
    const tileRows = at; memory.set(win.tileRows, at); at += win.tileRows.length;
    const windowDesc = at;
    const tables = GAME_END - tablesBytes;
    memory.set(buildWindowDesc({ cx: win.cx, cy: win.cy, worldW: win.worldW, camMax: win.camMax, bands: win.bands, tables, tileFlags, worldSrc, tileRows }), at); at += descBytes;
    memory.set(win.tables, tables);
    w16(GAME_BASE + 18, windowDesc);
    winLayout = { worldSrc, tileFlags, tileRows, windowDesc, tables, descBytes };
  }

  let viewLayout = null;
  if (view) {
    let at = codeEnd + spriteBytes;
    let mapSrc = addrOf.get(view.key);
    if (mapSrc === undefined) { mapSrc = at; memory.set(viewRle, at); at += viewRle.length; addrOf.set(view.key, mapSrc); }
    const patterns = viewPatterns ? at : 0;
    if (viewPatterns) { memory.set(view.patterns, at); at += viewPatterns; }
    const viewDesc = at;
    memory.set(buildViewDesc({ colw: view.colw, mapW: view.mapW, mapH: view.mapH, attrTop: view.attrTop, attrBottom: view.attrBottom, mapSrc, patterns }), at);
    w16(GAME_BASE + 18, viewDesc);
    viewLayout = { mapSrc, patterns, viewDesc };
  }

  // the worlds / plans only a WORLD statement names, then every WORLD's `LD HL,src`
  {
    let at = codeEnd + spriteBytes + winData + viewData;
    for (const st of gen.streams ?? []) {
      if (!addrOf.has(st.key)) { memory.set(st.data, at); addrOf.set(st.key, at); at += st.data.length; }
    }
    // bankable per-level tables: a record that is not in the window sits right after the streams (layoutOf counts it); every LOADTABLE's address is a fixup too
    for (const t of gen.tables ?? []) {
      if (!addrOf.has(t.key)) { memory.set(t.data, at); addrOf.set(t.key, at); at += t.data.length; }
    }
    for (const f of gen.fixups ?? []) {
      const a = addrOf.get(f.key);
      if (a === undefined) return fail(`internal: the world or table '${f.key}' was not placed`);
      w16(f.at, a);
    }
  }

  const chunks = {};
  for (const c of shipped) chunks[c] = memory.slice(c * CHUNK, (c + 1) * CHUNK);
  const dck = buildDck(chunks);

  const lines = [...gen.srcMap].sort((a, b) => a.addr - b.addr);
  const map = {
    lines,
    vars: gen.symbols.vars,
    slots: gen.symbols.slots,
    procs: gen.symbols.procs,
    fns: gen.symbols.fns,
    sprites: gen.symbols.sprites,
    ...(gen.symbols.arrays ? { arrays: gen.symbols.arrays, instances: gen.symbols.instances } : {}),
    entries: gen.entries,
    banked: banked.map((b) => ({ name: b.name, kind: b.kind, at: b.at, bytes: b.bytes, why: b.why })),       // the banked assets: they are data in the window, not code, so findSource() does not name them
  };
  const usage = {
    gameBase: GAME_BASE,
    header: headerLen,
    data: gen.usage.dataBytes ?? {},
    descriptors: descLen,
    code: gen.code.length,
    spriteData: spriteBytes,
    ...((gen.tables ?? []).length ? { tables: tableRecBytes } : {}),      // the mapped bytes of the bankable per-level table records (the banked ones are in `banked`); only a game with tables has the field
    total: end - GAME_BASE,
    end,
    free: GAME_END - end,
    varBytes: gen.usage.varBytes,
    dckBytes: dck.length,
    // the whole 16 KB game area: everything above plus the scroll tables (`total` and `free` leave the tables out, as they were first reported)
    gameArea: { used: end + tablesBytes - GAME_BASE, available: GAME_END - GAME_BASE, free: GAME_END - end - tablesBytes },
    // the banked cartridge map (docs/ARCADE_BANKING_CONTRACT.md section 5): the mapped part (the same as gameArea) and the window
    mapped: { used: end + tablesBytes - GAME_BASE, available: GAME_AREA_BYTES },
    banked: { used: bankedBytes, available: BANK_BYTES, assets: banked.map((b) => ({ name: b.name, kind: b.kind, bytes: b.bytes, at: b.at, why: b.why })) },
    shippedChunks: shipped,
    ...(view ? {
      // language batch 3: the 3D view (the ray tables and buffers are the runtime's own memory, built at scene start: nothing of them is in the image)
      frames: gen.sprites.reduce((n, sp) => n + sp.data.length, 0),
      view: {
        mapSource: viewRle.length, mapExpanded: VIEW_RAM_BYTES, mapW: view.mapW, mapH: view.mapH, descriptor: VIEW_DESC_BYTES, patterns: viewPatterns, colw: view.colw,
        attrTop: view.attrTop, attrBottom: view.attrBottom, at: viewLayout,
        note: 'the ray tables, buffers and the 32 x 32 map array are in memory the runtime owns (built at scene start); they are not part of the game image',
      },
      gameVars: { used: gen.usage.varBytes, available: (cst.GAME_VARS_LIMIT ?? 0) - (cst.GAME_VARS_BASE ?? 0) + 1 },
    } : {}),
    ...(gen.noviewPhase ? { noviewPhaseRam: { needed: gen.noviewPhase.need, available: gen.noviewPhase.pieces.reduce((n, [, l]) => n + l, 0), miss: gen.noviewPhase.miss, K: gen.noviewPhase.K, perAsset: gen.noviewPhase.perAsset } } : {}),
    ...(gen.phase ? {
      // language batch 2: bytes per category and the two capacity figures the Studio shows
      frames: gen.sprites.reduce((n, sp) => n + sp.data.length, 0),
      window: win ? {
        worldSource: worldRle.length, worldExpanded: win.worldSrc.length, tileFlags: win.tileFlags.length, tileRows: win.tileRows.length, descriptor: descBytes,
        scrollTables: tablesBytes, camMax: win.camMax, worldW: win.worldW, bands: win.bands.length, at: winLayout,
      } : null,
      phaseRam: { needed: gen.phase.need, available: runtime.constants?.PHASE_POOL_BYTES ?? gen.phase.pieces.reduce((n, [, l]) => n + l, 0), miss: gen.phase.miss, K: gen.phase.K, perAsset: gen.phase.perAsset },
      gameVars: { used: gen.usage.varBytes, available: (cst.GAME_VARS_LIMIT ?? 0) - (cst.GAME_VARS_BASE ?? 0) + 1 },
    } : {}),
  };
  errors.push(...warnings);
  return { errors, memory, dck, map, usage, shipped };
}
