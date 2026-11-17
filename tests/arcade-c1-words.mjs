#!/usr/bin/env node
"use strict";
// arcade-c1-words.mjs -- Studio completion stage 6, item C1 (docs/ARCADE_STUDIO_COMPLETION_CONTRACT.md section 4): the words the compiler used to refuse.
//
//   node tests/arcade-c1-words.mjs          (ARCADE_QUICK=1 shortens nothing: every program runs 60 to 90 ticks on the real v2 runtime, about a minute in all)
//
// IMPLEMENTED (compiler for the Z80 AND the reference interpreter, equal tick by tick on the real runtime): END, PRINT TAB, FLASH, PEEK, POKE
// REMOVED from the table and Help but still reserved, each with its own message ("X is not part of Leap Arcade: <reason>"): LEN USR OUT IN PLOT POINT
//
//   1  the word table: what is in it, what is reserved, the messages, no variable can take a removed word's name
//   2  the checker: PEEK / POKE warnings by address range (constants, CONSTs, none for a run-time address), the TAB range, END in a WIRE3D game, nothing for END / FLASH
//   3  the parser: TAB after AT, TAB alone, a second TAB is refused
//   4  differential, v2: interpreter against the Z80 on the cells, the attributes, the cursor, the text attribute and every variable, tick by tick
//      END (top level, nested PROCs with parameters, inside FOR / WHILE, in INIT, in a game with ENTER and one with TIMER / KEYPRESS, with a sound playing), TAB, FLASH (and ENTER clears it,
//      CLS drops it), PEEK / POKE (an address wrap, a negative address, a value above 255, a value that is an expression, the cartridge's read-only ranges, an array element)
//   5  END on the machine: ticks and refreshes go on, nothing is drawn again (both display files equal and unchanged), the keys and the joystick are ignored, an effect already playing goes on
//      (the AY registers keep changing). That a game without the new words compiles to the same bytes is NOT checked here: the hash baselines (arcade-m5 section 8, arcade-m6 / m8 / m19 compilers) and
//      `node arcade/tools/regen-baselines.mjs --dry-run` are the guard
//   5b the same words on the v3 (WINDOW) and v4 (VIEW3D) runtimes: variables, arrays, text attribute and cursor equal the interpreter's over 30 ticks (their compositors write the cell map, so cells are not compared)
//   6  negative controls: the comparison sees a wrong TAB column, a wrong FLASH bit, a wrong POKE value, an END one tick late
import { parse } from '../src/lang/arcade/arcade-parse.js';
import { check } from '../src/lang/arcade/arcade-check.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile } from '../src/lang/arcade/arcade-compile.js';
import { ARCADE_WORDS, RESERVED, FUNCTIONS, REMOVED_WORDS, removedWordMessage } from '../src/lang/arcade/arcade-words.js';
import { real, compileReal, runReal, interpFor, diffRecords, differential, errText } from './arcade-m5-harness.mjs';
import { ASSETS } from './arcade-m9-common.mjs';

let passed = 0, failed = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  (' + detail + ')'}`); ok ? passed++ : failed++; return ok; };
const info = (s) => console.log('  INFO  ' + s);
const R = real();
if (!R.ok) { console.log(`SKIP: ${R.why}`); process.exit(0); }

/** A one-scene game: `decl` extra DIM items, `top` extra top-level lines, `init` / `frame` the bodies (4 spaces in), `procs` more PROCs. */
const GAME = ({ top = '', decl = '', init = '', frame = '', procs = '' } = {}) => `GAME "c1"
FRAMERATE 30
${top}SCENE main
  DIM t, a, b, c${decl}
${procs}  PROC INIT():
${init}
  ENDP
  PROC FRAME():
${frame}
  ENDP
ENDSCENE
`;
const diag = (src, version = 2) => {
  const p = parse(src);
  return { parse: p.errors, check: check(p.ast, { version }) };
};
const msgs = (r) => [...r.parse, ...r.check].map((d) => `${d.severity}: ${d.message}`);

