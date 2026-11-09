/**
 * tests/arcade-parse.mjs — Leap Arcade v0 front end: tokenizer, recovering parser, semantic checker.
 *
 *   node tests/arcade-parse.mjs
 *
 * No ROMs, no browser: the three modules in src/lang/arcade/ are pure. Prints PASS / FAIL per check and exits 1
 * if any failed. The Breakout example is read from docs/ARCADE_LANGUAGE.md, so a change to the doc is tested.
 */

"use strict";

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { tokenize, parse } = await import(join(ROOT, 'src/lang/arcade/arcade-parse.js'));
const { check: checkAst } = await import(join(ROOT, 'src/lang/arcade/arcade-check.js'));
const W = await import(join(ROOT, 'src/lang/arcade/arcade-words.js'));

let failed = 0, total = 0;
function check(name, ok, detail = '') {
  total++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  — ' + detail : ''}`);
  if (!ok) failed++;
}
const json = v => JSON.stringify(v);
const same = (name, got, want) => check(name, json(got) === json(want), `got ${json(got)}, want ${json(want)}`);

// ── helpers ──
/** Parse and check; returns {ast, all, errors, warnings}. */
function run(src) {
  const { ast, errors: perrs } = parse(src);
  const cerrs = checkAst(ast);
  const all = [...perrs, ...cerrs];
  return { ast, perrs, cerrs, all, errors: all.filter(e => e.severity === 'error'), warnings: all.filter(e => e.severity === 'warning') };
}
/** A complete program with declared assets and variables; `body` is the body of PROC FRAME. */
function wrap(body, top = '') {
  return `SPRITE ball = "ball"\nSPRITE bat = "bat"\nSFX snd = "snd"\n${top}\nSCENE s\n  DIM v, w, n, a(5), t$\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n${body}\n  ENDP\nENDSCENE\n`;
}
const lineOf = (src, text) => src.split('\n').findIndex(l => l.includes(text)) + 1;
const colOf = (src, line, text) => src.split('\n')[line - 1].indexOf(text);
const frameBody = ast => ast.scenes[0].procs.find(p => p.name === 'FRAME').body;
const stmts = body => frameBody(parse(wrap(body)).ast);
const errorsOf = (body, top = '') => run(wrap(body, top)).errors;
const hasMsg = (errs, re) => errs.some(e => re.test(e.message));
/** S-expression of an expression node. */
function sx(e) {
  switch (e.type) {
    case 'Number': return String(e.value);
    case 'String': return JSON.stringify(e.value);
    case 'Ident': return e.name;
    case 'Index': return `${e.name}[${sx(e.index)}]`;
    case 'Unary': return `(${e.op} ${sx(e.operand)})`;
    case 'Binary': return `(${e.op} ${sx(e.left)} ${sx(e.right)})`;
    case 'Func': return `${e.name}(${e.args.map(sx).join(',')})`;
    case 'FnCall': return `FN ${e.name}(${sx(e.arg)})`;
    default: return `<${e.type}>`;
  }
}
const exprOf = src => sx(stmts(`    v = ${src}`)[0].value);

// ── 1. tokenizer ──
{
  const t = tokenize('x1 = 12 <> "hi"');
  same('tokens: types', t.map(k => k.type), ['ident', 'op', 'number', 'op', 'string', 'newline', 'eof']);
  same('tokens: columns (0-based, end exclusive)', t.slice(0, 5).map(k => [k.col, k.end]), [[0, 2], [3, 4], [5, 7], [8, 10], [11, 15]]);
  same('tokens: line numbers (1-based)', tokenize('a\nb\n\nc').filter(k => k.type === 'ident').map(k => k.line), [1, 2, 4]);
  check('tokens: keywords are case-insensitive', ['print', 'PRINT', 'PrInT'].every(w => { const k = tokenize(w)[0]; return k.type === 'keyword' && k.value === 'PRINT'; }));
  check('tokens: whole words only (tomato, print2, REMark are names)', ['tomato', 'print2', 'REMark', 'Android'].every(w => tokenize(w)[0].type === 'ident'));
  check('tokens: STR$ is a keyword, name$ is a name', tokenize('STR$')[0].type === 'keyword' && tokenize('name$')[0].type === 'ident' && tokenize('name$')[0].text === 'name$');
  const r = tokenize('REM a : b = 1\nx = 1 : REM tail');
  same('REM runs to the end of the line, ":" included', r.filter(k => k.type === 'comment').map(k => k.text), ['REM a : b = 1', 'REM tail']);
  same('tokens: <> <= >= are single tokens', tokenize('<> <= >= < > =').filter(k => k.type === 'op').map(k => k.text), ['<>', '<=', '>=', '<', '>', '=']);
  check('lexical: decimal number is an error', parse('GAME "x"\nSCENE s\nDIM v\nPROC INIT()\nv = 1.5\nENDP\nENDSCENE').errors.some(e => e.line === 5 && /decimal|integers/.test(e.message)));
  check('lexical: underscore in a name is an error', parse('SCENE a_b\nENDSCENE').errors.some(e => /underscore/.test(e.message)));
  check('lexical: 31-character name is fine, 32 is an error',
    !parse(`DIM ${'a'.repeat(31)}`).errors.some(e => /longer/.test(e.message)) && parse(`DIM ${'a'.repeat(32)}`).errors.some(e => /longer/.test(e.message)));
  check("lexical: ' is not a comment", parse("SCENE s\nPROC INIT()\n' hello\nENDP\nENDSCENE").errors.some(e => e.line === 3 && /REM/.test(e.message)));
  check('lexical: unterminated string', parse('GAME "abc').errors.some(e => /unterminated/.test(e.message)));
  check('tokenize accepts a non-string', tokenize(undefined).length === 2 && tokenize(42)[0].type === 'number');
}

