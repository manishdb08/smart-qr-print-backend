@echo off
title Smart QR Print - End-to-End User Simulation
cd /d "%~dp0"

echo ============================================================
echo   Smart QR Print - End-to-End Simulation Runner
echo ============================================================
echo.
echo Running full kiosk journey:
echo 1. Scan QR -> 2. Upload -> 3. Quote -> 4. Pay -> 5. Hardware Print
echo.

node scripts/simulate-user-flow.mjs
echo.
pause
