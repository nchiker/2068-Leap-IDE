/**
 * src/leap-errors.js — GENERATED, do not edit.
 *
 * tools/gen-leap-errors.py from 2068-Leap docs/manual/07_appendices.md
 * (Appendix B) at v2.0.2-emu.1: error code -> {message, cause}.
 */

"use strict";

export const LEAP_COMPILE_ERRORS = {
  "1": {
    "message": "TOO MANY VARIABLES",
    "cause": "more than 251 number names (252nd)"
  },
  "2": {
    "message": "SYNTAX ERROR",
    "cause": "an identifier at the start of a statement not followed by = (also: an unknown word, LET, GOSUB, a package statement without its package)"
  },
  "3": {
    "message": "SYNTAX ERROR",
    "cause": "an expression could not start where it did (PRINT 1 +, PRINT ), x = )"
  },
  "7": {
    "message": "SYNTAX ERROR",
    "cause": "GOTO to a label that does not exist"
  },
  "8": {
    "message": "SYNTAX ERROR",
    "cause": "IF without THEN"
  },
  "9": {
    "message": "SYNTAX ERROR",
    "cause": "an IF block missing its ELSE or ENDIF"
  },
  "10": {
    "message": "SYNTAX ERROR",
    "cause": "no loop variable after FOR"
  },
  "11": {
    "message": "SYNTAX ERROR",
    "cause": "FOR without TO"
  },
  "12": {
    "message": "SYNTAX ERROR",
    "cause": "no label name after GOTO"
  },
  "13": {
    "message": "SYNTAX ERROR",
    "cause": "CALL: no procedure name; no (; no )"
  },
  "14": {
    "message": "SYNTAX ERROR",
    "cause": "CALL: no procedure name; no (; no )"
  },
  "15": {
    "message": "SYNTAX ERROR",
    "cause": "CALL: no procedure name; no (; no )"
  },
  "16": {
    "message": "SYNTAX ERROR",
    "cause": "PROC without ENDP"
  },
  "17": {
    "message": "SYNTAX ERROR",
    "cause": "PROC: no name; no (; no parameter; no )"
  },
  "18": {
    "message": "SYNTAX ERROR",
    "cause": "PROC: no name; no (; no parameter; no )"
  },
  "19": {
    "message": "SYNTAX ERROR",
    "cause": "PROC: no name; no (; no parameter; no )"
  },
  "20": {
    "message": "SYNTAX ERROR",
    "cause": "PROC: no name; no (; no parameter; no )"
  },
  "22": {
    "message": "SYNTAX ERROR",
    "cause": "no comma in a two-argument statement (PLOT 1 2, BEEP 1, POKE, SOUND, OUT, AT)"
  },
  "23": {
    "message": "SYNTAX ERROR",
    "cause": "LINE: no comma after x0; no TO; no comma after x1"
  },
  "24": {
    "message": "SYNTAX ERROR",
    "cause": "LINE: no comma after x0; no TO; no comma after x1"
  },
  "25": {
    "message": "SYNTAX ERROR",
    "cause": "LINE: no comma after x0; no TO; no comma after x1"
  },
  "28": {
    "message": "SYNTAX ERROR",
    "cause": "a package statement with the wrong number of arguments"
  },
  "29": {
    "message": "SYNTAX ERROR",
    "cause": "a built-in function: no (; no comma between arguments; no )"
  },
  "30": {
    "message": "SYNTAX ERROR",
    "cause": "a built-in function: no (; no comma between arguments; no )"
  },
  "31": {
    "message": "SYNTAX ERROR",
    "cause": "a built-in function: no (; no comma between arguments; no )"
  },
  "32": {
    "message": "SYNTAX ERROR",
    "cause": "DIM with no name; also LPRINT without the printer package"
  },
  "33": {
    "message": "SYNTAX ERROR",
    "cause": "DIM a without ("
  },
  "34": {
    "message": "SYNTAX ERROR",
    "cause": "the DIM size (or width) is not a plain number"
  },
  "35": {
    "message": "SYNTAX ERROR",
    "cause": "DIM size of 0"
  },
  "37": {
    "message": "SYNTAX ERROR",
    "cause": "DIM with no ) (also: a second dimension)"
  },
  "38": {
    "message": "SYNTAX ERROR",
    "cause": "an array declared twice"
  },
  "41": {
    "message": "SYNTAX ERROR",
    "cause": "an array index with no )"
  },
  "42": {
    "message": "SYNTAX ERROR",
    "cause": "an assignment to an array that was never DIM'd"
  },
  "43": {
    "message": "SYNTAX ERROR",
    "cause": "INPUT with no variable name"
  },
  "44": {
    "message": "SYNTAX ERROR",
    "cause": "EXIT not followed by FOR"
  },
  "46": {
    "message": "SYNTAX ERROR",
    "cause": "DIMN: no (; not a numeric array name; no )"
  },
  "47": {
    "message": "SYNTAX ERROR",
    "cause": "DIMN: no (; not a numeric array name; no )"
  },
  "48": {
    "message": "SYNTAX ERROR",
    "cause": "DIMN: no (; not a numeric array name; no )"
  },
  "49": {
    "message": "SYNTAX ERROR",
    "cause": "DEF FN: no FN; no name; no (; no parameter; no ); no ="
  },
  "50": {
    "message": "SYNTAX ERROR",
    "cause": "DEF FN: no FN; no name; no (; no parameter; no ); no ="
  },
  "51": {
    "message": "SYNTAX ERROR",
    "cause": "DEF FN: no FN; no name; no (; no parameter; no ); no ="
  },
  "52": {
    "message": "SYNTAX ERROR",
    "cause": "DEF FN: no FN; no name; no (; no parameter; no ); no ="
  },
  "53": {
    "message": "SYNTAX ERROR",
    "cause": "DEF FN: no FN; no name; no (; no parameter; no ); no ="
  },
  "54": {
    "message": "SYNTAX ERROR",
    "cause": "DEF FN: no FN; no name; no (; no parameter; no ); no ="
  },
  "56": {
    "message": "SYNTAX ERROR",
    "cause": "NEXT for another variable (or no loop open)"
  },
  "57": {
    "message": "SYNTAX ERROR",
    "cause": "a label or procedure defined twice"
  },
  "60": {
    "message": "NESTING TOO DEEP",
    "cause": "nesting too deep"
  },
  "61": {
    "message": "NAME TOO LONG",
    "cause": "a name of more than 31 characters"
  },
  "63": {
    "message": "SYNTAX ERROR",
    "cause": "EXIT FOR outside a loop"
  },
  "64": {
    "message": "UNEXPECTED TOKEN",
    "cause": "a token that cannot go here (see Appendix A); also a literal beyond the number range"
  },
  "65": {
    "message": "SYNTAX ERROR",
    "cause": "a FOR with no NEXT"
  },
  "66": {
    "message": "SYNTAX ERROR",
    "cause": "a bracketed expression with no )"
  },
  "70": {
    "message": "SYNTAX ERROR",
    "cause": "a string literal longer than 31 characters"
  },
  "71": {
    "message": "SYNTAX ERROR",
    "cause": "an immediate statement tried to define a label, procedure or function"
  }
};

