@echo off
REM Build the IGG VIP Studio Windows client EXE.
REM Usage: double-click build_exe.bat   (or run it from a terminal in client/)
setlocal
cd /d "%~dp0"

echo [1/2] Installing build tools (pyinstaller, pywebview)...
python -m pip install --quiet --disable-pip-version-check pyinstaller pywebview
if errorlevel 1 (
  echo Failed to install build tools. Make sure Python 3.9+ is installed and on PATH.
  pause
  exit /b 1
)

echo [2/2] Building EXE with PyInstaller...
python -m PyInstaller --clean --noconfirm igg_client.spec
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)

echo.
echo Done. The EXE is at:  dist\IGG VIP TOOL.exe
pause
