@echo off
REM Stop the Soulmask Bridge
REM Kills the start.bat restart loop (cmd.exe) and its child node.exe process

powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*SoulmaskBridge*' -and $_.CommandLine -like '*start*' } | ForEach-Object { & taskkill /T /F /PID $_.ProcessId 2>&1 | Out-Null }"

exit /b 0
