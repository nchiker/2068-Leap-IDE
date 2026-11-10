#!/usr/bin/env python3
"""Run an Arcade cartridge in ZEsarUX (headless, stock TS2068 ROM, ZRCP) and dump the displayed display file.

  python3 arcade/tools/xemu/zesarux-run.py CART.dck [--frames 300] [--out dump.bin] [--timeout 90] [--port 10777]

Same setup as cartridge-build/tests/zesarux_check.py: ZEsarUX 13.0 with --vo null --ao null, the stock ts2068.rom,
the cartridge put in with `smartload`. The runtime's own variables are read over ZRCP (runtime.json symbols):
  HO_MARK = $5AA5 means the cartridge entry was reached; the frame counter V_FRAMES counts refreshes from its first
  interrupt, which comes about 9 refreshes after the entry (interrupts are off during the boot).  The script waits
  until V_FRAMES has advanced by FRAMES since the entry, then reads V_SHADOW_FF (the runtime's copy of port $FF,
  bit 0 = the displayed file) and the displayed bitmap + attributes (6912 bytes), which go to --out.
The emulator runs at real speed (48K timing, 69,888 T per refresh), so this takes about FRAMES/50 seconds.
Exit 0 = the dump was written; 1 = the cartridge did not enter or the wait timed out.
"""
import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path.home() / "ts2068-debug"))
from ts2068_debug.zrcp import ZRCPClient  # noqa: E402

ZDIR = Path.home() / "Applications/ZEsarUX-13.0"
ARCADE = Path(__file__).resolve().parents[2]


def symbols():
    rt = json.loads((ARCADE / "build/runtime.json").read_text())
    return rt["symbols"], rt["constants"]


def read(c, addr, n):
    txt = c.command(f"read-memory {addr} {n}")
    return bytes.fromhex("".join(txt.split()))


def word(c, addr):
    b = read(c, addr, 2)
    return b[0] | (b[1] << 8)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dck")
    ap.add_argument("--frames", type=int, default=300)
    ap.add_argument("--out", default=None)
    ap.add_argument("--timeout", type=float, default=90)
    ap.add_argument("--ticks", type=int, default=None, help="stop at the first refresh where V_TICKS = N (absolute)")
    ap.add_argument("--port", type=int, default=10777)
    a = ap.parse_args()
    S, C = symbols()

    proc = subprocess.Popen(
        ["zesarux", "--noconfigfile", "--machine", "TS2068", "--enable-remoteprotocol",
         "--remoteprotocol-port", str(a.port), "--vo", "null", "--ao", "null",
         "--romfile", str(ZDIR / "ts2068.rom")],
        cwd=ZDIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        c = ZRCPClient(port=a.port)
        c.connect()
        c.command(f"smartload {Path(a.dck).resolve()}")
        deadline = time.time() + a.timeout
        entry_frames = None
        while time.time() < deadline:
            time.sleep(0.2)
            if entry_frames is None:
                if word(c, S["HO_MARK"]) == 0x5AA5:
                    entry_frames = word(c, S["V_FRAMES"])
                    hand = {k: read(c, S[k], 1)[0] for k in ("HO_IFF", "HO_F4", "HO_FF")}
                    hand["HO_SP"] = word(c, S["HO_SP"])
                    print(f"entry: reached; hand-off IFF {hand['HO_IFF']} F4 ${hand['HO_F4']:02X} FF ${hand['HO_FF']:02X} "
                          f"SP ${hand['HO_SP']:04X}")
                continue
            frames = (word(c, S["V_FRAMES"]) - entry_frames) & 0xFFFF
            if a.ticks is not None:
                if word(c, S["V_TICKS"]) >= a.ticks:
                    break
            elif frames >= a.frames:
                break
        else:
            print(f"timeout after {a.timeout}s: entry {'reached' if entry_frames is not None else 'NOT reached'}")
            sys.exit(1)
        c.command("enter-cpu-step")
        ff = read(c, S["V_SHADOW_FF"], 1)[0]
        shown = 1 if ff & 1 else 0
        dfile, dattr = (C["DFILE1"], C["DATTR1"]) if shown else (C["DFILE0"], C["DATTR0"])
        bitmap = read(c, dfile, 6144)
        attrs = read(c, dattr, 768)
        print(f"after {frames} refreshes past entry: V_TICKS {word(c, S['V_TICKS'])}; port $FF shadow ${ff:02X}; "
              f"displayed file {shown + 1} (${dfile:04X})")
        dump = bitmap + attrs
        if a.out:
            Path(a.out).parent.mkdir(parents=True, exist_ok=True)
            Path(a.out).write_bytes(dump)
            print(f"dump: {Path(a.out).resolve()} (6912 bytes: bitmap + attributes of the displayed file)")
        c.close()
        sys.exit(0)
    finally:
        proc.terminate()
        proc.wait(timeout=10)


if __name__ == "__main__":
    main()
