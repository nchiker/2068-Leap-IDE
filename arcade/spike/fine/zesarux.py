#!/usr/bin/env python3
"""Run an F1 cartridge built with STOPAT=n in ZEsarUX 13.0 (headless, stock TS2068 ROM, ZRCP); when it has stopped (V_STOP = $A5),
save the bitmap and the colour plane (zone 0, "Machine RAM") and a rendered screenshot (save-screen .bmp, from ZEsarUX's own display).

  python3 arcade/spike/fine/zesarux.py build/xA/fine.dck build/xA [--port 10781] [--timeout 120]

Writes OUTDIR/zesarux-mem.bin (6,144 bitmap bytes, then 6,144 colour bytes) and OUTDIR/zesarux.bmp.  Compare with compare-xemu.mjs.
As arcade/spike/bank/zesarux.py: ZEsarUX started from its folder with --vo null --ao null, the cartridge put in with smartload.
"""
import argparse
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path.home() / "ts2068-debug"))
from ts2068_debug.zrcp import ZRCPClient  # noqa: E402

ZDIR = Path.home() / "Applications/ZEsarUX-13.0"


def rd(c, addr, n):
    out = b""
    while n > 0:
        k = min(n, 8192)
        out += bytes.fromhex("".join(c.command(f"read-memory {addr} {k}").split()))
        addr += k
        n -= k
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dck")
    ap.add_argument("outdir")
    ap.add_argument("--port", type=int, default=10781)
    ap.add_argument("--timeout", type=float, default=120)
    a = ap.parse_args()
    out = Path(a.outdir).resolve()
    syms = {}
    for line in (out / "out.sym").read_text().splitlines():
        m = re.match(r"^(\S+):\s+EQU\s+0x([0-9A-Fa-f]+)", line)
        if m:
            syms[m.group(1)] = int(m.group(2), 16)
    zram = lambda addr: addr - 0x4000
    proc = subprocess.Popen(
        ["./zesarux", "--noconfigfile", "--machine", "TS2068", "--enable-remoteprotocol", "--remoteprotocol-port", str(a.port),
         "--vo", "null", "--ao", "null", "--romfile", str(ZDIR / "ts2068.rom")],
        cwd=ZDIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ok = False
    try:
        c = ZRCPClient(port=a.port)
        c.connect()
        c.command("set-memory-zone 0")
        c.command(f"smartload {Path(a.dck).resolve()}")
        t0 = time.time()
        while time.time() - t0 < a.timeout:
            if rd(c, zram(syms["V_STOP"]), 1)[0] == 0xA5:
                ok = True
                break
            time.sleep(0.2)
        if not ok:
            print(f"timeout: V_STOP not set after {a.timeout} s")
            sys.exit(1)
        n = int.from_bytes(rd(c, zram(syms["V_N"]), 2), "little")
        mem = rd(c, zram(0x4000), 6144) + rd(c, zram(0x6000), 6144)
        (out / "zesarux-mem.bin").write_bytes(mem)
        c.command(f"save-screen {out / 'zesarux.bmp'}")
        time.sleep(0.5)
        print(f"stopped after {time.time() - t0:.1f} s, V_N = {n} (the shown state is V_N - 1); wrote {out / 'zesarux-mem.bin'} and zesarux.bmp")
        c.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    main()