// ── 1. the word table ────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('1. the word table');
{
  const KEEP = ['END', 'TAB', 'FLASH', 'PEEK', 'POKE'], GONE = ['LEN', 'USR', 'OUT', 'IN', 'PLOT', 'POINT'];
  check_('END TAB FLASH PEEK POKE are in the table (statements, TAB a part of PRINT, PEEK a function)', KEEP.every((w) => ARCADE_WORDS.has(w)) && FUNCTIONS.has('PEEK') && !FUNCTIONS.has('POKE'));
  check_('LEN USR OUT IN PLOT POINT are not in the table (no Help entry, no completion)', GONE.every((w) => !ARCADE_WORDS.has(w) && !FUNCTIONS.has(w)));
  check_('they are still RESERVED (the tokenizer reads them as keywords: none can be a variable)', GONE.every((w) => RESERVED.has(w)));
  check_('REMOVED_WORDS is exactly those six', [...REMOVED_WORDS.keys()].sort().join(' ') === [...GONE].sort().join(' '));
  for (const w of GONE) {
    const m = removedWordMessage(w);
    check_(`${w}: "${w} is not part of Leap Arcade: <one sentence>"`, m?.startsWith(`${w} is not part of Leap Arcade: `) && m.length > `${w} is not part of Leap Arcade: `.length + 15 && !m.includes('\n'), m);
  }
  check_('removedWordMessage keeps the case the user wrote and is null for other words', removedWordMessage('len')?.startsWith('len is not part') && removedWordMessage('PRINT') === null);
  for (const [w, usage] of [['LEN', 'a = LEN("x")'], ['USR', 'a = USR(5)'], ['IN', 'a = IN(254)'], ['POINT', 'a = POINT(1, 2)'], ['PLOT', 'PLOT 1, 2'], ['OUT', 'OUT 254, 1']]) {
    const r = diag(GAME({ frame: `    ${usage}` }));
    check_(`using ${w} says it is not part of Leap Arcade`, r.parse.some((d) => d.message.startsWith(`${w} is not part of Leap Arcade: `)), msgs(r).join(' | '));
    const lower = diag(GAME({ frame: `    ${usage.replace(w, w.toLowerCase())}` }));
    check_(`  ... in lower case too, with the case kept in the message`, lower.parse.some((d) => d.message.startsWith(`${w.toLowerCase()} is not part of Leap Arcade: `)), msgs(lower).join(' | '));
    const asVar = diag(GAME({ decl: `, ${w.toLowerCase()}`, frame: `    ${w.toLowerCase()} = 1` }));
    check_(`  ... and ${w} cannot be a variable name (declared or assigned)`, asVar.parse.some((d) => /reserved word/.test(d.message)) || asVar.check.some((d) => d.severity === 'error'), msgs(asVar).join(' | '));
  }
}

