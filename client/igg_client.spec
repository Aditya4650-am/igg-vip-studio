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
    datas=[],
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
    name="IGG-VIP-Studio",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,                 # UPX often triggers antivirus false-positives
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,             # windowed app (no console)
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(ROOT / "icon.ico") if (ROOT / "icon.ico").exists() else None,
    version="version_info.txt" if (ROOT / "version_info.txt").exists() else None,
)
