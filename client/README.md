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

## Run the prebuilt EXE
```
dist\IGG-VIP-Studio.exe
```

## Build it yourself
```
cd client
build_exe.bat
```
The EXE is produced at `client\dist\IGG-VIP-Studio.exe`.

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
