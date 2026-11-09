#!/usr/bin/env python3
"""Run an Arcade v2 cartridge (shooter.dck) in ZEsarUX 13.0 (headless, stock TS2068 ROM, no input) and record the runtime
state at the end of every frame interrupt.  Adapted from breakout-zesarux.py; symbols from arcade/build/v2/runtime.json.

  python3 arcade/tools/xemu/shooter-zesarux.py [CART.dck] [--out arcade/build/xemu/zesarux] [--ticks 200] [--port 10777]

Method (as breakout-zesarux.py): a breakpoint at ISR_DONE (the end of the frame interrupt).  At each hit, once the
cartridge has entered (HO_MARK = $5AA5), the script reads V_TICKS, V_SYNC, V_SHADOW_FF, V_SFX_ACTIVE and AY_SHADOW.
Displayed tick = V_TICKS when V_SYNC < 2, else V_TICKS - 1 (as shooter-tsrun.mjs).
  shooter-zesarux-t<N>.bin        6912 bytes of the displayed screen at the first hit with displayed tick N
  shooter-zesarux-state-t<N>.bin  SPR_TAB (96) + CELL_TILE (768) at the first hit with V_TICKS = N
  shooter-zesarux-log.txt         one line per hit (the same columns as shooter-tsrun-log.txt, AY from AY_SHADOW)
  shooter-zesarux-timing.txt      hits (interrupts) per tick, and ticks per second of emulated time (50.08 Hz, 69,888 T)
  shooter-zesarux-ay.txt          the AY_SHADOW values around the first sound effect(s)
Joystick: AY register 14 is set to $FF after entry (see the note in the code); without it ZEsarUX reads fire pressed.
AY: ZEsarUX 13.0's ZRCP has no AY command, so AY_SHADOW (the runtime's copy of its writes to ports $F5/$F6) is used.
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
TICK_TARGETS = (5, 30, 90, 200)
T_PER_FRAME_48K = 69888
CPU_HZ = 3528000


def symbols():
    rt = json.loads((ARCADE / "build/v2/runtime.json").read_text())
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
    ap.add_argument("dck", nargs="?", default=str(ARCADE / "build/shooter.dck"))
    ap.add_argument("--out", default=str(ARCADE / "build/xemu/zesarux"))
    ap.add_argument("--ticks", type=int, default=200)
    ap.add_argument("--port", type=int, default=10777)
    ap.add_argument("--max-hits", type=int, default=20000)
    a = ap.parse_args()
    S, C = symbols()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    P = "shooter-zesarux"

    proc = subprocess.Popen(
        ["zesarux", "--noconfigfile", "--machine", "TS2068", "--enable-remoteprotocol",
         "--remoteprotocol-port", str(a.port), "--vo", "null", "--ao", "null",
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
        c.command(f"set-breakpoint 1 PC={S['ISR_DONE']:04X}H")

        rows = []   # dict per hit
        dumped, states = {}, {}
        entered = False
        hits = 0
        while hits < a.max_hits:
            c.command("run 5000000", timeout=600)
            if pc_of(c) != S["ISR_DONE"]:
                continue
            hits += 1
            if word(c, S["HO_MARK"]) != 0x5AA5:
                continue
            if not entered:
                entered = True
                # ZEsarUX 13.0 reads AY register 14 (joystick port A) as the register's contents, 0 after boot, which
                # the runtime's STICK takes as "fire and every direction pressed".  A TS2068 with no joystick reads $FF
                # (the contacts pull high; TSRun does the same), so set R14 = $FF once the cartridge has entered.
                c.command("write-port 245 14")
                c.command("write-port 246 255")
                print(f"entry: reached (hit {hits}); AY R14 set to $FF (no joystick, as TSRun reads it)")
            ticks = word(c, S["V_TICKS"])
            sync = read(c, S["V_SYNC"], 1)[0]
            shadow = read(c, S["V_SHADOW_FF"], 1)[0]
            sfx = read(c, S["V_SFX_ACTIVE"], 1)[0]
            ay = list(read(c, S["AY_SHADOW"], 11))
            shown = (ticks - 1) & 0xFFFF if sync >= 2 else ticks
            rows.append(dict(hit=hits, ticks=ticks, sync=sync, shown=shown, shadow=shadow, sfx=sfx, ay=ay))
            if shown in TICK_TARGETS and shown not in dumped:
                f = shadow & 1
                dfile, dattr = (C["DFILE1"], C["DATTR1"]) if f else (C["DFILE0"], C["DATTR0"])
                dump = read(c, dfile, 6144) + read(c, dattr, 768)
                (out / f"{P}-t{shown}.bin").write_bytes(dump)
                dumped[shown] = (hits, f + 1)
                print(f"displayed tick {shown}: hit {hits}, V_TICKS {ticks}, V_SYNC {sync}, file {f + 1}")
            if ticks in TICK_TARGETS and ticks not in states:
                st = read(c, S["SPR_TAB"], 96) + read(c, S["CELL_TILE"], 768)
                (out / f"{P}-state-t{ticks}.bin").write_bytes(st)
                states[ticks] = hits
            if ticks > a.ticks:
                break
        else:
            print(f"stopped after {hits} hits")
            sys.exit(1)
        if not entered:
            print("cartridge did not enter")
            sys.exit(1)

        # timing: hits between successive V_TICKS changes
        changes = []
        for i in range(1, len(rows)):
            if rows[i]["ticks"] != rows[i - 1]["ticks"]:
                changes.append((rows[i]["ticks"], rows[i]["hit"]))
        gaps = [changes[i][1] - changes[i - 1][1] for i in range(1, len(changes))]
        avg = sum(gaps) / len(gaps)
        hist = {}
        for g in gaps:
            hist[g] = hist.get(g, 0) + 1
        tl = [
            f"ticks observed {len(changes)}; interrupts per tick: average {avg:.3f}, worst {max(gaps)}, histogram {hist}",
            "first ticks (tick:hit): " + " ".join(f"{t}:{h}" for t, h in changes[:20]),
            f"ticks per second of emulated time (48K timing, {T_PER_FRAME_48K} T per interrupt at {CPU_HZ} Hz): "
            f"{CPU_HZ / T_PER_FRAME_48K / avg:.3f}",
        ]
        (out / f"{P}-timing.txt").write_text("\n".join(tl) + "\n")
        print("\n".join(tl))

        seen = {}
        for r in rows:
            seen.setdefault(r["shown"], r["shadow"] & 1)
        keys = sorted(seen)
        gaps_t = sum(1 for i in range(1, len(keys)) if keys[i] != keys[i - 1] + 1)
        alt = all(seen[keys[i]] != seen[keys[i - 1]] for i in range(1, len(keys)))
        print(f"displayed file alternates on every tick: {alt} ({len(keys)} ticks seen, {gaps_t} gaps)")

        log = ["hit ticks sync shown shadowFF sfx AY(R0..R10 from AY_SHADOW)"]
        for r in rows:
            log.append(f"{r['hit']} {r['ticks']} {r['sync']} {r['shown']} ${r['shadow']:02X} {r['sfx']} "
                       + " ".join(f"{v:02x}" for v in r["ay"]))
        (out / f"{P}-log.txt").write_text("\n".join(log) + "\n")

        starts = [i for i in range(1, len(rows)) if rows[i]["sfx"] != 0 and rows[i - 1]["sfx"] == 0]
        ayl = []
        if not starts:
            ayl.append("no sound effect in the run")
        for si in starts[:3]:
            r0 = rows[si]
            ayl.append(f"effect starts: hit {r0['hit']}, V_TICKS {r0['ticks']}, V_SFX_ACTIVE ${r0['sfx']:02X}")
            ayl.append("hit ticks  sfx  R0 R1 R2 R3 R4 R5 R6 R7 R8 R9 R10 (AY_SHADOW, after the frame)")
            for r in rows[max(0, si - 2): si + 6]:
                ayl.append(f"{r['hit']:5d} {r['ticks']:5d} {r['sfx']:4d}  " + " ".join(f"{v:02x}" for v in r["ay"]))
            ayl.append("")
        (out / f"{P}-ay.txt").write_text("\n".join(ayl) + "\n")
        print(f"sound effects start at ticks: {[rows[i]['ticks'] for i in starts]}")
        print(f"dumps (tick: hit, file): {sorted(dumped.items())}")
        c.close()
        sys.exit(0)
    finally:
        proc.terminate()
        proc.wait(timeout=10)


if __name__ == "__main__":
    main()
