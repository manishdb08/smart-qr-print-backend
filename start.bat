@echo off
title Smart QR Print - Server
cd /d "%~dp0"

echo ============================================================
echo   Smart QR Print - Local Production Runner (Non-Docker)
echo ============================================================
echo.

if not exist node_modules (
  echo [1/3] Installing dependencies...
  call npm install
)

echo [2/3] Compiling TypeScript build...
call npm run build

echo [3/3] Launching server on http://localhost:5000...
echo.
echo ============================================================
echo  - Swagger UI: http://localhost:5000/docs
echo  - Health:     http://localhost:5000/health
echo  - Printers:   http://localhost:5000/v1/printers
echo ============================================================
echo.
start http://localhost:5000/docs

call npm start
pause