export const LEAP_RUNTIME_ERRORS = {
  "2": {
    "message": "STACK OVERFLOW",
    "cause": "recursion (6) or expression nesting (2) too deep"
  },
  "6": {
    "message": "STACK OVERFLOW",
    "cause": "recursion (6) or expression nesting (2) too deep"
  },
  "5": {
    "message": "RUNTIME ERROR",
    "cause": "division by zero (/, DIV, MOD), TAN(90)"
  },
  "7": {
    "message": "RUNTIME ERROR",
    "cause": "NEXT or return with no frame: jumping into a loop; a loop ended by CLEAR"
  },
  "8": {
    "message": "RUNTIME ERROR",
    "cause": "SOUND register 17 or more"
  },
  "10": {
    "message": "RUNTIME ERROR",
    "cause": "array index outside the array"
  },
  "11": {
    "message": "RUNTIME ERROR",
    "cause": "a fraction or out-of-range number stored in a numeric array, or used as an index"
  },
  "15": {
    "message": "RUNTIME ERROR",
    "cause": "argument out of range: CHR$, STICK, SQR of a negative number, an address of 65536 or more, BEEP seconds negative or over 273 or semitones outside -60 to 69; sprite package (see Part 5); cbeep package: CBEEP out of range"
  },
  "64": {
    "message": "OUT OF MEMORY",
    "cause": "an array does not fit"
  },
  "65": {
    "message": "ARRAY SIZE MISMATCH",
    "cause": "DIM differs from a stored array"
  },
  "66": {
    "message": "BREAK",
    "cause": "CAPS SHIFT + SPACE"
  },
  "67": {
    "message": "RUNTIME ERROR",
    "cause": "a result beyond about 1.7 x 10^38"
  },
  "12": {
    "message": "RUNTIME ERROR",
    "cause": "mode package: bad MODE, ULAPLUS, PALETTE"
  },
  "13": {
    "message": "RUNTIME ERROR",
    "cause": "mode package: bad MODE, ULAPLUS, PALETTE"
  },
  "14": {
    "message": "RUNTIME ERROR",
    "cause": "mode package: bad MODE, ULAPLUS, PALETTE"
  },
  "16": {
    "message": "RUNTIME ERROR",
    "cause": "sprite package (see Part 5)"
  },
  "17": {
    "message": "RUNTIME ERROR",
    "cause": "sprite package (see Part 5)"
  },
  "18": {
    "message": "RUNTIME ERROR",
    "cause": "sprite package (see Part 5)"
  },
  "19": {
    "message": "RUNTIME ERROR",
    "cause": "sprite package (see Part 5)"
  },
  "20": {
    "message": "RUNTIME ERROR",
    "cause": "sprite package (see Part 5)"
  }
};