// ── 2. the Breakout example ──
const doc = readFileSync(join(ROOT, 'docs/ARCADE_LANGUAGE.md'), 'utf8');
const bm = /```\n(GAME "Breakout"[\s\S]*?\nENDSCENE\n)```/.exec(doc);
check('Breakout example found in docs/ARCADE_LANGUAGE.md', !!bm);
const BREAKOUT = bm ? bm[1] : '';
{
  const r = run(BREAKOUT);
  same('Breakout: no parse errors', r.perrs, []);
  same('Breakout: no check errors', r.cerrs.filter(e => e.severity === 'error'), []);
  const ast = r.ast;
  check('Breakout: GAME and FRAMERATE', ast.game?.title === 'Breakout' && ast.framerate?.value === 30);
  same('Breakout: assets', ast.assets.map(a => [a.kind, a.name, a.asset]), [['SPRITE', 'bat', 'bat'], ['SPRITE', 'ball', 'ball'], ['SFX', 'bounce', 'bounce'], ['TILESET', 'bricks', 'bricks']]);
  same('Breakout: one scene named play (PLAY is a word, scene names have their own namespace)', ast.scenes.map(s => s.name), ['play']);
  same('Breakout: scene DIM', ast.scenes[0].decls[0].items.map(i => i.name), ['bx', 'by', 'dx', 'dy', 'px', 'score']);
  same('Breakout: procs INIT and FRAME', ast.scenes[0].procs.map(p => [p.name, p.param]), [['INIT', null], ['FRAME', null]]);
  same('Breakout: INIT body is six assignments', ast.scenes[0].procs[0].body.filter(s => s.type !== 'Rem').map(s => s.type), Array(6).fill('Assign'));
  same('Breakout: FRAME statement shapes', frameBody(ast).filter(s => s.type !== 'Rem').map(s => s.type),
    ['If', 'If', 'Assign', 'Assign', 'If', 'If', 'Show', 'Show', 'Print']);
  const ifs = frameBody(ast).filter(s => s.type === 'If');
  same('Breakout: IF conditions', ifs.map(i => sx(i.cond)), ['BIT(STICK(1),2)', 'BIT(STICK(1),3)', '(OR (< bx 0) (> bx 248))', 'HIT(ball,bat)']);
  same('Breakout: IF bodies', ifs.map(i => i.then.map(s => s.type)), [['Assign'], ['Assign'], ['Assign', 'Play'], ['Assign', 'Play', 'Assign']]);
  const pr = frameBody(ast).find(s => s.type === 'Print');
  same('Breakout: PRINT AT 0,0; "SCORE "; score', [sx(pr.at.row), sx(pr.at.col), pr.items.map(sx), pr.seps, pr.trailing], ['0', '0', ['"SCORE "', 'score'], [';'], null]);
  const shows = frameBody(ast).filter(s => s.type === 'Show');
  same('Breakout: SHOW nodes', shows.map(s => [s.sprite.name, sx(s.x), sx(s.y), s.frame]), [['ball', 'bx', 'by', null], ['bat', 'px', '176', null]]);
  // Node positions are usable for a source map.
  const lines = BREAKOUT.split('\n');
  const showLine = lines.findIndex(l => l.includes('SHOW ball AT bx, by')) + 1;
  check('Breakout: statement line/col match the source', shows[0].line === showLine && shows[0].col === lines[showLine - 1].indexOf('SHOW'));
  const bxs = lines.findIndex(l => l.includes('bx = bx + dx')) + 1;
  const asg = frameBody(ast).filter(s => s.type === 'Assign')[0];
  check('Breakout: expression line/col/endCol match the source', asg.line === bxs && asg.value.col === lines[bxs - 1].indexOf('bx + dx') && asg.value.endCol === lines[bxs - 1].indexOf('bx + dx') + 'bx + dx'.length);
  const lc = BREAKOUT.toLowerCase(), uc = BREAKOUT.toUpperCase();
  check('Breakout: all lower case parses and checks the same', run(lc).errors.length === 0 && run(lc).ast.scenes[0].procs[1].body.length === frameBody(ast).length);
  check('Breakout: all upper case parses and checks the same', run(uc).errors.length === 0);
  check('Breakout: CRLF line endings give the same AST', json(parse(BREAKOUT.replace(/\n/g, '\r\n')).ast) === json(ast));
  check('Breakout: no warnings', r.warnings.length === 0, json(r.warnings));
}

