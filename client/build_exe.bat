@echo off
REM Build the IGG VIP Studio Windows client (onedir) and zip it for release.
REM Usage: double-click build_exe.bat   (or run it from a terminal in client/)
setlocal
cd /d "%~dp0"

echo [1/3] Installing build tools (pyinstaller, pywebview)...
python -m pip install --quiet --disable-pip-version-check pyinstaller pywebview
if errorlevel 1 (
  echo Failed to install build tools. Make sure Python 3.9+ is installed and on PATH.
  pause
  exit /b 1
)

echo [2/3] Building the app folder with PyInstaller...
python -m PyInstaller --clean --noconfirm igg_client.spec
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)

echo [3/3] Packaging dist\IGG.VIP.TOOL.zip...
powershell -NoProfile -Command "Compress-Archive -Path 'dist\IGG VIP TOOL' -DestinationPath 'dist\IGG.VIP.TOOL.zip' -Force"
if errorlevel 1 (
  echo Zip packaging failed.
  pause
  exit /b 1
)

echo.
echo Done.
echo   App folder: dist\IGG VIP TOOL\IGG VIP TOOL.exe
echo   Release zip: dist\IGG.VIP.TOOL.zip
pause
