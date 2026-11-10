"use strict";
// Prints the reference picture of one pose: node art.mjs METHOD:W:H:WCOL:MAPN poseId
import { castFrame, drawFrame, makeMap, makePoses, asciiWindow } from './common.mjs';
const [METHOD, W, H, WCOL, MAPN] = process.argv[2].split(':').map(Number);
const cfg = { METHOD, W, H, WCOL, MAPN };
const p = makePoses(MAPN)[+process.argv[3]];
const cf = castFrame(cfg, p, makeMap(MAPN));
const bm = new Uint8Array(6144);
drawFrame(cfg, cf.hh, cf.pi, bm);
console.log(`pose ${p.id}: x=${p.px / 256} y=${p.py / 256} angle=${p.ang} (${(p.ang * 360 / 256).toFixed(1)} deg)  rays=${cf.hh.length} avg DDA steps=${(cf.steps / cf.hh.length).toFixed(1)}`);
console.log(asciiWindow(cfg, bm));
