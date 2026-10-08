@echo off
REM ============================================================
REM  FolioFold-Clean.bat
REM  Safely empties the G:\FolioFold\Clean staging area.
REM  Strict path guard: it can NEVER delete anything outside Clean.
REM ============================================================
setlocal EnableExtensions DisableDelayedExpansion

REM --- 1. Strict path guard ---
set "EXPECTED=G:\FolioFold\Clean"
set "TARGET=%~dp0Clean"
for %%I in ("%TARGET%") do set "TARGET=%%~fI"
for %%I in ("%EXPECTED%") do set "EXPECTED=%%~fI"

if /I not "%TARGET%"=="%EXPECTED%" (
  echo [ABORT] Path guard failed.
  echo   Expected: %EXPECTED%
  echo   Resolved: %TARGET%
  echo This script only empties G:\FolioFold\Clean. Nothing was deleted.
  pause
  exit /b 1
)

REM --- 2. Explicit confirmation ---
echo This will PERMANENTLY DELETE all content inside:
echo   %TARGET%
echo (the .gitkeep and README.md placeholders are kept)
echo.
set "ANS="
set /p ANS=Type YES to continue, or anything else to cancel: 
if /I not "%ANS%"=="YES" (
  echo [CANCELLED] Nothing was deleted.
  pause
  exit /b 0
)

REM --- 3. Empty the staging area (keep placeholders) ---
for /D %%D in ("%TARGET%\*") do (
  echo rmdir /s /q "%%D"
  rmdir /s /q "%%D" >nul 2>&1
)
for %%F in ("%TARGET%\*") do (
  if /I not "%%~nxF"==".gitkeep" (
    if /I not "%%~nxF"=="README.md" (
      echo del /f /q "%%F"
      del /f /q "%%F" >nul 2>&1
    )
  )
)
echo [DONE] Clean staging area emptied. Placeholders kept.
pause
