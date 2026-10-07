@echo off
setlocal EnableExtensions
rem ============================================================
rem  FolioFold Launcher (must ship with the repo, at project root)
rem  Uses only %~dp0 to locate the project root. No hardcoded
rem  machine path / username / token. Portable: clone it to
rem  C:\FolioFold, D:\FolioFold, E:\MyProjects\FolioFold -> still works.
rem ============================================================
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

rem --- 0. Single-instance: if already running, just open browser ---
call :check_up
if not errorlevel 1 (
    echo FolioFold is already running. Opening browser...
    start "" http://localhost:3000/
    goto :eof
)

rem --- 1. Pick Python 3.11 (cgi dependency; 3.13 will not work) ---
set "PY="
where py >nul 2>nul
if not errorlevel 1 (
    py -3.11 --version >nul 2>nul
    if not errorlevel 1 set "PY=py -3.11"
)
if not defined PY (
    where python >nul 2>nul
    if not errorlevel 1 (
        for /f "tokens=2" %%v in ('python --version 2^>^&1') do (
            echo %%v | findstr /b "3.11" >nul 2>nul && set "PY=python"
        )
    )
)
if not defined PY (
    echo [Error] Python 3.11 was not found.
    echo Please install Python 3.11 ^(https://www.python.org/downloads/^) with "Add to PATH" checked.
    echo Or run manually:  py -3.11 server.py
    pause
    goto :eof
)

rem --- 2. Remove any stale PID file (do NOT kill by it, to avoid hitting other Python) ---
if exist "%ROOT%\.foliofold.pid" del /q "%ROOT%\.foliofold.pid" >nul 2>nul

rem --- 3. Start the server (own console window titled FolioFold) ---
echo Starting FolioFold server: http://localhost:3000
start "FolioFold" %PY% "%ROOT%\server.py"

rem --- 4. Wait for health check (up to ~20s) ---
set "UP=0"
for /l %%i in (1,1,40) do (
    call :check_up
    if not errorlevel 1 (set "UP=1" & goto :ready)
    timeout /t 1 /nobreak >nul 2>nul
)
:ready
if "%UP%"=="1" (
    echo FolioFold is ready. Opening browser...
    start "" http://localhost:3000/
) else (
    echo [Warning] Server did not start in time. Check the "FolioFold" console window for errors.
)
goto :eof

rem --- Proxy-safe localhost health check (curl bypasses HTTP_PROXY so the guard /
rem     stop detection work even when a system proxy is configured). Falls back to
rem     PowerShell only if curl.exe is unavailable. Sets errorlevel 0 = server UP. ---
:check_up
where curl >nul 2>nul
if not errorlevel 1 (
    curl.exe -s -o nul --noproxy * --max-time 2 -w "%%{http_code}" "http://127.0.0.1:3000/api/version" | findstr /b "200" >nul 2>nul
) else (
    powershell -NoProfile -Command "try{if((Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/version' -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200){exit 0}}catch{};exit 1" >nul 2>nul
)
exit /b
