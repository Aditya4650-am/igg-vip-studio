@echo off
REM Build the protected IGG VIP Studio Windows client EXE.
REM Usage: double-click build_exe.bat   (or run it from a terminal in client/)
REM
REM The build is Nuitka (compiles the Python to machine code) followed by
REM protect/build.py, which encrypts the result with AES-256-GCM and wraps it
REM in a small C loader. Requires Python 3.9-3.12 for the MinGW path, or 3.13+
REM with the MSVC build tools installed.
setlocal
cd /d "%~dp0"

echo [1/2] Installing build tools (nuitka, pywebview, cryptography)...
python -m pip install --quiet --disable-pip-version-check nuitka pywebview cryptography
if errorlevel 1 (
  echo Failed to install build tools. Make sure Python 3.9+ is installed and on PATH.
  pause
  exit /b 1
)

echo [2/2] Compiling with Nuitka, then encrypting and packing...
python protect\build.py
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)

echo.
echo Done. The protected EXE is at:  dist\IGG VIP TOOL.exe
pause
