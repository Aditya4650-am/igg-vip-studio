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

Grab `IGG VIP TOOL.exe` from the latest release:
**https://github.com/Aditya4650-am/igg-vip-studio/releases/latest**

It is a windowed build, so no console window appears behind the app. Runs on
64-bit Windows 10/11.

> The repository is private, so the release download requires being signed in to
> GitHub. If you need a public link, the same EXE is attached to each build as a
> workflow artifact (Actions → Build Windows client → Artifacts).

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

`build_exe.bat` builds with whatever Python is on PATH. If that interpreter is
brand new, PyInstaller may not yet ship a bootloader for it, and the build can
fail or need `console=True`. The CI workflow pins Python 3.12 for this reason;
prefer it if the local build misbehaves.

Or trigger a build in CI without a Windows machine: **Actions → Build Windows
client → Run workflow**. Pushing a `v*` tag builds the EXE and attaches it to a
GitHub release automatically.

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
