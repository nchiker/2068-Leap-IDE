#!/usr/bin/env node
"use strict";
// tsrun-ay-silent.mjs -- proof test for TSRun's closed-form silent AY advance (rule V10 of docs/ARCADE_STUDIO_COMPLETION_CONTRACT.md).
//
//   node tests/tsrun-ay-silent.mjs            (AY_SEEDS=N for the number of random histories, default 4000; AY_BENCH=0 skips the timing)
//
// ayRunSilent (tsrun/ay.js) jumps over all but the last ~120 chip ticks of a span in closed form. The reference below is a VERBATIM copy of the
// per-tick silent advance as it was in TSRun 9893b46 (ayAdvanceTo with collect = false, ayTick, ayRefreshLevels and the envelope functions).
// Two chips get the same register writes at the same T-states; one advances with the reference, the other with ayRunSilent. After every call
// every chip state field must be bit-identical (regs, toneCounter, toneLevel, noiseCounter, noiseLfsr, noiseLevel, clockDividerPhase, env.*, t,
// nextTickT, out, areas) and filterOut within 1e-12. The sound-on path (ayRunTo) is checked against a verbatim copy of its collect path too.
import { createAy, resetAy, aySeek, ayRunTo, ayRunSilent, ayWriteReg } from '../tsrun/ay.js';

// ---- verbatim reference (TSRun 9893b46, tsrun/ay.js) -------------------------------------------------------------------------------------
const ayVolume = Float64Array.of(
    0.0000, 0.0137, 0.0205, 0.0291, 0.0423, 0.0618, 0.0847, 0.1369,
    0.1691, 0.2647, 0.3527, 0.4499, 0.5704, 0.6873, 0.8482, 1.0000,
);
const ayRegNoise = 6;
const ayRegMixer = 7;
const ayRegAmpA = 8;
const ayRegEnvFine = 11;
const ayRegEnvCoarse = 12;
const ayRegEnvShape = 13;
const ayAmpEnvMode = 0x10;

function ayAdvanceTo(ay, t, collect) {
    while (t > ay.t) {
        const next = Math.min(ay.nextTickT, t);
        const dur = next - ay.t;
        const decay = ay.filterDecay[dur];
        const areaScale = ay.filterTauT * (1 - decay);
        const deltaA = ay.filterOut[0] - ay.out[0];
        const deltaB = ay.filterOut[1] - ay.out[1];
        const deltaC = ay.filterOut[2] - ay.out[2];
        if (collect) {
            ay.areaA += ay.out[0] * dur + deltaA * areaScale;
            ay.areaB += ay.out[1] * dur + deltaB * areaScale;
            ay.areaC += ay.out[2] * dur + deltaC * areaScale;
        }
        ay.filterOut[0] = ay.out[0] + deltaA * decay;
        ay.filterOut[1] = ay.out[1] + deltaB * decay;
        ay.filterOut[2] = ay.out[2] + deltaC * decay;
        ay.t = next;
        if (ay.t === ay.nextTickT) {
            ayTick(ay);
            ayRefreshLevels(ay);
            ay.nextTickT += ay.tickT;
        }
    }
}

function ayTick(ay) {
    const clock16 = !ay.clockDividerPhase;
    ay.clockDividerPhase = !ay.clockDividerPhase;

    for (let ch = 0; ch < 3; ch += 1) {
        if (ay.toneCounter[ch] === 0) {
            ay.toneLevel[ch] ^= 1;
            // A zero period counts as one.
            const half = (ay.regs[ch * 2 + 1] << 8) | ay.regs[ch * 2];
            ay.toneCounter[ch] = Math.max(half, 1) - 1;
        } else {
            ay.toneCounter[ch] -= 1;
        }
    }

    if (clock16) {
        if (ay.noiseCounter === 0) {
            ay.noiseCounter = Math.max(ay.regs[ayRegNoise], 1) - 1;
            const feedback = (ay.noiseLfsr ^ (ay.noiseLfsr >> 3)) & 1;
            ay.noiseLfsr = (ay.noiseLfsr >> 1) | (feedback << 16);
            ay.noiseLevel = ay.noiseLfsr & 1;
        } else {
            ay.noiseCounter -= 1;
        }
        if (ay.env.counter === 0) {
            ay.env.counter = ayEnvPeriod(ay) - 1;
            ayEnvStep(ay);
        } else {
            ay.env.counter -= 1;
        }
    }
}

