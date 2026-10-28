#!/usr/bin/env python3
"""mkdck.py -- pack 8 KB ROM images into a one-block TS2068 DOCK cartridge (.dck) and,
optionally, a flat 64 KB .bin (absent chunks filled with $FF).

Usage: mkdck.py OUT.dck [--bin OUT.bin] CHUNK=FILE [CHUNK=FILE ...]
A FILE longer than 8 KB fills consecutive chunks (a 16 KB HOME image at chunk 0 fills 0-1).
"""
import sys

CHUNK = 8192


def pack(chunks):
    """chunks: {index: 8192 bytes}. Returns (dck bytes, flat 64 KB bytes)."""
    desc = bytes(2 if c in chunks else 0 for c in range(8))   # 2 = ROM chunk, 0 = absent
    dck = bytes([0]) + desc + b"".join(chunks[c] for c in sorted(chunks))
    flat = b"".join(chunks.get(c, b"\xff" * CHUNK) for c in range(8))
    return dck, flat


def main(argv):
    out, binout, chunks, i = argv[0], None, {}, 1
    while i < len(argv):
        if argv[i] == "--bin":
            binout = argv[i + 1]
            i += 2
            continue
        c, path = argv[i].split("=", 1)
        data = open(path, "rb").read()
        if len(data) % CHUNK:
            sys.exit(f"{path}: {len(data)} bytes, not a multiple of 8192")
        for k in range(len(data) // CHUNK):
            chunks[int(c) + k] = data[k * CHUNK:(k + 1) * CHUNK]
        i += 1
    dck, flat = pack(chunks)
    open(out, "wb").write(dck)
    if binout:
        open(binout, "wb").write(flat)


if __name__ == "__main__":
    main(sys.argv[1:])