// ── 3. every statement form ──
{
  const t = body => stmts(body).filter(s => s.type !== 'Rem');
  same('stmt: Assign variable, array element, string', t('    v = 1\n    a(2) = v\n    t$ = "x"').map(s => [s.type, s.target.type, s.target.name]), [['Assign', 'Ident', 'v'], ['Assign', 'Index', 'a'], ['Assign', 'Ident', 't$']]);
  const iff = t('    IF v THEN\n      w = 1\n    ELSE\n      w = 2\n    ENDIF')[0];
  check('stmt: IF ... ELSE ... ENDIF', iff.type === 'If' && iff.then.length === 1 && iff.else.length === 1 && iff.elseLine === iff.line + 2 && iff.endLine === iff.line + 4);
  check('stmt: IF without ELSE has else = null', t('    IF v THEN\n      w = 1\n    ENDIF')[0].else === null);
  const f = t('    FOR n = 1 TO 10 STEP 2\n      v = v + n\n    NEXT n')[0];
  check('stmt: FOR with STEP and NEXT variable', f.type === 'For' && f.variable.name === 'n' && sx(f.from) === '1' && sx(f.to) === '10' && sx(f.step) === '2' && f.nextVar.name === 'n' && f.body.length === 1);
  check('stmt: FOR without STEP / NEXT variable', (g => g.step === null && g.nextVar === null)(t('    FOR n = 1 TO 3\n    NEXT')[0]));
  const wh = t('    WHILE v < 3\n      v = v + 1\n    WEND')[0];
  check('stmt: WHILE ... WEND', wh.type === 'While' && sx(wh.cond) === '(< v 3)' && wh.body.length === 1);
  const sel = t('    SELECT CASE v\n    CASE 1, 2\n      w = 1\n    CASE 3\n      w = 2\n    CASE ELSE\n      w = 3\n    ENDSEL')[0];
  check('stmt: SELECT CASE with value lists and CASE ELSE', sel.type === 'Select' && sel.cases.length === 2 && sel.cases[0].values.length === 2 && sel.else.body.length === 1 && sx(sel.expr) === 'v');
  same('stmt: CALL with and without an argument', t('    CALL f(v + 1)\n    CALL g()').map(s => [s.type, s.name, s.arg ? sx(s.arg) : null]), [['Call', 'f', '(+ v 1)'], ['Call', 'g', null]]);
  const pr = t('    PRINT AT 1, 2; TAB 3; "a"; v, w;')[0];
  same('stmt: PRINT AT / TAB prefixes, separators, trailing', [sx(pr.at.row), sx(pr.at.col), sx(pr.tab), pr.items.length, pr.seps, pr.trailing], ['1', '2', '3', 3, [';', ','], ';']);
  same('stmt: bare PRINT', (p => [p.items.length, p.at, p.tab])(t('    PRINT')[0]), [0, null, null]);
  same('stmt: SHOW ... FRAME', (s => [s.sprite.name, sx(s.x), sx(s.y), sx(s.frame)])(t('    SHOW ball AT 10, 20 FRAME v + 1')[0]), ['ball', '10', '20', '(+ v 1)']);
  same('stmt: HIDE PLAY SILENCE ENTER', t('    HIDE ball\n    PLAY snd\n    SILENCE\n    ENTER s').map(s => s.type), ['Hide', 'Play', 'Silence', 'Enter']);
  same('stmt: TILE x, y = t (y stops before "=")', (s => [s.type, sx(s.x), sx(s.y), sx(s.value)])(t('    TILE v + 1, w * 2 = n')[0]), ['Tile', '(+ v 1)', '(* w 2)', 'n']);
  same('stmt: EXIT FOR / EXIT WHILE, END', t('    FOR n = 1 TO 2\n      EXIT FOR\n    NEXT\n    END')[0].body.map(s => s.kind).concat(t('    END')[0].type), ['FOR', 'End']);
  same('stmt: INK PAPER BRIGHT FLASH', t('    INK 1\n    PAPER 2\n    BRIGHT 1\n    FLASH 0').map(s => [s.type, s.which]), [['Color', 'INK'], ['Color', 'PAPER'], ['Color', 'BRIGHT'], ['Color', 'FLASH']]);
  same('stmt: PLOT LINE POKE OUT CLS BORDER RANDOMISE', t('    PLOT 1, 2\n    LINE 1, 2 TO 3, 4\n    POKE 30000, 1\n    OUT 254, 2\n    CLS\n    BORDER 1\n    RANDOMISE 5').map(s => s.type), ['Plot', 'Line', 'Poke', 'Out', 'Cls', 'Border', 'Randomise']);
  same('stmt: LINE operands', (s => [sx(s.x0), sx(s.y0), sx(s.x1), sx(s.y1)])(t('    LINE 1, 2 TO 3, 4')[0]), ['1', '2', '3', '4']);
  const top = parse('DIM g, h(10), s$\nDEF FN dbl(x) = x * 2\nSCENE q\n  DIM z\nENDSCENE');
  same('stmt: DIM scalars and arrays, DEF FN', [top.ast.decls[0].items.map(i => [i.name, i.size]), top.ast.decls[1].type, top.ast.decls[1].name, top.ast.decls[1].param, sx(top.ast.decls[1].body)],
    [[['g', null], ['h', 10], ['s$', null]], 'DefFn', 'dbl', 'x', '(* x 2)']);
  same('stmt: PROC with a parameter', (p => [p.name, p.param])(parse('PROC bump(n)\nENDP').ast.procs[0]), ['bump', 'n']);
  same('stmt: PROC with a string parameter and a trailing colon', (p => [p.name, p.param])(parse('PROC show(m$):\nENDP').ast.procs[0]), ['show', 'm$']);
  same('stmt: ":" separates statements', t('    v = 1 : w = 2 : n = 3').map(s => s.target.name), ['v', 'w', 'n']);
  same('REM to end of line swallows ":" and statements', stmts('    REM v = 1 : w = 2').map(s => s.type), ['Rem']);
  same('REM may trail a statement without ":"', stmts('    v = 1 REM note : w = 2').map(s => s.type), ['Assign', 'Rem']);
  check('one-line IF with closers on the same line', t('    IF v THEN w = 1 ELSE w = 2 ENDIF')[0].else.length === 1);
}

