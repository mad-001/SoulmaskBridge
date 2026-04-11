@echo off
title Soulmask Bridge
echo ========================================================
echo      TAKARO SOULMASK BRIDGE
echo ========================================================
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Node.js is not installed!
    echo.
    pause
    exit /b 1
)

REM Check if TakaroConfig.txt exists
if not exist TakaroConfig.txt (
    echo ERROR: TakaroConfig.txt not found!
    echo.
    pause
    exit /b 1
)

REM Check if dist folder exists
if not exist dist\index.js (
    echo ERROR: Bridge files are missing!
    echo.
    pause
    exit /b 1
)

REM Start the bridge (auto-restarts on crash)
:loop
echo.
echo Starting bridge server...
echo --------------------------------------------------------
node dist/index.js
echo.
echo Bridge exited - restarting in 5 seconds... (Close this window to stop)
timeout /t 5 /nobreak
goto loop
