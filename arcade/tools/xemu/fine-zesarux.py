#!/usr/bin/env python3
"""Run a fine-colour sample game (Starfall = shooter, Lumen = lumen; runtime v2, arcade/build/<game>.dck) in ZEsarUX 13.0 (headless, stock TS2068 ROM) and sample it at the start of
the game's FRAME call of every tick.  Adapted from orbit-zesarux.py; the same sampling point as fine-tsrun.mjs: a breakpoint at the runtime's FINE_FRAME (the fine tick has published
the picture of the tick before and is about to call the game's FRAME entry), where V_TICKS = the ticks completed and the screen ($4000 bitmap, $6000 colour plane, $FF = 2) is a
complete fine picture.

  python3 arcade/tools/xemu/fine-zesarux.py shooter|lumen [--mode keys|script] [--out DIR] [--tag NAME] [--port 10777]

  --mode keys    the scenario's stick values (<game>-fine-scenario.json) become keys (left O, right P, up Q, down A, fire SPACE), pressed through ZRCP `send-keys-event` at the
                 FINE_FRAME where V_TICKS becomes t (the emulator is stopped there; the FRAME call that runs next reads them)
  --mode script  no keys: the cartridge patched by fine-patch.mjs (arcade/build/<game>-script.dck)
Writes, with prefix <out>/<tag> (default arcade/build/xemu/<game>-fine/<game>-zesarux[-script]): the same files as fine-tsrun.mjs:
  -t<N>.bin        12,288 bytes: the bitmap and the colour plane at FINE_FRAME with V_TICKS = N          (every tick)
  -state-t<N>.bin  RT_SEED + GAME_VARS + SPR_TAB + CELL_TILE + CELL_ATTR at that point                    (the sampled ticks)
  -log.txt         one line per tick, the columns of fine-tsrun.mjs
Joystick: AY register 14 reads 0 in ZEsarUX, which the runtime's RT_STICK takes as "no stick", so STICK(1) is not exercised with a pressed stick (TSRun's joystick mode does that).
"""
import hashlib
import json
import subprocess
import sys
import time
import argparse
from pathlib import Path

sys.path.insert(0, str(Path.home() / "ts2068-debug"))
from ts2068_debug.zrcp import ZRCPClient  # noqa: E402

ZDIR = Path.home() / "Applications/ZEsarUX-13.0"
HERE = Path(__file__).resolve().parent
ARCADE = HERE.parents[1]
KEYCODE = {"O": ord("o"), "P": ord("p"), "Q": ord("q"), "A": ord("a"), "SPACE": 128}
STICK_KEYS = [(4, "O"), (8, "P"), (1, "Q"), (2, "A"), (16, "SPACE")]   # stick bit -> key
LOG_VARS = {"shooter": ["SCORE", "WV", "PLAY.LIVES"], "lumen": ["SCORE", "CAVE", "PLAY.LIVES", "PLAY.WX", "PLAY.WY", "PLAY.ORBS"]}   # as fine-tsrun.mjs
LOG_HEADER = "ticks scene vfine ff keys(V_KEYS[0..7]) border V_FRAMES(refreshes since boot) vars... md5(picture)"


def read(c, addr, n):
    out = b""
    while n > 0:
        k = min(n, 2048)
        out += bytes.fromhex("".join(c.command(f"read-memory {addr} {k}").split()))
        addr += k
        n -= k
    return out


def word(c, addr):
    b = read(c, addr, 2)
    return b[0] | (b[1] << 8)


def pc_of(c):
    txt = c.command("get-registers")
    for tok in txt.replace("\n", " ").split():
        if tok.startswith("PC="):
            return int(tok[3:], 16)
    raise RuntimeError(f"no PC in get-registers: {txt[:200]}")