// ── 4. expressions, precedence and associativity ──
{
  same('expr: * binds tighter than +', exprOf('1 + 2 * 3'), '(+ 1 (* 2 3))');
  same('expr: - is left associative', exprOf('10 - 4 - 3'), '(- (- 10 4) 3)');
  same('expr: brackets', exprOf('(1 + 2) * 3'), '(* (+ 1 2) 3)');
  same('expr: AND binds tighter than OR', exprOf('a OR b AND c'), '(OR a (AND b c))');
  same('expr: OR and AND are left associative', exprOf('a OR b OR c'), '(OR (OR a b) c)');
  same('expr: NOT is looser than comparison', exprOf('NOT a = b'), '(NOT (= a b))');
  same('expr: NOT after AND', exprOf('a AND NOT b'), '(AND a (NOT b))');
  same('expr: comparison is looser than +', exprOf('a < b + 1'), '(< a (+ b 1))');
  same('expr: comparison operators', ['=', '<>', '<', '>', '<=', '>='].map(o => exprOf(`a ${o} b`)), ['(= a b)', '(<> a b)', '(< a b)', '(> a b)', '(<= a b)', '(>= a b)']);
  same('expr: unary minus binds tighter than *', exprOf('-a * b'), '(* (- a) b)');
  same('expr: unary minus repeats', exprOf('- - 5'), '(- (- 5))');
  same('expr: a - -b', exprOf('a - -b'), '(- a (- b))');
  same('expr: MOD and DIV are infix, multiplicative, left to right', exprOf('a MOD b * c DIV 2'), '(DIV (* (MOD a b) c) 2)');
  same('expr: DIV below +', exprOf('a DIV 2 + 1'), '(+ (DIV a 2) 1)');
  same('expr: function call, nested, with an index', exprOf('BIT(STICK(1), a(i + 1))'), 'BIT(STICK(1),a[(+ i 1)])');
  same('expr: FN call', exprOf('FN dbl(v) + 1'), '(+ FN dbl(v) 1)');
  same('expr: string literal and concatenation', exprOf('"a" + t$'), '(+ "a" t$)');
  same('expr: zero-argument bracket call parses', exprOf('RND()'), 'RND()');
  check('expr: "/" is refused with a hint (and parses as DIV)', (r => r.errors.some(e => /DIV/.test(e.message)) && sx(frameBody(r.ast)[0].value) === '(DIV 6 2)')(parse(wrap('    v = 6 / 2'))));
  check('expr: a function needs brackets', parse(wrap('    v = ABS')).errors.some(e => /needs brackets/.test(e.message)));
  check('expr: nesting 5000 brackets does not crash', (r => r.errors.length > 0)(parse(wrap(`    v = ${'('.repeat(5000)}1${')'.repeat(5000)}`))));
  check('expr: node spans cover brackets', (e => e.col === 8 && e.endCol === 19)(stmts('    v = (1 + 2) * 3')[0].value) , json(stmts('    v = (1 + 2) * 3')[0].value));
}

// ── 5. error recovery ──
{
  const src = [
    'GAME "r"',          // 1
    'SCENE s',           // 2
    '  DIM v, w',        // 3
    '  PROC INIT()',     // 4
    '    v = = 1',       // 5  expression expected at the second "="
    '    w = 1 +',       // 6  expression expected at end of line
    '    LET v = 2',     // 7  LET is not in Arcade
    '    v = 1.5',       // 8  lexical: decimal
    '    IF v THEN',     // 9  IF without ENDIF
    '  ENDP',            // 10
    '  PROC FRAME()',    // 11
    '    w = 3',         // 12
    '  ENDP',            // 13
    'ENDSCENE',          // 14
  ].join('\n');
  const { ast, errors } = parse(src);
  same('recovery: five mistakes give five errors with line and col', errors.map(e => [e.line, e.col]), [[5, 8], [6, 11], [7, 4], [8, 8], [9, 4]]);
  check('recovery: every error has endCol > col and severity', errors.every(e => e.endCol > e.col && e.severity === 'error'));
  check('recovery: messages say what is wrong', /expression/.test(errors[0].message) && /expression/.test(errors[1].message) && /LET/.test(errors[2].message) && /decimal|integers/.test(errors[3].message) && /IF without ENDIF/.test(errors[4].message));
  check('recovery: the rest of the program is still parsed', ast.scenes.length === 1 && ast.scenes[0].procs.length === 2 && frameBody(ast).length === 1);
  const r2 = parse(wrap('    v = = 1 : w = 2'));
  check('recovery: ":" resynchronises inside a line', r2.errors.length === 1 && frameBody(r2.ast).length === 0 || frameBody(r2.ast).some(s => s.target && s.target.name === 'w'));
  const r3 = parse('SCENE a\n  PROC INIT()\n  PROC FRAME()\n  ENDP\nENDSCENE');
  check('recovery: missing ENDP is reported at the PROC and the next PROC is kept', r3.errors.length === 1 && r3.errors[0].line === 2 && /ENDP/.test(r3.errors[0].message) && r3.ast.scenes[0].procs.length === 2);
  const r4 = parse('SCENE a\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nSCENE b\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE');
  check('recovery: missing ENDSCENE is reported at the SCENE and the next scene is kept', r4.errors.length === 1 && r4.errors[0].line === 1 && /ENDSCENE/.test(r4.errors[0].message) && r4.ast.scenes.length === 2);
  const r5 = parse(wrap('    FOR n = 1 TO 3\n      IF v THEN\n        w = 1\n    NEXT'));
  check('recovery: IF forgotten inside FOR: one error, FOR still closed by NEXT', r5.errors.length === 1 && /IF without ENDIF/.test(r5.errors[0].message) && frameBody(r5.ast)[0].type === 'For');
  const r6 = parse(wrap('    v = 1\n    ENDIF\n    w = 2'));
  check('recovery: stray ENDIF reported and skipped', r6.errors.length === 1 && /ENDIF without IF/.test(r6.errors[0].message) && frameBody(r6.ast).length === 2);
  const r7 = parse(wrap('    FOR n = TO 3\n      v = 1\n    NEXT'));
  check('recovery: broken FOR header: one error, body and NEXT still parsed', r7.errors.length === 1 && r7.errors[0].line === lineOf(wrap('    FOR n = TO 3\n      v = 1\n    NEXT'), 'FOR') && frameBody(r7.ast)[0].body.length === 1);
  const r8 = parse(wrap('    IF v > THEN\n      w = 1\n    ENDIF\n    w = 2'));
  check('recovery: broken IF condition: one error, rest intact', r8.errors.length === 1 && frameBody(r8.ast).length === 2);
  const r9 = parse(wrap('    t$ = "abc\n    w = 2'));
  check('recovery: unterminated string reported, next line parsed', r9.errors.length === 1 && frameBody(r9.ast).length === 2);
  const r10 = parse('PRINT "x"\nGAME "g"\nx = 1');
  check('recovery: statements outside a PROC are reported and the GAME still parsed', r10.errors.length === 2 && r10.ast.game?.title === 'g');
  const r11 = parse(wrap('    SELECT CASE v\n    CASE 1\n      w = 1\n    CASE ELSE\n      w = 2\n'));
  check('recovery: SELECT without ENDSEL reported at the SELECT', r11.errors.some(e => /ENDSEL/.test(e.message) && e.line === lineOf(wrap('    SELECT CASE v\n    CASE 1\n      w = 1\n    CASE ELSE\n      w = 2\n'), 'SELECT')));
  check('recovery: GAME inside a SCENE is reported but recorded', (r => r.errors.length === 1 && /top level/.test(r.errors[0].message) && r.ast.game)(parse('SCENE a\n  GAME "x"\nENDSCENE')));
  check('recovery: labels do not exist', parse(wrap('    loop:\n    v = 1')).errors.some(e => /labels/.test(e.message)));
  check('recovery: GOTO / GOSUB / INPUT get advice', ['GOTO 10', 'GOSUB 10', 'INPUT v'].every(s => parse(wrap('    ' + s)).errors.some(e => /not in Arcade/.test(e.message))));
  check('recovery: a keyword cannot name a PROC', parse('PROC print()\nENDP').errors.some(e => /reserved/.test(e.message)));
  check('recovery: one-line IF without ENDIF', parse(wrap('    IF v THEN w = 1')).errors.some(e => /IF without ENDIF/.test(e.message)));
}

