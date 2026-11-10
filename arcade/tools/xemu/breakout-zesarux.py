#!/usr/bin/env python3
"""Run an Arcade cartridge in ZEsarUX 13.0 (headless, stock TS2068 ROM, no input) and record the runtime state at the end
of every frame interrupt.  Adapted from zesarux-run.py; the symbols are those of the v1 runtime
(arcade/build/v1/runtime.json).

  python3 arcade/tools/xemu/breakout-zesarux.py CART.dck [--out arcade/build/xemu] [--ticks 300]

Method: a breakpoint at the runtime's ISR_DONE (end of the frame interrupt, after the flip).  At each hit, once the cartridge
has entered (HO_MARK = $5AA5), the script reads V_TICKS, V_SYNC, V_SHADOW_FF, V_SFX_ACTIVE and AY_SHADOW.  After the ISR's
flip the displayed tick is V_TICKS (see breakout-tsrun.mjs for the definition), so the first hit with V_TICKS = N dumps tick
screen N (6912 bytes, bitmap + attributes of the file the shadow selects).

AY: ZEsarUX 13.0's ZRCP has no command for the AY chip's registers (checked with `help`), so the AY values are the runtime's
own copy AY_SHADOW, which it updates on every write to ports $F5 / $F6 and which boot zeroes together with the chip.

Writes into --out: breakout-zesarux-t<N>.bin, breakout-zesarux-log.txt, breakout-zesarux-ay.txt.
Exit 0 = the run reached the last tick; 1 = the cartridge did not enter or the run stopped early.
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
TICK_TARGETS = (5, 20, 60)


def symbols():
    rt = json.loads((ARCADE / "build/v1/runtime.json").read_text())
    return rt["symbols"], rt["constants"]


def read(c, addr, n):
    txt = c.command(f"read-memory {addr} {n}")
    return bytes.fromhex("".join(txt.split()))


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
    ap.add_argument("dck")
    ap.add_argument("--out", default=str(ARCADE / "build/xemu"))
    ap.add_argument("--ticks", type=int, default=300)
    ap.add_argument("--port", type=int, default=10777)
    ap.add_argument("--max-hits", type=int, default=20000)
    a = ap.parse_args()
    S, C = symbols()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    proc = subprocess.Popen(
        ["zesarux", "--noconfigfile", "--machine", "TS2068", "--enable-remoteprotocol",
         "--remoteprotocol-port", str(a.port), "--vo", "null", "--ao", "null",
         "--romfile", str(ZDIR / "ts2068.rom")],
        cwd=ZDIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        c = ZRCPClient(port=a.port, timeout=120)
        c.connect()
        c.command(f"smartload {Path(a.dck).resolve()}")
        time.sleep(1.0)                # smartload leaves a menu open for a moment; enter-cpu-step refuses while it is up
        c.command("close-all-menus")
        time.sleep(0.5)
        c.command("enter-cpu-step")
        try:
            c.command("enable-breakpoints")
        except Exception as exc:  # noqa: BLE001 - already enabled is fine
            if "already" not in str(exc).lower():
                raise
        isr_done = S["ISR_DONE"]
        c.command(f"set-breakpoint 1 PC={isr_done:04X}H")

        rows = []      # (hit, ticks, sync, shadow, sfx, ay[0..10])
        dumped = {}
        entered = False
        hits = 0
        while hits < a.max_hits:
            c.command("run 5000000", timeout=600)
            if pc_of(c) != isr_done:
                continue               # the run budget ran out, or the breakpoint is not this one
            hits += 1
            if word(c, S["HO_MARK"]) != 0x5AA5:
                continue               # ROM's own interrupt code before the cartridge entered
            if not entered:
                entered = True
                print(f"entry: reached (hit {hits})")
            ticks = word(c, S["V_TICKS"])
            sync = read(c, S["V_SYNC"], 1)[0]
            shadow = read(c, S["V_SHADOW_FF"], 1)[0]
            sfx = read(c, S["V_SFX_ACTIVE"], 1)[0]
            ay = list(read(c, S["AY_SHADOW"], 11))
            rows.append((hits, ticks, sync, shadow, sfx, ay))
            if ticks in TICK_TARGETS and ticks not in dumped:
                shown = shadow & 1
                dfile, dattr = (C["DFILE1"], C["DATTR1"]) if shown else (C["DFILE0"], C["DATTR0"])
                dump = read(c, dfile, 6144) + read(c, dattr, 768)
                (out / f"breakout-zesarux-t{ticks}.bin").write_bytes(dump)
                dumped[ticks] = shown + 1
                print(f"tick {ticks}: hit {hits}, V_SYNC {sync}, V_SHADOW_FF ${shadow:02X}, displayed file {shown + 1}")
            if ticks > a.ticks:
                break
        else:
            print(f"stopped after {hits} hits")
            sys.exit(1)

        if not entered:
            print("cartridge did not enter")
            sys.exit(1)

        # the displayed file per tick (alternation) and gaps, as breakout-tsrun.mjs reports them
        seen = {}
        for _, ticks, _, shadow, _, _ in rows:
            seen.setdefault(ticks, shadow & 1)
        keys = sorted(seen)
        gaps = sum(1 for i in range(1, len(keys)) if keys[i] != keys[i - 1] + 1)
        alt = all(seen[keys[i]] != seen[keys[i - 1]] for i in range(1, len(keys)))
        print(f"displayed file alternates on every tick: {alt} ({len(keys)} ticks seen, {gaps} gaps)")
        print("displayed file per tick (flip): " + " ".join(f"{t}:{seen[t] + 1}" for t in keys[:12]))

        log = ["hit ticks sync shadowFF sfx AY(R0..R10 proxy AY_SHADOW)"]
        for hit, ticks, sync, shadow, sfx, ay in rows:
            log.append(f"{hit} {ticks} {sync} ${shadow:02X} {sfx} " + " ".join(f"{v:02x}" for v in ay))
        (out / "breakout-zesarux-log.txt").write_text("\n".join(log) + "\n")

        first = next((i for i, r in enumerate(rows) if r[4] != 0), None)
        ayl = []
        if first is None:
            ayl.append("no sound effect in the run")
        else:
            h, t, _, _, sfx, _ = rows[first]
            ayl.append(f"first effect: hit {h}, V_TICKS {t}, V_SFX_ACTIVE ${sfx:02X}")
            ayl.append("hit ticks  sfx  R0 R1 R2 R3 R4 R5 R6 R7 R8 R9 R10 (AY_SHADOW, after the frame)")
            for r in rows[max(0, first - 2): first + 12]:
                ayl.append(f"{r[0]:5d} {r[1]:5d} {r[4]:4d}  " + " ".join(f"{v:02x}" for v in r[5]))
            print(f"first sound effect at V_TICKS {t}; AY_SHADOW R0..R10 in its first frame: "
                  + " ".join(f"{v:02X}" for v in rows[first][5]))
        (out / "breakout-zesarux-ay.txt").write_text("\n".join(ayl) + "\n")
        print(f"dumps: {sorted(dumped.items())}")
        c.close()
        sys.exit(0)
    finally:
        proc.terminate()
        proc.wait(timeout=10)


if __name__ == "__main__":
    main()
