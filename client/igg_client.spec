# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for the IGG VIP Studio Windows client.
# Build with:  python -m PyInstaller igg_client.spec

from pathlib import Path

block_cipher = None
ROOT = Path(SPECPATH)  # the client/ folder

a = Analysis(
    ["igg_client.py"],
    pathex=[str(ROOT)],
    binaries=[],
    datas=[
        # Bundle adb so the client never depends on the user's PATH.
        (str(ROOT / "adb" / "adb.exe"), "adb"),
        (str(ROOT / "adb" / "AdbWinApi.dll"), "adb"),
        (str(ROOT / "adb" / "AdbWinUsbApi.dll"), "adb"),
        # Bundled fresh-city profile (TS-Lite-style Level-1 injection).
        (str(ROOT / "fresh_profile" / "localinfo.profile"), "fresh_profile"),
        (str(ROOT / "fresh_profile" / "mgameinfo.profile"), "fresh_profile"),
    ],
    hiddenimports=[
        "webview",
        "webview.platforms.winforms",
        "clr",
        "pythonnet",
        "bottle",
        "proxy_tools",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="IGG VIP TOOL",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,                 # UPX often triggers antivirus false-positives
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,            # windowed build: no console window on launch
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(ROOT / "icon.ico") if (ROOT / "icon.ico").exists() else None,
    version="version_info.txt" if (ROOT / "version_info.txt").exists() else None,
)