// ── 6. semantic checks ──
{
  // names declared before use
  check('names: declared variable is fine', errorsOf('    v = 1\n    w = v + n').length === 0);
  const e1 = errorsOf('    zz = 1');
  check('names: undeclared variable is an error with its position', e1.length === 1 && e1[0].line === 10 && e1[0].col === 4 && /zz/.test(e1[0].message) && /DIM/.test(e1[0].message), json(e1));
  check('names: undeclared variable in an expression', hasMsg(errorsOf('    v = qq + 1'), /'qq' is not declared/));
  check('names: undeclared array', hasMsg(errorsOf('    v = zz(1)'), /'zz' is not declared/));
  check('names: one error per undeclared name per PROC', errorsOf('    zz = 1\n    zz = 2\n    v = zz').length === 1);
  const useBefore = 'SCENE s\n  PROC INIT()\n    v = 1\n  ENDP\n  DIM v\n  PROC FRAME()\n    v = 2\n  ENDP\nENDSCENE';
  check('names: a DIM after the PROC that uses it is too late', run(useBefore).errors.length === 1 && run(useBefore).errors[0].line === 3);
  const glob = 'DIM score\nSCENE a\n  PROC INIT()\n    score = 0\n  ENDP\n  PROC FRAME()\n    score = score + 1\n  ENDP\nENDSCENE\nSCENE b\n  PROC INIT()\n    score = 1\n  ENDP\n  PROC FRAME()\n    score = 2\n  ENDP\nENDSCENE';
  check('names: a top-level DIM is global to every scene', run(glob).errors.length === 0, json(run(glob).errors));
  const loc = 'SCENE a\n  DIM mine\n  PROC INIT()\n    mine = 0\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\nSCENE b\n  PROC INIT()\n    mine = 1\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE';
  check('names: a scene DIM is local to its scene', (e => e.length === 1 && e[0].line === 11)(run(loc).errors), json(run(loc).errors));
  check('names: a PROC parameter is local to its PROC', hasMsg(run(wrap('    CALL p(1)\n    k = 1', 'PROC p(k)\n  v2 = k\nENDP')).errors, /'k' is not declared/));
  check('names: a FOR variable must be declared', hasMsg(errorsOf('    FOR q = 1 TO 2\n    NEXT'), /'q' is not declared/));
  check('names: reserved names need no DIM and cannot be variables', hasMsg(errorsOf('    ABS = 1'), /built-in function/));

  // assets
  check('assets: SHOW of a declared SPRITE', errorsOf('    SHOW ball AT 1, 2').length === 0);
  check('assets: SHOW of an undeclared name', hasMsg(errorsOf('    SHOW ghost AT 1, 2'), /'ghost' is not a declared SPRITE/));
  check('assets: SHOW of an SFX is wrong', hasMsg(errorsOf('    SHOW snd AT 1, 2'), /SFX, not a SPRITE/));
  check('assets: HIDE of an undeclared sprite', hasMsg(errorsOf('    HIDE ghost'), /ghost/));
  check('assets: PLAY of a declared SFX', errorsOf('    PLAY snd').length === 0);
  check('assets: PLAY of a SPRITE is wrong', hasMsg(errorsOf('    PLAY ball'), /SPRITE, not a SFX/));
  check('assets: HIT of two declared sprites', errorsOf('    IF HIT(ball, bat) THEN\n    ENDIF').length === 0);
  check('assets: HIT with an SFX or an unknown name is wrong', errorsOf('    IF HIT(ball, snd) THEN\n    ENDIF').length === 1 && errorsOf('    IF HIT(ball, nope) THEN\n    ENDIF').length === 1);
  check('assets: an asset is not a value', hasMsg(errorsOf('    v = ball'), /SPRITE, not a variable/));
  check('assets: a variable cannot reuse an asset name', hasMsg(run('SPRITE ball = "b"\nDIM ball').errors, /already declared/));
  check('assets: assets may be declared after the scene that uses them', run('SCENE s\n  PROC INIT()\n    SHOW ball AT 1, 2\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\nSPRITE ball = "ball"').errors.length === 0);

  // scenes
  check('scenes: INIT and FRAME present', run(wrap('')).errors.length === 0);
  check('scenes: missing INIT', hasMsg(run('SCENE a\n PROC FRAME()\n ENDP\nENDSCENE').errors, /no PROC INIT/));
  check('scenes: missing FRAME', hasMsg(run('SCENE a\n PROC INIT()\n ENDP\nENDSCENE').errors, /no PROC FRAME/));
  check('scenes: INIT defined twice', hasMsg(run('SCENE a\n PROC INIT()\n ENDP\n PROC INIT()\n ENDP\n PROC FRAME()\n ENDP\nENDSCENE').errors, /already defined/));
  check('scenes: PROC names are case-insensitive (init / frame)', run('SCENE a\n PROC init()\n ENDP\n PROC Frame()\n ENDP\nENDSCENE').errors.length === 0);
  check('scenes: INIT takes no parameter', hasMsg(run('SCENE a\n PROC INIT(x)\n ENDP\n PROC FRAME()\n ENDP\nENDSCENE').errors, /no parameter/));
  const two = 'SCENE a\n PROC INIT()\n  ENTER b\n ENDP\n PROC FRAME()\n ENDP\nENDSCENE\nSCENE b\n PROC INIT()\n ENDP\n PROC FRAME()\n ENDP\nENDSCENE';
  check('scenes: ENTER of a scene that exists (defined later)', run(two).errors.length === 0, json(run(two).errors));
  check('scenes: ENTER of a scene that does not exist', hasMsg(errorsOf('    ENTER nowhere'), /unknown SCENE 'nowhere'/));
  check('scenes: duplicate scene name', hasMsg(run('SCENE a\nENDSCENE\nSCENE A\nENDSCENE').errors, /already defined/));
  check('scenes: the same PROC names in two scenes are fine', run(two).errors.length === 0);

  // EXIT
  check('EXIT FOR inside FOR', errorsOf('    FOR n = 1 TO 3\n      EXIT FOR\n    NEXT').length === 0);
  check('EXIT FOR outside a FOR', hasMsg(errorsOf('    EXIT FOR'), /outside a FOR/));
  check('EXIT FOR inside a WHILE only', hasMsg(errorsOf('    WHILE v\n      EXIT FOR\n    WEND'), /outside a FOR/));
  check('EXIT WHILE inside WHILE, and outside', errorsOf('    WHILE v\n      EXIT WHILE\n    WEND').length === 0 && hasMsg(errorsOf('    EXIT WHILE'), /outside a WHILE/));
  check('EXIT FOR inside an IF inside a FOR', errorsOf('    FOR n = 1 TO 3\n      IF v THEN\n        EXIT FOR\n      ENDIF\n    NEXT').length === 0);
  check('EXIT FOR does not leak out of a PROC into a FOR around the CALL', hasMsg(run(wrap('    FOR n = 1 TO 2\n      CALL p(0)\n    NEXT', 'PROC p(k)\n  EXIT FOR\nENDP')).errors, /outside a FOR/));

  // duplicates
  check('dup: DIM twice in a scene', hasMsg(run('SCENE a\n DIM x, X\nENDSCENE').errors, /already declared/));
  check('dup: a scene DIM over a global', hasMsg(run('DIM x\nSCENE a\n DIM x\nENDSCENE').errors, /already declared/));
  check('dup: two assets with one name', hasMsg(run('SPRITE a = "x"\nSFX A = "y"').errors, /already declared/));
  check('dup: two top-level PROCs', hasMsg(run('PROC p()\nENDP\nPROC P()\nENDP').errors, /already defined/));
  check('dup: two DEF FNs', hasMsg(run('DEF FN f(x) = x\nDEF FN f(x) = x + 1').errors, /already defined/));
  check('dup: a variable named like a PROC', hasMsg(run('PROC p()\nENDP\nDIM p').errors, /PROC or DEF FN/));

  // built-in arguments
  check('args: ABS(1) fine', errorsOf('    v = ABS(-3)').length === 0);
  check('args: too few arguments', hasMsg(errorsOf('    v = ABS()'), /ABS takes 1 argument, got 0/));
  check('args: too many arguments', hasMsg(errorsOf('    v = ABS(1, 2)'), /ABS takes 1 argument, got 2/));
  check('args: BIT needs two', hasMsg(errorsOf('    v = BIT(1)'), /BIT takes 2 arguments, got 1/));
  check('args: HIT needs two', hasMsg(errorsOf('    v = HIT(ball)'), /HIT takes 2 arguments, got 1/));
  check('args: LEN needs a string', hasMsg(errorsOf('    v = LEN(5)'), /argument 1 of LEN must be a string/));
  check('args: STR$ needs a number', hasMsg(errorsOf('    t$ = STR$("a")'), /argument 1 of STR\$ must be a number/));
  check('args: every table function has a consistent entry', [...W.FUNCTIONS.values()].every(f => f.args.length >= f.min && (f.ret === 'num' || f.ret === 'str') && f.desc.length > 0));
  check('args: every function in the table accepts exactly its argument count', [...W.FUNCTIONS.values()].every(f => {
    const a = f.args.map(x => x.type === 'num' ? '1' : x.type === 'str' ? '"s"' : x.type === 'sprite' ? 'ball' : x.type === 'sfx' ? 'snd' : '1');
    const call = `${f.name}(${a.join(', ')})`;
    return errorsOf(f.ret === 'str' ? `    t$ = ${call}` : `    v = ${call}`).length === 0;
  }));
  check('args: PROC call parameter counts', hasMsg(run(wrap('    CALL p()', 'PROC p(k)\nENDP')).errors, /takes one parameter/) && hasMsg(run(wrap('    CALL p(1)', 'PROC p()\nENDP')).errors, /takes no parameter/) && run(wrap('    CALL p(1)', 'PROC p(k)\nENDP')).errors.length === 0);
  check('args: CALL of an unknown PROC', hasMsg(errorsOf('    CALL nope(1)'), /unknown PROC 'nope'/));
  check('args: FN call needs a DEF FN', hasMsg(errorsOf('    v = FN nope(1)'), /unknown function FN nope/) && errorsOf('    v = FN dbl(2)', 'DEF FN dbl(x) = x * 2').length === 0);

  // assignment to keywords / functions
  check('assign: to a built-in function', hasMsg(errorsOf('    ABS = 1'), /built-in function/));
  check('assign: to a keyword', hasMsg(errorsOf('    PRINT = 1'), /keyword/));
  check('assign: to a PROC name', hasMsg(run(wrap('    p = 1', 'PROC p()\nENDP')).errors, /PROC, not a variable/));
  check('assign: to a DEF FN name', hasMsg(run(wrap('    dbl = 1', 'DEF FN dbl(x) = x')).errors, /DEF FN function, not a variable/));

  // GAME / FRAMERATE
  check('GAME twice', hasMsg(run('GAME "a"\nGAME "b"').errors, /GAME may appear only once/));
  check('FRAMERATE twice', hasMsg(run('FRAMERATE 30\nFRAMERATE 60').errors, /FRAMERATE may appear only once/));
  check('GAME and FRAMERATE once each', run('GAME "a"\nFRAMERATE 30').errors.length === 0);
  check('FRAMERATE: all twelve divisors of 60 are accepted', W.VALID_FRAMERATES.length === 12 && W.VALID_FRAMERATES.every(n => 60 % n === 0 && run(`FRAMERATE ${n}`).errors.length === 0));
  check('FRAMERATE: 7, 0, 25, 61, 120 are refused', [7, 0, 25, 61, 120].every(n => hasMsg(run(`FRAMERATE ${n}`).errors, /not valid/)));
  check('FRAMERATE needs a number', parse('FRAMERATE fast').errors.length === 1);

  // literals
  check('range: 32767 and -32768 are fine', errorsOf('    v = 32767\n    w = -32768').length === 0);
  check('range: 49152 and 65535 are fine (addresses)', errorsOf('    v = 49152\n    w = 65535').length === 0);
  check('range: 65536 is out of range', hasMsg(errorsOf('    v = 65536'), /out of range/));
  check('range: -32769 is out of range', hasMsg(errorsOf('    v = -32769'), /out of range/));
  check('range: -32769 is out of range', hasMsg(errorsOf('    v = -32769'), /out of range/));
  check('range: a huge literal is out of range', errorsOf(`    v = ${'9'.repeat(400)}`).length === 1);
  check('strings: 31 characters fine, 32 an error', errorsOf(`    t$ = "${'x'.repeat(31)}"`).length === 0 && hasMsg(errorsOf(`    t$ = "${'x'.repeat(32)}"`), /32 characters/));

  // types
  check('types: string = number is an error', hasMsg(errorsOf('    t$ = 5'), /cannot assign a number to t\$/));
  check('types: number = string is an error', hasMsg(errorsOf('    v = "x"'), /cannot assign a string to v/));
  check('types: string concatenation with STR$ is fine', errorsOf('    t$ = "n=" + STR$(v)').length === 0);
  check('types: mixing + is an error', hasMsg(errorsOf('    t$ = "n=" + v'), /cannot add a string and a number/));
  check('types: strings compare with strings only', errorsOf('    IF t$ = "a" THEN\n    ENDIF').length === 0 && hasMsg(errorsOf('    IF t$ = 1 THEN\n    ENDIF'), /cannot compare/));
  check('types: arithmetic on a string is an error', hasMsg(errorsOf('    v = t$ * 2'), /needs numbers/));

  // arrays and DIM
  check('arrays: a(i) fine', errorsOf('    a(2) = 1\n    v = a(v)').length === 0);
  check('arrays: an array needs an index', hasMsg(errorsOf('    v = a'), /is an array/));
  check('arrays: a scalar cannot be indexed', hasMsg(errorsOf('    v(1) = 2'), /not an array/));
  check('arrays: DIM size range', hasMsg(run('DIM x(0)').errors, /out of range/) && hasMsg(run('DIM x(16384)').errors, /out of range/) && run('DIM x(16383)').errors.length === 0);
  check('arrays: DIM with two dimensions is a parse error', parse('DIM x(2, 3)').errors.some(e => /one dimension/.test(e.message)));
  check('arrays: DIM size must be a literal', parse('DIM x(n)').errors.length === 1);
  check('DIM inside a PROC is an error', hasMsg(errorsOf('    DIM zz'), /not inside a PROC/));
  check('DEF FN inside a PROC is an error', hasMsg(errorsOf('    DEF FN q(x) = x'), /not inside a PROC/));

  // misc
  check('NEXT must name the FOR variable', hasMsg(errorsOf('    FOR n = 1 TO 2\n    NEXT v'), /NEXT v does not match FOR n/));
  check('SELECT / WHILE / FOR with declared names pass', errorsOf('    SELECT CASE v\n    CASE 1, 2\n      w = 1\n    CASE ELSE\n      w = 0\n    ENDSEL\n    WHILE w < 3\n      w = w + 1\n    WEND\n    FOR n = 1 TO 3 STEP 1\n      v = v + n\n    NEXT n').length === 0);
  check('not-in-v0 words get advice: CHR$', hasMsg(errorsOf('    t$ = CHR$(65)'), /CHR\$ is not in v0/));
  check('DEF FN body is checked and must be numeric', hasMsg(errorsOf('', 'DEF FN f(x) = y'), /'y' is not declared/) && hasMsg(errorsOf('', 'DEF FN g(x) = "a"'), /must give a number/));
  check('checker: positions point at the offending node', (e => e.length === 1 && e[0].line === 10 && e[0].col === 8 && e[0].endCol === 13)(errorsOf('    v = ghost')), json(errorsOf('    v = ghost')));
  check('checker: errors are sorted by position', (e => e.every((x, i) => i === 0 || e[i - 1].line < x.line || (e[i - 1].line === x.line && e[i - 1].col <= x.col)))(run(wrap('    v = q1\n    w = q2\n    n = q0')).all));

  // warnings
  const unused = run('SCENE a\n DIM spare\n PROC INIT()\n ENDP\n PROC FRAME()\n ENDP\nENDSCENE');
  check('warning: unused variable is a warning, not an error', unused.errors.length === 0 && unused.warnings.some(w => /'spare' is never used/.test(w.message) && w.severity === 'warning'));
  check('warning: unused SPRITE', run('SPRITE lone = "x"').warnings.some(w => /SPRITE 'lone'/.test(w.message)));
  check('warning: statement after END', run(wrap('    END\n    v = 1')).warnings.some(w => /unreachable/.test(w.message)));
  check('warning: PROC never called (INIT and FRAME exempt)', run('PROC lonely()\nENDP').warnings.some(w => /never called/.test(w.message)) && !run(wrap('')).warnings.some(w => /never called/.test(w.message)));
  check('warning: TILESET and MAP are never reported unused', run('TILESET t = "x"\nMAP m = "y"').warnings.length === 0);
}

