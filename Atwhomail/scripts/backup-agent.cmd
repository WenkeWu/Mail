@echo off
rem AtWhoMail backup agent supervisor (launched by Windows Task Scheduler at logon).
rem ASCII-only on purpose: cmd.exe reads .cmd in the OEM codepage (CP950 here) and UTF-8
rem comments get mangled into stray quotes/commands.
rem Logs: D:\Mail\mail-backup\logs\agent.log
rem
rem 2026-10-06 (incident fix):
rem   Previously this script ran the agent once, then ended. It also swallowed the exit code
rem   (plain "endlocal" => always 0 => Task Scheduler recorded "success"), so the configured
rem   RestartOnFailure never fired. Result: when the agent hit a transient PostgreSQL timeout
rem   at 01:30 it stayed dead for ~8 hours unnoticed.
rem   Fix a: capture RC and propagate it with "endlocal & exit /b %RC%".
rem   Fix b: Task Scheduler repetition and RestartOnFailure were both verified NOT to fire on
rem   this machine (agent killed on purpose; no relaunch within 5 minutes). So this wrapper is
rem   now a SUPERVISOR LOOP: if the agent exits for any reason, log it, wait 60s, start it again.
rem   The loop only ends if the wrapper itself is killed or the machine reboots - the AtLogOn
rem   trigger covers reboots. The Task Scheduler repetition/RestartOnFailure settings are kept
rem   as a second net but are NOT relied upon.
rem   Sleep uses ping, not "timeout": timeout.exe aborts immediately when stdin is redirected
rem   (which is the case under Task Scheduler).
setlocal
chcp 65001 >nul
set "LOGDIR=D:\Mail\mail-backup\logs"
set "LOG=%LOGDIR%\agent.log"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
cd /d D:\Mail\Atwhomail

:loop
set "TS="
for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-ddTHH:mm:ssK"') do set "TS=%%i"
echo [%TS%] agent start >> "%LOG%"
call pnpm --filter @atwhomail/backup-agent start >> "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
set "TS="
for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-ddTHH:mm:ssK"') do set "TS=%%i"
echo [%TS%] agent exited code=%RC% ; supervisor restarting in 60s >> "%LOG%"
ping -n 61 127.0.0.1 >nul
goto loop
