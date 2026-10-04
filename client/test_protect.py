"""Tests for the protector (`protect/`).

These run in CI without a compiler: they cover the parts of pack_exe.py that
have to agree byte-for-byte with loader.c — the trailer layout, the PE overlay
computation, and the masked key header — because a mismatch there is exactly
the kind of bug that only shows up as "the shipped EXE silently fails its
integrity check on a user's machine".

One class goes further and compiles loader.c itself against a fixture (it
skips when no gcc is available). That is the only test which can see bcrypt
reject the call: Python's half of the pipeline stays byte-perfect while the
shipped loader refuses its own payload.

The end-to-end path (compile the loader, encrypt a real payload, launch it) is
exercised by `protect/build.py`, which finishes with a `IGG_CLIENT_PROBE` run.
"""

from __future__ import annotations

import struct
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "protect"))

import pack_exe  # noqa: E402


def fake_pe(nsec: int = 2) -> bytes:
    """Smallest buffer overlay_offset() accepts: MZ stub + PE headers + sections."""
    buf = bytearray(0x1000)
    buf[0:2] = b"MZ"
    struct.pack_into("<I", buf, 0x3C, 0x80)  # e_lfanew
    buf[0x80:0x84] = b"PE\0\0"
    fh = 0x84
    struct.pack_into("<H", buf, fh + 2, nsec)     # NumberOfSections
    struct.pack_into("<H", buf, fh + 16, 0xF0)    # SizeOfOptionalHeader
    opt = fh + 20
    struct.pack_into("<I", buf, opt + 60, 0x200)  # SizeOfHeaders
    sec = opt + 0xF0
    for i in range(nsec):
        # Real section-header layout: VirtualSize@8, VirtualAddress@12,
        # SizeOfRawData@16, PointerToRawData@20.
        struct.pack_into("<I", buf, sec + i * 40 + 8, 0x100)               # VirtualSize
        struct.pack_into("<I", buf, sec + i * 40 + 12, 0x4000 + i * 0x100) # VirtualAddress
        struct.pack_into("<I", buf, sec + i * 40 + 16, 0x100)              # SizeOfRawData
        struct.pack_into("<I", buf, sec + i * 40 + 20, 0x200 + i * 0x100)  # PointerToRawData
    return bytes(buf)


class TrailerTests(unittest.TestCase):
    def test_trailer_is_exactly_48_bytes_and_round_trips(self) -> None:
        nonce, tag = bytes(range(12)), bytes(range(16))
        blob = pack_exe.pack_trailer(123456789012, nonce, tag)
        self.assertEqual(len(blob), pack_exe.TRAILER_SIZE)
        self.assertEqual(len(blob), 48)
        back = pack_exe.unpack_trailer(blob)
        self.assertEqual(back["magic"], b"IGGPK001")
        self.assertEqual(back["cipher_len"], 123456789012)
        self.assertEqual(back["nonce"], nonce)
        self.assertEqual(back["tag"], tag)
        self.assertEqual(back["reserved"], 0)

    def test_magic_sits_in_the_first_eight_bytes_like_loader_c_reads_it(self) -> None:
        blob = pack_exe.pack_trailer(1, b"\x01" * 12, b"\x02" * 16)
        self.assertEqual(blob[:8], b"IGGPK001")
        # cipher_len immediately follows, little-endian u64
        self.assertEqual(struct.unpack_from("<Q", blob, 8)[0], 1)
        # nonce then tag
        self.assertEqual(blob[16:28], b"\x01" * 12)
        self.assertEqual(blob[28:44], b"\x02" * 16)


class OverlayTests(unittest.TestCase):
    def test_overlay_starts_after_headers_and_all_sections(self) -> None:
        self.assertEqual(pack_exe.overlay_offset(fake_pe()), 0x400)

    def test_more_sections_moves_the_overlay(self) -> None:
        self.assertEqual(pack_exe.overlay_offset(fake_pe(nsec=4)), 0x600)

    def test_rejects_a_non_pe(self) -> None:
        with self.assertRaises(ValueError):
            pack_exe.overlay_offset(b"not a pe" * 16)


class KeyHeaderTests(unittest.TestCase):
    def test_key_header_round_trips_the_way_loader_c_derives_it(self) -> None:
        import tempfile

        key = bytes(range(32))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "keygen.h"
            pack_exe.write_key_header(key, path)
            self.assertEqual(pack_exe.roundtrip_key_header(key, path), key)

    def test_key_is_never_stored_as_32_contiguous_bytes(self) -> None:
        """The whole point: no blob scan finds the key."""
        import tempfile

        key = bytes(range(32))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "keygen.h"
            pack_exe.write_key_header(key, path)
            text = path.read_text(encoding="utf-8")
            # Each half appears only as u64 words xored with a mask.
            self.assertNotIn(key.hex(), text)
            self.assertNotIn(key[:8].hex(), text)
            self.assertIn("IGK_A", text)
            self.assertIn("IGK_B", text)


