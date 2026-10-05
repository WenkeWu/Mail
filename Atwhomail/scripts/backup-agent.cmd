@echo off
rem AtWhoMail backup agent - runs continuously (launched by Windows Task Scheduler at logon)
rem ASCII-only on purpose: cmd.exe reads .cmd in the OEM codepage (CP950 here) and UTF-8
rem comments get mangled into stray quotes/commands. Logs: D:\Mail\mail-backup\logs\agent.log
setlocal
chcp 65001 >nul
set "LOGDIR=D:\Mail\mail-backup\logs"
set "LOG=%LOGDIR%\agent.log"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "TS="
for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-ddTHH:mm:ssK"') do set "TS=%%i"
cd /d D:\Mail\Atwhomail
echo [%TS%] agent start >> "%LOG%"
call pnpm --filter @atwhomail/backup-agent start >> "%LOG%" 2>&1
echo [%TS%] agent exited code=%ERRORLEVEL% >> "%LOG%"
endlocal