// ── 2. the checker ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('2. the checker: PEEK / POKE warnings, TAB range, END');
{
  const w = (frame, top = '') => { const r = diag(GAME({ frame, top })); return { errors: r.parse.concat(r.check).filter((d) => d.severity === 'error').map((d) => d.message), warnings: r.check.filter((d) => d.severity === 'warning' && !/never used/.test(d.message)).map((d) => d.message) }; };
  const addrs = [[0, 'the runtime in the cartridge', true], [0x3FFF, 'the runtime in the cartridge', true], [0x4000, 'display files', false], [0x7FFF, 'display files', false], [0x8000, 'the game and its data', true], [0xBFFF, 'the game and its data', true], [0xC000, 'the runtime\'s RAM', false], [0xE100, 'the runtime\'s RAM', false], [0xFFFF, 'the runtime\'s RAM', false]];
  for (const [a, what, fixed] of addrs) {
    const p = w(`    POKE ${a}, 1`), q = w(`    a = PEEK(${a})`);
    check_(`POKE ${a}: a warning, no error, names ${what}${fixed ? ' (the write is lost)' : ' (corrupts the game)'}`,
      p.errors.length === 0 && p.warnings.length === 1 && p.warnings[0].includes(what) && p.warnings[0].includes(`$${a.toString(16).toUpperCase().padStart(4, '0')}`) && (fixed ? /write is lost/.test(p.warnings[0]) : /corrupts/.test(p.warnings[0])), p.warnings.concat(p.errors).join(' | '));
    check_(`PEEK(${a}): a warning, no error, says the interpreter reads 0`, q.errors.length === 0 && q.warnings.length === 1 && q.warnings[0].includes(what) && /interpreter/.test(q.warnings[0]), q.warnings.concat(q.errors).join(' | '));
  }
  check_('a run-time address gets no warning', w('    POKE a, 1\n    b = PEEK(a + 3)').warnings.length === 0);
  check_('a CONST address is looked through', w('    POKE BASEADDR, 1\n    a = PEEK(BASEADDR + 2)', 'CONST BASEADDR = 24576\n').warnings.length === 2, w('    POKE BASEADDR, 1', 'CONST BASEADDR = 24576\n').warnings.join(' | '));
  check_('a negative constant address wraps (-1 is $FFFF)', /\$FFFF/.test(w('    POKE -1, 1').warnings[0] ?? ''));
  check_('PEEK and POKE of a plain variable address are errors nowhere', w('    POKE a, b\n    c = PEEK(b)').errors.length === 0);
  check_('PEEK with a string, POKE with a string value: errors', w('    a = PEEK("x")').errors.some((m) => /must be a number/.test(m)) && w('    POKE 1, "x"').errors.some((m) => /must be a number/.test(m)));
  check_('PEEK with two arguments: an error', w('    a = PEEK(1, 2)').errors.some((m) => /PEEK takes 1 argument/.test(m)));
  check_('TAB 0..31 is fine, TAB 32 and TAB -1 are errors (as AT)', w('    PRINT TAB 0; "a"\n    PRINT TAB 31; "a"').errors.length === 0 && /TAB column is 32/.test(w('    PRINT TAB 32; "a"').errors.join('|')) && /TAB column is -1/.test(w('    PRINT TAB -1; "a"').errors.join('|')));
  check_('TAB with a string is an error', w('    PRINT TAB "a"; "b"').errors.some((m) => /must be a number/.test(m)));
  check_('FLASH 0 and 1 are fine, FLASH 2 an error', w('    FLASH 0\n    FLASH 1').errors.length === 0 && /FLASH \(0..1\) is 2/.test(w('    FLASH 2').errors.join('|')));
  check_('END is fine and the statement after it is "unreachable"', w('    END').errors.length === 0 && w('    END').warnings.length === 0 && w('    END\n    a = 1').warnings.some((m) => /unreachable/.test(m)));
  const wire = diag(`GAME "w"\nFRAMERATE 30\nWIRE3D ROWS 2 TO 21 INK 7 PAPER 0 BRIGHT 0\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    END\n  ENDP\nENDSCENE\n`);
  check_('END in a WIRE3D game warns that the play area stays blank', wire.check.some((d) => d.severity === 'warning' && /WIRE3D game: the runtime clears the play area/.test(d.message)), msgs(wire).join(' | '));
}

// ── 3. the parser ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('3. the parser');
{
  const st = (s) => parse(GAME({ frame: `    ${s}` })).ast.scenes[0].procs.find((p) => /FRAME/i.test(p.name)).body[0];
  const n1 = st('PRINT TAB 7; "x"'), n2 = st('PRINT AT 3, 4; TAB 9; "x"'), n3 = st('PRINT TAB 5;'), n4 = st('POKE 1, 2'), n5 = st('END'), n6 = st('FLASH 1');
  check_('PRINT TAB col; item: tab is the column expression, no AT', n1.tab?.value === 7 && n1.at === null && n1.items.length === 1);
  check_('PRINT AT r, c; TAB c2; item: both are kept', n2.at?.row.value === 3 && n2.tab?.value === 9);
  check_('PRINT TAB col;  with no items only positions the cursor (trailing ;)', n3.tab?.value === 5 && n3.trailing === ';');
  check_('POKE a, v, END, FLASH n parse to Poke, End, Color(FLASH)', n4.type === 'Poke' && n5.type === 'End' && n6.type === 'Color' && n6.which === 'FLASH');
  check_('TAB is not a statement and not twice in a PRINT', diag(GAME({ frame: '    TAB 4' })).parse.some((d) => /not a statement/.test(d.message)) && diag(GAME({ frame: '    PRINT TAB 1; TAB 2; "x"' })).parse.length > 0);
}

// ── 4. differential on the real v2 runtime ────────────────────────────────────────────────────────────────────────────────────────
console.log('4. interpreter against the Z80 (real v2 runtime), tick by tick');
const diff = (name, src, { ticks = 60, assets = {}, keys = null, stick = null, expect = null } = {}) => {
  const r = differential(src, assets, { ticks, keys, stick });
  let ok = r.ok;
  let detail = r.detail;
  if (ok && expect) { const bad = expect(r); if (bad) { ok = false; detail = bad; } }
  check_(`${name} (${ticks} ticks)`, ok, detail);
  return r;
};
const last = (r) => r.want.ticks[r.want.ticks.length - 1];
const cellsText = (rec, row) => Array.from({ length: 32 }, (_, c) => String.fromCharCode(rec.cells[row * 32 + c])).join('');
const noError = (r) => (r.res.errors.length === 0 ? null : errText(r.res));

