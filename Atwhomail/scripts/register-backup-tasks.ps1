<#
.SYNOPSIS
  註冊 AtWhoMail 備份排程（Windows 工作排程器；使用者層級，無需系統管理員）

.DESCRIPTION
  建立兩個工作：
    1. AtWhoMail Backup Agent  — 登入時啟動並常駐；異常結束自動重啟（每 1 分鐘，最多 999 次）
    2. AtWhoMail Backup Verify — 每日 09:00 執行完整性檢查（sha256），失敗時結束碼 1

.EXAMPLE
  # 註冊（在一般 PowerShell 視窗執行，不需管理員）
  powershell -ExecutionPolicy Bypass -File D:\Mail\Atwhomail\scripts\register-backup-tasks.ps1

.EXAMPLE
  # 移除
  powershell -ExecutionPolicy Bypass -File D:\Mail\Atwhomail\scripts\register-backup-tasks.ps1 -Remove

.EXAMPLE
  # 查看狀態 / 立即執行一次
  Get-ScheduledTask -TaskName "AtWhoMail Backup *" | Format-Table TaskName, State
  Start-ScheduledTask -TaskName "AtWhoMail Backup Verify"
#>
param([switch]$Remove)

$ErrorActionPreference = "Stop"
$root       = "D:\Mail\Atwhomail"
$agentTask  = "AtWhoMail Backup Agent"
$verifyTask = "AtWhoMail Backup Verify"

if ($Remove) {
    foreach ($t in @($agentTask, $verifyTask)) {
        if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $t -Confirm:$false
            Write-Host "已移除排程：$t" -ForegroundColor Yellow
        } else {
            Write-Host "找不到排程：$t" -ForegroundColor DarkGray
        }
    }
    return
}

if (-not (Test-Path "$root\scripts\backup-agent.cmd")) { throw "找不到 $root\scripts\backup-agent.cmd" }
if (-not (Test-Path "$root\packages\backup-agent\.env")) { throw "找不到 packages\backup-agent\.env（請先設定 PG 密碼與 ADMIN_TOKEN）" }

# ── 1) 常駐備份 Agent ──
$agentAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$root\scripts\backup-agent.cmd`"" -WorkingDirectory $root
$agentTrigger = New-ScheduledTaskTrigger -AtLogOn
$agentSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)   # 0 = 無時限（常駐）
$agentPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $agentTask -Action $agentAction -Trigger $agentTrigger `
    -Settings $agentSettings -Principal $agentPrincipal `
    -Description "AtWhoMail 備份 Agent（D1/R2 → 本機 PostgreSQL + 磁碟；單向增量）" -Force | Out-Null
Write-Host "已註冊：$agentTask（登入時啟動、常駐、異常自動重啟）" -ForegroundColor Green

# ── 2) 每日完整性檢查 ──
$verifyAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$root\scripts\backup-verify.cmd`"" -WorkingDirectory $root
$verifyTrigger = New-ScheduledTaskTrigger -Daily -At 9:00am
$verifySettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName $verifyTask -Action $verifyAction -Trigger $verifyTrigger `
    -Settings $verifySettings -Principal $agentPrincipal `
    -Description "AtWhoMail 備份完整性檢查（sha256 重算；缺檔/損毀 → 結束碼 1）" -Force | Out-Null
Write-Host "已註冊：$verifyTask（每日 09:00）" -ForegroundColor Green

Write-Host ""
Write-Host "驗證方式：" -ForegroundColor Cyan
Write-Host "  Get-ScheduledTask -TaskName `"AtWhoMail Backup *`" | Format-Table TaskName, State"
Write-Host "  Get-Content D:\Mail\mail-backup\logs\agent.log -Tail 5"
Write-Host "  Start-ScheduledTask -TaskName `"AtWhoMail Backup Verify`" ; Get-Content D:\Mail\mail-backup\logs\verify.log -Tail 3"
