-- 0005_heartbeat_cron_ts.sql
-- 讓 Cron 每次執行都在 D1 留痕（last_cron_at）：
--   1. 可直接從 D1 驗證「雲端 cron 真的有在跑」，不需要用破壞性手段（把心跳改舊）來測試
--   2. 為「cron 本身停掉」提供可觀測欄位（未來可再納入監控）
ALTER TABLE system_heartbeat ADD COLUMN last_cron_at INTEGER;