function ayRefreshLevels(ay) {
    const mixer = ay.regs[ayRegMixer];
    const noiseHigh = ay.noiseLevel !== 0;
    for (let ch = 0; ch < 3; ch += 1) {
        const toneOut = ay.toneLevel[ch] !== 0 || (mixer & (1 << ch)) !== 0;
        const noiseOut = noiseHigh || (mixer & (1 << (ch + 3))) !== 0;
        if (!toneOut || !noiseOut) {
            ay.out[ch] = 0;
            continue;
        }
        const ampreg = ay.regs[ayRegAmpA + ch];
        let amp = ampreg & 0x0F;
        if ((ampreg & ayAmpEnvMode) !== 0) {
            amp = ay.env.level;
        }
        ay.out[ch] = ayVolume[amp];
    }
}

function ayEnvStep(ay) {
    const e = ay.env;
    if (e.holding) {
        return;
    }
    if (e.step < 15) {
        e.step += 1;
        ayEnvSetLevel(ay);
        return;
    }
    const shape = ay.regs[ayRegEnvShape] & 0x0F;
    const cont = (shape & 0x08) !== 0;
    const alt = (shape & 0x02) !== 0;
    const hold = (shape & 0x01) !== 0;
    if (!cont) {
        e.holding = true;
        e.level = 0;
        return;
    }
    if (hold) {
        e.holding = true;
        if (alt) {
            e.attack = !e.attack;
        }
        if (e.attack) {
            e.level = 15;
        } else {
            e.level = 0;
        }
        return;
    }
    if (alt) {
        e.attack = !e.attack;
    }
    e.step = 0;
    ayEnvSetLevel(ay);
}

function ayEnvPeriod(ay) {
    return Math.max(ay.regs[ayRegEnvFine] | (ay.regs[ayRegEnvCoarse] << 8), 1);
}

function ayEnvSetLevel(ay) {
    const e = ay.env;
    if (e.attack) {
        e.level = e.step;
    } else {
        e.level = 15 - e.step;
    }
}

const refRunSilent = (ay, t) => ayAdvanceTo(ay, t, false);
const refRunTo = (ay, t) => ayAdvanceTo(ay, t, true);
// ---- end of the verbatim reference ---------------------------------------------------------------------------------------------------------

// TSRun's machine: cpuHz 3,528,000, AY clock cpuHz / 2, a tick every 16 T, amplifier 680 kOhm x 20 pF (machine.js).
const cpuHz = 3528000;
const TICK_T = cpuHz / (cpuHz / 2 / 8);
const TAU_T = cpuHz * 680000 * 20e-12;
const FRAME_T = 58688;
const FILTER_TOL = 1e-12;

function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

let passed = 0;
let failed = 0;
let maxFilterErr = 0;
const failures = [];

const EXACT = ['t', 'nextTickT', 'tickT', 'filterTauT', 'noiseLfsr', 'noiseCounter', 'noiseLevel', 'clockDividerPhase', 'areaA', 'areaB', 'areaC'];
const ARRAYS = ['regs', 'toneCounter', 'toneLevel', 'out'];
const ENV = ['counter', 'step', 'attack', 'holding', 'level'];

/** The first difference between the two chips, or null. Every field is compared with Object.is (bit-identical; -0 and NaN included). */
function diffAy(ref, got) {
    const keys = new Set([...Object.keys(ref), ...Object.keys(got)]);
    for (const k of keys) {
        if (!(k in ref) || !(k in got)) {
            return `field ${k} only on one side`;
        }
    }
    for (const k of EXACT) {
        if (!Object.is(ref[k], got[k])) {
            return `${k}: ref ${ref[k]} got ${got[k]}`;
        }
    }
    for (const k of ARRAYS) {
        for (let i = 0; i < ref[k].length; i += 1) {
            if (!Object.is(ref[k][i], got[k][i])) {
                return `${k}[${i}]: ref ${ref[k][i]} got ${got[k][i]}`;
            }
        }
    }
    for (const k of ENV) {
        if (!Object.is(ref.env[k], got.env[k])) {
            return `env.${k}: ref ${ref.env[k]} got ${got.env[k]}`;
        }
    }
    if (Object.keys(ref.env).length !== Object.keys(got.env).length) {
        return 'env fields differ';
    }
    for (let i = 0; i < ref.filterDecay.length; i += 1) {
        if (!Object.is(ref.filterDecay[i], got.filterDecay[i])) {
            return `filterDecay[${i}] changed`;
        }
    }
    for (let i = 0; i < 3; i += 1) {
        const err = Math.abs(ref.filterOut[i] - got.filterOut[i]);
        if (!(err <= FILTER_TOL)) {
            return `filterOut[${i}]: ref ${ref.filterOut[i]} got ${got.filterOut[i]} (|diff| ${err})`;
        }
        if (err > maxFilterErr) {
            maxFilterErr = err;
        }
    }
    return null;
}

