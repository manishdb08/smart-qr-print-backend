@echo off
title Smart QR Print - Dev Server
cd /d "%~dp0"

echo ============================================================
echo   Smart QR Print - Development Mode with Hot Reload
echo ============================================================
echo.
echo Launching dev server on http://localhost:5000...
echo.
echo Opening Swagger documentation in default browser...
start http://localhost:5000/docs
echo.

call npm run dev
pause
