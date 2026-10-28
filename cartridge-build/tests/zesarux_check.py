#!/usr/bin/env python3
"""Run a cartridge in ZEsarUX (the qualified emulator) with the stock TS2068 ROMs and compare its final
screen with TSRun's (tools/cartrun.mjs) for the same .dck.

  python3 tests/zesarux_check.py CART.dck [--seconds 15] [--port 10777]

ZEsarUX runs headless (--vo null --ao null) with ZRCP; the cartridge goes in with `smartload`, which
resets the machine into the stock ROM's LROS probe. After SECONDS of emulated running the display
file and attributes ($4000-$5AFF) are read and compared byte for byte with TSRun after 600 frames.
Uses ~/ts2068-debug's ZRCP client. Exit 0 = identical screens.
"""
import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path.home() / "ts2068-debug"))
from ts2068_debug.zrcp import ZRCPClient  # noqa: E402

ZDIR = Path.home() / "Applications/ZEsarUX-13.0"
HERE = Path(__file__).resolve().parent


def zesarux_screen(dck, seconds, port):
    proc = subprocess.Popen(
        ["./zesarux", "--noconfigfile", "--machine", "TS2068", "--enable-remoteprotocol",
         "--remoteprotocol-port", str(port), "--vo", "null", "--ao", "null",
         "--romfile", str(ZDIR / "ts2068.rom")],
        cwd=ZDIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        c = ZRCPClient(port=port)
        c.connect()
        c.command(f"smartload {Path(dck).resolve()}")
        time.sleep(seconds)                     # free-running at real speed
        c.command("enter-cpu-step")
        hexdump = c.command("read-memory 16384 6912")
        ports = c.command("get-io-ports")
        c.close()
        return bytes.fromhex("".join(hexdump.split())), ports
    finally:
        proc.terminate()
        proc.wait(timeout=10)


def tsrun_screen(dck):
    out = subprocess.run(["node", str(HERE.parent / "tools/cartrun.mjs"), "--dck", str(dck), "--frames", "600",
                          "--dump", "4000:6912"], capture_output=True, text=True, check=True).stdout
    line = next(l for l in out.splitlines() if l.startswith("$4000:"))
    return bytes.fromhex(line.split(":", 1)[1].replace(" ", ""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dck")
    ap.add_argument("--seconds", type=float, default=15)
    ap.add_argument("--port", type=int, default=10777)
    a = ap.parse_args()
    z, ports = zesarux_screen(a.dck, a.seconds, a.port)
    t = tsrun_screen(a.dck)
    diff = sum(x != y for x, y in zip(z, t))
    blank = all(b == z[0] for b in z[:6144])
    print(f"{a.dck}: ZEsarUX vs TSRun -- {diff} of 6912 bytes differ{' (ZEsarUX screen blank)' if blank else ''}")
    print("ZEsarUX ports:", " ".join(ports.split())[:200])
    sys.exit(0 if diff == 0 and not blank else 1)


if __name__ == "__main__":
    main()