// ── 7. words table ──
{
  const must = ['GAME', 'FRAMERATE', 'SPRITE', 'SFX', 'TILESET', 'MAP', 'SCENE', 'ENDSCENE', 'ENTER', 'SHOW', 'AT', 'HIDE', 'PLAY', 'SILENCE', 'TILE',
    'HIT', 'BIT', 'STICK', 'KEYDOWN', 'TILEAT', 'STR$', 'LEN', 'ABS', 'SGN', 'RND', 'PEEK', 'IN', 'USR', 'WHILE', 'WEND', 'SELECT', 'CASE', 'ENDSEL'];
  check('words: every word of the language doc is in the table', must.every(w => W.ARCADE_WORDS.has(w) && W.RESERVED.has(w)));
  check('words: every entry has a class, a syntax and a description', [...W.ARCADE_WORDS.values()].every(e => e.cls && e.syntax && e.desc));
  check('words: FRAME and INIT are contextual, not reserved', !W.RESERVED.has('FRAME') && !W.RESERVED.has('INIT') && W.wordEntry('frame').cls === 'game');
  check('words: MOD and DIV are operators', W.wordEntry('mod').cls === 'operator' && W.wordEntry('div').cls === 'operator');
  check('words: nothing invented beyond the doc plus WHILE/WEND and SELECT/CASE/ENDSEL', !['GOTO', 'GOSUB', 'LET', 'INPUT', 'MUSIC', 'SCROLL'].some(w => W.RESERVED.has(w)));
}

