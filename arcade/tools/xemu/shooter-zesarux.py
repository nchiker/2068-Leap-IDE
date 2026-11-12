#!/usr/bin/env python3
"""Run the Starfall cartridge (arcade/examples/shooter.arc, runtime v2, arcade/build/shooter.dck) in ZEsarUX 13.0 (headless, stock TS2068 ROM) and sample it at the end of every tick.
Rewritten after language batch 4 (title scene, play scene, GAME OVER scene) on the model of runner-zesarux.py: the same sampling point as shooter-tsrun.mjs, a breakpoint at
WORK_END (main.asm: the tick's work is done and V_TICKS was incremented), where the game state is "at V_TICKS = N" and the hidden display file (V_HIDDEN) holds the finished picture.

  python3 arcade/tools/xemu/shooter-zesarux.py [CART.dck] [--mode keys|script] [--out arcade/build/xemu/shooter] [--tag NAME] [--port 10777]

Order of the commands: see the header of shooter-tsrun.mjs (scenario, build, patch, tsrun, zesarux, fuse, compare).
  --mode keys    the scenario's stick values (shooter-scenario.json) become keys (left O, right P, up Q, down A, fire SPACE), pressed through ZRCP `send-keys-event` at the
                 WORK_END where V_TICKS becomes t (the emulator is stopped there; the event sets ZEsarUX's keyboard matrix at once, and the FRAME call that runs next reads it
                 a refresh or more later)
  --mode script  no keys: the cartridge patched by shooter-patch.mjs (arcade/build/shooter-script.dck)
Writes, with prefix <out>/<tag> (default shooter-zesarux, shooter-zesarux-script for --mode script), the same files as shooter-tsrun.mjs:
  -t<N>.bin        6912 bytes of the hidden file at WORK_END with V_TICKS = N          (every tick)
  -state-t<N>.bin  GAMEVARS + SPR_TAB + CELL_TILE + RT_SEED at that point              (the sampled ticks)
  -log.txt         one line per tick: ticks scene score wave px py lives keys(V_KEYS[0..7]) border V_FRAMES V_SFX_ACTIVE md5 AY(R0..R10 from AY_SHADOW)
Joystick: AY register 14 reads 0 in ZEsarUX, which the runtime's RT_STICK takes as "no stick" (all four directions at once is impossible, and the whole port is ignored), so
nothing is written to the AY here.  AY: ZEsarUX 13.0's ZRCP has no AY command, so the runtime's own copy AY_SHADOW (its writes to ports $F5 / $F6) is logged.
"""
import argparse
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path.home() / "ts2068-debug"))
from ts2068_debug.zrcp import ZRCPClient  # noqa: E402

ZDIR = Path.home() / "Applications/ZEsarUX-13.0"
HERE = Path(__file__).resolve().parent
ARCADE = HERE.parents[1]
KEYCODE = {"O": ord("o"), "P": ord("p"), "Q": ord("q"), "A": ord("a"), "SPACE": 128}   # send-keys-event codes (ASCII; 128 = SPACE)
STICK_KEYS = [(4, "O"), (8, "P"), (1, "Q"), (2, "A"), (16, "SPACE")]                       # stick bit -> key


def load():
    rt = json.loads((ARCADE / "build/v2/runtime.json").read_text())
    return rt["symbols"], rt["constants"], json.loads((HERE / "shooter-scenario.json").read_text()), json.loads((ARCADE / "build/xemu/shooter/meta.json").read_text())


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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dck", nargs="?", default=None)
    ap.add_argument("--mode", default="keys", choices=["keys", "script"])
    ap.add_argument("--out", default=str(ARCADE / "build/xemu/shooter"))
    ap.add_argument("--tag", default=None)
    ap.add_argument("--port", type=int, default=10777)
    ap.add_argument("--max-hits", type=int, default=5000)
    a = ap.parse_args()
    S, C, sc, meta = load()
    dck = a.dck or str(ARCADE / ("build/shooter-script.dck" if a.mode == "script" else "build/shooter.dck"))
    tag = a.tag or ("shooter-zesarux-script" if a.mode == "script" else "shooter-zesarux")
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    P = str(out / tag)
    targets = set(sc["sample_ticks"])
    parts = [(C["GAME_VARS_BASE"], C["GAME_VARS_LIMIT"] - C["GAME_VARS_BASE"] + 1), (S["SPR_TAB"], 96), (S["CELL_TILE"], 768), (S["RT_SEED"], 2)]
    script = [v for v, n in sc["runs"] for _ in range(n)]
    V = meta["vars"]

    def keys_at(t):
        sv = script[t] if t < len(script) else 0
        return {name for bit, name in STICK_KEYS if sv & bit}

    def s16(x):
        return ((x & 0xFFFF) ^ 0x8000) - 0x8000

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
        c.command(f"set-breakpoint 1 PC={S['WORK_END']:04X}H")

        log = ["ticks scene score wave px py lives keys(V_KEYS[0..7]) border V_FRAMES(refreshes since boot) V_SFX_ACTIVE md5(hidden file) AY(R0..R10, AY_SHADOW)"]
        held = set()
        last = -1
        hits = 0
        while hits < a.max_hits:
            c.command("run 50000000", timeout=600)
            if pc_of(c) != S["WORK_END"]:
                continue
            hits += 1
            if word(c, S["HO_MARK"]) != 0x5AA5:
                continue
            t = word(c, S["V_TICKS"])
            if t == last:
                continue
            last = t
            hidden = read(c, S["V_HIDDEN"], 1)[0]
            dfile, dattr = (C["DFILE1"], C["DATTR1"]) if hidden else (C["DFILE0"], C["DATTR0"])
            scr = read(c, dfile, 6144) + read(c, dattr, 768)
            ks = read(c, S["V_KEYS"], 8)
            g = lambda n: s16(word(c, V[n]))  # noqa: E731
            ay = read(c, S["AY_SHADOW"], 11)
            log.append(f"{t} {word(c, meta['scene'])} {g('SCORE')} {g('WV')} {g('PX')} {g('PY')} {g('LIVES')} {ks.hex()} {read(c, S['V_BORDER'], 1)[0]} {word(c, S['V_FRAMES'])} "
                       f"{read(c, S['V_SFX_ACTIVE'], 1)[0]} {hashlib.md5(scr).hexdigest()} {' '.join(f'{v:02x}' for v in ay)}")
            Path(f"{P}-t{t}.bin").write_bytes(scr)
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
