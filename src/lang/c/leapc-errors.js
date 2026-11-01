/**
 * src/lang/c/leapc-errors.js — GENERATED, do not edit.
 *
 * tools/gen-leapc-errors.py from 2068-Leap-C include/leapc_errors.inc at v1.0.0:
 * error code -> {message, cause}; the message is what the ROM shows.
 */

"use strict";

export const LEAPC_COMPILE_ERRORS = {
  1: {"message": "NOT SUPPORTED", "cause": "long constants here; reserved words in the parser"},
  10: {"message": "BAD CHARACTER", "cause": "outside ASCII 32-126 / not a C token: @ $ `"},
  11: {"message": "UNTERMINATED COMMENT", "cause": "reported at the line where it starts"},
  12: {"message": "UNTERMINATED STRING", "cause": "end of line inside \"...\""},
  13: {"message": "BAD CHARACTER CONSTANT", "cause": "empty, unterminated or more than one char"},
  14: {"message": "BAD ESCAPE", "cause": "unknown \\c, \\x without digits, value > 255"},
  15: {"message": "BAD NUMBER", "cause": "invalid digit or suffix, 0x without digits, a malformed floating constant"},
  16: {"message": "NUMBER TOO LARGE", "cause": "a constant above 65535, a floating constant or constant float expression beyond the float range"},
  17: {"message": "STRING TOO LONG", "cause": "a string literal beyond TOK_BUF (a line the editor cannot make: guard only)"},
  20: {"message": "SYNTAX ERROR", "cause": "a token that cannot appear here"},
  21: {"message": "REDECLARED", "cause": "the name is already declared differently in this scope"},
  22: {"message": "ALREADY DEFINED", "cause": "second body, initialiser or struct/enum definition"},
  23: {"message": "UNDECLARED IDENTIFIER", "cause": ""},
  24: {"message": "BAD TYPE SPECIFIERS", "cause": "e.g. `int char`, `signed unsigned`, `int T`"},
  25: {"message": "BAD DECLARATOR", "cause": "array of functions, function returning an array or a function, void parameter or member, function definition here"},
  26: {"message": "BAD STORAGE CLASS", "cause": "two classes, auto at file scope, typedef = ..."},
  27: {"message": "BAD PARAMETER", "cause": "unnamed parameter in a function definition"},
  28: {"message": "BAD INITIALISER", "cause": "too many elements, string too long, braces missing"},
  29: {"message": "BAD ARRAY SIZE", "cause": "zero or negative"},
  40: {"message": "TYPE MISMATCH", "cause": "conflicting declarations, incompatible initialiser"},
  41: {"message": "INCOMPLETE TYPE", "cause": "void object, undefined struct, `[]` without size"},
  42: {"message": "TYPE TOO LARGE", "cause": "an object of more than 65535 bytes"},
  50: {"message": "CONSTANT REQUIRED", "cause": "a constant expression is required here"},
  51: {"message": "BAD OPERAND TYPE", "cause": "e.g. `*` of an int, `.` of a non-struct"},
  52: {"message": "NO SUCH MEMBER", "cause": ""},
  53: {"message": "NOT AN LVALUE", "cause": "`&` of a value, assignment to a value"},
  54: {"message": "ASSIGNMENT TO CONST", "cause": "a const object assigned or incremented"},
  55: {"message": "WRONG ARGUMENT COUNT", "cause": "call of a prototyped function"},
  70: {"message": "UNDEFINED FUNCTION", "cause": "called or used, never defined; line of first use"},
  71: {"message": "NO MAIN FUNCTION", "cause": "RUN"},
  72: {"message": "MISPLACED BREAK", "cause": "break outside a loop or switch"},
  73: {"message": "MISPLACED CONTINUE", "cause": "continue outside a loop"},
  74: {"message": "MISPLACED CASE", "cause": "case or default outside a switch"},
  75: {"message": "DUPLICATE CASE", "cause": "a case value twice, or a second default"},
  76: {"message": "UNDEFINED LABEL", "cause": "goto to a label the function does not define; line of the first goto"},
  90: {"message": "NESTING TOO DEEP", "cause": "compiler stack guard; more than 15 `*`"},
  91: {"message": "FRAME TOO LARGE", "cause": "more than 255 bytes of locals; spec.md 4.10"},
  92: {"message": "TOO MANY PARAMETERS", "cause": "more than 16; spec.md 4.10"},
  100: {"message": "OUT OF MEMORY", "cause": "compile workspace full"},
  101: {"message": "PROGRAM TOO BIG", "cause": "image regions full"},
};

export const LEAPC_RUNTIME_ERRORS = {
  1: {"message": "STACK OVERFLOW", "cause": "ENTER"},
  2: {"message": "OUT OF HEAP", "cause": "no Release 1 library function raises it (malloc gives NULL)"},
  3: {"message": "HI-RES IN USE", "cause": "hi-res mode with the image in $6000-$77FF"},
  4: {"message": "BAD ARGUMENT", "cause": "invalid library argument"},
  5: {"message": "BREAK", "cause": "the shell reports it as BREAK, without a number"},
  6: {"message": "NUMBER TOO BIG", "cause": "a float operation's overflow or division by 0 (Phase 8)"},
};

