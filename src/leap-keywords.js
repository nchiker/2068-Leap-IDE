/**
 * src/leap-keywords.js — GENERATED, do not edit.
 *
 * tools/gen-leap-keywords.py from 2068-Leap docs/manual/03_keywords.md at v2.1.0-emu.1.
 * One entry per manual keyword heading: kind (function / statement /
 * operator / command / part of), package (null for core), syntax, the
 * individual forms, the description's first paragraph and the first example.
 */

"use strict";

export const LEAP_MANUAL_REF = "v2.1.0-emu.1";

export const LEAP_KEYWORD_ENTRIES = {
  "ABS": {
    "kind": "function",
    "package": null,
    "syntax": "ABS(n)",
    "forms": [
      "ABS(n)"
    ],
    "desc": "The size of n without its sign.",
    "example": "PRINT ABS(-5)\nPRINT ABS(2.5)\nPRINT ABS(-2.5)"
  },
  "ALL": {
    "kind": "part of",
    "package": null,
    "syntax": "SAVE \"name\" ALL",
    "forms": [
      "SAVE \"name\" ALL"
    ],
    "desc": "Saves the program and its variables and arrays. See SAVE and the concept Sessions.",
    "example": null
  },
  "AND": {
    "kind": "operator",
    "package": null,
    "syntax": "a AND b",
    "forms": [
      "a AND b"
    ],
    "desc": "True (1) when both a and b are true; otherwise 0. Any value other than 0 counts as true. AND is a logical operator -- it gives 0 or 1, never a bit pattern: 3 AND 5 is 1, not 1. (There is no bitwise AND in V2.)",
    "example": "y = 0\nIF y <> 0 AND 10 / y > 1 THEN\n  PRINT \"big\"\nELSE\n  PRINT \"safe\"\nENDIF"
  },
  "ARRAY": {
    "kind": "part of",
    "package": null,
    "syntax": "SAVE \"name\" ARRAY a, LOAD \"name\" ARRAY a",
    "forms": [
      "SAVE \"name\" ARRAY a",
      "LOAD \"name\" ARRAY a"
    ],
    "desc": "Saves or loads a single array (and, on loading, puts it in the Array Store). See SAVE, LOAD and the concept Array Store.",
    "example": null
  },
  "AT": {
    "kind": "statement",
    "package": null,
    "syntax": "AT row, col",
    "forms": [
      "AT row, col"
    ],
    "desc": "Moves the printing position, so that the next PRINT starts at that row and column. Row 0 is the top of the screen and column 0 the left edge. AT is a statement of its own, used before PRINT; it is not an item inside PRINT as it is in Sinclair BASIC.",
    "example": "AT 3, 5\nPRINT \"here\"\nAT 0, 0\nPRINT \"top\""
  },
  "ATTR": {
    "kind": "function",
    "package": null,
    "syntax": "ATTR(row, col)",
    "forms": [
      "ATTR(row, col)"
    ],
    "desc": "The colour attribute of the character cell at row, col: one number made of | Part | Value | |---|---| | ink colour | 0 to 7 | | paper colour | 8 times (0 to 7) | | bright | 64 if on | | flash | 128 if on | A cell outside the screen (row above 23, column above 31) gives 0.",
    "example": "INK 2\nPAPER 6\nCLS\nPRINT ATTR(0, 0)\nPRINT ATTR(10, 12)\nPRINT ATTR(30, 0)"
  },
  "BEEP": {
    "kind": "statement",
    "package": null,
    "syntax": "BEEP seconds, semitones",
    "forms": [
      "BEEP seconds, semitones"
    ],
    "desc": "Plays a note on the AY-3-8912 sound chip, as Sinclair BASIC's BEEP does: seconds is how long, semitones is the pitch counted from middle C (0 is middle C, 12 the C above it, -12 the C below; the range is -60 to 69). The program waits until the note ends.",
    "example": "BEEP 0.25, 0\nBEEP 0.25, 4\nBEEP 0.25, 7\nBEEP 0.5, 12\nPRINT \"done\""
  },
  "BLOCK": {
    "kind": "statement",
    "package": "graphics",
    "syntax": "BLOCK x0, y0, x1, y1",
    "forms": [
      "BLOCK x0, y0, x1, y1"
    ],
    "desc": "Fills a rectangle with the current ink (and paper) colours. The corners may be given in any order. Needs the graphics package. See Part 5.",
    "example": "INK 4\nBLOCK 10, 40, 60, 70\nINK 2\nFRAME 70, 40, 120, 70\nINK 1\nBLOCK 130, 40, 180, 70\n…"
  },
  "BORDER": {
    "kind": "statement",
    "package": null,
    "syntax": "BORDER n",
    "forms": [
      "BORDER n"
    ],
    "desc": "Sets the colour of the border. Only the low three bits of n count, so the colours repeat every eight: | n | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | |---|---|---|---|---|---|---|---|---| | colour | black | blue | red | magenta | green | cyan | yellow | white | basic ex=kw.border.1 BORDER 2 PAUSE 25 BORDER 7 PRINT \"border\"  output ex=kw.border.1 border  See also INK, PAPER.",
    "example": "BORDER 2\nPAUSE 25\nBORDER 7\nPRINT \"border\""
  },
  "BRIGHT": {
    "kind": "statement",
    "package": null,
    "syntax": "BRIGHT n",
    "forms": [
      "BRIGHT n"
    ],
    "desc": "Turns the bright (extra intensity) attribute on for everything printed or drawn next. Only the low bit of n counts: BRIGHT 1 is on, BRIGHT 0 off; BRIGHT 2 is off.",
    "example": "BRIGHT 1\nCLS\na = ATTR(0, 0)\nBRIGHT 0\nCLS\nb = ATTR(0, 0)\n…"
  },
  "CALL": {
    "kind": "statement",
    "package": null,
    "syntax": "CALL name(expression)",
    "forms": [
      "CALL name(expression)"
    ],
    "desc": "Runs the procedure name (see PROC), giving it the value of expression as its one parameter. When the procedure ends, the program carries on after the CALL.",
    "example": "CALL hello(5)\nCALL hello(6)\nEND\nPROC hello(n):\n  PRINT \"n = \"; n\nENDP"
  },
  "CBEEP": {
    "kind": "statement",
    "package": "cbeep",
    "syntax": "CBEEP milliseconds, semitones, border",
    "forms": [
      "CBEEP milliseconds, semitones, border"
    ],
    "desc": "Plays a note on the machine's loudspeaker (the TS2068's original beeper), with the pitch counted in semitones from middle C as BEEP does. milliseconds is the length (0 to 32767: package arguments are whole numbers, so the length is in thousandths of a second); semitones is -60 to 69; border is the border colour (0 to 7) to keep while the note sounds and afterwards.",
    "example": "BORDER 1\nCBEEP 250, 0, 1\nCBEEP 250, 7, 1\nCBEEP 500, 12, 1\nPRINT \"beeped\""
  },
  "CHR$": {
    "kind": "function",
    "package": null,
    "syntax": "CHR$(n)",
    "forms": [
      "CHR$(n)"
    ],
    "desc": "A string of one character: the character whose code is n (0 to 255). Any other value stops the program with a run-time error.",
    "example": "PRINT CHR$(72) + CHR$(105)\nPRINT CODE(CHR$(200))"
  },
  "CIRCLE": {
    "kind": "statement",
    "package": "shapes",
    "syntax": "CIRCLE x, y, radius",
    "forms": [
      "CIRCLE x, y, radius"
    ],
    "desc": "Draws a circle with its centre at pixel x, y. Needs the shapes package. See Part 5.",
    "example": "INK 1\nCIRCLE 128, 96, 60\nINK 2\nCIRCLE 128, 96, 30\nFILL 128, 96\nINK 0\n…"
  },
  "CLEAR": {
    "kind": "statement",
    "package": null,
    "syntax": "CLEAR",
    "forms": [
      "CLEAR"
    ],
    "desc": "Sets every variable back to 0 (numbers) or \"\" (strings) and removes the contents of ordinary arrays. The program stays as it is. In a FOR loop, CLEAR also ends the loop (so a later NEXT is a run-time error). The Array Store and any loaded package are not touched.",
    "example": "x = 5\nPRINT x\nCLEAR\nPRINT x"
  },
  "CLS": {
    "kind": "statement",
    "package": null,
    "syntax": "CLS",
    "forms": [
      "CLS"
    ],
    "desc": "Clears the text area of the screen, paints it with the current ink, paper, bright and flash colours, and puts the printing position at the top left (row 0, column 0).",
    "example": "PRINT \"gone\"\nCLS\nPRINT \"fresh\""
  },
  "CODE": {
    "kind": "function",
    "package": null,
    "syntax": "CODE(a$)",
    "forms": [
      "CODE(a$)"
    ],
    "desc": "The character code of the first character of a$, or 0 if a$ is empty.",
    "example": "PRINT CODE(\"A\")\nPRINT CODE(\"abc\")\nPRINT CODE(\"\")\nPRINT CODE(\" \")"
  },
  "COS": {
    "kind": "function",
    "package": null,
    "syntax": "COS(angle)",
    "forms": [
      "COS(angle)"
    ],
    "desc": "The cosine of an angle given in degrees (not radians); fractions of a degree are allowed. The result is a floating-point number.",
    "example": "PRINT COS(60)\nPRINT COS(0)"
  },
  "CPLOT": {
    "kind": "statement",
    "package": "graphics",
    "syntax": "CPLOT x, y",
    "forms": [
      "CPLOT x, y"
    ],
    "desc": "Plots a coarse \"big pixel\": a 4 x 4 block of ordinary pixels on a grid of 64 columns by 48 rows. x is 0 to 63 and y 0 to 47, counted from the top left (larger values are treated as the last column or row). Needs the graphics package: type LOAD \"GRAPHICS\" EXT first. See Part 5.",
    "example": "INK 2\nFOR x = 0 TO 63\n  CPLOT x, DIV(x * 47, 63)\nNEXT x"
  },
  "DEF FN": {
    "kind": "statement",
    "package": null,
    "syntax": "DEF FN name(parameter) = expression",
    "forms": [
      "DEF FN name(parameter) = expression"
    ],
    "desc": "Defines a one-line function with one numeric parameter. You use it with FN inside an expression: FN name(argument). The name may be as long as any other name. The definition itself does nothing when it is reached; it may be anywhere in the program, even after the places that use it.",
    "example": "DEF FN sq(x) = x * x\nPRINT FN sq(7)\nPRINT FN sq(1.5)\ny = 3\nPRINT FN sq(y + 1)"
  },
  "DEG": {
    "kind": "function",
    "package": null,
    "syntax": "DEG(r)",
    "forms": [
      "DEG(r)"
    ],
    "desc": "Converts an angle from radians to degrees.",
    "example": "PRINT DEG(PI())\nPRINT DEG(1)"
  },
  "DIM": {
    "kind": "statement",
    "package": null,
    "syntax": "DIM name(size), DIM name$(size), DIM name$(size, width)",
    "forms": [
      "DIM name(size)",
      "DIM name$(size)",
      "DIM name$(size, width)"
    ],
    "desc": "Declares an array. size is the number of elements, and it must be a plain whole number in the program (not a variable or a sum). The elements are numbered from 0: DIM a(5) has a(0) to a(4).",
    "example": "DIM a(5)\nFOR i = 0 TO 4\n  a(i) = i * i\nNEXT i\nPRINT a(3)\nPRINT DIMN(a)"
  },
  "DIMN": {
    "kind": "function",
    "package": null,
    "syntax": "DIMN(name)",
    "forms": [
      "DIMN(name)"
    ],
    "desc": "The size an array was declared with: DIMN(a) after DIM a(5) is 5.",
    "example": "DIM scores(12)\nPRINT DIMN(scores)\nPRINT DIMN(scores) - 1"
  },
  "DIV": {
    "kind": "function",
    "package": null,
    "syntax": "DIV(a, b)",
    "forms": [
      "DIV(a, b)"
    ],
    "desc": "The whole-number part of a divided by b, rounded toward zero. Fractions are cut off first. Dividing by zero stops the program with a run-time error. (DIV is written like a function, not between its operands.)",
    "example": "PRINT DIV(17, 5)\nPRINT DIV(-7, 2)\nPRINT DIV(20, 4)"
  },
  "ELSE": {
    "kind": "part of",
    "package": null,
    "syntax": "ELSE",
    "forms": [
      "ELSE"
    ],
    "desc": "Starts the part of a block IF that is run when the condition is false. See IF.",
    "example": null
  },
  "END": {
    "kind": "statement",
    "package": null,
    "syntax": "END",
    "forms": [
      "END"
    ],
    "desc": "Stops the program. Reaching the last line does the same, so END is needed only to stop before the end -- typically before the procedures that follow the main program. Variables are kept (see the concept Sessions).",
    "example": "PRINT \"start\"\nCALL work(1)\nEND\nPROC work(n):\n  PRINT \"working\"\nENDP"
  },
  "ENDIF": {
    "kind": "part of",
    "package": null,
    "syntax": "ENDIF",
    "forms": [
      "ENDIF"
    ],
    "desc": "Closes a block IF. See IF.",
    "example": null
  },
  "ENDP": {
    "kind": "part of",
    "package": null,
    "syntax": "ENDP",
    "forms": [
      "ENDP"
    ],
    "desc": "Ends a procedure; the program returns to the statement after the CALL. See PROC.",
    "example": null
  },
  "EXIT FOR": {
    "kind": "statement",
    "package": null,
    "syntax": "EXIT FOR",
    "forms": [
      "EXIT FOR"
    ],
    "desc": "Leaves the innermost FOR loop at once, carrying on after its NEXT. The loop variable keeps the value it had.",
    "example": "FOR i = 1 TO 10\n  IF i = 4 THEN\n    EXIT FOR\n  ENDIF\n  PRINT i\nNEXT i\n…"
  },
  "EXT": {
    "kind": "part of",
    "package": null,
    "syntax": "SAVE \"name\" EXT, LOAD \"name\" EXT",
    "forms": [
      "SAVE \"name\" EXT",
      "LOAD \"name\" EXT"
    ],
    "desc": "Saves or loads a package: LOAD \"SHAPES\" EXT adds the statements CIRCLE and FILL to the language. See Part 5 and the commands SAVE and LOAD.",
    "example": null
  },
  "FILL": {
    "kind": "statement",
    "package": "shapes",
    "syntax": "FILL x, y",
    "forms": [
      "FILL x, y"
    ],
    "desc": "Floods the area around pixel x, y with the current ink colour, spreading in every direction until it meets pixels that are already set (a line, a circle, any outline). The area must be closed: if the outline has a gap, the colour spills out through it. Needs the shapes package: type LOAD \"SHAPES\" EXT first. See Part 5.",
    "example": "INK 1\nLINE 70, 150 TO 70, 90\nLINE 70, 90 TO 128, 40\nLINE 128, 40 TO 186, 90\nLINE 186, 90 TO 186, 150\nLINE 186, 150 TO 70, 150\n…"
  },
  "FLASH": {
    "kind": "statement",
    "package": null,
    "syntax": "FLASH n",
    "forms": [
      "FLASH n"
    ],
    "desc": "Makes what is printed next flash (its ink and paper swap about twice a second). Only the low bit of n counts: FLASH 1 on, FLASH 0 off.",
    "example": "FLASH 1\nCLS\na = ATTR(0, 0)\nFLASH 0\nCLS\nb = ATTR(0, 0)\n…"
  },
  "FN": {
    "kind": "part of",
    "package": null,
    "syntax": "FN name(expression)",
    "forms": [
      "FN name(expression)"
    ],
    "desc": "Calls a function defined with DEF FN. See DEF FN.",
    "example": null
  },
  "FOR": {
    "kind": "statement",
    "package": null,
    "syntax": "FOR variable = start TO limit [STEP step] ... NEXT [variable]",
    "forms": [
      "FOR variable = start TO limit [STEP step] ... NEXT [variable]"
    ],
    "desc": "Repeats the statements between FOR and NEXT. The variable is set to start, the statements run, and at NEXT the step (1 if you leave STEP out) is added; the loop goes round again while the variable has not gone past limit. The limit and step are worked out once, when the loop starts.",
    "example": "FOR i = 1 TO 3\n  PRINT i\nNEXT i\nPRINT \"after: \"; i"
  },
  "FRAME": {
    "kind": "statement",
    "package": "graphics",
    "syntax": "FRAME x0, y0, x1, y1",
    "forms": [
      "FRAME x0, y0, x1, y1"
    ],
    "desc": "Draws the outline of a rectangle between two opposite corners (given in any order), in the current ink. Needs the graphics package: type LOAD \"GRAPHICS\" EXT first. See Part 5.",
    "example": "FOR i = 0 TO 5\n  INK i + 1\n  FRAME 20 + i * 14, 20 + i * 10, 235 - i * 14, 170 - i * 10\nNEXT i"
  },
  "FREE": {
    "kind": "function",
    "package": null,
    "syntax": "FREE(), FREE(1)",
    "forms": [
      "FREE()",
      "FREE(1)"
    ],
    "desc": "FREE() is the number of bytes still free in the main memory pool, which the program text, the variables and the arrays share. FREE(1) is the number of bytes free in the 2 KB overflow area (segment 2) that arrays use when they do not fit in the main pool, and where the Array Store lives.",
    "example": "PRINT FREE(1)\nDIM a(100)\nPRINT FREE(1)"
  },
  "GOTO": {
    "kind": "statement",
    "package": null,
    "syntax": "GOTO label",
    "forms": [
      "GOTO label"
    ],
    "desc": "Continues the program at the line label:. A label is a line consisting of a name followed by a colon; GOTO can only go to labels (there are no line numbers).",
    "example": "n = 0\nagain:\nn = n + 1\nPRINT n\nIF n < 3 THEN GOTO again\nPRINT \"finished\""
  },
  "GRAB": {
    "kind": "statement",
    "package": "sprite",
    "syntax": "GRAB slot, row, col, width, height",
    "forms": [
      "GRAB slot, row, col, width, height"
    ],
    "desc": "Copies a rectangle of the screen -- both the pixels and the colours -- into a sprite slot (0 to 7). The rectangle starts at character cell row, col and is width by height character cells (each from 1 to 4). The picture stays on the screen; the copy is kept until you GRAB into that slot again. Needs the sprite package: type LOAD \"SPRITE\" EXT first. See Part 5.",
    "example": "INK 2\nPAPER 6\nLINE 23, 16 TO 31, 24\nLINE 31, 24 TO 23, 31\nLINE 23, 31 TO 16, 24\nLINE 16, 24 TO 23, 16\n…"
  },
  "HIDE": {
    "kind": "statement",
    "package": "sprite",
    "syntax": "HIDE slot",
    "forms": [
      "HIDE slot"
    ],
    "desc": "Removes a shown sprite, restoring the screen exactly as it was underneath it. Hiding a sprite that is not shown is a run-time error. Needs the sprite package: type LOAD \"SPRITE\" EXT first.",
    "example": "INK 2\nPAPER 6\nLINE 23, 16 TO 31, 24\nLINE 31, 24 TO 23, 31\nLINE 23, 31 TO 16, 24\nLINE 16, 24 TO 23, 16\n…"
  },
  "IF": {
    "kind": "statement",
    "package": null,
    "syntax": "IF condition THEN ... [ELSE ...] ENDIF IF condition THEN GOTO label",
    "forms": [
      "IF condition THEN ... [ELSE ...] ENDIF",
      "IF condition THEN GOTO label"
    ],
    "desc": "Chooses what to do. In the block form, THEN is the last thing on its line; the statements that follow, up to ELSE or ENDIF, run when the condition is true (not 0), and those between ELSE and ENDIF run when it is false. Every block IF is closed by ENDIF.",
    "example": "score = 75\nIF score > 100 THEN\n  PRINT \"WELL DONE\"\nELSE\n  IF score > 50 THEN\n    PRINT \"GOOD\"\n…"
  },
  "IN": {
    "kind": "function",
    "package": null,
    "syntax": "IN(port)",
    "forms": [
      "IN(port)"
    ],
    "desc": "Reads one byte from an input port. port is the full 16-bit port address: the high byte also selects which keyboard half-row is read, as on the Spectrum (IN(65278) reads the row with CAPS SHIFT, IN(32766) the row with SPACE). Joystick and keyboard bits are active low.",
    "example": "k = IN(65278)\nPRINT k >= 0\nPRINT k <= 255"
  },
  "INK": {
    "kind": "statement",
    "package": null,
    "syntax": "INK n",
    "forms": [
      "INK n"
    ],
    "desc": "Sets the ink (foreground) colour used for printing and drawing from now on. Only the low three bits of n count, so the colours repeat every eight: | n | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | |---|---|---|---|---|---|---|---|---| | colour | black | blue | red | magenta | green | cyan | yellow | white | basic ex=kw.ink.1 INK 2 PAPER 6 CLS PRINT ATTR(0, 0)  output ex=kw.ink.1 50  Colour changes affect what is printed or drawn…",
    "example": "INK 2\nPAPER 6\nCLS\nPRINT ATTR(0, 0)"
  },
  "INKEY$": {
    "kind": "function",
    "package": null,
    "syntax": "INKEY$()",
    "forms": [
      "INKEY$()"
    ],
    "desc": "The key being held down right now, as a one-character string, or the empty string \"\" if no key is down. It does not wait for a key.",
    "example": "a$ = INKEY$()\nPRINT LEN(a$)"
  },
  "INPUT": {
    "kind": "statement",
    "package": null,
    "syntax": "INPUT variable INPUT \"prompt\"; variable INPUT \"prompt\", variable",
    "forms": [
      "INPUT variable",
      "INPUT \"prompt\"; variable",
      "INPUT \"prompt\", variable"
    ],
    "desc": "Waits for you to type something and press ENTER, and stores it in variable. A numeric variable takes a number (fractions are fine, up to 20 characters; anything that is not a number gives 0, and text after a number is ignored: 12abc gives 12). A string variable (a$) takes up to 31 characters. What you type is shown on the screen as you type it.",
    "example": "INPUT n\nPRINT n + 1"
  },
  "INT": {
    "kind": "function",
    "package": null,
    "syntax": "INT(n)",
    "forms": [
      "INT(n)"
    ],
    "desc": "n with its fraction cut off, toward zero. (Sinclair BASIC rounds down instead, so INT(-3.5) is -4 there but -3 here.) For a whole number the result is the number itself.",
    "example": "PRINT INT(3.7)\nPRINT INT(-3.7)\nPRINT INT(7 / 2)\nPRINT INT(5)"
  },
  "INVERSE": {
    "kind": "statement",
    "package": null,
    "syntax": "INVERSE n",
    "forms": [
      "INVERSE n"
    ],
    "desc": "When n is 1, what is printed next has its ink and paper colours swapped. Only the low bit counts.",
    "example": "INVERSE 1\nCLS\nPRINT ATTR(0, 0)"
  },
  "INVERT": {
    "kind": "statement",
    "package": "graphics",
    "syntax": "INVERT x0, y0, x1, y1",
    "forms": [
      "INVERT x0, y0, x1, y1"
    ],
    "desc": "Flips every pixel of a rectangle: set pixels become clear and clear pixels become set, whatever OVER is. Doing it twice puts the picture back. Needs the graphics package: type LOAD \"GRAPHICS\" EXT first. See Part 5.",
    "example": "INK 1\nBLOCK 40, 40, 140, 110\nINVERT 100, 80, 200, 150"
  },
  "LEFT$": {
    "kind": "function",
    "package": null,
    "syntax": "LEFT$(a$, n)",
    "forms": [
      "LEFT$(a$, n)"
    ],
    "desc": "The first n characters of a$. If n is larger than the length you get the whole string; n of 0 (or less) gives \"\".",
    "example": "PRINT LEFT$(\"abcdef\", 2)\nPRINT LEFT$(\"abcdef\", 99)\nPRINT LEN(LEFT$(\"abcdef\", 0))"
  },
  "LEN": {
    "kind": "function",
    "package": null,
    "syntax": "LEN(a$)",
    "forms": [
      "LEN(a$)"
    ],
    "desc": "The number of characters in a$ (0 to 31).",
    "example": "PRINT LEN(\"hello world\")\nPRINT LEN(\"\")\nPRINT LEN(STR$(12345))"
  },
  "LINE": {
    "kind": "statement",
    "package": null,
    "syntax": "LINE x0, y0 TO x1, y1",
    "forms": [
      "LINE x0, y0 TO x1, y1"
    ],
    "desc": "Draws a straight line between two pixels, in the current ink. x runs 0 to 255 from the left and y 0 to 191 from the top (this differs from Sinclair BASIC, where y counts up from the bottom). Coordinates off the screen are moved to the nearest edge.",
    "example": "INK 1\nLINE 20, 30 TO 235, 30\nLINE 235, 30 TO 235, 170\nLINE 235, 170 TO 20, 170\nLINE 20, 170 TO 20, 30\nINK 2\n…"
  },
  "LIST": {
    "kind": "command",
    "package": null,
    "syntax": "LIST",
    "forms": [
      "LIST"
    ],
    "desc": "Typed on the editor's empty last line. Shows the program from its first line, keywords in bold, 23 lines at a time. When the screen is full it waits for a key and then shows the next page; BREAK (CAPS SHIFT + SPACE) at a full page stops the listing. At the end of the program it waits for a key and returns to the editor.",
    "example": null
  },
  "LLIST": {
    "kind": "statement",
    "package": "printer",
    "syntax": "LLIST",
    "forms": [
      "LLIST"
    ],
    "desc": "Prints the program, one program line per printed line (a long line wraps at 32 characters), on the ZX Printer. Needs the printer package; without it LLIST is not known and the program fails to compile. See Part 5.",
    "example": "PRINT \"listing\"\nLLIST"
  },
  "LOAD": {
    "kind": "command",
    "package": null,
    "syntax": "LOAD \"name\" LOAD \"\" LOAD \"name\" ARRAY array LOAD \"name\" EXT",
    "forms": [
      "LOAD \"name\"",
      "LOAD \"\"",
      "LOAD \"name\" ARRAY array",
      "LOAD \"name\" EXT"
    ],
    "desc": "Reads from tape what SAVE wrote: | Command | Loads | |---|---| | LOAD \"name\" | the program called name -- and, if it was saved with ALL, the variables and arrays that went with it | | LOAD \"\" | the next program on the tape, whatever its name | | LOAD \"name\" ARRAY a | one array, into the Array Store (the program is not touched) | | LOAD \"name\" EXT | a package (see Part 5) | basic ex=kw.load.1 PRINT \"from tape\"  tape e…",
    "example": "PRINT \"from tape\""
  },
  "LOWER$": {
    "kind": "function",
    "package": null,
    "syntax": "LOWER$(a$)",
    "forms": [
      "LOWER$(a$)"
    ],
    "desc": "a$ with its capital letters changed to lower case.",
    "example": "PRINT LOWER$(\"Hello, WORLD 1\")"
  },
  "LPRINT": {
    "kind": "statement",
    "package": "printer",
    "syntax": "LPRINT expression",
    "forms": [
      "LPRINT expression"
    ],
    "desc": "Prints one number or string on the ZX Printer, wrapping at 32 characters. Needs the printer package; without it, LPRINT is a compile error. Only one item may follow LPRINT (not a list), and a number is printed as a whole number. See Part 5.",
    "example": "LPRINT \"hello\"\nLPRINT 42\nPRINT \"sent\""
  },
  "MID$": {
    "kind": "function",
    "package": null,
    "syntax": "MID$(a$, start, length)",
    "forms": [
      "MID$(a$, start, length)"
    ],
    "desc": "length characters of a$, starting at character number start. The first character is number 1. A start below 1 counts as 1; a length that runs past the end gives what is left; a start beyond the end gives \"\".",
    "example": "PRINT MID$(\"abcdef\", 3, 2)\nPRINT MID$(\"abcdef\", 3, 99)\nPRINT LEN(MID$(\"abcdef\", 10, 2))\nPRINT MID$(\"abcdef\", -1, 3)"
  },
  "MOD": {
    "kind": "function",
    "package": null,
    "syntax": "MOD(a, b)",
    "forms": [
      "MOD(a, b)"
    ],
    "desc": "The remainder of a divided by b, with the sign of a (truncating division). Fractions are cut off first. b of 0 stops the program with a run-time error.",
    "example": "PRINT MOD(17, 5)\nPRINT MOD(-10, 3)\nPRINT MOD(10, -3)\nPRINT MOD(20, 4)"
  },
  "MODE": {
    "kind": "statement",
    "package": "mode",
    "syntax": "MODE m",
    "forms": [
      "MODE m"
    ],
    "desc": "Selects the video mode: MODE 0 is the normal mode and MODE 1 the TS2068's extended-colour mode (every row of eight pixels can have its own colours; the ROM's own source calls it \"High Resolution Graphics\", which it is not). Any other value is a run-time error. Needs the mode package. See Part 5.",
    "example": "MODE 1\nMODE 0\nPRINT \"back to normal\""
  },
  "MOVE": {
    "kind": "statement",
    "package": "sprite",
    "syntax": "MOVE slot, row, col",
    "forms": [
      "MOVE slot, row, col"
    ],
    "desc": "Moves a shown sprite to a new character cell: the screen under the old position is restored, and the sprite is drawn at the new one. Moving a sprite that is not shown is a run-time error. Needs the sprite package: type LOAD \"SPRITE\" EXT first.",
    "example": "INK 2\nPAPER 6\nLINE 23, 16 TO 31, 24\nLINE 31, 24 TO 23, 31\nLINE 23, 31 TO 16, 24\nLINE 16, 24 TO 23, 16\n…"
  },
  "NEW": {
    "kind": "command",
    "package": null,
    "syntax": "NEW",
    "forms": [
      "NEW"
    ],
    "desc": "Typed on the editor's empty last line. Wipes the program, the variables kept from the last run, the Array Store, and any loaded package, and starts a clean machine.",
    "example": null
  },
  "NEXT": {
    "kind": "part of",
    "package": null,
    "syntax": "NEXT [variable]",
    "forms": [
      "NEXT [variable]"
    ],
    "desc": "Ends the body of a FOR loop and adds the step. See FOR.",
    "example": null
  },
  "NOT": {
    "kind": "operator",
    "package": null,
    "syntax": "NOT value",
    "forms": [
      "NOT value"
    ],
    "desc": "1 if value is 0, otherwise 0. NOT is a logical operator (no bit patterns). It binds more loosely than the comparisons, so NOT a = 4 means NOT (a = 4); use brackets for anything else.",
    "example": "a = 5\nPRINT NOT 0\nPRINT NOT 5\nPRINT NOT a = 4\nPRINT NOT NOT 3"
  },
  "OR": {
    "kind": "operator",
    "package": null,
    "syntax": "a OR b",
    "forms": [
      "a OR b"
    ],
    "desc": "True (1) when a or b (or both) is true; otherwise 0. Like AND, it is a logical operator giving 0 or 1, and it stops as soon as the answer is known: if a is true, b is not evaluated. OR binds more loosely than AND.",
    "example": "a = 5\nPRINT a < 3 OR a > 4\nPRINT 0 OR 7\nPRINT 0 OR 0"
  },
  "OUT": {
    "kind": "statement",
    "package": null,
    "syntax": "OUT port, value",
    "forms": [
      "OUT port, value"
    ],
    "desc": "Writes the low byte of value to an output port. port is the full 16-bit port address.",
    "example": "OUT 254, 2\nPRINT \"red border\""
  },
  "OVER": {
    "kind": "statement",
    "package": null,
    "syntax": "OVER n",
    "forms": [
      "OVER n"
    ],
    "desc": "When n is 1, printing and drawing exclusive-OR with what is already on the screen: drawing a pixel that is already set clears it, and printing a character over itself erases it. OVER 0 returns to normal. Only the low bit counts.",
    "example": "PLOT 10, 100\nOVER 1\nPLOT 10, 100\nOVER 0\nPRINT POINT(10, 100)\nPRINT \"A\"\n…"
  },
  "PALETTE": {
    "kind": "statement",
    "package": "mode",
    "syntax": "PALETTE index, value",
    "forms": [
      "PALETTE index, value"
    ],
    "desc": "Writes value to ULAplus palette entry index (0 to 63). Needs the mode package and a machine or emulator with ULAplus. An index of 64 or more is a run-time error. See Part 5.",
    "example": "ULAPLUS 1\nPALETTE 0, 255\nULAPLUS 0\nPRINT \"palette set\""
  },
  "PAPER": {
    "kind": "statement",
    "package": null,
    "syntax": "PAPER n",
    "forms": [
      "PAPER n"
    ],
    "desc": "Sets the paper (background) colour for what is printed or drawn next; CLS paints the whole screen with it. The colours are those of INK; only the low three bits of n count.",
    "example": "PAPER 6\nINK 2\nCLS\nPRINT ATTR(5, 5)"
  },
  "PAUSE": {
    "kind": "statement",
    "package": null,
    "syntax": "PAUSE n",
    "forms": [
      "PAUSE n"
    ],
    "desc": "Waits for n frames (one frame is one display interrupt: 1/60 s on a TS2068, 1/50 s in the qualification emulator) and goes on; n can be 1 to 65535. PAUSE 0 waits for a key to be pressed. BREAK ends a long pause.",
    "example": "PRINT \"wait\"\nPAUSE 50\nPRINT \"done\""
  },
  "PEEK": {
    "kind": "function",
    "package": null,
    "syntax": "PEEK(address)",
    "forms": [
      "PEEK(address)"
    ],
    "desc": "The byte (0 to 255) stored at an address (0 to 65535). Reading the ROM works; writing it (with POKE) does nothing.",
    "example": "POKE 23296, 65\nPRINT PEEK(23296)\nPRINT PEEK(0)"
  },
  "PI": {
    "kind": "function",
    "package": null,
    "syntax": "PI()",
    "forms": [
      "PI()"
    ],
    "desc": "The number pi, 3.14159265... (written with brackets, like every function).",
    "example": "PRINT PI()\nPRINT 2 * PI()"
  },
  "PLOT": {
    "kind": "statement",
    "package": null,
    "syntax": "PLOT x, y",
    "forms": [
      "PLOT x, y"
    ],
    "desc": "Sets one pixel, in the current ink colour. The screen is 256 pixels wide and 192 high; x counts from the left (0 to 255) and y from the top (0 to 191). Values outside the screen are moved to the nearest edge, and a fraction is cut off.",
    "example": "INK 1\nFOR x = 0 TO 255\n  PLOT x, 96 - INT(70 * SIN(x * 360 / 256))\nNEXT x"
  },
  "POINT": {
    "kind": "function",
    "package": null,
    "syntax": "POINT(x, y)",
    "forms": [
      "POINT(x, y)"
    ],
    "desc": "1 if the pixel at x, y is set (ink), 0 if it is clear (paper). Coordinates are as for PLOT, and off-screen values are moved to the nearest edge.",
    "example": "LINE 100, 100 TO 107, 107\nLINE 107, 100 TO 100, 107\nFOR y = 100 TO 107\n  a$ = \"\"\n  FOR x = 100 TO 107\n    IF POINT(x, y) = 1 THEN\n…"
  },
  "POKE": {
    "kind": "statement",
    "package": null,
    "syntax": "POKE address, value",
    "forms": [
      "POKE address, value"
    ],
    "desc": "Stores a byte in memory: the low byte of value, so POKE a, 300 stores 44 and POKE a, -1 stores 255. A fraction is cut off. address is 0 to 65535; above that is a run-time error. Writing to the ROM does nothing.",
    "example": "POKE 23296, 300\nPRINT PEEK(23296)\nPOKE 23296, -1\nPRINT PEEK(23296)"
  },
  "PRINT": {
    "kind": "statement",
    "package": null,
    "syntax": "PRINT [item [separator item]... [separator]]",
    "forms": [
      "PRINT [item [separator item]... [separator]]"
    ],
    "desc": "Shows values on the screen, starting at the printing position. An item is a number or a string (anything that can follow = in an assignment). The separator between items is • ; -- the next item follows immediately, with nothing between; • , -- the next item starts at the next zone: columns 0 and 16 (two zones per 32-column row).",
    "example": "PRINT \"A\"; \"B\"\nPRINT \"A\", \"B\"\nPRINT 1; 2; 3\nPRINT\nPRINT \"x\";\nPRINT \"y\""
  },
  "PROC": {
    "kind": "statement",
    "package": null,
    "syntax": "PROC name(parameter): ... ENDP",
    "forms": [
      "PROC name(parameter): ... ENDP"
    ],
    "desc": "Defines a procedure: a named piece of program that you run with CALL. It has exactly one parameter, which gets the value passed by CALL. The statements run until ENDP, and then the program returns to the statement after the CALL.",
    "example": "CALL squareof(7)\nCALL squareof(12)\nEND\nPROC squareof(n):\n  PRINT n; \" squared is \"; n * n\nENDP"
  },
  "RAD": {
    "kind": "function",
    "package": null,
    "syntax": "RAD(d)",
    "forms": [
      "RAD(d)"
    ],
    "desc": "Converts an angle from degrees to radians.",
    "example": "PRINT RAD(180)\nPRINT RAD(90)"
  },
  "RANDOMISE": {
    "kind": "statement",
    "package": null,
    "syntax": "RANDOMISE n",
    "forms": [
      "RANDOMISE n"
    ],
    "desc": "Sets the starting point of the random number sequence of RND. The same n always gives the same sequence, which is useful for repeatable tests. A program that wants different numbers each time must give RANDOMISE something that changes (a value read from the keyboard timing, say); RANDOMISE with no number is a compile error.",
    "example": "RANDOMISE 5\na = RND(1000)\nRANDOMISE 5\nb = RND(1000)\nPRINT a = b\nPRINT a"
  },
  "REM": {
    "kind": "statement",
    "package": null,
    "syntax": "REM text",
    "forms": [
      "REM text"
    ],
    "desc": "A remark. Everything from REM to the end of the line is ignored (even a :), so a remark can end a line after other statements.",
    "example": "REM this whole line is ignored : PRINT \"no\"\nx = 1 : REM and so is this\nPRINT x"
  },
  "RIGHT$": {
    "kind": "function",
    "package": null,
    "syntax": "RIGHT$(a$, n)",
    "forms": [
      "RIGHT$(a$, n)"
    ],
    "desc": "The last n characters of a$; the whole string if n is larger than its length.",
    "example": "PRINT RIGHT$(\"abcdef\", 2)\nPRINT RIGHT$(\"abcdef\", 99)"
  },
  "RND": {
    "kind": "function",
    "package": null,
    "syntax": "RND(n)",
    "forms": [
      "RND(n)"
    ],
    "desc": "A random whole number from 0 to n - 1. (RND(6) is 0, 1, 2, 3, 4 or 5.) With n below 1 the result is 0.",
    "example": "RANDOMISE 7\nFOR i = 1 TO 3\n  PRINT RND(6)\nNEXT i\nPRINT RND(1)\nPRINT RND(0)"
  },
  "RUN": {
    "kind": "command",
    "package": null,
    "syntax": "RUN",
    "forms": [
      "RUN"
    ],
    "desc": "Typed on the editor's empty last line. Compiles the whole program, and, if there is no error, runs it with fresh variables. If the compiler finds a mistake, nothing runs: the message appears on the status line, and when you press a key the cursor goes to the line where the error was found.",
    "example": null
  },
  "SAVE": {
    "kind": "command",
    "package": null,
    "syntax": "SAVE \"name\" SAVE \"name\" ALL SAVE \"name\" ARRAY array SAVE \"name\" EXT",
    "forms": [
      "SAVE \"name\"",
      "SAVE \"name\" ALL",
      "SAVE \"name\" ARRAY array",
      "SAVE \"name\" EXT"
    ],
    "desc": "Writes to tape (or the emulator's tape output). name is up to 10 characters.",
    "example": "x = 5\ny$ = \"hello\"\nz = 2.5"
  },
  "SGN": {
    "kind": "function",
    "package": null,
    "syntax": "SGN(n)",
    "forms": [
      "SGN(n)"
    ],
    "desc": "The sign of n: -1, 0 or 1.",
    "example": "PRINT SGN(-7)\nPRINT SGN(0)\nPRINT SGN(0.5)"
  },
  "SHOW": {
    "kind": "statement",
    "package": "sprite",
    "syntax": "SHOW slot, row, col",
    "forms": [
      "SHOW slot, row, col"
    ],
    "desc": "Draws a grabbed sprite at character cell row, col, remembering the screen underneath so that HIDE or MOVE can restore it. The slot must have been grabbed (GRAB) and must not already be shown. Needs the sprite package: type LOAD \"SPRITE\" EXT first. See GRAB for a complete example.",
    "example": "INK 2\nPAPER 6\nLINE 23, 16 TO 31, 24\nLINE 31, 24 TO 23, 31\nLINE 23, 31 TO 16, 24\nLINE 16, 24 TO 23, 16\n…"
  },
  "SIN": {
    "kind": "function",
    "package": null,
    "syntax": "SIN(angle)",
    "forms": [
      "SIN(angle)"
    ],
    "desc": "The sine of an angle in degrees.",
    "example": "PRINT SIN(30)\nPRINT SIN(90)\nPRINT SIN(0.5)"
  },
  "SOUND": {
    "kind": "statement",
    "package": null,
    "syntax": "SOUND register, value",
    "forms": [
      "SOUND register, value"
    ],
    "desc": "Writes value (0 to 255) to a register of the AY-3-8912 sound chip. The chip makes three tones and a noise, and keeps playing while the program goes on, until you silence it.",
    "example": "SOUND 7, 62\nSOUND 0, 200\nSOUND 1, 1\nSOUND 8, 10\nPAUSE 50\nSOUND 8, 0\n…"
  },
  "SQR": {
    "kind": "function",
    "package": null,
    "syntax": "SQR(n)",
    "forms": [
      "SQR(n)"
    ],
    "desc": "The square root of n. A negative n stops the program with a run-time error. The result is a floating-point number.",
    "example": "PRINT SQR(16)\nPRINT SQR(2)\nPRINT SQR(0)"
  },
  "STEP": {
    "kind": "part of",
    "package": null,
    "syntax": "STEP value",
    "forms": [
      "STEP value"
    ],
    "desc": "Gives the amount a FOR loop adds each time round. See FOR.",
    "example": null
  },
  "STICK": {
    "kind": "function",
    "package": null,
    "syntax": "STICK(n)",
    "forms": [
      "STICK(n)"
    ],
    "desc": "Reads joystick n (1 or 2) through the sound chip's input port. Any other n is a run-time error. STICK(1) gives a number from 0 to 15, one bit per direction switch (a bit is 1 while its switch is closed; 0 means nothing is pressed). STICK(2) gives 0 or 1 -- a hardware limitation of the machine's second joystick connection, not of BASIC.",
    "example": "j = STICK(1)\nPRINT j >= 0 AND j <= 15\nk = STICK(2)\nPRINT k >= 0 AND k <= 1"
  },
  "STOP": {
    "kind": "statement",
    "package": null,
    "syntax": "STOP",
    "forms": [
      "STOP"
    ],
    "desc": "Stops the program, like END. Variables are kept (see Sessions), so you can look at them with : PRINT x and carry on with : GOTO label.",
    "example": "PRINT \"a\"\nSTOP\nPRINT \"b\""
  },
  "STR$": {
    "kind": "function",
    "package": null,
    "syntax": "STR$(n)",
    "forms": [
      "STR$(n)"
    ],
    "desc": "The number n as a string, spelled exactly as PRINT would show it.",
    "example": "PRINT STR$(5) + \"!\"\nPRINT STR$(-2.5)\nPRINT STR$(0)\nPRINT LEN(STR$(100))"
  },
  "TAB": {
    "kind": "statement",
    "package": null,
    "syntax": "TAB col",
    "forms": [
      "TAB col"
    ],
    "desc": "Moves the printing position to column col of the current row (0 is the left edge). The column is taken modulo 32. Used before PRINT, as AT is.",
    "example": "TAB 10\nPRINT \"tab10\"\nTAB 40\nPRINT \"Z\""
  },
  "TAN": {
    "kind": "function",
    "package": null,
    "syntax": "TAN(angle)",
    "forms": [
      "TAN(angle)"
    ],
    "desc": "The tangent of an angle in degrees. TAN(90) and the other odd multiples of 90 stop the program with a run-time error.",
    "example": "PRINT TAN(45)\nPRINT TAN(0)"
  },
  "THEN": {
    "kind": "part of",
    "package": null,
    "syntax": "THEN",
    "forms": [
      "THEN"
    ],
    "desc": "Follows the condition of an IF. See IF.",
    "example": null
  },
  "TO": {
    "kind": "part of",
    "package": null,
    "syntax": "TO",
    "forms": [
      "TO"
    ],
    "desc": "Separates the start from the limit in FOR, and the two end points in LINE.",
    "example": null
  },
  "ULAPLUS": {
    "kind": "statement",
    "package": "mode",
    "syntax": "ULAPLUS n",
    "forms": [
      "ULAPLUS n"
    ],
    "desc": "Turns the ULAplus colour extension off (0) or on (1) on hardware that has it. Any other value is a run-time error. Needs the mode package. See Part 5 and PALETTE.",
    "example": "ULAPLUS 1\nULAPLUS 0\nPRINT \"ok\""
  },
  "UPPER$": {
    "kind": "function",
    "package": null,
    "syntax": "UPPER$(a$)",
    "forms": [
      "UPPER$(a$)"
    ],
    "desc": "a$ with its small letters changed to capitals.",
    "example": "PRINT UPPER$(\"Hello, world 1\")"
  },
  "USR": {
    "kind": "function",
    "package": null,
    "syntax": "USR(address)",
    "forms": [
      "USR(address)"
    ],
    "desc": "Runs the machine-code routine that starts at address, and gives its result as a number from 0 to 65535.",
    "example": "REM machine code at 23296: LD HL,777 / RET\nPOKE 23296, 33\nPOKE 23297, 9\nPOKE 23298, 3\nPOKE 23299, 201\nPRINT USR(23296)"
  },
  "VAL": {
    "kind": "function",
    "package": null,
    "syntax": "VAL(a$)",
    "forms": [
      "VAL(a$)"
    ],
    "desc": "The number at the start of a$. Leading spaces and a sign are allowed; the number may have a fraction; reading stops at the first character that cannot continue it. If there is no number, the result is 0.",
    "example": "PRINT VAL(\"42\")\nPRINT VAL(\"3.5abc\")\nPRINT VAL(\"abc\")\nPRINT VAL(\"  -7\")\nPRINT VAL(\"1.5.2\")\nPRINT VAL(\"\")"
  },
  "VERIFY": {
    "kind": "command",
    "package": null,
    "syntax": "VERIFY \"name\"",
    "forms": [
      "VERIFY \"name\""
    ],
    "desc": "Compares the tape with what is in memory, without changing memory, and reports VERIFIED or VERIFY FAILED. VERIFY of a program saved with ALL also checks the saved variables, and, like SAVE ... ALL, takes about 2.4 seconds to get ready.",
    "example": "PRINT \"hello\"\nx = 7"
  }
};