function check(label, ref, got) {
    const d = diffAy(ref, got);
    if (d === null) {
        passed += 1;
        return true;
    }
    failed += 1;
    if (failures.length < 20) {
        failures.push(`${label}: ${d}`);
    }
    return false;
}

/** A register value biased toward the edge cases: zero, one and full periods, the noise extremes, envelope mode, every envelope shape. */
function randomWrite(rnd) {
    const r = Math.floor(rnd() * 16);
    const pick = (...vals) => vals[Math.floor(rnd() * vals.length)];
    let v;
    switch (r) {
    case 0: case 2: case 4:
        v = rnd() < 0.5 ? pick(0, 1, 2, 4, 0xFF) : Math.floor(rnd() * 256);
        break;
    case 1: case 3: case 5:
        v = rnd() < 0.6 ? pick(0, 0x0F, 0xFF) : Math.floor(rnd() * 256);
        break;
    case 6:
        v = pick(0, 1, 2, 31, 0xFF, Math.floor(rnd() * 256));
        break;
    case 7:
        v = Math.floor(rnd() * 256);
        break;
    case 8: case 9: case 10:
        v = rnd() < 0.5 ? (0x10 | Math.floor(rnd() * 16)) : Math.floor(rnd() * 256);
        break;
    case 11: case 12:
        v = pick(0, 1, 2, 0xFF, Math.floor(rnd() * 256));
        break;
    case 13:
        v = Math.floor(rnd() * 256);
        break;
    default:
        v = Math.floor(rnd() * 256);
    }
    // Sometimes a deselected address (high nibble set): the write goes nowhere.
    const address = rnd() < 0.03 ? (r | 0x10) : r;
    return [address, v];
}

/** A span length: 0, inside a tick, around the jump threshold, a frame, several frames. */
function randomSpan(rnd) {
    const k = rnd();
    if (k < 0.12) return 0;
    if (k < 0.30) return Math.floor(rnd() * 20);
    if (k < 0.45) return Math.floor(rnd() * 400);
    if (k < 0.60) return 1800 + Math.floor(rnd() * 400);   // around 120 ticks: the jump threshold
    if (k < 0.80) return Math.floor(rnd() * FRAME_T);
    if (k < 0.93) return FRAME_T + Math.floor(rnd() * 3 * FRAME_T);
    return Math.floor(rnd() * 12 * FRAME_T);
}

function makePair(startT) {
    const ref = createAy(TICK_T, TAU_T);
    const got = createAy(TICK_T, TAU_T);
    resetAy(ref, startT);
    resetAy(got, startT);
    return [ref, got];
}

