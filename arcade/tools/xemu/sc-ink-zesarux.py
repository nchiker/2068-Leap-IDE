#!/usr/bin/env python3
"""Run the ink-build cartridge of the cross-emulator check (tests/arcade-sc-xemu.mjs) in ZEsarUX 13.0 (headless, stock TS2068 ROM) and dump the hidden display file at the end of every tick.

  python3 arcade/tools/xemu/sc-ink-zesarux.py CART.dck RUNTIME.json OUTDIR [--ticks 60] [--port 10777]

The sampling point is the runtime's WORK_END (the tick's work is done, V_TICKS was incremented): the same instruction as in the TSRun side of the test, so the states are compared at
equal ticks.  Writes OUTDIR/t<N>.bin (6144 bitmap bytes + 768 attribute bytes of the hidden file, the finished picture of tick N), N = 1 .. --ticks.  No input is needed (the game
plays itself).  Exit 0 = done, 1 = the run did not reach the tick, 3 = ZEsarUX or the ts2068-debug client is not here (the caller skips).
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

ZDIR = Path.home() / "Applications/ZEsarUX-13.0"
sys.path.insert(0, str(Path.home() / "ts2068-debug"))
try:
    from ts2068_debug.zrcp import ZRCPClient
except ImportError:
    print("ts2068_debug is not installed (~/ts2068-debug)")
    sys.exit(3)


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
    for tok in c.command("get-registers").replace("\n", " ").split():
        if tok.startswith("PC="):
            return int(tok[3:], 16)
    raise RuntimeError("no PC in get-registers")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dck")
    ap.add_argument("runtime")
    ap.add_argument("out")
    ap.add_argument("--ticks", type=int, default=60)
    ap.add_argument("--port", type=int, default=10777)
    ap.add_argument("--max-hits", type=int, default=2000)
    a = ap.parse_args()
    rt = json.loads(Path(a.runtime).read_text())
    S, C = rt["symbols"], rt["constants"]
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    if not (ZDIR / "ts2068.rom").exists():
        print("ZEsarUX 13.0 is not at ~/Applications/ZEsarUX-13.0")
        sys.exit(3)
    proc = subprocess.Popen(
        ["zesarux", "--noconfigfile", "--machine", "TS2068", "--enable-remoteprotocol", "--remoteprotocol-port", str(a.port), "--vo", "null", "--ao", "null",
         "--romfile", str(ZDIR / "ts2068.rom")],
        cwd=ZDIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        c = ZRCPClient(port=a.port, timeout=120)
        c.connect()
        c.command(f"smartload {Path(a.dck).resolve()}")
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
        last, hits = -1, 0
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
            (out / f"t{t}.bin").write_bytes(read(c, dfile, 6144) + read(c, dattr, 768))
            if t >= a.ticks:
                break
        else:
            print(f"stopped after {hits} hits at tick {last}")
            sys.exit(1)
        print(f"zesarux: {hits} breakpoint hits, last tick {last}")
        c.close()
    finally:
        proc.terminate()
        proc.wait(timeout=10)


if __name__ == "__main__":
    main()
