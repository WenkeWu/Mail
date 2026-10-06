@echo off
rem AtWhoMail backup watchdog - runs every 10 minutes (Windows Task Scheduler).
rem Silent while healthy: the python watchdog prints nothing and mails nothing unless something
rem is wrong. stdout/stderr are appended to watchdog.log as a local record; real notification is
rem the alert email it sends via our own mail API (to the operator's Gmail).
rem ASCII-only on purpose (cmd.exe reads .cmd in the OEM codepage, CP950 here).
rem 2026-10-06: created so the watchdog runs even when the Hermes desktop app is closed.
setlocal
chcp 65001 >nul
set "LOGDIR=D:\Mail\mail-backup\logs"
set "LOG=%LOGDIR%\watchdog.log"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "PYTHONIOENCODING=utf-8"
set "TS="
for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-ddTHH:mm:ssK"') do set "TS=%%i"
python "D:\Mail\Atwhomail\scripts\backup_watchdog.py" >> "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo [%TS%] watchdog exited with code=%RC% >> "%LOG%"
)
endlocal & exit /b %RC%