// ---- 1. random register histories --------------------------------------------------------------------------------------------------------
const SEEDS = Number(process.env.AY_SEEDS ?? 4000);
let calls = 0;
for (let seed = 1; seed <= SEEDS; seed += 1) {
    const rnd = mulberry32(seed * 2654435761);
    const [ref, got] = makePair(Math.floor(rnd() * 100000));
    // A preset of the hard cases, then random writes.
    const presets = [
        [[7, 0], [8, 0x10], [9, 0x10], [10, 0x10], [13, 0x08 + Math.floor(rnd() * 8)]],
        [[11, 0], [12, 0], [13, Math.floor(rnd() * 16)], [8, 0x10]],
        [[11, 0xFF], [12, 0xFF], [13, Math.floor(rnd() * 16)], [9, 0x10]],
        [[0, 0xFF], [1, 0x0F], [6, 31], [7, 0]],
        [[0, 1], [6, 1], [7, 0], [8, 0x10], [11, 1], [12, 0], [13, 0x0A]],
        [],
    ];
    for (const [a, v] of presets[Math.floor(rnd() * presets.length)]) {
        ayWriteReg(ref, a, v);
        ayWriteReg(got, a, v);
    }
    const ops = 5 + Math.floor(rnd() * 40);
    let label = '';
    let ok = true;
    for (let op = 0; op < ops && ok; op += 1) {
        const span = randomSpan(rnd);
        const target = ref.t + span;
        refRunSilent(ref, target);
        ayRunSilent(got, target);
        calls += 1;
        label = `seed ${seed} op ${op} span ${span}`;
        ok = check(label, ref, got);
        // Zero or more writes at this T-state (machine.js flushes through renderSound first, which is what we just did).
        const writes = Math.floor(rnd() * 4);
        for (let w = 0; w < writes; w += 1) {
            const [a, v] = randomWrite(rnd);
            ayWriteReg(ref, a, v);
            ayWriteReg(got, a, v);
        }
        if (rnd() < 0.01) {
            // A seek (audio switched on / rate change) re-phases the tick grid.
            const s = ref.t + Math.floor(rnd() * 50);
            aySeek(ref, s);
            aySeek(got, s);
        }
    }
}
console.log(`random histories: ${SEEDS} seeds, ${calls} ayRunSilent calls`);

// ---- 2. edge cases -----------------------------------------------------------------------------------------------------------------------
function scenario(name, setup, spans) {
    const [ref, got] = makePair(0);
    for (const [a, v] of setup) {
        ayWriteReg(ref, a, v);
        ayWriteReg(got, a, v);
    }
    let i = 0;
    for (const span of spans) {
        const target = ref.t + span;
        refRunSilent(ref, target);
        ayRunSilent(got, target);
        check(`${name} span#${i}`, ref, got);
        i += 1;
    }
}
const ENV_ON = [[7, 0x00], [8, 0x10], [9, 0x10], [10, 0x10]];
const longSpans = [1, 15, 16, 17, 1919, 1920, 1921, 1936, FRAME_T, 3 * FRAME_T + 7, 10 * FRAME_T, 0, 33];
for (let shape = 0; shape < 16; shape += 1) {
    for (const per of [0, 1, 2, 3, 255, 65535]) {
        scenario(`env shape ${shape} period ${per}`, [...ENV_ON, [11, per & 0xFF], [12, per >> 8], [13, shape]], longSpans);
    }
}
for (const tone of [0, 1, 2, 4095]) {
    for (const noise of [0, 1, 2, 31]) {
        scenario(`tone ${tone} noise ${noise}`, [[0, tone & 0xFF], [1, tone >> 8], [2, tone & 0xFF], [3, tone >> 8], [4, 7], [6, noise], [7, 0], [8, 15], [9, 9], [10, 0x10]], longSpans);
    }
}
// Every span from 0 to 300 ticks (+ a partial) after every start phase of a 16-T tick, so the jump boundary (ticks = tail + 1) and partial tails are hit.
for (let phase = 0; phase < 16; phase += 1) {
    for (let ticks = 0; ticks <= 300; ticks += 1) {
        const [ref, got] = makePair(0);
        for (const [a, v] of [[0, 3], [2, 5], [4, 0], [6, 1], [7, 0x30], [8, 0x10], [9, 12], [10, 0x1F], [11, 1], [13, 0x0E]]) {
            ayWriteReg(ref, a, v);
            ayWriteReg(got, a, v);
        }
        refRunSilent(ref, phase);
        ayRunSilent(got, phase);
        check(`phase ${phase}`, ref, got);
        const target = ref.t + ticks * TICK_T + (ticks % 7);
        refRunSilent(ref, target);
        ayRunSilent(got, target);
        check(`phase ${phase} ticks ${ticks}`, ref, got);
    }
}
// A counter loaded from a long period, then the period cut short: the counter runs down from its old value first.
scenario('period shortened', [[0, 0xFF], [1, 0x0F], [11, 0xFF], [12, 0xFF], [6, 31]], [5000]);
{
    const [ref, got] = makePair(0);
    for (const [a, v] of [[0, 0xFF], [1, 0x0F], [6, 31], [11, 0xFF], [12, 0xFF], [13, 0x0C], [7, 0], [8, 0x10]]) {
        ayWriteReg(ref, a, v);
        ayWriteReg(got, a, v);
    }
    for (const span of [200, 3000]) {
        refRunSilent(ref, ref.t + span);
        ayRunSilent(got, got.t + span);
        check('before cut', ref, got);
    }
    for (const [a, v] of [[0, 2], [1, 0], [6, 1], [11, 3], [12, 0]]) {
        ayWriteReg(ref, a, v);
        ayWriteReg(got, a, v);
    }
    for (const span of [5, 300, 4000, FRAME_T]) {
        refRunSilent(ref, ref.t + span);
        ayRunSilent(got, got.t + span);
        check('after cut', ref, got);
    }
}
// Very long spans: the noise register wraps its 131,071-step period many times; the envelope wraps thousands of ramps.
scenario('very long', [[6, 0], [7, 0], [8, 0x10], [9, 0x0F], [10, 0x10], [11, 0], [12, 0], [13, 0x0A], [0, 1], [2, 0], [4, 0xFF], [5, 0x0F]],
    [200 * FRAME_T, 1, 77 * FRAME_T + 5]);
