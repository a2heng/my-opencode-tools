@echo off
rem stop the dashboard (kill node processes running server.mjs)
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*server.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host ('stopped ' + $_.ProcessId) }"