{
  // END
  const r1 = diff('END in FRAME stops the counter at 5 and keeps the screen', GAME({ init: '    PRINT AT 0, 0; "GO"', frame: '    t = t + 1\n    PRINT AT 2, 0; t\n    IF t = 5 THEN\n      END\n    ENDIF\n    PRINT AT 3, 0; t' }), {
    expect: (r) => (last(r).vars.T === 5 && cellsText(last(r), 3).trim() === '4' && cellsText(last(r), 2).startsWith('5') && r.want.ticks[3].vars.T === 4 ? null : `T = ${last(r).vars.T}, row 3 ${JSON.stringify(cellsText(last(r), 3))}`),
  });
  void r1;
  diff('END in a PROC called with parameters, from inside a FOR inside a WHILE', GAME({
    procs: '  PROC deep(n, m):\n    LOCAL i\n    FOR i = 1 TO 3\n      c = c + n * i\n      IF c > 60 THEN\n        PRINT AT 5, 5; "END"; c\n        END\n      ENDIF\n    NEXT i\n    PRINT AT 6, 6; "back"; m\n  ENDP\n  PROC mid(k):\n    CALL deep(k, k + 1)\n    b = b + 1\n  ENDP\n',
    frame: '    t = t + 1\n    WHILE a < 3\n      a = a + 1\n      CALL mid(t)\n    WEND\n    a = 0',
  }), { expect: (r) => (last(r).vars.C > 60 && last(r).vars.T >= 2 && r.want.ticks.at(-2).vars.T === last(r).vars.T ? null : `C = ${last(r).vars.C} T = ${last(r).vars.T}`) });
  diff('END in INIT: FRAME never runs, the screen is what INIT drew', GAME({ init: '    PRINT AT 4, 4; "INIT"\n    a = 7\n    END\n    a = 9', frame: '    t = t + 1\n    PRINT AT 0, 0; "FRAME"' }), {
    expect: (r) => (last(r).vars.A === 7 && last(r).vars.T === 0 ? null : `A = ${last(r).vars.A}, T = ${last(r).vars.T}`),
  });
  diff('END as the last statement of FRAME, and FRAME of the next tick does not run', GAME({ frame: '    t = t + 1\n    IF t = 3 THEN\n      PRINT AT 1, 1; "bye"\n      END\n    ENDIF', top: '' }), { expect: (r) => (last(r).vars.T === 3 ? null : `T = ${last(r).vars.T}`) });
  diff('END with TIMER and KEYPRESS in the prologue: the timers stop counting, the edges stop', `GAME "c1"
FRAMERATE 30
SCENE main
  DIM t, key, fire
  TIMER cd, cd2
  PROC INIT():
    cd = 40 : cd2 = 25
  ENDP
  PROC FRAME():
    t = t + 1
    IF KEYPRESS("A") THEN key = key + 1 ENDIF
    IF BIT(JOYPRESS(1), 4) THEN fire = fire + 1 ENDIF
    IF cd = 20 THEN
      PRINT AT 3, 3; "STOP"; cd; " "; cd2
      END
    ENDIF
  ENDP
ENDSCENE
`, { ticks: 70, keys: (t) => (t % 7 < 3 ? [65] : []), stick: (t) => (t % 5 < 2 ? 16 : 0), expect: (r) => (last(r).vars.CD === 20 && last(r).vars.T === 20 && last(r).vars.KEY > 0 && last(r).vars.FIRE > 0 ? null : JSON.stringify(last(r).vars)) });
  diff('END in a game with scenes and ENTER (the scene driver): END in the second scene after a switch', `GAME "c1"
FRAMERATE 30
SCENE first
  DIM n
  PROC INIT():
    PRINT AT 0, 0; "ONE"
  ENDP
  PROC FRAME():
    n = n + 1
    IF n = 4 THEN ENTER second ENDIF
  ENDP
ENDSCENE
SCENE second
  DIM m
  PROC INIT():
    PRINT AT 1, 1; "TWO"
    FLASH 1
  ENDP
  PROC FRAME():
    m = m + 1
    PRINT AT 5, 5; m
    IF m = 6 THEN
      PRINT AT 7, 7; "DONE"
      END
    ENDIF
  ENDP
ENDSCENE
`, { ticks: 70, expect: (r) => (last(r).scene === 1 && last(r).vars['SECOND.M'] === 6 ? null : JSON.stringify([last(r).scene, last(r).vars])) });
  diff('END in a game with ENTER in INIT (ENTER cuts the stack, END uses the same saved pointer)', `GAME "c1"
FRAMERATE 60
SCENE a
  PROC INIT():
    ENTER b
  ENDP
  PROC FRAME():
    PRINT AT 0, 0; "A"
  ENDP
ENDSCENE
SCENE b
  DIM k
  PROC INIT():
    k = 1
  ENDP
  PROC FRAME():
    k = k + 1
    IF k = 10 THEN END ENDIF
  ENDP
ENDSCENE
`, { ticks: 60, expect: (r) => (last(r).vars['B.K'] === 10 ? null : JSON.stringify(last(r).vars)) });
  diff('END in the INIT of a scene entered by ENTER (the stack is cut back, then END cuts it back again and returns to the runtime)', `GAME "c1"
FRAMERATE 30
SCENE a
  DIM n
  PROC INIT():
  ENDP
  PROC FRAME():
    n = n + 1
    PRINT AT 0, 0; n
    IF n = 3 THEN ENTER b ENDIF
  ENDP
ENDSCENE
SCENE b
  DIM k
  PROC INIT():
    PRINT AT 5, 5; "B INIT"
    k = 5
    END
  ENDP
  PROC FRAME():
    k = k + 1
  ENDP
ENDSCENE
`, { ticks: 60, expect: (r) => (last(r).scene === 1 && last(r).vars['B.K'] === 5 && last(r).vars['A.N'] === 3 ? null : JSON.stringify([last(r).scene, last(r).vars])) });
  diff('END with an effect playing: the sound goes on (interpreter and machine agree)', GAME({ top: 'SFX long = "long"\n', init: '    PLAY long', frame: '    t = t + 1\n    IF t = 6 THEN END ENDIF' }), { assets: ASSETS, ticks: 60 });

  // TAB
  diff('PRINT TAB: the column with the row kept, after AT, beyond the screen, with a run-time column', GAME({
    frame: '    t = t + 1\n    PRINT AT 2, 0; "ab"\n    PRINT TAB 10; "cd"\n    PRINT TAB t MOD 40; "x"\n    PRINT AT 8, 5; TAB 20; t\n    PRINT AT 9, 9; TAB a - 3; "n"\n    PRINT TAB 31; "ww"\n    a = t * 7 - 40\n    PRINT AT 12, 1; TAB a; "end";\n    PRINT TAB 4; "q"',
  }), { ticks: 70 });
  diff('PRINT TAB with no items, with a comma, with USING', GAME({ frame: '    t = t + 1\n    PRINT AT 3, 2; "ab";\n    PRINT TAB 12;\n    PRINT "cd"\n    PRINT AT 6, 0; TAB 4, "x", t\n    PRINT TAB 2; t USING "000"' }), { ticks: 60 });
  {
    const r = differential(GAME({ frame: '    PRINT AT 4, 0; "ab"\n    PRINT TAB 10; "cd"' }), {}, { ticks: 4 });
    check_('PRINT TAB 10 puts "cd" at column 10 of the row the cursor was on (row 5 after the first PRINT)', r.ok && r.got.ticks[3].cells[5 * 32 + 10] === 99 && r.got.ticks[3].cells[5 * 32 + 11] === 100, r.detail);
  }

  // FLASH
  diff('FLASH 0 / 1 / a run-time value, text printed, CLS drops it from the cleared cells, FILLC takes it', GAME({
    top: '', decl: ', ts', frame: '    t = t + 1\n    FLASH 1\n    PRINT AT 1, 1; "F"\n    FLASH t\n    PRINT AT 2, 1; "G"; t\n    INK 3\n    BRIGHT 1\n    FLASH 3 - t MOD 4\n    PRINT AT 3, 1; "H"\n    FILLC 10, 10, 3, 2 = 65\n    FLASH 0\n    PRINT AT 4, 1; "N"\n    IF t MOD 20 = 0 THEN\n      FLASH 1\n      CLS\n      PRINT AT 0, 0; "CLS"\n    ENDIF',
  }), { ticks: 90 });
  diff('ENTER puts FLASH back to 0 (and the text colours), the first scene starts at 0', `GAME "c1"
FRAMERATE 30
SCENE a
  DIM t
  PROC INIT():
    PRINT AT 0, 0; "a0"
  ENDP
  PROC FRAME():
    t = t + 1
    FLASH 1
    INK 2
    PRINT AT 1, 0; "a"; t
    IF t = 5 THEN ENTER b ENDIF
  ENDP
ENDSCENE
SCENE b
  DIM u
  PROC INIT():
    PRINT AT 2, 0; "b0"
  ENDP
  PROC FRAME():
    u = u + 1
    PRINT AT 3, 0; "b"; u
    IF u = 3 THEN
      FLASH 1
      PRINT AT 4, 0; "f"
      ENTER a
    ENDIF
  ENDP
ENDSCENE
`, { ticks: 60, expect: (r) => {
    const tick = (k) => r.got.ticks[k - 1].textAttr;          // a: FLASH 1 + INK 2 = $BA in ticks 1-4; ENTER b in tick 5 resets to $38; b's FLASH 1 at its tick 3 (tick 8) is gone after ENTER a
    return tick(1) === 0xBA && tick(4) === 0xBA && tick(5) === 0x38 && tick(7) === 0x38 && tick(8) === 0x38 && tick(9) === 0xBA ? null : `text attribute by tick: ${r.got.ticks.slice(0, 10).map((x) => x.textAttr.toString(16))}`;
  } });

  // PEEK / POKE
  diff('POKE and PEEK: a byte, an address that wraps ($EA00 as -5632 and as 59904), values 256, 300, -1, an expression value, POKE through a variable', GAME({
    decl: ', m(3)', frame: '    t = t + 1\n    POKE 60000, t\n    a = PEEK(60000)\n    POKE 60000 + t, t * 300\n    b = PEEK(60000 + t)\n    c = PEEK(-5536)\n    POKE -5536 + 8, 513\n    m(0) = PEEK(-5528)\n    POKE 60100, -1\n    m(1) = PEEK(60100)\n    POKE 60101, 256\n    m(2) = PEEK(60101) + 1000\n    POKE a + 59000, c\n    m(3) = PEEK(a + 59000)\n    PRINT AT 0, 0; a; " "; b; " "; c; " "; m(0)',
  }), { ticks: 70 });
  diff('POKE and PEEK wrap past 65535 (65535 + k) and read a byte POKEd as 16 bits', GAME({
    decl: ', n', frame: '    t = t + 1\n    n = 64000 + t\n    POKE n * 1 - 40000 + 40000, t\n    a = PEEK(64000 + t)\n    POKE 65535, 7\n    b = PEEK(65535) + PEEK(65535 + 1 - 1)\n    c = PEEK(-1)\n    POKE -1 - 1, 99\n    n = PEEK(65534)',
  }), { ticks: 64 });
  diff('POKE into the two read-only ranges is lost (the interpreter ignores it too); PEEK of a cell no one wrote reads 0', GAME({
    decl: ', ro', frame: '    t = t + 1\n    POKE 100, 77\n    POKE 33000, 55\n    POKE 49151, 1\n    POKE 49136, 55\n    b = PEEK(49136)\n    ro = ro + 1\n    a = PEEK(60500)\n    POKE 60500, a + t',
  }), { ticks: 64 });
  diff('PEEK in a condition and a loop; POKE of a table at run time, summed back', GAME({
    decl: ', s', frame: '    t = t + 1\n    FOR a = 0 TO 9\n      POKE 60200 + a, a * t\n    NEXT a\n    s = 0\n    FOR a = 0 TO 9\n      s = s + PEEK(60200 + a)\n    NEXT a\n    IF PEEK(60203) = 3 * t MOD 256 THEN b = b + 1 ENDIF',
  }), { ticks: 60 });
  diff('PEEK / POKE as DEF FN bodies and arguments of a PROC (the value is evaluated in order: address, then value)', GAME({
    top: '', decl: ', q', frame: '    t = t + 1\n    POKE 61000 + RND(8), RND(250)\n    c = FN pk(5) + PEEK(61000)\n    CALL st(61010, t)',
    procs: '  DEF FN pk(x) = PEEK(61000 + x) + x\n  PROC st(p, v):\n    POKE p, v\n    q = PEEK(p)\n  ENDP\n',
  }), { ticks: 64 });
}

