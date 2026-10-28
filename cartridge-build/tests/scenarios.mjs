#!/usr/bin/env node
// scenarios.mjs — the cartridge's own behaviour on the stock ROMs (TSRun), beyond "runs like RUN"
// (tests/compare.mjs): the hand-off, restarts, errors, BREAK, INPUT, refused images, and that the
// paging never leaves the cartridge's own chunks.
//
//   node tests/scenarios.mjs

import {
  sym, cartridgeFor, stockMachine, runUntil, atPc, atKeyWait, frames, tap, type, setKeys,
  screenText, Z,
} from "./harness.mjs";

let failed = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " -- " + detail : ""}`);
  if (!ok) failed++;
}
const row = (m, r) => screenText(m)[r] ?? "";
const vmRuns = (m) => m.cpu.pc === sym.VM_RUN;

// Ports $F4/$FF written while the cartridge ran (logged from the hand-off on): only its own mappings, DOCK always.
function pagingOk(m) {
  const bad = m.outs.filter(([p, v]) =>
    (p === 0xF4 && ![0x43, 0x4B].includes(v)) || (p === 0xFF && (v & 0x80) !== 0));
  return { ok: bad.length === 0, detail: bad.slice(0, 3).map(([p, v, pc]) => `out $${p.toString(16)},$${v.toString(16)} at $${pc.toString(16)}`).join("; ") };
}

// 1. Hand-off, a normal end, a key, a restart from cold.
{
  const m = stockMachine(cartridgeFor('PRINT "ONE"\nPRINT 6 * 7\n'));
  let entry = null;
  runUntil(m, atPc(sym.CART_COLD_START), 300);
  entry = { iff1: m.cpu.iff1, f4: m.portF4 };
  m.outs = [];                                     // from here on the cartridge owns the paging
  check("stock ROM hands off to CART_COLD_START", m.cpu.pc === sym.CART_COLD_START,
    `interrupts ${entry.iff1 ? "on" : "off"}, $F4=$${entry.f4.toString(16)}`);
  check("program ends at a key wait", runUntil(m, atKeyWait, 300));
  const t = screenText(m);
  check("output", t[0] === "ONE" && t[1] === "42", JSON.stringify(t.slice(0, 2)));
  setKeys(m, " ", true);
  const restarted = runUntil(m, atPc(sym.CART_COLD_START), 50);
  setKeys(m, " ", false);
  check("a key restarts the cartridge from cold", restarted);
  check("and the program runs again", runUntil(m, atKeyWait, 300) && row(m, 1) === "42");
  const p = pagingOk(m);
  check("paging: only $43/$4B on $F4, DOCK on $FF", p.ok, p.detail);
}

// 2. A run-time error: the message on row 23, then a key restarts.
{
  const m = stockMachine(cartridgeFor("DIM a(3)\nPRINT 1\nPRINT a(10)\n"));
  runUntil(m, atKeyWait, 600);
  check("runtime error message", /ERROR|RANGE|SUBSCRIPT/.test(row(m, 23)) && row(m, 0) === "1", JSON.stringify(row(m, 23)));
  setKeys(m, " ", true);
  check("a key after an error restarts", runUntil(m, atPc(sym.CART_COLD_START), 50));
  setKeys(m, " ", false);
}

// 3. BREAK (CAPS SHIFT + SPACE) stops an endless loop.
{
  const m = stockMachine(cartridgeFor("n = 0\nagain:\nn = n + 1\nGOTO again\n"));
  runUntil(m, vmRuns, 300);
  frames(m, 50);
  setKeys(m, "\x01 ", true);
  const stopped = runUntil(m, atKeyWait, 100);
  setKeys(m, "\x01 ", false);
  check("BREAK stops the program", stopped && row(m, 23).includes("BREAK"), JSON.stringify(row(m, 23)));
}

// 4. INPUT reads the keyboard.
{
  const m = stockMachine(cartridgeFor('INPUT n\nPRINT "X"; n * 2\n'));
  runUntil(m, vmRuns, 300);
  frames(m, 20);
  type(m, "21\n");
  runUntil(m, atKeyWait, 100);
  check("INPUT", screenText(m).some((r) => r.includes("X42")), JSON.stringify(screenText(m).slice(0, 3)));
}

// 5. Sound: BEEP runs to the end (AY on the stock machine's ports).
{
  const m = stockMachine(cartridgeFor('BEEP 0.1, 0\nPRINT "DONE"\n'));
  check("BEEP", runUntil(m, atKeyWait, 600) && row(m, 0) === "DONE", JSON.stringify(row(m, 0)));
}

// 6. Refused images: another ROM build's identity, and no program chunk at all.
{
  const m = stockMachine(cartridgeFor('PRINT "NO"\n', { identity: 0x1234 }));
  runUntil(m, atKeyWait, 400);
  check("wrong identity: NO PROGRAM", row(m, 23).startsWith("NO PROGRAM") && row(m, 0) === "", JSON.stringify(row(m, 23)));
  const dck = cartridgeFor('PRINT "NO"\n');
  const blank = Uint8Array.from(dck);
  blank[1 + 3] = 0;                                  // chunk 3 absent: reads $FF
  const noChunk = new Uint8Array(blank.length - 8192);
  noChunk.set(blank.subarray(0, 9 + 2 * 8192));
  noChunk.set(blank.subarray(9 + 3 * 8192), 9 + 2 * 8192);
  const m2 = stockMachine(noChunk);
  runUntil(m2, atKeyWait, 400);
  check("no program chunk: NO PROGRAM", row(m2, 23).startsWith("NO PROGRAM"), JSON.stringify(row(m2, 23)));
}

// 7. An interrupt at the hand-off, before CART_COLD_START's `di`, runs Leap's ISR harmlessly.
{
  const m = stockMachine(cartridgeFor('PRINT "SAFE"\n'));
  runUntil(m, atPc(sym.CART_COLD_START), 300);
  const taken = Z.irqZ80(m.cpu, m.bus) > 0;           // as if INT were active at this instruction
  const back = runUntil(m, atPc(sym.CART_COLD_START), 5);
  check("interrupt at the hand-off is taken and returns to the entry", taken && back);
  check("and the program then runs", runUntil(m, atKeyWait, 300) && row(m, 0) === "SAFE", JSON.stringify(row(m, 0)));
}

console.log(failed ? `\n${failed} failed` : "\nall scenarios pass");
process.exit(failed ? 1 : 0);
