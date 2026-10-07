@echo off
setlocal EnableExtensions
rem ============================================================
rem  FolioFold Stopper (safe edition: stops ONLY this project.
rem  Never uses "taskkill /IM python.exe" which would kill other
rem  Python processes). Uses only %~dp0, no hardcoded path /
rem  username / token.
rem ============================================================
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

echo Stopping FolioFold (this project only)...

rem --- Method 1: localhost-only safe stop endpoint /api/shutdown ---
rem   (server binds 127.0.0.1 only, so it is unreachable externally)
curl.exe -s -o nul --noproxy * --max-time 3 -X POST "http://127.0.0.1:3000/api/shutdown" >nul 2>nul

rem --- Method 2: wait for the port to free (up to ~8s) ---
set "STOPPED=0"
for /l %%i in (1,1,16) do (
    call :check_up
    if errorlevel 1 (set "STOPPED=1" & goto :done)
    timeout /t 1 /nobreak >nul 2>nul
)

:done
if "%STOPPED%"=="1" (
    echo FolioFold stopped.
    if exist "%ROOT%\.foliofold.pid" del /q "%ROOT%\.foliofold.pid" >nul 2>nul
    goto :eof
)

rem --- Method 3 (fallback): identify the exact PID listening on 3000 ---
rem   and kill ONLY that process tree. Does NOT touch other Python.
echo Endpoint did not respond. Locating the process by port...
set "PID="
for /f "tokens=5" %%p in ('netstat -ano -p TCP 2^>nul ^| findstr "127.0.0.1:3000" ^| findstr "LISTENING"') do set "PID=%%p"
if defined PID (
    echo Ending the process listening on port 3000 (PID=%PID%)
    taskkill /PID %PID% /T /F >nul 2>nul
    timeout /t 1 /nobreak >nul 2>nul
    if exist "%ROOT%\.foliofold.pid" del /q "%ROOT%\.foliofold.pid" >nul 2>nul
    echo FolioFold stopped.
) else (
    echo No running FolioFold found (port 3000 is free).
    if exist "%ROOT%\.foliofold.pid" del /q "%ROOT%\.foliofold.pid" >nul 2>nul
)
goto :eof

rem --- Proxy-safe localhost health check (curl bypasses HTTP_PROXY so the stop
rem     detection is reliable even when a system proxy is configured). Falls back to
rem     PowerShell only if curl.exe is unavailable. Sets errorlevel 0 = server UP. ---
:check_up
where curl >nul 2>nul
if not errorlevel 1 (
    curl.exe -s -o nul --noproxy * --max-time 1 -w "%%{http_code}" "http://127.0.0.1:3000/api/version" | findstr /b "200" >nul 2>nul
) else (
    powershell -NoProfile -Command "try{if((Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/version' -TimeoutSec 1 -UseBasicParsing).StatusCode -eq 200){exit 0}}catch{};exit 1" >nul 2>nul
)
exit /b