// ── 5. END on the machine ─────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('5. END on the machine');
{
  const SYM = R.SYM;
  const src = GAME({ top: 'SFX long = "long"\n', decl: ', hold', init: '    PLAY long\n    PRINT AT 0, 0; "start"', frame: '    t = t + 1\n    PRINT AT 2, 2; t\n    IF KEYDOWN("A") THEN hold = hold + 1 ENDIF\n    IF t = 8 THEN\n      PRINT AT 4, 4; "last"\n      END\n    ENDIF' });
  const res = compileReal(src, ASSETS);
  // keys: nothing held before tick 12, then A held and the joystick pushed for the rest
  const got = runReal(res, { ticks: 40, keys: (k) => (k > 12 ? [65] : []), stick: (k) => (k > 12 ? 31 : 0), measure: false });
  check_('the run completed 40 ticks without a machine error', !got.error, got.error ?? '');
  const m = got.machine, ram = (a) => m.ram[a], word = (a) => m.ram[a] | (m.ram[a + 1] << 8);
  check_('the counter stopped at 8, A was never counted (END came first), "last" is on the screen', got.ticks[39].vars.T === 8 && got.ticks[39].vars.HOLD === 0 && Array.from(got.ticks[39].cells.slice(4 * 32 + 4, 4 * 32 + 8)).map((c) => String.fromCharCode(c)).join('') === 'last');
  check_('the ticks keep counting (V_TICKS = 40: the runtime still runs its tick loop) and no tick after the 8th changed a cell, an attribute, a variable or the cursor',
    word(SYM.V_TICKS) === 40 && got.ticks.slice(8).every((s, i) => s.cells.every((c, j) => c === got.ticks[8].cells[j]) && s.attrs.every((c, j) => c === got.ticks[8].attrs[j]) && JSON.stringify(s.vars) === JSON.stringify(got.ticks[8].vars) && s.cursor.row === got.ticks[8].cursor.row && s.cursor.col === got.ticks[8].cursor.col), `V_TICKS ${word(SYM.V_TICKS)}`);
  const frames0 = word(SYM.V_FRAMES);
  const shot = () => ({ f0: Array.from(m.ram.slice(0x4000, 0x5B00)), f1: Array.from(m.ram.slice(0x6000, 0x7B00)) });
  const MM = await import('../tsrun/machine.js');
  for (let f = 0; f < 8; f++) MM.runFrame(m);                // let the last tick's picture reach both display files, then look at them
  const s1 = shot();
  for (let f = 0; f < 40; f++) MM.runFrame(m);
  const s2 = shot();
  check_('the refresh interrupt goes on (V_FRAMES counts) and the two display files are equal and do not change any more', word(SYM.V_FRAMES) > frames0 + 40 && s1.f0.every((b, i) => b === s1.f1[i]) && s1.f0.every((b, i) => b === s2.f0[i]) && s1.f1.every((b, i) => b === s2.f1[i]), `${s1.f0.filter((b, i) => b !== s1.f1[i]).length} bytes differ between the files, ${s1.f0.filter((b, i) => b !== s2.f0[i]).length} change`);
  check_('what END left is a complete picture: the text "start", the counter and "last" are drawn in the file on screen', (() => {
    const lit = (row, col) => { let n = 0; for (let y = 0; y < 8; y++) n += s2.f0[((row >> 3) << 11) + ((row & 7) << 5) + y * 256 + col] ? 1 : 0; return n > 0; };
    return lit(0, 0) && lit(2, 2) && lit(4, 4) && lit(4, 7);
  })());
  check_('the AY registers go on changing while the long effect plays (the interrupt keeps running)', (() => {
    const a = Array.from({ length: 11 }, (_, k) => m.ay.regs[k]).join(',');
    for (let f = 0; f < 6; f++) MM.runFrame(m);
    return Array.from({ length: 11 }, (_, k) => m.ay.regs[k]).join(',') !== a;
  })());
  void ram;
}

