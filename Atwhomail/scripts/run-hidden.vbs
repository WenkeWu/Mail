' run-hidden.vbs - launch a command/script with NO visible console window.
'
' Usage (from Task Scheduler action, or manually):
'     wscript.exe "D:\Mail\Atwhomail\scripts\run-hidden.vbs" "D:\Mail\Atwhomail\scripts\backup-watchdog.cmd"
'
' Why this exists:
'   A Scheduled Task with LogonType=Interactive whose action is `cmd.exe /c ...`
'   creates a visible console window on the user's desktop every time it runs
'   (e.g. the watchdog every 10 minutes). Task Scheduler's Settings.Hidden flag
'   only hides the task from the Task Scheduler UI -- it does NOT hide the window.
'   Running the same command through WScript.Shell.Run with window style 0 keeps
'   it fully hidden.
'
' It waits for completion and returns the child's exit code (WScript.Quit rc) so
' the task's LastTaskResult still reflects the real result, exactly as before.
Option Explicit

Dim shell, rc, target
If WScript.Arguments.Count < 1 Then
    WScript.Quit 87   ' ERROR_INVALID_PARAMETER
End If

target = WScript.Arguments(0)

Set shell = CreateObject("WScript.Shell")
' 0 = hidden window, True = wait for the child process to finish
rc = shell.Run("cmd.exe /c """ & target & """", 0, True)

WScript.Quit rc
