#!/usr/bin/env python3
"""Run a bank probe cartridge in ZEsarUX 13.0 (headless, stock TS2068 ROM, ZRCP) and check the four questions.

  python3 zesarux.py [CART.dck] [--tag probe] [--expect pass|fail] [--timeout 60] [--port 10777]

As arcade/tools/xemu/zesarux-run.py: ZEsarUX started from its folder with --vo null --ao null, the cartridge put in with smartload.
Method:
  * a PC breakpoint at MAINC ($8000, the `ei`) with the action reset-tstatp (resets the T-state partial counter, no break), and a
    PC breakpoint at FINDI (the final `di`, after the last attribute fill) that breaks; so the T-states between them give the
    number of refreshes (69,888 T each, ZEsarUX's 48K timing for the TS2068) to compare with the ISR's counter;
  * while it runs, the RAM of the two display files is read through ZEsarUX's own "Machine RAM" memory zone (zone 0, bypasses
    the paging the CPU sees) every ~60 ms and compared with the two patterns; the shadow of $F4 in chunk 7 is read too, to say
    how many samples were taken while a DOCK chunk was (by the shadow) mapped;
  * after the break: the result record, the ISR counters, and the DOCK zone (19) chunks 2, 3 and 6 compared with the pattern
    (a DOCK chunk written through the window would show up there).
Video note: ZEsarUX draws the TS2068 screen, and save-screen reads it, from home RAM page 0 directly (get_base_mem_pantalla ->
timex_home_ram_mem_table[0]), whatever $F4 maps, so the DOCK bytes can not reach its video.
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
HERE = Path(__file__).resolve().parent
FRAME_T = 69888


def pat(c, i):
    return (i * 7 + (i >> 8) * 13 + c * 31 + 1) & 0xFF


def ref_screen(xor, attr):
    return bytes([(k & 0xFF) ^ xor for k in range(6144)]) + bytes([attr]) * 768


REF_A, REF_B = ref_screen(0, 0x38), ref_screen(0x55, 0x07)


def syms(tag):
    o = {}
    for line in (HERE / "build" / tag / "out.sym").read_text().splitlines():
        m = re.match(r"^(\S+):\s+EQU\s+0x([0-9A-Fa-f]+)", line)
        if m:
            o[m.group(1)] = int(m.group(2), 16)
    return o


def rd(c, addr, n):
    """read-memory in the current zone (reads in chunks of at most 8192 bytes)"""
    out = b""
    while n > 0:
        k = min(n, 8192)
        txt = c.command(f"read-memory {addr} {k}")
        out += bytes.fromhex("".join(txt.split()))
        addr += k
        n -= k
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dck", nargs="?", default=str(HERE / "build/probe.dck"))
    ap.add_argument("--tag", default="probe")
    ap.add_argument("--expect", default="pass")
    ap.add_argument("--timeout", type=float, default=90)
    ap.add_argument("--port", type=int, default=10777)
    a = ap.parse_args()
    S = syms(a.tag)
    ZRAM = lambda addr: addr - 0x4000   # zone 0 "Machine RAM" offset of a CPU RAM address $4000-$FFFF

    proc = subprocess.Popen(
        ["zesarux", "--noconfigfile", "--machine", "TS2068", "--enable-remoteprotocol", "--remoteprotocol-port", str(a.port),
         "--vo", "null", "--ao", "null", "--romfile", str(ZDIR / "ts2068.rom")],
        cwd=ZDIR, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ok = False
    try:
        c = ZRCPClient(port=a.port)
        c.connect()
        c.command("set-memory-zone 0")
        c.command("enable-breakpoints")
        c.command(f"set-breakpoint 1 PC={S['MAINC']}")
        c.command("set-breakpointaction 1 reset-tstatp")
        # FINDI: four breakpoints on the same PC, each writes one byte of TSTATESP to $FB80+k (the CPU keeps running; a "break" action
        # does not stop the CPU over ZRCP here)
        for k in range(4):
            c.command(f"set-breakpoint {2 + k} PC={S['FINDI']}")
            c.command(f"set-breakpointaction {2 + k} write {0xFB80 + k} (TSTATESP/{1 << (8 * k)})&255")
        c.command(f"smartload {Path(a.dck).resolve()}")
        t0 = time.time()
        samples = 0; bad = 0; mapped = 0; mapped_vals = {}; first_bad = None; done = False
        while time.time() - t0 < a.timeout:
            sh = rd(c, ZRAM(S["MAPSH"]), 1)[0]
            f1 = rd(c, ZRAM(0x4000), 0x1B00)
            f2 = rd(c, ZRAM(0x6000), 0x1B00)
            rec = rd(c, ZRAM(0xFF00), 4)
            if rec == b"BKPR":
                samples += 1
                if sh != 0x33:
                    mapped += 1
                    mapped_vals[sh] = mapped_vals.get(sh, 0) + 1
                # the final attribute fill (state still 0 while it runs) may be half done: each attribute byte is then the original
                # one or the green / red fill value; the bitmaps never change
                def fine(f, ref):
                    return f[:6144] == ref[:6144] and all(x == y or x in (0x20, 0x10) for x, y in zip(f[6144:], ref[6144:]))
                if not (fine(f1, REF_A) and fine(f2, REF_B)):
                    bad += 1
                    if first_bad is None:
                        first_bad = (samples, fine(f1, REF_A), fine(f2, REF_B))
                st2 = rd(c, ZRAM(0xFF04), 1)[0]
                if st2 != 0:
                    done = True
                    break
            time.sleep(0.03)
        if not done:
            print(f"timeout after {a.timeout}s (record magic seen: {rec == b'BKPR'})")
            sys.exit(1)
        time.sleep(0.2)
        t = int.from_bytes(rd(c, ZRAM(0xFB80), 4), "little")
        print(f"t-states partial from MAINC to FINDI (written by the breakpoint actions): {t}")
        rec = rd(c, ZRAM(0xFF00), 32)
        frames_live = rec[12] | (rec[13] << 8)
        irqmap = rec[22] | (rec[23] << 8)
        passn = rec[8] | (rec[9] << 8)
        bytesv = int.from_bytes(rec[16:20], "little")
        itern = rec[20] | (rec[21] << 8)
        print(f"ISR count {frames_live}, T/{FRAME_T} = {t / FRAME_T:.2f} refreshes between MAINC and FINDI, ISR saw map shadow set {irqmap} times;"
              f" pieces passed {passn}, bytes verified {bytesv}, iterations {itern}")
        state, kind, bank = rec[4], rec[5], rec[6]
        failn = rec[10] | (rec[11] << 8); off = rec[14] | (rec[15] << 8)
        print(f"record: state {state} (1 pass, 2 fail) kind {kind} chunk {bank} fail count {failn} offset {off} expected {rec[24]:#04x} actual {rec[25]:#04x}")
        # DOCK zone: chunks 2, 3, 6 still equal the pattern?
        c.command("set-memory-zone 19")
        dock_bad = {}
        for ch in (2, 3, 6):
            data = rd(c, ch * 8192, 8192)
            n = sum(1 for i in range(8192) if data[i] != pat(ch, i))
            dock_bad[ch] = n
        c.command("set-memory-zone 0")
        print(f"DOCK chunks 2, 3, 6 bytes differing from the pattern after the run: {dock_bad}")
        print(f"display samples while running: {samples}, of them with the display files not equal to the two patterns: {bad}"
              f"{'' if first_bad is None else ' (first at sample %d, file1 ok %s, file2 ok %s)' % first_bad}; taken while the $F4 shadow was not $33: {mapped} {({hex(k): v for k, v in mapped_vals.items()})}")
        want = 1 if a.expect == "pass" else 2
        diff = abs(frames_live - t / FRAME_T)
        res = {
            "copies+RAM-under (record)": state == want,
            "display RAM unchanged in every sample": bad == 0 and samples > 0,
            "interrupts: ISR count within 1 of T/frame": diff <= 1.0,
            "DOCK data intact": all(v == 0 for v in dock_bad.values()),
        }
        for k, v in res.items():
            print(f"  {'PASS' if v else 'FAIL'}  {k}")
        ok = all(res.values())
        c.close()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
