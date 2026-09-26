"""Unit tests for the Windows client's URL handling.

Network-free: the loopback proxy is stubbed, so these run on any machine,
including the Windows build runner before the EXE is packaged.
"""

from __future__ import annotations

import os
import socket
import sys
import types
import unittest
import urllib.request
from pathlib import Path

# pywebview is imported at module import time and is not needed for these tests.
sys.modules.setdefault("webview", types.ModuleType("webview"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import igg_client as c  # noqa: E402

HOST = "igg-vip-studio-07u9.onrender.com"
BASE = "https://" + HOST


class NormalizeBaseUrl(unittest.TestCase):
    def test_keeps_a_clean_https_origin(self):
        self.assertEqual(c.normalize_base_url(BASE), BASE)

    def test_adds_the_scheme_when_missing(self):
        self.assertEqual(c.normalize_base_url(HOST), BASE)

    def test_drops_paths_and_queries(self):
        self.assertEqual(c.normalize_base_url(BASE + "/studio?x=1"), BASE)

    def test_blank_and_junk_fall_back_to_the_baked_origin(self):
        # A stale server.txt pointing at the retired Vercel host used to leave
        # the window blank, so unusable values must resolve to the baked origin.
        for raw in ("", "   ", "not a url", "http://", "https://"):
            self.assertEqual(c.normalize_base_url(raw), c.DEFAULT_SERVER_URL, raw)

    def test_rejects_a_host_outside_the_dns_alphabet(self):
        # urlsplit accepts spaces inside the netloc, so the host is validated
        # rather than trusted.
        self.assertEqual(c.normalize_base_url("https://bad host"), c.DEFAULT_SERVER_URL)
        self.assertEqual(c.normalize_base_url("https://a_b.com"), c.DEFAULT_SERVER_URL)

    def test_keeps_a_retired_host_well_formed(self):
        # Well-formed but retired is still a valid origin to try; only garbage
        # is replaced.
        self.assertEqual(
            c.normalize_base_url("https://igg-vip-studio.vercel.app/"),
            "https://igg-vip-studio.vercel.app",
        )


class _FakeProxy:
    """Stands in for _LocalProxy so no socket or DNS is touched."""

    calls: list[str] = []

    def __init__(self, base: str) -> None:
        _FakeProxy.calls.append(base)

    def start(self) -> str:
        return "http://127.0.0.1:9"


class ChooseWindowUrl(unittest.TestCase):
    def setUp(self):
        self._real = socket.getaddrinfo
        self._proxy = c._LocalProxy
        self._env = os.environ.pop("IGG_VIP_PROXY", None)
        _FakeProxy.calls = []
        c._LocalProxy = _FakeProxy  # type: ignore[assignment]

    def tearDown(self):
        socket.getaddrinfo = self._real
        c._LocalProxy = self._proxy  # type: ignore[assignment]
        if self._env is not None:
            os.environ["IGG_VIP_PROXY"] = self._env

    def _break_dns(self):
        def broken(host, *a, **k):
            if HOST in str(host):
                raise socket.gaierror(-2, "Name or service not known")
            return self._real(host, *a, **k)

        socket.getaddrinfo = broken

    def test_working_dns_loads_the_origin_directly(self):
        # Nothing about the normal path changes: no proxy, so cookies and the
        # certificate are exactly what they were before.
        self.assertEqual(c.choose_window_url(BASE), BASE)
        self.assertEqual(_FakeProxy.calls, [])

    def test_broken_dns_falls_back_to_the_loopback_proxy(self):
        # This is ERR_NAME_NOT_RESOLVED: WebView2 would fail to resolve the host
        # itself, so the app is served from loopback instead.
        self._break_dns()
        self.assertTrue(c.choose_window_url(BASE).startswith("http://127.0.0.1:"))
        self.assertEqual(_FakeProxy.calls, [BASE])

    def test_env_forces_the_proxy_even_when_dns_works(self):
        os.environ["IGG_VIP_PROXY"] = "1"
        self.assertTrue(c.choose_window_url(BASE).startswith("http://127.0.0.1:"))

    def test_a_failing_proxy_still_falls_back_to_the_origin(self):
        class Boom:
            def __init__(self, base: str) -> None:
                raise RuntimeError("no route")

        c._LocalProxy = Boom  # type: ignore[assignment]
        self._break_dns()
        self.assertEqual(c.choose_window_url(BASE), BASE)


class DeviceId(unittest.TestCase):
    """The license device id must survive EXE restarts on one PC."""

    def setUp(self):
        import tempfile

        self._tmp = tempfile.TemporaryDirectory()
        self._app_data = os.environ.get("APPDATA")
        os.environ["APPDATA"] = self._tmp.name

    def tearDown(self):
        if self._app_data is None:
            os.environ.pop("APPDATA", None)
        else:
            os.environ["APPDATA"] = self._app_data
        self._tmp.cleanup()

    def test_back_to_back_launches_return_the_same_id(self):
        first = c.get_device_id()
        self.assertRegex(first, r"^VIP(?:-[A-Z0-9]{4}){5}$")
        self.assertEqual(c.get_device_id(), first)
        self.assertEqual(c.NativeBridge().deviceId(), first)

    def test_a_foreign_file_is_replaced_not_reused(self):
        (c._app_data_dir() / "device.id").write_text("junk", encoding="utf-8")
        fresh = c.get_device_id()
        self.assertRegex(fresh, r"^VIP(?:-[A-Z0-9]{4}){5}$")
        self.assertEqual(c.get_device_id(), fresh)


class WipeFiles(unittest.TestCase):
    """Fresh-start wipe deletes exactly the given absolute paths, then stops."""

    def setUp(self):
        self._adb = c._find_adb
        self._run = c._run_adb
        self.calls: list[list[str]] = []
        c._find_adb = lambda: "/fake/adb"  # type: ignore[assignment]

    def tearDown(self):
        c._find_adb = self._adb  # type: ignore[assignment]
        c._run_adb = self._run  # type: ignore[assignment]

    def _ok_rm(self, adb, args, timeout=30):
        self.calls.append(args)
        cmd = " ".join(args)
        if " force-stop " in cmd:
            return (0, b"", b"")
        if "'ls \"" in cmd:
            return (1, b"", b"No such file")  # gone after rm
        if " rm -f " in cmd:
            return (0, b"", b"")
        return (1, b"", b"unexpected")

    def test_deletes_both_files_and_reports_them(self):
        c._run_adb = self._ok_rm  # type: ignore[assignment]
        bridge = c.NativeBridge()
        bridge.forceStop = lambda serial: {"ok": True, "package": "pkg"}  # type: ignore[method-assign]
        r = bridge.wipeFiles("emulator-5554", ["/a/mGameInfo.xml", "/a/mLocalInfo.xml"])
        self.assertTrue(r["ok"])
        self.assertEqual(r["wiped"], ["/a/mGameInfo.xml", "/a/mLocalInfo.xml"])
        rm_cmds = [" ".join(a) for a in self.calls if " rm -f " in " ".join(a)]
        self.assertEqual(len(rm_cmds), 2, rm_cmds)

    def test_rejects_relative_paths_without_touching_adb(self):
        seen: list[list[str]] = []
        c._run_adb = lambda adb, args, timeout=30: (seen.append(args), (0, b"", b""))[1]  # type: ignore[assignment]
        bridge = c.NativeBridge()
        bridge.forceStop = lambda serial: {"ok": True, "package": "pkg"}  # type: ignore[method-assign]
        r = bridge.wipeFiles("emulator-5554", ["mGameInfo.xml", ""])
        self.assertFalse(r["ok"])
        self.assertEqual(r["wiped"], [])
        self.assertEqual(seen, [])

    def test_surviving_file_is_reported_not_claimed(self):
        def stubborn(adb, args, timeout=30):
            cmd = " ".join(args)
            if "'ls \"" in cmd:
                return (0, b"/a/mGameInfo.xml\n", b"")  # still there
            return (0, b"", b"")

        c._run_adb = stubborn  # type: ignore[assignment]
        bridge = c.NativeBridge()
        bridge.forceStop = lambda serial: {"ok": True, "package": "pkg"}  # type: ignore[method-assign]
        r = bridge.wipeFiles("emulator-5554", ["/a/mGameInfo.xml"])
        self.assertFalse(r["ok"])
        self.assertEqual(r["wiped"], [])
        self.assertIn("still present", r["error"])


class OriginIp(unittest.TestCase):
    def test_os_resolver_is_preferred(self):
        def fake(host, *a, **k):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.7", 443))]

        real = socket.getaddrinfo
        socket.getaddrinfo = fake
        try:
            self.assertEqual(c.resolve_origin_ip(HOST), "10.0.0.7")
        finally:
            socket.getaddrinfo = real

    def test_doh_parses_an_a_record(self):
        # The DoH path is stubbed so this stays network-free: it only needs to
        # show that an A answer is read out and junk is ignored.
        payload = (
            b'{"Status":0,"Answer":['
            b'{"name":"x","type":5,"data":"alias.example"},'
            b'{"name":"x","type":1,"data":"10.0.0.9"}]}'
        )
        real = urllib.request.urlopen

        class Resp:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return payload

        urllib.request.urlopen = lambda *a, **k: Resp()
        try:
            self.assertEqual(c._doh_lookup(HOST), "10.0.0.9")
        finally:
            urllib.request.urlopen = real

    def test_doh_returns_none_when_every_endpoint_fails(self):
        real = urllib.request.urlopen

        def boom(*a, **k):
            raise OSError("doh unreachable")

        urllib.request.urlopen = boom
        try:
            self.assertIsNone(c._doh_lookup(HOST))
        finally:
            urllib.request.urlopen = real


class CookieSafety(unittest.TestCase):
    """The proxy only works if the session cookie is host-only.

    A `Domain=` attribute would make the browser drop the cookie for
    `127.0.0.1`, silently breaking sign-in on a DNS-broken machine. The auth
    config deliberately sets none, and this guards that decision.
    """

    def test_auth_cookies_carry_no_domain_attribute(self):
        root = Path(__file__).resolve().parent.parent
        src = (root / "src/lib/auth/server.ts").read_text(encoding="utf-8")
        self.assertNotIn(
            "domain:",
            src,
            "a cookie Domain would break the loopback proxy; keep cookies host-only",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)