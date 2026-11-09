// probe-frames.mjs -- where do the refreshes go? prints V_FRAMES after each refresh around the entry (TSRun).
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = resolve(HERE, '../..');
const M = await import(pathToFileURL(join(ARCADE, '../tsrun/machine.js')).href);
const rt = JSON.parse(readFileSync(join(ARCADE, 'build/runtime.json'), 'utf8'));
const S = rt.symbols;
const rd16 = (m, a) => m.ram[a] | (m.ram[a + 1] << 8);
const m = M.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
M.setHomeRom(m, readFileSync(join(ARCADE, '../tsrun/roms/ts2068-0.rom')));
M.setExRom(m, readFileSync(join(ARCADE, '../tsrun/roms/ts2068-1.rom')));
M.insertDock(m, new Uint8Array(readFileSync(process.argv[2])));
M.resetMachine(m);
const log = [];
for (let f = 1; f <= 420; f++) { M.runFrame(m); log.push(`${f}:${rd16(m, S.V_FRAMES)}`); }
console.log(log.join(' '));