// ── 5b. v3 and v4 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('5b. END, TAB, FLASH, PEEK and POKE on the v3 and v4 runtimes');
for (const v of [3, 4]) {
  const RV = real(v);
  if (!RV.ok) { console.log(`  SKIP  v${v}: ${RV.why || 'no runtime build'}`); continue; }
  const head = v === 3 ? 'TILESET ts = "ts"\nMAP level = "lv"\nWINDOW level\n' : 'TILESET ts = "ts"\nMAP plan = "maze"\nVIEW3D plan COLW 4\n';
  const src = `GAME "c1v${v}"\nFRAMERATE 20\n${head}SCENE one\n  DIM t, a, b, m(3)\n  PROC INIT():\n    FLASH 1\n    PRINT AT 3, 3; "hi"\n  ENDP\n  PROC FRAME():\n    t = t + 1\n    PRINT AT 5, 2; "ab"\n    PRINT TAB 9; "cd"\n    FLASH t MOD 2\n    POKE 60000, t\n    POKE 60001 + t, t * 300\n    a = PEEK(60000)\n    b = PEEK(60001 + t)\n    m(1) = PEEK(60000) + PEEK(-5535)\n    IF t = 12 THEN END ENDIF\n  ENDP\nENDSCENE\n`;
  let res, got, want, bad = null;
  try {
    res = compileReal(src, ASSETS, { R: RV });
    got = runReal(res, { ticks: 30, R: RV });
    if (got.error) bad = got.error;
    else {
      want = interpret(parse(src).ast, { version: v, ticks: 30, assets: ASSETS, maxSteps: 1e9, border0: RV.rt.constants?.BORDER_COLOUR ?? 1 });
      for (let i = 0; i < 30 && !bad; i++) {
        const g = got.ticks[i], w = want.ticks[i];
        for (const k of Object.keys(w.vars)) if (g.vars[k] !== w.vars[k]) bad = `tick ${i + 1}: ${k} = ${g.vars[k]}, interpreter ${w.vars[k]}`;
        if (!bad && g.textAttr !== w.textAttr) bad = `tick ${i + 1}: text attribute ${g.textAttr}, interpreter ${w.textAttr}`;
        if (!bad && (g.cursor.row !== w.cursor.row || g.cursor.col !== w.cursor.col)) bad = `tick ${i + 1}: cursor`;
        if (!bad && JSON.stringify(g.arrays) !== JSON.stringify(w.arrays)) bad = `tick ${i + 1}: arrays ${JSON.stringify(g.arrays)} / ${JSON.stringify(w.arrays)}`;
      }
    }
  } catch (e) { bad = e.message; }
  check_(`v${v}: every variable, the array, the text attribute and the cursor equal the interpreter's for 30 ticks; END stopped the counter at 12`, bad === null && got.ticks[29].vars.T === 12, bad ?? `T = ${got?.ticks?.[29]?.vars?.T}`);
}

