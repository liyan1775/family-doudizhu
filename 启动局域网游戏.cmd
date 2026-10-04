@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local.ps1"
set "taskLauncherExit=%errorlevel%"
if not "%taskLauncherExit%"=="0" pause
exit /b %taskLauncherExit%
