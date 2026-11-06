@echo off
rem start OpenCode cache-hit dashboard in hidden background window
set DIR=%~dp0
powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath 'node' -ArgumentList 'server.mjs','--port','8788' -WorkingDirectory '%DIR%' -WindowStyle Hidden"
echo dashboard: http://127.0.0.1:8788
ping -n 3 127.0.0.1 >nul
