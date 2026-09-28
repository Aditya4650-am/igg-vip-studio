"""Unit tests for the Windows client's URL handling.

Network-free: the loopback proxy is stubbed, so these run on any machine,
including the Windows build runner before the EXE is packaged.
"""

from __future__ import annotations

import os
import re
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


class LocalInfoPaths(unittest.TestCase):
    """mLocalInfo discovery must prioritize files/ over saves/."""

    def test_files_comes_before_saves(self):
        paths = c.localinfo_candidate_paths_for_package("com.playrix.township")
        files_idx = next(i for i, p in enumerate(paths) if "/files/mLocalInfo.xml" in p)
        saves_idx = next(i for i, p in enumerate(paths) if "/saves/mLocalInfo.xml" in p)
        self.assertLess(files_idx, saves_idx)
        self.assertIn("shared_prefs", " ".join(paths))


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


class FreshStartBridge(unittest.TestCase):
    """New-Account bridge: enumerate state files, read/write them, reset Android ID."""

    def setUp(self):
        self._adb = c._find_adb
        self._run = c._run_adb
        c._find_adb = lambda: "/fake/adb"  # type: ignore[assignment]

    def tearDown(self):
        c._find_adb = self._adb  # type: ignore[assignment]
        c._run_adb = self._run  # type: ignore[assignment]

    def _shell(self, mapping):
        def run(adb, args, timeout=30):
            cmd = " ".join(args)
            for key, val in mapping.items():
                if key in cmd:
                    return val
            return (1, b"", b"unexpected: " + cmd.encode()[:40])
        return run

    def test_lists_state_files_for_the_installed_package(self):
        c._run_adb = self._shell({  # type: ignore[assignment]
            "pm path": (0, b"package:/data/app/pkg/base.apk\n", b""),
            "ls \"/data/data/com.playrix.township/saves\"": (0, b"mGameInfo.xml\n", b""),
            "ls \"/data/data/com.playrix.township/files\"": (0, b"mLocalInfo.xml\n", b""),
            "ls \"/data/data/com.playrix.township/shared_prefs\"": (
                0, b"account.xml\nwebview.db\n", b"",
            ),
            "ls \"/data/data/com.playrix.township/databases\"": (1, b"", b"No such file"),
            "ls \"/data/user/0/": (1, b"", b"No such file"),
        })
        r = c.NativeBridge().listStateFiles("emulator-5554")
        self.assertTrue(r["ok"])
        self.assertEqual(r["package"], "com.playrix.township")
        self.assertIn("/data/data/com.playrix.township/saves/mGameInfo.xml", r["files"])
        self.assertIn("/data/data/com.playrix.township/shared_prefs/account.xml", r["files"])

    def test_read_android_id_accepts_only_hex(self):
        c._run_adb = self._shell({  # type: ignore[assignment]
            "android_id": (0, b"abcdef0123456789\n", b""),
        })
        r = c.NativeBridge().readAndroidId("emulator-5554")
        self.assertEqual(r["androidId"], "abcdef0123456789")

    def test_read_android_id_rejects_shell_chatter(self):
        c._run_adb = self._shell({  # type: ignore[assignment]
            "android_id": (0, b"error: device offline\n", b""),
        })
        with self.assertRaises(RuntimeError):
            c.NativeBridge().readAndroidId("emulator-5554")

    def test_reset_android_id_verifies_the_change(self):
        seen: list[str] = []
        state = {"id": "aaaaaaaaaaaaaaaa"}

        def run(adb, args, timeout=30):
            cmd = " ".join(args)
            seen.append(cmd)
            if "settings put secure android_id" in cmd:
                state["id"] = cmd.strip().rsplit(" ", 1)[-1]
                return (0, b"", b"")
            if "android_id" in cmd:
                return (0, (state["id"] + "\n").encode(), b"")
            return (1, b"", b"unexpected")

        c._run_adb = run  # type: ignore[assignment]
        r = c.NativeBridge().resetAndroidId("emulator-5554")
        self.assertTrue(r["ok"])
        self.assertEqual(r["oldAndroidId"], "aaaaaaaaaaaaaaaa")
        self.assertRegex(r["androidId"], r"^[0-9a-f]{16}$")
        self.assertNotEqual(r["androidId"], "aaaaaaaaaaaaaaaa")

    def test_write_file_rejects_relative_paths(self):
        seen: list[list[str]] = []
        c._run_adb = lambda adb, args, timeout=30: (seen.append(args), (0, b"", b""))[1]  # type: ignore[assignment]
        with self.assertRaises(RuntimeError):
            c.NativeBridge().writeFile("emulator-5554", "mGameInfo.xml", "eA==")
        self.assertEqual(seen, [])

    def test_su_commands_are_single_shell_strings(self):
        # Regression: passing su/-c/payload as separate argv items makes
        # `adb shell` join them with spaces, and the device answers
        # "Unknown id: put". Every su invocation must be one shell string.
        seen: list[list[str]] = []
        state = {"id": "aaaaaaaaaaaaaaaa"}

        def run(adb, args, timeout=30):
            seen.append(args)
            cmd = " ".join(args)
            if "settings put secure android_id" in cmd and "su -c '" in cmd:
                state["id"] = cmd.strip().rsplit(" ", 1)[-1].rstrip("'")
                return (0, b"", b"")
            if "android_id" in cmd and "put" not in cmd:
                return (0, (state["id"] + "\n").encode(), b"")
            return (1, b"", b"unexpected")

        c._run_adb = run  # type: ignore[assignment]
        r = c.NativeBridge().resetAndroidId("emulator-5554")
        self.assertTrue(r["ok"])
        for args in seen:
            shell_args = [a for a in args if a not in ("-s", "emulator-5554", "shell")]
            if any("su -c" in a for a in shell_args):
                quoted = [a for a in shell_args if a.startswith("su -c '")]
                self.assertEqual(len(quoted), 1, args)

    def test_unknown_id_falls_through_to_the_next_variant(self):
        state = {"id": "aaaaaaaaaaaaaaaa"}
        calls: list[str] = []

        def run(adb, args, timeout=30):
            cmd = " ".join(args)
            calls.append(cmd)
            if cmd.endswith("settings get secure android_id"):
                return (0, (state["id"] + "\n").encode(), b"")
            if "settings put secure android_id" in cmd:
                if cmd.startswith("-s emulator-5554 shell settings put"):
                    return (0, b"", b"Unknown id: put")
                state["id"] = cmd.strip().rsplit(" ", 1)[-1].rstrip("'")
                return (0, b"", b"")
            return (1, b"", b"unexpected")

        c._run_adb = run  # type: ignore[assignment]
        r = c.NativeBridge().resetAndroidId("emulator-5554")
        self.assertTrue(r["ok"])
        self.assertNotEqual(r["androidId"], "aaaaaaaaaaaaaaaa")
        self.assertTrue(any("settings put secure android_id" in x and "su -c" in x for x in calls))

    def test_refusal_points_at_emulator_device_settings(self):
        c._run_adb = lambda adb, args, timeout=30: (0, b"aaaaaaaaaaaaaaaa\n", b"") if "get" in " ".join(args) else (1, b"", b"Permission denied")  # type: ignore[assignment]
        with self.assertRaisesRegex(RuntimeError, "emulator's device settings"):
            c.NativeBridge().resetAndroidId("emulator-5554")

    def test_read_gsf_id_from_pulled_database(self):
        import sqlite3
        import tempfile

        with tempfile.TemporaryDirectory() as td:
            db = os.path.join(td, "gservices.db")
            con = sqlite3.connect(db)
            con.execute("CREATE TABLE main (name TEXT, value TEXT)")
            con.execute("INSERT INTO main VALUES ('android_id', 'ABCDEF0123456789')")
            con.commit()
            con.close()
            with open(db, "rb") as fh:
                blob = fh.read()

        real_pull = c.NativeBridge._pull_privileged

        def fake_pull(self, adb, serial, remote, diag=None):
            if "gservices.db" in remote:
                return blob
            return None

        c.NativeBridge._pull_privileged = fake_pull  # type: ignore[assignment]
        c._run_adb = lambda adb, args, timeout=30: (0, b"/x/gservices.db\n", b"") if "ls " in " ".join(args) else (1, b"", b"no")  # type: ignore[assignment]
        try:
            r = c.NativeBridge().readGsfId("emulator-5554")
        finally:
            c.NativeBridge._pull_privileged = real_pull  # type: ignore[assignment]
        self.assertTrue(r["ok"])
        self.assertEqual(r["gsfId"], "abcdef0123456789")

    def test_reset_gsf_id_reports_deleted_files(self):
        c._run_adb = lambda adb, args, timeout=30: (0, b"", b"") if "rm -f" in " ".join(args) else (1, b"", b"No such file")  # type: ignore[assignment]
        r = c.NativeBridge().resetGsfId("emulator-5554")
        self.assertTrue(r["ok"])
        self.assertTrue(any("gservices.db" in p and not p.endswith(("-shm", "-wal")) for p in r["deleted"]))

    def test_nuke_secure_settings_renames_never_deletes(self):
        seen: list[str] = []
        c._run_adb = lambda adb, args, timeout=30: (seen.append(" ".join(args)), (0, b"/data/system/users/0/settings_secure.xml\n", b""))[1]  # type: ignore[assignment]
        r = c.NativeBridge().nukeSecureSettings("emulator-5554")
        self.assertTrue(r["ok"])
        self.assertTrue(any("settings_secure.xml.iggbak" in c for c in seen))
        self.assertFalse(any(re.search(r"\brm\b", c) for c in seen))

    def test_reboot_timeout_means_rebooting_not_failed(self):
        # `adb reboot` drops the connection by design; a timeout verdict is
        # the success signal, not an error.
        c._run_adb = lambda adb, args, timeout=30: (124, b"", b"adb timed out")  # type: ignore[assignment]
        r = c.NativeBridge().rebootDevice("emulator-5554")
        self.assertTrue(r["ok"])
        self.assertTrue(r.get("rebooting"))

    def test_reboot_refuses_on_hard_errors_only(self):
        c._run_adb = lambda adb, args, timeout=30: (1, b"", b"device unauthorized")  # type: ignore[assignment]
        with self.assertRaisesRegex(RuntimeError, "reboot failed"):
            c.NativeBridge().rebootDevice("emulator-5554")

    def test_pm_clear_stops_then_clears_and_clears_cache(self):
        seen: list[str] = []
        c._run_adb = lambda adb, args, timeout=30: (seen.append(" ".join(args)), (0, b"package:/data/app/x.apk\n" if "pm path" in " ".join(args) else (b"Success\n" if "pm clear" in " ".join(args) else b""), b""))[1]  # type: ignore[assignment]
        r = c.NativeBridge().pmClear("emulator-5554")
        self.assertTrue(r["ok"])
        self.assertIn(r["package"], ("com.playrix.township", "com.playrix.township.vn"))
        joined = "\n".join(seen)
        self.assertIn("force-stop", joined)
        self.assertIn("pm clear", joined)
        self.assertLess(joined.index("force-stop"), joined.index("pm clear"))

    def test_pm_clear_falls_through_to_the_next_package(self):
        def run(adb, args, timeout=30):
            cmd = " ".join(args)
            if "pm path com.playrix.township " in cmd or cmd.endswith("pm path com.playrix.township"):
                return (1, b"", b"not installed")
            if "pm path" in cmd:
                return (0, b"package:/data/app/x.apk\n", b"")
            if "pm clear" in cmd:
                return (0, b"Success\n", b"")
            return (0, b"", b"")

        c._run_adb = run  # type: ignore[assignment]
        r = c.NativeBridge().pmClear("emulator-5554")
        self.assertTrue(r["ok"])

    def test_pm_clear_raises_when_nothing_works(self):
        c._run_adb = lambda adb, args, timeout=30: (1, b"", b"Failure")  # type: ignore[assignment]
        with self.assertRaises(RuntimeError):
            c.NativeBridge().pmClear("emulator-5554")


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