// The tone level toggled an odd and an even number of times in one jump, for periods 1..40.
for (let p = 1; p <= 40; p += 1) {
    scenario(`tone period ${p}`, [[0, p], [2, p + 1], [4, 2 * p], [7, 0x38], [8, 15], [9, 15], [10, 15]], [2500, 2501, 2517, 31 * 16 * p]);
}
// The sound-on path is untouched: ayRunTo against the reference's collect path, areas included (bit-identical).
for (let seed = 1; seed <= 200; seed += 1) {
    const rnd = mulberry32(seed * 7919);
    const [ref, got] = makePair(0);
    for (let op = 0; op < 30; op += 1) {
        const target = ref.t + Math.floor(rnd() * 3000);
        refRunTo(ref, target);
        ayRunTo(got, target);
        const d = diffAy(ref, got);
        const exactFilter = [0, 1, 2].every((i) => Object.is(ref.filterOut[i], got.filterOut[i]));
        if (d === null && exactFilter) {
            passed += 1;
        } else {
            failed += 1;
            failures.push(`ayRunTo seed ${seed} op ${op}: ${d ?? 'filterOut not bit-identical'}`);
        }
        const [a, v] = randomWrite(rnd);
        ayWriteReg(ref, a, v);
        ayWriteReg(got, a, v);
    }
}

for (const f of failures) {
    console.log(`FAIL ${f}`);
}
console.log(`largest filterOut difference: ${maxFilterErr.toExponential(2)} (tolerance ${FILTER_TOL})`);
console.log(`${passed} passed, ${failed} failed`);

// ---- 3. timing ----------------------------------------------------------------------------------------------------------------------------
if (process.env.AY_BENCH !== '0') {
    const FRAMES = 1000;
    const typical = [[0, 0x1C], [1, 0x01], [2, 0xFE], [4, 0x50], [6, 8], [7, 0x38], [8, 0x10], [9, 12], [10, 0x09], [11, 0x40], [12, 0x02], [13, 0x0E]];
    const bench = (run) => {
        let best = Infinity;
        for (let rep = 0; rep < 5; rep += 1) {
            const ay = createAy(TICK_T, TAU_T);
            for (const [a, v] of typical) ayWriteReg(ay, a, v);
            const t0 = process.hrtime.bigint();
            for (let f = 1; f <= FRAMES; f += 1) {
                run(ay, f * FRAME_T);
            }
            const ms = Number(process.hrtime.bigint() - t0) / 1e6;
            best = Math.min(best, ms);
        }
        return best;
    };
    const oldMs = bench(refRunSilent);
    const newMs = bench(ayRunSilent);
    console.log(`timing, ${FRAMES} frames (tone on, envelope running), best of 5: per-tick ${oldMs.toFixed(1)} ms, closed form ${newMs.toFixed(1)} ms (${(oldMs / newMs).toFixed(0)}x)`);
}

process.exit(failed === 0 ? 0 : 1);
