# IGG VIP Studio — Windows Client

A native desktop app for IGG VIP Studio. It opens the web app (from your
deployed Render server) in a WebView2 window and adds the **ADB bridge** so the
desktop can do what a browser tab can't: connect to an emulator, pull/push the
save, run Unban, and self-update.

Like the README says, the EXE holds **no save algorithm and no secrets** — all
game logic stays on the server.

## Requirements
- Windows 10/11 (WebView2 runtime — already on most Windows 11; the app prompts
  if it's missing).
- Internet connection (it loads the UI from your server URL).
- For ADB features: an Android emulator (BlueStacks / Nox / LDPlayer / MEmu)
  with ADB enabled, or Android SDK platform-tools on PATH.

## Download the prebuilt EXE

Grab `IGG.VIP.TOOL.exe` from the latest release:
**https://github.com/Aditya4650-am/igg-vip-studio/releases/latest**

It is a windowed build, so no console window appears behind the app. Runs on
64-bit Windows 10/11.

> The asset is named `IGG.VIP.TOOL.exe`: GitHub replaces the spaces in the
> local `IGG VIP TOOL.exe` when it uploads. The repository is public, so no
> GitHub sign-in is needed — a plain download works. The same EXE is also
> attached to each build as a workflow artifact (Actions → Build Windows
> client → Artifacts), zipped under its original name.

## Run it
```
IGG VIP TOOL.exe
```

## Build it yourself
```
cd client
build_exe.bat
```
The EXE is produced at `client\dist\IGG VIP TOOL.exe`.

The build is two stages (`client/protect/build.py` runs both):

1. **Nuitka** compiles `igg_client.py` — and every module it uses — to machine
   code. The old PyInstaller build shipped recoverable Python bytecode:
   `pyinstxtractor` plus a decompiler recovered the full source from it, which
   is the opposite of protection.
2. **`protect/pack_exe.py`** encrypts that EXE with AES-256-GCM and appends it
   to a small C loader (`protect/loader.c`). On disk the client is unreadable
   ciphertext; the loader authenticates it with the GCM tag (a tampered byte is
   refused before anything runs), refuses to run under a debugger, decrypts to
   a fresh `%TEMP%` folder, runs it with the same command line, and deletes it
   afterwards. The AES key lives only inside the compiled loader and never as
   32 contiguous bytes.

`build_exe.bat` builds with whatever Python is on PATH. Nuitka's MinGW
toolchain needs Python ≤ 3.12 (3.13+ requires MSVC); the CI workflow pins 3.12,
which is the safest choice locally too. The first build downloads that
toolchain (~300 MB) into `%LOCALAPPDATA%\Nuitka`.

The build ends by **launching the protected EXE** with `IGG_CLIENT_PROBE` set
and failing unless it reports its bundled `adb/` and `fresh_profile/` — i.e.
"does it still work after encryption" is answered by the build itself, not by
hope. CI repeats the launch as its own gate.

Or trigger a build in CI without a Windows machine: **Actions → Build Windows
client → Run workflow**. Pushing a `v*` tag builds the EXE and attaches it to a
GitHub release automatically.

### Notes on what this does and does not buy

- Bytecode extraction (`pyinstxtractor` / `decompyle`) — gone; there is no
  Python left in the file.
- On-disk copy — AES-256-GCM, authenticated, per-build key.
- Casual tampering / re-packing — refused by the GCM tag.
- Debugging the loader — exits silently under a debugger.
- A determined reverse engineer can still dump the payload from memory while
  it runs: nothing that runs on someone else's machine can be made
  "impossible to crack". The bar is moved from minutes to days.
- Antivirus heuristics dislike a self-decrypting EXE. An unsigned tool that
  drops and runs a temp binary is exactly what they look for, so expect to
  allowlist it; that is a property of every protector, not a defect here.

## Point it at your server
The client loads `DEFAULT_SERVER_URL` (in `igg_client.py`). Change it without
rebuilding by either:
- creating `%APPDATA%\IGG-VIP-Studio\server.txt` with your URL, or
- setting the environment variable `IGG_VIP_URL`.

## What the ADB bridge does (window.iggNative)
| Method | Purpose |
|---|---|
| `version()` | Client version (used for update checks). |
| `devices()` | List connected ADB devices. |
| `pull(serial)` | Pull `mGameInfo.xml` from the emulator. |
| `pullLocalInfo(serial)` | Pull `mLocalInfo.xml`. |
| `push(serial, b64, options)` | Force-stop, push save + `.bak`, optionally relaunch. |
| `forceStop(serial)` | Force-stop the game package. |
| `installUpdate(release)` | Download + verify (SHA-256) + swap in a new EXE. |
| `loadSavedKey` / `saveKey` / `clearSavedKey` | Store the license key locally. |

Game package assumed: `com.playrix.township` (save at
`/sdcard/Android/data/<pkg>/files/`). Adjust the constants at the top of
`igg_client.py` if your target differs.
