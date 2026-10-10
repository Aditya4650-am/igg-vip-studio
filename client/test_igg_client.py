"""Unit tests for the Windows client's URL handling.

Network-free: the loopback proxy is stubbed, so these run on any machine,
including the Windows build runner before the EXE is packaged.
"""

from __future__ import annotations

import hashlib
import io
import os
import re
import socket
import sys
import tempfile
import types
import unittest
import urllib.request
import zipfile
from pathlib import Path

# pywebview is imported at module import time and is not needed for these tests.
sys.modules.setdefault("webview", types.ModuleType("webview"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import igg_client as c  # noqa: E402

HOST = "igg-vip-studio-491.onrender.com"
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

    # --- bundled fresh-city profile (TS-Lite-style injection) ---------------

    def test_bundled_profile_files_exist_and_are_complete(self):
        d = c.NativeBridge()._freshProfileDir()
        local = (d / c.FRESH_LOCAL_PROFILE).read_bytes()
        save = (d / c.FRESH_SAVE_PROFILE).read_bytes()
        self.assertEqual(len(local), 4675)
        self.assertEqual(len(save), 300008)
        # The save is the game's own container, not plain XML.
        self.assertFalse(save.lstrip().startswith(b"<"))

    def test_missing_profile_directory_is_reported_not_hidden(self):
        saved = c.FRESH_PROFILE_DIR
        c.FRESH_PROFILE_DIR = "fresh_profile_does_not_exist"
        try:
            with self.assertRaises(RuntimeError):
                c.NativeBridge()._freshProfileDir()
        finally:
            c.FRESH_PROFILE_DIR = saved

    def _inject_shell(self, overrides=None):
        # The whole proven script runs in ONE root command and must answer
        # with its SUCCESS probe plus both byte counts.
        ok_out = (
            b"restorecon: reset /data/user/0/com.playrix.township/saves/LocalInfo.xml context\n"
            b"SUCCESS\n"
            b"4675 /data/user/0/com.playrix.township/saves/LocalInfo.xml\n"
            b"300008 /data/user/0/com.playrix.township/saves/mGameInfo.xml\n"
        )
        mapping = {
            "pm path": (0, b"package:/data/app/p/base.apk\n", b""),
            "am force-stop": (0, b"", b""),
            "find ": (
                0, b"/data/user/0/com.playrix.township/saves/mGameInfo.xml\n", b""
            ),
            "push": (0, b"", b""),
            "setenforce 0": (0, ok_out, b""),
        }
        if overrides:
            mapping.update(overrides)
        return self._shell(mapping)

    def test_injects_and_verifies_both_profile_files(self):
        c._run_adb = self._inject_shell()  # type: ignore[assignment]
        r = c.NativeBridge().injectFreshProfile("emulator-5554")
        self.assertTrue(r["ok"])
        self.assertEqual(r["package"], "com.playrix.township")
        self.assertEqual(r["dir"], "/data/user/0/com.playrix.township/saves")
        self.assertEqual(r["verified"]["mGameInfo.xml"], 300008)
        self.assertEqual(r["verified"]["LocalInfo.xml"], 4675)

    def test_inject_script_is_the_proven_one_and_in_order(self):
        # Reproduce the competitor's script command-for-command: SELinux off,
        # clear the saves folder, copy the pair, fix modes + labels, SELinux
        # back on, then its SUCCESS probe. A missing `setenforce 0` or `rm -rf`
        # is exactly what let the old city survive last time.
        seen: list[str] = []
        base = self._inject_shell()

        def spy(adb, args, timeout=30):
            cmd = " ".join(str(a) for a in args)
            if "setenforce 0" in cmd:
                seen.append(cmd)
            return base(adb, args, timeout)

        c._run_adb = spy  # type: ignore[assignment]
        r = c.NativeBridge().injectFreshProfile("emulator-5554")
        self.assertTrue(r["ok"])
        self.assertEqual(len(seen), 1, "one root command for the whole script")
        cmd = seen[0]
        self.assertIn('su -mm -c "', cmd, "mount-master wrapper is what it runs")
        idx = -1
        for marker in (
            "setenforce 0",
            'rm -rf \\"',
            'mkdir -p \\"',
            'cp -af \\"',
            "LocalInfo.xml",
            "mGameInfo.xml",
            "chmod 777",
            "restorecon -vR",
            "setenforce 1",
            '[ -f \\"',
            'echo \\"SUCCESS\\"',
            "wc -c",
        ):
            pos = cmd.find(marker, idx + 1)
            self.assertGreater(pos, idx, f"missing or out of order: {marker!r}")
            idx = pos
        # Exactly the proven pair — no third file.
        self.assertNotIn("mLocalInfo.xml", cmd)

    def test_wrong_copy_size_is_an_error_never_a_success(self):
        # A truncated copy must not be reported as a working fresh start —
        # that silent-success pattern is exactly what broke the wipe flow.
        c._run_adb = self._inject_shell({
            "setenforce 0": (
                0,
                b"SUCCESS\n"
                b"1234 /data/user/0/com.playrix.township/saves/mGameInfo.xml\n"
                b"4675 /data/user/0/com.playrix.township/saves/LocalInfo.xml\n",
                b"",
            ),
        })  # type: ignore[assignment]
        with self.assertRaises(RuntimeError) as ctx:
            c.NativeBridge().injectFreshProfile("emulator-5554")
        self.assertIn("verification mismatch", str(ctx.exception))

    def test_failed_probe_is_an_error_never_a_success(self):
        # The script answering FAILURE (or nothing) must surface as an error
        # with the reason, not a silent pass.
        c._run_adb = self._inject_shell({
            "setenforce 0": (0, b"FAILURE\n", b""),
        })  # type: ignore[assignment]
        with self.assertRaises(RuntimeError) as ctx:
            c.NativeBridge().injectFreshProfile("emulator-5554")
        self.assertIn("FAILURE", str(ctx.exception))

    def test_root_denied_is_reported_with_the_reason(self):
        c._run_adb = self._inject_shell({
            "setenforce 0": (1, b"", b"Permission denied"),
        })  # type: ignore[assignment]
        with self.assertRaises(RuntimeError) as ctx:
            c.NativeBridge().injectFreshProfile("emulator-5554")
        self.assertIn("injection failed", str(ctx.exception))
        self.assertIn("Permission denied", str(ctx.exception))

    # --- launch (mirrors the post-inject "open the game" step) ------------

    @staticmethod
    def _pkg_path():
        return (0, b"package:/data/app/p/base.apk\n", b"")

    def test_launch_game_uses_the_proven_monkey_intent(self):
        seen: list[str] = []

        def run(adb, args, timeout=30):
            cmd = " ".join(str(a) for a in args)
            seen.append(cmd)
            if "pm path" in cmd:
                return self._pkg_path()
            if "monkey" in cmd:
                return (0, b"Events injected: 1\n", b"")
            return (1, b"", b"unexpected: " + cmd.encode()[:40])

        c._run_adb = run  # type: ignore[assignment]
        r = c.NativeBridge().launchGame("emulator-5554")
        self.assertTrue(r["ok"])
        monkey = next(c for c in seen if "monkey" in c)
        self.assertIn("monkey -p com.playrix.township", monkey)
        self.assertIn("android.intent.category.LAUNCHER 1", monkey)

    def test_launch_game_falls_back_to_resolved_am_start(self):
        def run(adb, args, timeout=30):
            cmd = " ".join(str(a) for a in args)
            if "pm path" in cmd:
                return self._pkg_path()
            if "monkey" in cmd:
                return (0, b"No activities found to run 'monkey'\n", b"")
            if "am start" in cmd:
                return (0, b"Starting: Intent { cmp=com.playrix.township/.A }\n", b"")
            return (1, b"", b"unexpected: " + cmd.encode()[:40])

        c._run_adb = run  # type: ignore[assignment]
        r = c.NativeBridge().launchGame("emulator-5554")
        self.assertTrue(r["ok"])

    def test_launch_game_reports_failure_not_fake_success(self):
        def run(adb, args, timeout=30):
            cmd = " ".join(str(a) for a in args)
            if "pm path" in cmd:
                return self._pkg_path()
            return (0, b"No activities found to run 'monkey'\n", b"")

        c._run_adb = run  # type: ignore[assignment]
        with self.assertRaises(RuntimeError) as ctx:
            c.NativeBridge().launchGame("emulator-5554")
        self.assertIn("could not launch", str(ctx.exception))

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

    def test_force_android_id_writes_new_id_into_settings_file(self):
        from pathlib import Path as _Path

        body = '<settings><setting id="1" name="android_id" value="aaaaaaaaaaaaaaaa" package="android" /></settings>'
        state = {"written": ""}

        def run(adb, args, timeout=30):
            cmd = " ".join(args)
            if "settings get secure android_id" in cmd and "put" not in cmd:
                return (0, b"aaaaaaaaaaaaaaaa\n", b"")
            if "su -c 'cat " in cmd:
                return (0, body.encode(), b"")
            if len(args) > 3 and args[2] == "push":
                local = _Path(args[3])
                data = local.read_text(encoding="utf-8")
                m = re.search(r'name="android_id" value="([0-9a-f]{16})"', data)
                state["written"] = m.group(1) if m else ""
                return (0, b"", b"")
            if "su -c 'cp " in cmd:
                return (0, b"", b"")
            if "grep android_id" in cmd:
                return (0, f'name="android_id" value="{state["written"]}"\n'.encode(), b"")
            return (1, b"", b"unexpected")

        c._run_adb = run  # type: ignore[assignment]
        r = c.NativeBridge().forceAndroidId("emulator-5554")
        self.assertTrue(r["ok"])
        self.assertEqual(r["oldAndroidId"], "aaaaaaaaaaaaaaaa")
        self.assertRegex(r["androidId"], r"^[0-9a-f]{16}$")
        self.assertNotEqual(r["androidId"], "aaaaaaaaaaaaaaaa")
        self.assertEqual(state["written"], r["androidId"])

    def test_clear_gms_clears_all_packages_including_play_games(self):
        seen: list[str] = []

        def run(adb, args, timeout=30):
            cmd = " ".join(args)
            seen.append(cmd)
            if "pm path" in cmd:
                return (0, b"package:/data/app/x.apk\n", b"")
            if "pm clear" in cmd:
                return (0, b"Success\n", b"")
            return (0, b"", b"")

        c._run_adb = run  # type: ignore[assignment]
        r = c.NativeBridge().clearGms("emulator-5554")
        self.assertTrue(r["ok"])
        self.assertIn("com.google.android.gms", r["cleared"])
        self.assertIn("com.google.android.gsf", r["cleared"])
        self.assertIn("com.google.android.play.games", r["cleared"])

    def test_reset_tries_content_commands_and_drops_ssaid(self):
        seen: list[str] = []
        state = {"id": "aaaaaaaaaaaaaaaa"}

        def run(adb, args, timeout=30):
            cmd = " ".join(args)
            seen.append(cmd)
            if "settings get secure android_id" in cmd and "put" not in cmd:
                return (0, (state["id"] + "\n").encode(), b"")
            if "settings put secure android_id" in cmd:
                return (0, b"", b"")  # silent ignore: id stays
            if "content delete" in cmd:
                state["id"] = ""
                return (0, b"", b"")
            if "content insert" in cmd:
                m = re.search(r"value:s:([0-9a-f]{16})", cmd)
                state["id"] = m.group(1) if m else state["id"]
                return (0, b"", b"")
            if "settings_ssaid" in cmd:
                return (0, b"", b"")
            return (1, b"", b"unexpected")

        c._run_adb = run  # type: ignore[assignment]
        r = c.NativeBridge().resetAndroidId("emulator-5554")
        self.assertTrue(r["ok"])
        self.assertNotEqual(r["androidId"], "aaaaaaaaaaaaaaaa")
        joined = "\n".join(seen)
        self.assertIn("content delete", joined)
        self.assertIn("content insert", joined)
        self.assertIn("settings_ssaid", joined)

    def test_wait_for_device_ok_and_timeout(self):
        c._run_adb = lambda adb, args, timeout=30: (0, b"", b"")  # type: ignore[assignment]
        self.assertTrue(c.NativeBridge().waitForDevice("emulator-5554")["ok"])
        c._run_adb = lambda adb, args, timeout=30: (124, b"", b"adb timed out")  # type: ignore[assignment]
        with self.assertRaisesRegex(RuntimeError, "did not come back"):
            c.NativeBridge().waitForDevice("emulator-5554")

    def test_verify_wipe_passes_when_nothing_remains(self):
        def run(adb, args, timeout=30):
            cmd = " ".join(args)
            if "pm path com.playrix.township " in cmd or cmd.endswith("pm path com.playrix.township"):
                return (1, b"", b"not installed")
            if "pm path" in cmd:
                return (0, b"package:/data/app/x.apk\n", b"")
            if "su -c 'ls " in cmd:
                return (1, b"", b"No such file")
            return (0, b"", b"")

        c._run_adb = run  # type: ignore[assignment]
        r = c.NativeBridge().verifyWipe("emulator-5554")
        self.assertTrue(r["ok"])
        self.assertGreater(r["checked"], 0)

    def test_verify_wipe_names_surviving_files(self):
        def run(adb, args, timeout=30):
            cmd = " ".join(args)
            if "pm path" in cmd:
                return (0, b"package:/data/app/x.apk\n", b"")
            if "su -c 'ls " in cmd and "mGameInfo.xml" in cmd and "/saves/" in cmd:
                return (0, b"/data/data/com.playrix.township.vn/saves/mGameInfo.xml\n", b"")
            if "su -c 'ls " in cmd:
                return (1, b"", b"No such file")
            return (0, b"", b"")

        c._run_adb = run  # type: ignore[assignment]
        r = c.NativeBridge().verifyWipe("emulator-5554")
        self.assertFalse(r["ok"])
        self.assertTrue(any("mGameInfo.xml" in p for p in r["remaining"]))

    def test_device_fingerprint_reads_build_props(self):
        def run(adb, args, timeout=30):
            cmd = " ".join(args)
            if cmd.endswith("getprop ro.product.model"):
                return (0, b"MEmu\n", b"")
            if cmd.endswith("getprop ro.build.fingerprint"):
                return (0, b"generic/fake\n", b"")
            if "getprop" in cmd:
                return (1, b"", b"unknown prop")
            return (1, b"", b"unexpected")

        c._run_adb = run  # type: ignore[assignment]
        r = c.NativeBridge().deviceFingerprint("emulator-5554")
        self.assertTrue(r["ok"])
        self.assertEqual(r["props"].get("ro.product.model"), "MEmu")

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

    def test_reinstall_backs_up_apk_then_uninstalls_and_reinstalls(self):
        from pathlib import Path as _Path

        calls: list[str] = []

        def run(adb, args, timeout=30):
            cmd = " ".join(args)
            calls.append(cmd)
            if "pm path com.playrix.township" in cmd and "vn" not in cmd:
                return (1, b"", b"not installed")
            if "pm path" in cmd:
                return (0, b"package:/data/app/x/base.apk\npackage:/data/app/x/split.apk\n", b"")
            if " pull " in cmd:
                _Path(args[-1]).write_bytes(b"FAKEAPK")
                return (0, b"", b"")
            if "uninstall com.playrix" in cmd:
                return (0, b"Success\n", b"")
            if "install-multiple" in cmd:
                return (0, b"Success\n", b"")
            return (0, b"", b"")

        c._run_adb = run  # type: ignore[assignment]
        r = c.NativeBridge().reinstallTownship("emulator-5554")
        self.assertTrue(r["ok"])
        self.assertEqual(r["apkCount"], 2)
        self.assertGreater(r["apkBytes"], 0)
        joined = "\n".join(calls)
        self.assertLess(joined.index("uninstall"), joined.index("install-multiple"))

    def test_reinstall_refuses_when_uninstall_fails(self):
        from pathlib import Path as _Path2

        def run(adb, args, timeout=30):
            cmd = " ".join(args)
            if "pm path" in cmd:
                return (0, b"package:/data/app/x/base.apk\n", b"")
            if " pull " in cmd:
                _Path2(args[-1]).write_bytes(b"FAKEAPK")
                return (0, b"", b"")
            if "uninstall" in cmd:
                return (1, b"", b"Failure [DELETE_FAILED_INTERNAL_ERROR]")
            return (0, b"", b"")

        c._run_adb = run  # type: ignore[assignment]
        with self.assertRaisesRegex(RuntimeError, "uninstall failed"):
            c.NativeBridge().reinstallTownship("emulator-5554")


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


class ReleaseZipLayout(unittest.TestCase):
    """The release is a zipped onedir app folder; the updater must tell it
    apart from the legacy single-exe zip so a server still pointing at an old
    URL keeps working unchanged."""

    def test_flat_exe_zip_is_the_legacy_layout(self):
        self.assertFalse(c._release_zip_is_folder(["IGG VIP TOOL.exe"]))

    def test_folder_entries_mark_the_onedir_layout(self):
        self.assertTrue(
            c._release_zip_is_folder(
                ["IGG VIP TOOL/IGG VIP TOOL.exe",
                 "IGG VIP TOOL/_internal/python312.dll"]
            )
        )


class StageFolderRelease(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.install = Path(self._tmp.name) / "IGG VIP TOOL"
        self.install.mkdir()

    def _zip(self, entries: dict[str, bytes]) -> bytes:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            for name, data in entries.items():
                zf.writestr(name, data)
        return buf.getvalue()

    def test_matching_hash_unpacks_the_app_folder(self):
        payload = self._zip({
            "IGG VIP TOOL/IGG VIP TOOL.exe": b"MZ-fake",
            "IGG VIP TOOL/_internal/mod.py": b"x",
        })
        expected = hashlib.sha256(payload).hexdigest()
        out = c._stage_folder_release(payload, expected, self.install)
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["src"].name, "IGG VIP TOOL")
        self.assertTrue((out["src"] / "IGG VIP TOOL.exe").is_file())
        # staging sits beside the install folder, never inside it — an update
        # must not copy the app onto its own leftovers.
        self.assertEqual(out["staging"].parent, self.install.parent)
        self.assertEqual(out["staging"].name, self.install.name + ".new")
        self.assertNotEqual(out["staging"], self.install)

    def test_wrong_hash_is_refused_before_anything_is_written(self):
        payload = self._zip({"IGG VIP TOOL/IGG VIP TOOL.exe": b"MZ-fake"})
        out = c._stage_folder_release(payload, "0" * 64, self.install)
        self.assertFalse(out["ok"])
        self.assertEqual(out["reason"], "sha256 mismatch")
        self.assertFalse((self.install.parent / (self.install.name + ".new")).exists())

    def test_a_zip_without_an_exe_is_refused(self):
        payload = self._zip({"IGG VIP TOOL/readme.txt": b"hi"})
        expected = hashlib.sha256(payload).hexdigest()
        out = c._stage_folder_release(payload, expected, self.install)
        self.assertFalse(out["ok"])
        self.assertEqual(out["reason"], "zip has no exe")


class FolderUpdaterBat(unittest.TestCase):
    def test_waits_for_exit_then_swaps_and_relaunches(self):
        bat = c._folder_updater_bat(
            Path("C:\\x\\IGG VIP TOOL.new\\IGG VIP TOOL"),
            Path("C:\\x\\IGG VIP TOOL.new"),
            Path("C:\\x\\IGG VIP TOOL"),
            Path("C:\\x\\IGG VIP TOOL\\IGG VIP TOOL.exe"),
        )
        self.assertIn(":wait", bat)
        self.assertIn("tasklist", bat)
        self.assertIn("xcopy /y /e /q /i", bat)
        self.assertIn('start "" "C:\\x\\IGG VIP TOOL\\IGG VIP TOOL.exe"', bat)
        # the running exe must be gone before xcopy may overwrite it, so the
        # wait loop has to come before the copy.
        self.assertLess(bat.index(":wait"), bat.index("xcopy"))
        # cleanup: staged folder and the updater script itself both go.
        self.assertIn("rmdir /s /q", bat)
        self.assertIn('del "%~f0"', bat)


if __name__ == "__main__":
    unittest.main(verbosity=2)