def s16(x):
    return ((x & 0xFFFF) ^ 0x8000) - 0x8000


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("game", choices=["shooter", "lumen"])
    ap.add_argument("dck", nargs="?", default=None)
    ap.add_argument("--mode", default="keys", choices=["keys", "script"])
    ap.add_argument("--out", default=None)
    ap.add_argument("--tag", default=None)
    ap.add_argument("--port", type=int, default=10777)
    ap.add_argument("--max-hits", type=int, default=20000)
    a = ap.parse_args()
    g = a.game
    rt = json.loads((ARCADE / "build/v2/runtime.json").read_text())
    S, C = rt["symbols"], rt["constants"]
    sc = json.loads((HERE / f"{g}-fine-scenario.json").read_text())
    outdir = ARCADE / "build/xemu" / f"{g}-fine"
    meta = json.loads((outdir / "meta.json").read_text())
    dck = a.dck or str(ARCADE / (f"build/{g}-script.dck" if a.mode == "script" else f"build/{g}.dck"))
    tag = a.tag or (f"{g}-zesarux-script" if a.mode == "script" else f"{g}-zesarux")
    out = Path(a.out) if a.out else outdir
    out.mkdir(parents=True, exist_ok=True)
    P = str(out / tag)
    targets = set(sc["sample_ticks"])
    parts = [(S["RT_SEED"], 2), (C["GAME_VARS_BASE"], C["GAME_VARS_LIMIT"] - C["GAME_VARS_BASE"] + 1),
             (C["SPR_TAB"], 128), (C["CELL_TILE"], 768), (C["CELL_ATTR"], 768)]
    script = [v for v, n in sc["runs"] for _ in range(n)]
    names = LOG_VARS[g]

    def keys_at(t):
        sv = script[t] if t < len(script) else 0
        return {name for bit, name in STICK_KEYS if sv & bit}

    proc = subprocess.Popen(
        ["zesarux", "--noconfigfile", "--machine", "TS2068", "--enable-remoteprotocol",
         "--remoteprotocol-port", str(a.port), "--vo", "null", "--ao", "null",
         "--romfile", str(ZDIR / "ts2068.rom")],
        cwd=ZDIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        c = ZRCPClient(port=a.port, timeout=120)
        c.connect()
        c.command(f"smartload {Path(dck).resolve()}")
        time.sleep(1.0)
        c.command("close-all-menus")
        time.sleep(0.5)
        c.command("enter-cpu-step")
        try:
            c.command("enable-breakpoints")
        except Exception as exc:  # noqa: BLE001
            if "already" not in str(exc).lower():
                raise
        c.command(f"set-breakpoint 1 PC={S['FINE_FRAME']:04X}H")

        log = [LOG_HEADER + " [" + " ".join(names) + "]"]
        held = set()
        last = -1
        hits = 0
        while hits < a.max_hits:
            c.command("run 50000000", timeout=600)
            if pc_of(c) != S["FINE_FRAME"]:
                continue
            hits += 1
            t = word(c, S["V_TICKS"])
            if t == last:
                continue
            last = t
            pic = read(c, 0x4000, 6144) + read(c, 0x6000, 6144)
            ks = read(c, S["V_KEYS"], 8)
            vs = " ".join(str(s16(word(c, meta["vars"][n]))) for n in names)
            log.append(f"{t} {read(c, meta['sceneAddr'], 1)[0]} {read(c, S['V_FINE'], 1)[0]} {read(c, S['V_SHADOW_FF'], 1)[0]} {ks.hex()} {read(c, S['V_BORDER'], 1)[0]} {word(c, S['V_FRAMES'])} {vs} {hashlib.md5(pic).hexdigest()}")
            Path(f"{P}-t{t}.bin").write_bytes(pic)
            if t in targets:
                Path(f"{P}-state-t{t}.bin").write_bytes(b"".join(read(c, ad, n) for ad, n in parts))
            if a.mode == "keys":
                want = keys_at(t)
                for k in sorted(held - want):
                    c.command(f"send-keys-event {KEYCODE[k]} 0")
                for k in sorted(want - held):
                    c.command(f"send-keys-event {KEYCODE[k]} 1")
                held = want
            if t >= sc["last_tick"]:
                break
        else:
            print(f"stopped after {hits} hits")
            sys.exit(1)
        Path(f"{P}-log.txt").write_text("\n".join(log) + "\n")
        print(f"{tag}: {hits} breakpoint hits, last tick {last}, {len(log) - 1} ticks logged")
        c.close()
        sys.exit(0)
    finally:
        proc.terminate()
        proc.wait(timeout=10)


if __name__ == "__main__":
    main()
