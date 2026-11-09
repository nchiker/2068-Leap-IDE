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
 * Runtime API v2 (gen.headerLen 16, gen.descLen 8, docs/ARCADE_RUNTIME_API_V2.md): the header continues +14 DW inst_table (inside the code
 * area: `DB ninst`, then one asset index per instance); `sprite_count` is the number of ASSETS; each descriptor is
 * `DB w, DB h, DW data, DW hot, DB phases, DB 0`.
 *
 * Runtime API v1 (gen.headerLen 14, docs/ARCADE_RUNTIME_API_V1.md): the header continues
 *   +8 DW tileset_ptr   +10 DW sfx_table   +12 DW map_ptr   (0 = none; the data is inside gen.code, see arcade-codegen.js)
 * and the last word of each sprite descriptor is the hot-box pointer (`DB x, y, w, h`; 0 in v0 images). The sprite descriptors
 * follow the header at +14 (the header's sprite_table pointer says where).
 *
 * `map` (for the debugger and the Studio): {lines: [{addr, line, col}] sorted by address, vars: {NAME: addr},
 * slots: [{name, addr}], procs, fns, sprites, entries}; findSource(map, addr) returns the last line entry at or
 * before an address.
 */

"use strict";

export const CHUNK = 8192;
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
  const fail = (message) => { errors.push({ line: 1, col: 0, endCol: 0, severity: 'error', message }); return { errors, memory: null, dck: null, map: null, usage: null }; };
  if (!gen || !gen.code) return fail('nothing to link');
  if (!(image instanceof Uint8Array) || image.length !== 65536) return fail('the runtime image must be 65,536 bytes');
  const cst = runtime.constants ?? {};
  const GAME_BASE = cst.GAME_BASE ?? 0x8000;
  const GAME_END = GAME_BASE + 2 * CHUNK;          // chunks 4-5 end at $C000
  const n = gen.sprites.length;
  const headerLen = gen.headerLen ?? 8, descLen = (gen.descLen ?? 6) * n;
  if (gen.base !== GAME_BASE + headerLen + descLen) return fail(`code was generated for base $${gen.base.toString(16)} but the image needs $${(GAME_BASE + headerLen + descLen).toString(16)}`);

  const memory = Uint8Array.from(image);
  memory.fill(0, GAME_BASE, GAME_END);
  const codeEnd = gen.base + gen.code.length;
  let spriteBytes = 0;
  for (const s of gen.sprites) spriteBytes += s.data.length;
  const end = codeEnd + spriteBytes;
  if (end > GAME_END) {
    return fail(`the game does not fit: ${end - GAME_BASE} bytes (code ${gen.code.length}, sprites ${spriteBytes}) in the ${GAME_END - GAME_BASE}-byte game area`);
  }

  const w16 = (a, v) => { memory[a] = v & 0xFF; memory[a + 1] = (v >> 8) & 0xFF; };
  w16(GAME_BASE, gen.entries.init);
  w16(GAME_BASE + 2, gen.entries.frame);
  memory[GAME_BASE + 4] = gen.frameDiv;
  memory[GAME_BASE + 5] = n;
  w16(GAME_BASE + 6, GAME_BASE + headerLen);
  if (headerLen >= 14) {
    w16(GAME_BASE + 8, gen.v1?.tileset ?? 0);
    w16(GAME_BASE + 10, gen.v1?.sfxTable ?? 0);
    w16(GAME_BASE + 12, gen.v1?.map ?? 0);
  }
  if (headerLen >= 16) w16(GAME_BASE + 14, gen.v2?.instTable ?? 0);      // v2: inst_table -> DB ninst, ninst x DB asset
  let dataAt = codeEnd;
  gen.sprites.forEach((s, i) => {
    const d = GAME_BASE + headerLen + (gen.descLen ?? 6) * i;
    memory[d] = s.w; memory[d + 1] = s.h;
    w16(d + 2, dataAt);
    w16(d + 4, s.hotAddr ?? 0);
    if ((gen.descLen ?? 6) >= 8) { memory[d + 6] = s.phases ?? 8; memory[d + 7] = 0; }     // v2: DB phases, DB 0
    memory.set(s.data, dataAt);
    dataAt += s.data.length;
  });
  memory.set(gen.code, gen.base);

  const chunks = {};
  for (const c of SHIPPED_CHUNKS) chunks[c] = memory.slice(c * CHUNK, (c + 1) * CHUNK);
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
  };
  const usage = {
    gameBase: GAME_BASE,
    header: headerLen,
    data: gen.usage.dataBytes ?? {},
    descriptors: descLen,
    code: gen.code.length,
    spriteData: spriteBytes,
    total: end - GAME_BASE,
    end,
    free: GAME_END - end,
    varBytes: gen.usage.varBytes,
    dckBytes: dck.length,
  };
  return { errors, memory, dck, map, usage };
}