// ── 8. speed ──
{
  const lines = ['GAME "big"', 'FRAMERATE 30', 'SPRITE ball = "ball"', 'SCENE big', '  DIM v, w, a(10), t$', '  PROC INIT()', '    v = 0', '  ENDP', '  PROC FRAME()', '    SHOW ball AT v, w', '  ENDP'];
  for (let i = 0; lines.length < 400; i++) {
    lines.push(`  PROC p${i}(n)`, '    IF n > 3 AND v < 100 THEN', `      v = v + n * 2 MOD 7 - ${i}`, '    ELSE', '      w = a(n MOD 10) - 1 : t$ = "x" + STR$(n)', '    ENDIF', '  ENDP');
  }
  lines.push('ENDSCENE');
  const src = lines.join('\n');
  const t0 = performance.now();
  const r = parse(src);
  const t1 = performance.now();
  const c = checkAst(r.ast);
  const t2 = performance.now();
  check(`speed: ${lines.length}-line program parses in ${(t1 - t0).toFixed(1)} ms (< 200)`, t1 - t0 < 200);
  check(`speed: and checks in ${(t2 - t1).toFixed(1)} ms (< 200)`, t2 - t1 < 200);
  check('speed: the generated program has no errors', r.errors.length === 0 && c.filter(e => e.severity === 'error').length === 0, json(r.errors.slice(0, 2)) + json(c.slice(0, 2)));
}