// ── 6. negative controls ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('6. negative controls: the differential sees a wrong result');
{
  const src = GAME({ frame: '    t = t + 1\n    PRINT AT 2, 0; "ab"\n    PRINT TAB 10; "cd"\n    FLASH t MOD 2\n    PRINT AT 6, 0; "f"\n    POKE 60000, t\n    a = PEEK(60000)\n    IF t = 9 THEN END ENDIF' });
  const res = compileReal(src, {});
  const got = runReal(res, { ticks: 30 });
  const want = interpFor(src, {}, got)(30);
  check_('the real run equals the interpreter (the baseline for the controls)', diffRecords(got.ticks, want, {}) === null);
  const asArr = (x) => (x && x.constructor === Uint8Array ? Array.from(x) : x);
  const copy = (w) => ({ ...w, ticks: w.ticks.map((t) => ({ ...t, cells: Uint8Array.from(asArr(t.cells)), attrs: Uint8Array.from(asArr(t.attrs)), vars: { ...t.vars }, cursor: { ...t.cursor } })) });
  { const w = copy(want); w.ticks[4].cells[3 * 32 + 11] = 0x20; check_('a wrong TAB column (a cell off) is seen', diffRecords(got.ticks, w, {}) !== null); }
  { const w = copy(want); w.ticks[4].attrs[6 * 32] ^= 0x80; check_('a wrong FLASH bit in an attribute is seen', diffRecords(got.ticks, w, {}) !== null); }
  { const w = copy(want); w.ticks[4].vars.A = (w.ticks[4].vars.A + 1) & 255; check_('a wrong PEEK value is seen', diffRecords(got.ticks, w, {}) !== null); }
  { const w = copy(want); w.ticks[12].vars.T = 10; check_('an END one tick late (the counter goes on) is seen', diffRecords(got.ticks, w, {}) !== null); }
  { const w = copy(want); w.ticks[2].cursor.col += 1; check_('a wrong cursor column after TAB is seen', diffRecords(got.ticks, w, {}) !== null); }
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: arcade-c1-words (${passed} passed, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
