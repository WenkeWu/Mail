@echo off
rem AtWhoMail backup integrity check (daily task): recompute sha256 vs r2_manifest
rem Non-zero exit = missing or corrupt file. ASCII-only on purpose (see backup-agent.cmd).
rem Logs: D:\Mail\mail-backup\logs\verify.log
setlocal
chcp 65001 >nul
set "LOGDIR=D:\Mail\mail-backup\logs"
set "LOG=%LOGDIR%\verify.log"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "TS="
for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-ddTHH:mm:ssK"') do set "TS=%%i"
cd /d D:\Mail\Atwhomail
echo [%TS%] verify start >> "%LOG%"
call pnpm --filter @atwhomail/backup-agent run verify >> "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
echo [%TS%] verify exit code=%RC% >> "%LOG%"
endlocal & exit /b %RC%