class EncryptTests(unittest.TestCase):
    def test_round_trip_through_the_real_aesgcm(self) -> None:
        """Decrypting with the derived key yields the payload unchanged —
        the same contract loader.c's BCryptDecrypt honours."""
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        import secrets

        payload = b"MZ" + bytes(secrets.token_bytes(4096))
        key = secrets.token_bytes(32)
        nonce = secrets.token_bytes(12)
        sealed = AESGCM(key).encrypt(nonce, payload, None)
        plain = AESGCM(key).decrypt(nonce, sealed, None)
        self.assertEqual(plain, payload)

    def test_a_flipped_ciphertext_byte_fails_authentication(self) -> None:
        """A tampered EXE must be refused by the GCM tag, not executed."""
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        import secrets

        key, nonce = secrets.token_bytes(32), secrets.token_bytes(12)
        sealed = bytearray(AESGCM(key).encrypt(nonce, b"x" * 4096, None))
        sealed[100] ^= 0x01
        with self.assertRaises(Exception):
            AESGCM(key).decrypt(nonce, bytes(sealed), None)


class CompilerDiscoveryTests(unittest.TestCase):
    def test_explicit_gcc_is_honoured(self) -> None:
        self.assertEqual(pack_exe.find_gcc("C:/tools/gcc.exe"), "C:/tools/gcc.exe")

    def test_missing_compiler_explains_how_to_get_one(self) -> None:
        import os
        from unittest import mock

        with mock.patch.object(pack_exe.shutil, "which", return_value=None), \
             mock.patch.object(pack_exe.os, "environ", {"LOCALAPPDATA": "C:/nowhere"}), \
             mock.patch.object(Path, "is_dir", return_value=False):
            with self.assertRaises(SystemExit) as ctx:
                pack_exe.find_gcc()
        self.assertIn("gcc", str(ctx.exception))
        self.assertIn("assume-yes-for-downloads", str(ctx.exception))


class LoaderCryptRoundTripTests(unittest.TestCase):
    """Compile loader.c itself and decrypt a Python-made fixture with it.

    This is the one test that observes bcrypt's real behaviour. Everything
    else in this file agrees byte-for-byte and still passes while the shipped
    EXE refuses its own payload: BCryptDecrypt answers STATUS_INVALID_PARAMETER
    when `BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO.dwInfoVersion` is left at 0,
    and it only does that on the call that writes output — so the loader's
    size-query form succeeds, Python's verification succeeds, and the failure
    surfaces as "This file failed its integrity check" on a user's machine.
    """

    def _gcc(self) -> str:
        try:
            return pack_exe.find_gcc()
        except SystemExit as exc:  # no compiler in this environment
            self.skipTest(f"no compiler available: {exc}")

    def test_loader_c_decrypts_what_python_encrypted(self) -> None:
        import secrets
        import subprocess
        import tempfile

        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        gcc = self._gcc()
        probe_src = Path(__file__).resolve().parent / "protect" / "loader_probe.c"

        with tempfile.TemporaryDirectory(prefix="iggprobe-") as tmp:
            d = Path(tmp)
            key = secrets.token_bytes(32)
            nonce = secrets.token_bytes(12)
            plain = b"MZ" + secrets.token_bytes(64 * 1024)
            sealed = AESGCM(key).encrypt(nonce, plain, None)

            (d / "nonce.bin").write_bytes(nonce)
            (d / "tag.bin").write_bytes(sealed[-16:])
            (d / "cipher.bin").write_bytes(sealed[:-16])
            (d / "plain.bin").write_bytes(plain)
            pack_exe.write_key_header(key, d / "keygen.h")

            exe = d / "probe.exe"
            build = subprocess.run(
                [gcc, "-O2", "-std=c11", "-Wall", "-Wextra", "-o", str(exe),
                 str(probe_src), "-I", str(d), "-lbcrypt", "-luser32"],
                capture_output=True, text=True,
            )
            self.assertEqual(build.returncode, 0, build.stdout + build.stderr)

            run = subprocess.run([str(exe), str(d)], capture_output=True, text=True,
                                 timeout=120)
            self.assertEqual(run.stdout.strip(), "PROBE-OK",
                             f"loader.c could not decrypt the fixture:\n"
                             f"{run.stdout}{run.stderr}")


if __name__ == "__main__":
    unittest.main()
