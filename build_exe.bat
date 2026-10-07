@echo off
REM ============================================================================
REM  Build FolioFold Windows launcher EXE (PyInstaller, onedir).
REM  Requires: Python 3.11 with `pyinstaller` installed (pip install pyinstaller)
REM  Output:   release\FolioFold\FolioFold.exe  (+ support folder)
REM
REM  Distribute: copy the *contents* of release\FolioFold\ into the user's
REM  FolioFold install folder (next to server.py), then double-click
REM  FolioFold.exe. The EXE only launches server.py; Python 3.11 must be
REM  installed. The .bat launchers remain the supported fallback.
REM
REM  No personal paths, usernames, or tokens are used here.
REM ============================================================================
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"

set "PY="
where py >nul 2>nul && set "PY=py -3.11"
if not defined PY set "PY=python"

echo Building FolioFold launcher EXE with: %PY%
%PY% -m PyInstaller --noconfirm --clean --onedir --windowed ^
    --name FolioFold ^
    --distpath "%ROOT%\release" ^
    --workpath "%ROOT%\build" ^
    "%ROOT%\launcher.py"

if exist "%ROOT%\release\FolioFold\FolioFold.exe" (
    echo.
    echo BUILD OK  -> %ROOT%\release\FolioFold\FolioFold.exe
) else (
    echo.
    echo BUILD FAILED. Check the output above.
    exit /b 1
)
