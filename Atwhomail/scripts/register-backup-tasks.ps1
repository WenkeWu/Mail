<#
.SYNOPSIS
  註冊 AtWhoMail 備份排程（Windows 工作排程器；使用者層級，無需系統管理員）

.DESCRIPTION
  建立三個工作：
    1. AtWhoMail Backup Agent  — 登入時啟動並常駐。**實際存活性由 wrapper 內的監督迴圈保證**
                                 （agent 一結束即記錄，60 秒後自動拉起）。排程層的 RestartOnFailure
                                 與 repetition 只是第二層保險，且**本機實測都不會觸發**，不可依賴
                                 （2026-10-06 事故：舊 wrapper 吞掉 exit code → 排程記成成功 → 停擺 8 小時）
    2. AtWhoMail Backup Verify — 每日 09:00 執行完整性檢查（sha256），失敗時結束碼 1
    3. AtWhoMail Backup Watchdog — 每 10 分鐘健檢（agent.log 新鮮度／崩潰重啟密度／verify 結果／
                                 API 健康／實例數）；**健康時完全靜默**，異常時寄告警信到
                                 ulhome@gmail.com（寄件者 alerts@atwho.org，經自家 /api/mail/send）

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
$agentTask    = "AtWhoMail Backup Agent"
$verifyTask   = "AtWhoMail Backup Verify"
$watchdogTask = "AtWhoMail Backup Watchdog"   # 2026-10-06 新增：每 10 分鐘健檢，異常時寄告警信

if ($Remove) {
    foreach ($t in @($agentTask, $verifyTask, $watchdogTask)) {
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
# 2026-10-06：加「每 5 分鐘重複觸發」保險。
#   事故根因：agent 崩潰時 wrapper 吞掉 exit code → 排程記成「成功」→ RestartCount 永遠不觸發，
#   於是 agent 一死就再也不回來（實際停擺 8 小時）。
#   ⚠️ 實測結論（2026-10-06，殺掉 agent 驗證）：repetition 只掛在純 AtLogOn 觸發器上**不會生效**，
#   因為 AtLogOn 沒有 StartBoundary，Task Scheduler 無法排定週期。必須另掛一個有 StartBoundary
#   的時間觸發器（下面 $agentRepTrigger），repetition 才會真的每 5 分鐘嘗試拉起。
#   搭配 MultipleInstances=IgnoreNew（見下方 settings）→ 已在執行時重複觸發會被忽略，不會重複啟動。
$agentRepTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$agentSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)   # 0 = 無時限（常駐）
$agentPrincipal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $agentTask -Action $agentAction -Trigger @($agentTrigger, $agentRepTrigger) `
    -Settings $agentSettings -Principal $agentPrincipal `
    -Description "AtWhoMail 備份 Agent（D1/R2 → 本機 PostgreSQL + 磁碟；單向增量）" -Force | Out-Null
Write-Host "已註冊：$agentTask（登入時啟動；崩潰由 wrapper 監督迴圈拉起）" -ForegroundColor Green

# ── 2) 每日完整性檢查 ──
$verifyAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$root\scripts\backup-verify.cmd`"" -WorkingDirectory $root
$verifyTrigger = New-ScheduledTaskTrigger -Daily -At 9:00am
$verifySettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName $verifyTask -Action $verifyAction -Trigger $verifyTrigger `
    -Settings $verifySettings -Principal $agentPrincipal `
    -Description "AtWhoMail 備份完整性檢查（sha256 重算；缺檔/損毀 → 結束碼 1）" -Force | Out-Null
Write-Host "已註冊：$verifyTask（每日 09:00）" -ForegroundColor Green

# ── 3) 備份 watchdog（每 10 分鐘；健康時靜默，異常時寄告警信）──
# 2026-10-06 新增。獨立的第三個工作，讓監控不依賴 Hermes 是否開著。
$wdAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$root\scripts\backup-watchdog.cmd`"" -WorkingDirectory $root
$wdTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650)
$wdSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $watchdogTask -Action $wdAction -Trigger $wdTrigger `
    -Settings $wdSettings -Principal $agentPrincipal `
    -Description "AtWhoMail 備份 watchdog（每 10 分鐘；健康時靜默，異常時寄告警信到 ulhome@gmail.com）" -Force | Out-Null
Write-Host "已註冊：$watchdogTask（每 10 分鐘；健康時靜默）" -ForegroundColor Green

Write-Host ""
Write-Host "驗證方式：" -ForegroundColor Cyan
Write-Host "  Get-ScheduledTask -TaskName `"AtWhoMail Backup *`" | Format-Table TaskName, State"
Write-Host "  Get-Content D:\Mail\mail-backup\logs\agent.log -Tail 5"
Write-Host "  Start-ScheduledTask -TaskName `"AtWhoMail Backup Verify`" ; Get-Content D:\Mail\mail-backup\logs\verify.log -Tail 3"
