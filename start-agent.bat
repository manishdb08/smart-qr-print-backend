@echo off
title Smart QR Print - Hardware Printer Daemon
cd /d "%~dp0"

echo ============================================================
echo   Smart QR Print - Local Hardware Printer Agent Daemon
echo ============================================================
echo.
echo Starting hardware daemon polling loop...
echo Connecting to: http://localhost:5000/v1
echo Assigned kiosk: library-a4-01
echo Spool storage:  agent-daemon\spool
echo.

node agent-daemon/printerAgent.mjs
pause
