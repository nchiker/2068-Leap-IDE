#!/usr/bin/env node
// cartrun.mjs — run a TS2068 dock cartridge headless on TSRun's emulator core with the
// stock HOME ROM and EXROM, then report what happened.
//
//   node tools/cartrun.mjs --dck build/x.dck [--frames 200] [--png out.png]
//        [--dump ADDR:LEN ...] [--keys TEXT --keys-at FRAME] [--watch-pc ADDR ...]
//        [--trace-dock] [--json]
//
// TSRun is imported read-only from $TSRUN (default: the IDE's tsrun/ submodule); the stock ROMs from
// $TSRUN/roms/ts2068-{0,1}.rom unless --home/--exrom name others.
//
// --trace-dock reports the first instruction fetched from a DOCK chunk (the stock ROM's
// hand-off): PC, IFF1, IM, SP, and ports $F4/$FF at that moment.
// --watch-pc ADDR stops at the first time the CPU reaches ADDR (hex) and reports state.
// --keys types TEXT (letters, digits, space, \n = ENTER) starting at --keys-at, one key every
// 6 frames (pressed 3, released 3).

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { pathToFileURL, fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = { frames: 200, dump: [], watch: [], keysAt: 100, json: false };
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    switch (a) {
    case "--dck": opt.dck = next(); break;
    case "--home": opt.home = next(); break;
    case "--exrom": opt.exrom = next(); break;
    case "--frames": opt.frames = parseInt(next(), 10); break;
    case "--png": opt.png = next(); break;
    case "--dump": opt.dump.push(next()); break;
    case "--keys": opt.keys = next().replace(/\\n/g, "\n"); break;
    case "--keys-at": opt.keysAt = parseInt(next(), 10); break;
    case "--watch-pc": opt.watch.push(parseInt(next(), 16)); break;
    case "--trace-dock": opt.traceDock = true; break;
    case "--json": opt.json = true; break;
    default: console.error("unknown option " + a); process.exit(2);
    }
}

const tsrun = process.env.TSRUN || fileURLToPath(new URL("../../tsrun", import.meta.url));
const M = await import(pathToFileURL(join(tsrun, "machine.js")).href);
const Z = await import(pathToFileURL(join(tsrun, "z80.js")).href);

const keyMatrix = new Uint8Array(9).fill(0x1F);
const joystick = new Uint8Array(2).fill(0xFF);
const m = M.createMachine(keyMatrix, joystick);
const fail = (e) => { if (e) { console.error(e); process.exit(2); } };
fail(M.setHomeRom(m, readFileSync(opt.home || join(tsrun, "roms/ts2068-0.rom"))));
fail(M.setExRom(m, readFileSync(opt.exrom || join(tsrun, "roms/ts2068-1.rom"))));
if (opt.dck) fail(M.insertDock(m, readFileSync(resolve(opt.dck))));
M.resetMachine(m);

// Spectrum keyboard matrix: row (half-row index), bit.
const KEYROWS = [
    ["\x01", "z", "x", "c", "v"],      // 0: CAPS SHIFT (\x01), Z X C V
    ["a", "s", "d", "f", "g"],
    ["q", "w", "e", "r", "t"],
    ["1", "2", "3", "4", "5"],
    ["0", "9", "8", "7", "6"],
    ["p", "o", "i", "u", "y"],
    ["\n", "l", "k", "j", "h"],
    [" ", "\x02", "m", "n", "b"],      // 7: SPACE, SYMBOL SHIFT (\x02), M N B
];
function keyPos(ch) {
    for (let r = 0; r < KEYROWS.length; r++) {
        const b = KEYROWS[r].indexOf(ch);
        if (b >= 0) return [r, b];
    }
    return null;
}
function press(ch, down) {
    const shifted = ch >= "A" && ch <= "Z";
    const p = keyPos(shifted ? ch.toLowerCase() : ch);
    if (!p) throw new Error("no key for " + JSON.stringify(ch));
    const set = (r, b) => { keyMatrix[r] = down ? keyMatrix[r] & ~(1 << b) : keyMatrix[r] | (1 << b); };
    if (shifted) set(0, 0);
    set(p[0], p[1]);
}

