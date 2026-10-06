-- 0004_system_heartbeat.sql
-- 本機 liveness 心跳（2026-10-06，對應 11-launch-checklist.md §5 #13）
--
-- 背景：備份 agent、watchdog、Windows 排程全在本機 → 整台機器關機時「不會有任何告警」。
-- 作法：本機 watchdog 每次健檢後 POST /heartbeat 更新 last_seen_at；
--       atwhomail-heartbeat Worker 的 Cron（每 15 分鐘）檢查是否過期，過期即寄告警信。
--       last_alert_at 用於去重（停擺期間不重複轟炸信箱）。
CREATE TABLE IF NOT EXISTS system_heartbeat (
  name          TEXT PRIMARY KEY,   -- 心跳來源識別（預設 local-backup-host）
  last_seen_at  INTEGER NOT NULL,   -- epoch ms
  last_alert_at INTEGER             -- 上次寄出告警的時間（NULL = 未曾告警）
);
