@echo off
title Video Tools (Gabungan)
color 0A
echo ========================================
echo   Video Tools - Starting Server
echo   %date%  %time:~0,8%
echo ========================================
echo.

:: Kill existing node processes on port 3000
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3000 ^| findstr LISTENING 2^>nul') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo Starting server...
echo.
node server.js
echo.
echo ========================================
echo   Server stopped. Press any key to exit.
echo ========================================
pause >nul