const report = { events: [] };
const cpu = m.cpu;
const isDock = (addr) => (m.portF4 & (1 << (addr >>> 13))) !== 0 && (m.portFF & 0x80) === 0;
const state = (why) => ({
    why, pc: hex(cpu.pc), sp: hex(cpu.sp), iff1: cpu.iff1, im: cpu.im,
    portF4: hex(m.portF4, 2), portFF: hex(m.portFF, 2), frame: report.frame,
});
function hex(v, w = 4) { return "$" + v.toString(16).toUpperCase().padStart(w, "0"); }

// Step one instruction at a time while something needs per-instruction checks.
const perInstr = opt.traceDock || opt.watch.length > 0;
let dockSeen = false;
let stopped = false;
function checkPc() {
    if (opt.traceDock && !dockSeen && isDock(cpu.pc)) {
        dockSeen = true;
        report.events.push(state("first DOCK fetch"));
    }
    if (opt.watch.includes(cpu.pc)) {
        report.events.push(state("watch " + hex(cpu.pc)));
        opt.watch = opt.watch.filter((a) => a !== cpu.pc);
        if (opt.watch.length === 0 && !opt.traceDock) stopped = false;
    }
}

const keyQueue = opt.keys ? [...opt.keys] : [];
for (report.frame = 0; report.frame < opt.frames && !stopped; report.frame++) {
    const f = report.frame;
    if (keyQueue.length && f >= opt.keysAt) {
        const k = (f - opt.keysAt) % 6;
        if (k === 0) press(keyQueue[0], true);
        if (k === 3) press(keyQueue.shift(), false);
    }
    if (!perInstr) {
        M.runFrame(m);
        continue;
    }
    // Same frame, sliced into single instructions: runZ80 with a 1 T-state budget runs one.
    const end = m.frameStart + M.tStatesPerFrame;
    while (m.tstates < end) {
        checkPc();
        if (cpu.halted) {
            // A halted CPU only burns whole 4 T steps; let it sleep to the frame end.
            if (end - m.tstates < 4) break;
            Z.runZ80(cpu, m.bus, end - m.tstates, m);
            continue;
        }
        Z.runZ80(cpu, m.bus, 1, m);
    }
    M.runFrame(m); // finishes the frame's video/interrupt bookkeeping (no T-states left to run)
}
report.final = state("end");
report.dumps = {};
for (const d of opt.dump) {
    const [a, l] = d.split(":");
    const addr = parseInt(a, 16), len = parseInt(l, 10);
    const bytes = [];
    for (let i = 0; i < len; i++) bytes.push(m.bus.read((addr + i) & 0xFFFF));
    report.dumps[hex(addr)] = bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ");
}
report.border = m.border;

if (opt.png) {
    writeFileSync(opt.png, screenPng());
    report.png = opt.png;
}
if (opt.json) console.log(JSON.stringify(report, null, 1));
else {
    for (const e of report.events) console.log(JSON.stringify(e));
    console.log(JSON.stringify(report.final));
    for (const [k, v] of Object.entries(report.dumps)) console.log(k + ": " + v);
}

// The 256x192 mode-0 display file and attributes from HOME RAM, scaled 2x, as a PNG.
function screenPng() {
    const pal = [[0, 0, 0], [0, 0, 205], [205, 0, 0], [205, 0, 205], [0, 205, 0], [0, 205, 205], [205, 205, 0], [205, 205, 205]];
    const palB = pal.map((c) => c.map((v) => (v ? 255 : 0)));
    const W = 256, H = 192, S = 2;
    const raw = Buffer.alloc((W * S * 3 + 1) * H * S);
    let o = 0;
    for (let y = 0; y < H * S; y++) {
        raw[o++] = 0;
        const py = y / S | 0;
        for (let x = 0; x < W * S; x++) {
            const px = x / S | 0;
            const addr = 0x4000 | ((py & 0xC0) << 5) | ((py & 7) << 8) | ((py & 0x38) << 2) | (px >> 3);
            const att = m.ram[0x5800 + (py >> 3) * 32 + (px >> 3)];
            const on = (m.ram[addr] >> (7 - (px & 7))) & 1;
            const p = att & 0x40 ? palB : pal;
            const c = on ? p[att & 7] : p[(att >> 3) & 7];
            raw[o++] = c[0]; raw[o++] = c[1]; raw[o++] = c[2];
        }
    }
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W * S, 0); ihdr.writeUInt32BE(H * S, 4);
    ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
function crc32(buf) {
    let c = ~0;
    for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; }
    return ~c >>> 0;
}
