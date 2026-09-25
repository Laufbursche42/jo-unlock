#!/usr/bin/env python3
"""Reference client for the Joyor / Lenzod (ViseBluetooth) BLE frame format (bleak).

Two frame families, both plaintext (no pairing, no AES):

  Short frame (writes + telemetry notifies):
      FF 55 <REG> <LEN> <DATA...> <CHK>
    LEN = number of DATA bytes. CHK = (sum of every byte from index 0 through the byte
    before CHK) mod 256. Example status poll FF 55 01 00 55: FF+55+01+00 = 341, 341 % 256 = 0x55.

  Long 8-byte frame (id / version / model / limit query and the 0x38 walk-assist set):
      FF 55 <REG> 00 00 00 <VAL> 00
    Last byte is fixed 0x00, it is NOT a checksum.

Write char is 0x8877, notify char is 0x8888. The app never records a GATT service UUID (it
matches characteristics by UUID across all services), so the real service must be read from the
device. Keep checksum() / short_frame() identical to app.js.

Usage:
    python joyor_speed.py <device-address> --write 0x1d --data 01          # cruise on
    python joyor_speed.py <device-address> --long 0x38 --val 60            # walk-assist cap 6.0 km/h
    python joyor_speed.py <device-address> --long 0x61                     # serial query
Requires: pip install bleak
"""
import argparse
import asyncio

WRITE_CHAR = "00008877-0000-1000-8000-00805f9b34fb"
NOTIFY_CHAR = "00008888-0000-1000-8000-00805f9b34fb"
# Candidate service UUIDs to probe; the true Joyor service is device-specific and unknown.
CANDIDATE_SERVICES = [
    "0000fff0-0000-1000-8000-00805f9b34fb",
    "0000ffe0-0000-1000-8000-00805f9b34fb",
    "0000ae00-0000-1000-8000-00805f9b34fb",
    "0000fee7-0000-1000-8000-00805f9b34fb",
    "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
]


def checksum(frame):
    """Additive checksum: sum of all bytes mod 256 (matches app.js sum8)."""
    return sum(frame) & 0xFF


def short_frame(reg, data=b""):
    body = bytes([0xFF, 0x55, reg, len(data)]) + bytes(data)
    return body + bytes([checksum(body)])


def long_frame(reg, val=0):
    return bytes([0xFF, 0x55, reg, 0x00, 0x00, 0x00, val & 0xFF, 0x00])


async def main():
    from bleak import BleakClient
    ap = argparse.ArgumentParser()
    ap.add_argument("address")
    ap.add_argument("--write", type=lambda x: int(x, 0), default=None, help="short-frame register")
    ap.add_argument("--data", default="", help="short-frame payload bytes, hex, e.g. 01 or 0102")
    ap.add_argument("--long", type=lambda x: int(x, 0), default=None, help="8-byte query register")
    ap.add_argument("--val", type=lambda x: int(x, 0), default=0, help="8-byte query VAL byte")
    a = ap.parse_args()

    if a.long is not None:
        frame = long_frame(a.long, a.val)
    elif a.write is not None:
        data = bytes.fromhex(a.data) if a.data else b""
        frame = short_frame(a.write, data)
    else:
        raise SystemExit("give --write REG [--data ..] or --long REG [--val ..]")

    async with BleakClient(a.address) as client:
        services = client.services
        write_uuid = None
        for svc_u in CANDIDATE_SERVICES:
            svc = services.get_service(svc_u)
            if svc and svc.get_characteristic(WRITE_CHAR):
                write_uuid = WRITE_CHAR
                break
        if not write_uuid:
            raise SystemExit("write char 0x8877 not found under any known service - read the real service UUID off the device")
        print("TX", frame.hex(" "))
        await client.write_gatt_char(write_uuid, frame, response=False)


if __name__ == "__main__":
    asyncio.run(main())
