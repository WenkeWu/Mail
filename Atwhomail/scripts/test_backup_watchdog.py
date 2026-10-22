#!/usr/bin/env python3
"""D17-3 告警去抖測試（watchdog debounce）。

執行：
  python scripts/test_backup_watchdog.py -v

只測狀態機（不碰網路、不真的寄信）：把 backup_watchdog 的檢查函式換成 stub，
用暫存狀態檔模擬「連續失敗」與「恢復」。
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import backup_watchdog as bw  # noqa: E402

CHECK_NAMES = (
    "check_agent_log",
    "check_verify",
    "check_api",
    "check_instances",
    "check_mta_sts",
    "check_dkim",
)


def _noop() -> None:
    return None


class WatchdogDebounceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.state_path = os.path.join(self.tmp.name, "watchdog-alert.state")
        self.sent: list[tuple[str, str]] = []
        self._saved = {
            "STATE": bw.STATE,
            "DEDUPE_SEC": bw.DEDUPE_SEC,
            "FAIL_THRESHOLD": bw.FAIL_THRESHOLD,
            "THROTTLE_H": bw.THROTTLE_H,
            "post_heartbeat": bw.post_heartbeat,
            "send_alert_email": bw.send_alert_email,
            **{name: getattr(bw, name) for name in CHECK_NAMES},
        }
        bw.STATE = self.state_path
        bw.DEDUPE_SEC = 0          # 每個測試呼叫都算一次（模擬相隔 10 分鐘）
        bw.FAIL_THRESHOLD = 2
        bw.THROTTLE_H = 6
        bw.post_heartbeat = _noop
        bw.send_alert_email = lambda subject, body: (
            self.sent.append((subject, body)) or "已寄出告警信到 test（HTTP 200）"
        )
        for name in CHECK_NAMES:
            setattr(bw, name, _noop)
        os.environ.pop("WATCHDOG_NO_EMAIL", None)

    def tearDown(self) -> None:
        bw.STATE = self._saved["STATE"]
        bw.DEDUPE_SEC = self._saved["DEDUPE_SEC"]
        bw.FAIL_THRESHOLD = self._saved["FAIL_THRESHOLD"]
        bw.THROTTLE_H = self._saved["THROTTLE_H"]
        bw.post_heartbeat = self._saved["post_heartbeat"]
        bw.send_alert_email = self._saved["send_alert_email"]
        for name in CHECK_NAMES:
            setattr(bw, name, self._saved[name])
        os.environ.pop("WATCHDOG_NO_EMAIL", None)
        self.tmp.cleanup()

    # ── helpers ──────────────────────────────────────────────────────────
    def state(self) -> dict:
        try:
            with open(self.state_path, "r", encoding="utf-8") as fh:
                return json.load(fh)
        except OSError:
            return {}

    def run_watchdog(self, failing: bool) -> tuple[int, str]:
        bw.problems = []
        if failing:
            bw.check_api = lambda: bw.problems.append("模擬：API 健康檢查失敗")
        else:
            bw.check_api = _noop
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = bw.main()
        return rc, out.getvalue()

    def run_failures(self, n: int) -> None:
        for _ in range(n):
            self.run_watchdog(True)

    # ── tests ────────────────────────────────────────────────────────────
    def test_first_failure_does_not_send(self) -> None:
        _, out = self.run_watchdog(True)
        self.assertEqual(self.sent, [], "第一次失敗不應寄信")
        self.assertEqual(self.state().get("fail_count"), 1)
        self.assertIn("未達告警門檻", out)

    def test_second_consecutive_failure_sends(self) -> None:
        self.run_failures(2)
        self.assertEqual(len(self.sent), 1, "連續 2 次失敗應寄 1 封告警")
        subject, body = self.sent[0]
        self.assertIn("告警", subject)
        self.assertIn("模擬：API 健康檢查失敗", body)
        st = self.state()
        self.assertEqual(st.get("fail_count"), 2)
        self.assertTrue(st.get("alerted"))

    def test_same_problem_is_throttled_after_alert(self) -> None:
        self.run_failures(3)
        self.assertEqual(len(self.sent), 1, "同類告警在 THROTTLE_H 內不重複寄")
        _, out = self.run_watchdog(True)
        self.assertIn("不重複寄送", out)

    def test_recovery_sends_once_then_resets(self) -> None:
        self.run_failures(2)
        self.assertEqual(len(self.sent), 1)

        _, out = self.run_watchdog(False)
        self.assertEqual(len(self.sent), 2, "恢復正常應寄一次恢復通知")
        subject, body = self.sent[1]
        self.assertIn("已恢復", subject)
        self.assertIn("模擬：API 健康檢查失敗", body)
        self.assertIn("已恢復", out)
        self.assertFalse(os.path.exists(self.state_path), "恢復後狀態檔應清除")

        self.run_watchdog(False)
        self.assertEqual(len(self.sent), 2, "恢復通知只寄一次")

    def test_single_failure_then_recovery_is_silent(self) -> None:
        self.run_watchdog(True)
        self.run_watchdog(False)
        self.assertEqual(self.sent, [], "未達門檻就恢復 → 不寄告警也不寄恢復")
        self.assertFalse(os.path.exists(self.state_path))

    def test_count_survives_restart(self) -> None:
        # 模擬「第一次失敗後程序結束」：狀態留在磁碟，下一次啟動繼續累計
        with open(self.state_path, "w", encoding="utf-8") as fh:
            json.dump({"fail_count": 1, "problems": ["舊的失敗"],
                       "last_check_at": datetime.now(timezone.utc).isoformat()}, fh)
        self.run_watchdog(True)
        self.assertEqual(len(self.sent), 1, "重啟後仍記得前一次失敗 → 第 2 次寄信")

    def test_duplicate_scheduler_run_counts_once(self) -> None:
        bw.DEDUPE_SEC = 60
        self.run_watchdog(True)   # 第一次排程器：count=1
        self.run_watchdog(True)   # 另一個排程器幾乎同時：不重複計數
        self.assertEqual(self.state().get("fail_count"), 1)
        self.assertEqual(self.sent, [])

        # 把 last_check_at 往回撥 5 分鐘，模擬 10 分鐘後的下一次檢查
        st = self.state()
        st["last_check_at"] = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
        with open(self.state_path, "w", encoding="utf-8") as fh:
            json.dump(st, fh)
        self.run_watchdog(True)
        self.assertEqual(self.state().get("fail_count"), 2)
        self.assertEqual(len(self.sent), 1)

    def test_old_state_format_is_compatible(self) -> None:
        # 升級前的狀態檔只有 {sig, at}：健康時直接清除，不應寄恢復信
        with open(self.state_path, "w", encoding="utf-8") as fh:
            json.dump({"sig": "abc", "at": datetime.now(timezone.utc).isoformat()}, fh)
        self.run_watchdog(False)
        self.assertEqual(self.sent, [])
        self.assertFalse(os.path.exists(self.state_path))


if __name__ == "__main__":
    unittest.main(verbosity=2)