// ── 9. fuzz ──
{
  let seed = 12345;
  const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  // 1. raw garbage: random UTF-16 units (lone surrogates, controls) and ASCII punctuation
  let threw = 0;
  for (let i = 0; i < 2000; i++) {
    const n = Math.floor(rnd() * 80);
    let s = '';
    for (let k = 0; k < n; k++) s += rnd() < 0.5 ? String.fromCharCode(Math.floor(rnd() * 0x10000)) : String.fromCharCode(32 + Math.floor(rnd() * 95));
    try { tokenize(s); parse(s); } catch { threw++; }
  }
  check('fuzz: tokenizer and parser never throw on 2000 random strings', threw === 0, `${threw} threw`);
  // 2. token soup: real words in random order, with newlines
  const pieces = [...W.RESERVED, 'x', 'y$', 'foo', 'INIT', 'FRAME', '(', ')', ',', ';', ':', '=', '<>', '+', '-', '*', '/', '1', '65536', '"s"', '"', '\n', '\n', '\n', ' ', 'REM c', '.', '_', '@'];
  threw = 0; let crashed = 0;
  for (let i = 0; i < 2000; i++) {
    const n = Math.floor(rnd() * 60);
    const s = Array.from({ length: n }, () => pick(pieces)).join(' ');
    try { const r = parse(s); checkAst(r.ast); if (!r.ast || r.ast.type !== 'Program') crashed++; } catch { threw++; }
  }
  check('fuzz: parse and check never throw on 2000 token-soup programs', threw === 0 && crashed === 0, `${threw} threw, ${crashed} bad`);
  // 3. mutations of the Breakout example: delete or swap a random token
  threw = 0;
  for (let i = 0; i < 300; i++) {
    const toks = BREAKOUT.split(/(\s+)/);
    const k = Math.floor(rnd() * toks.length);
    if (rnd() < 0.5) toks.splice(k, 1); else toks[k] = pick(pieces);
    try { checkAst(parse(toks.join('')).ast); } catch { threw++; }
  }
  check('fuzz: 300 mutated Breakouts never throw', threw === 0);
  check('fuzz: errors always carry line >= 1, col >= 0 and a message', (() => {
    for (let i = 0; i < 200; i++) {
      const s = Array.from({ length: 30 }, () => pick(pieces)).join(' ');
      const r = parse(s);
      for (const e of [...r.errors, ...checkAst(r.ast)]) {
        if (!(e.line >= 1 && e.col >= 0 && e.endCol >= e.col && typeof e.message === 'string' && e.message && (e.severity === 'error' || e.severity === 'warning'))) return false;
      }
    }
    return true;
  })());
}

console.log(`\n${total - failed}/${total} checks passed`);
process.exit(failed ? 1 : 0);
