#!/usr/bin/env python3
"""AtWhoMail backup watchdog — silent while healthy, alerts (stdout + email) when not.

Designed to run every 10 minutes from BOTH a Windows scheduled task and a Hermes cron job.
The two schedulers are safe to run together because alert emails are throttled via a shared
state file (a persistent problem is re-mailed at most every THROTTLE_H hours).

Alert channel: email through our own mail system (POST /api/mail/send, rescue token) so the
message lands in a mailbox the operator actually reads (Gmail). stdout is kept as a local
record. NOTE: if the API itself is down the email cannot go out - that case is reported on
stdout, and the machine-off case needs an external watcher (see docs/11 §5).

Checks
  1. agent.log freshness       - no log entry within STALE_MIN minutes => agent is not ticking
  2. crash-restart density     - >= RESTART_LIMIT "supervisor restarting" lines within WINDOW_MIN
  3. daily verify result       - last "verify exit code=" in verify.log must be 0, and must be fresh
  4. API worker health         - GET /api/health => 200 with db == "ok"
  5. single-instance invariant - exactly one node "src/index.ts" process
  6. MTA-STS signal + policy   - "_mta-sts" CNAME must exist (via DoH) and the policy must serve
                                 mode: none|testing|enforce  (§5 #11 曾無聲消失)

Env overrides (for testing):
  WATCHDOG_LOG WATCHDOG_VLOG WATCHDOG_API WATCHDOG_API_SEND WATCHDOG_ENV_FILE
  WATCHDOG_ALERT_TO WATCHDOG_ALERT_FROM WATCHDOG_STATE WATCHDOG_STALE_MIN
  WATCHDOG_RESTART_LIMIT WATCHDOG_THROTTLE_H WATCHDOG_SKIP_PROC WATCHDOG_NO_EMAIL
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

LOG = os.environ.get("WATCHDOG_LOG", r"D:\Mail\mail-backup\logs\agent.log")
VLOG = os.environ.get("WATCHDOG_VLOG", r"D:\Mail\mail-backup\logs\verify.log")
API = os.environ.get("WATCHDOG_API", "https://atwhomail-api.ulhome.workers.dev/api/health")
API_SEND = os.environ.get("WATCHDOG_API_SEND", "https://atwhomail-api.ulhome.workers.dev/api/mail/send")
ENV_FILE = os.environ.get("WATCHDOG_ENV_FILE", r"D:\Mail\Atwhomail\packages\api\.dev.vars")
ALERT_TO = os.environ.get("WATCHDOG_ALERT_TO", "ulhome@gmail.com")
ALERT_FROM = os.environ.get("WATCHDOG_ALERT_FROM", "alerts@atwho.org")
STATE = os.environ.get("WATCHDOG_STATE", r"D:\Mail\mail-backup\logs\watchdog-alert.state")
STALE_MIN = int(os.environ.get("WATCHDOG_STALE_MIN", "12"))       # agent ticks every 5 min
RESTART_LIMIT = int(os.environ.get("WATCHDOG_RESTART_LIMIT", "3"))
THROTTLE_H = float(os.environ.get("WATCHDOG_THROTTLE_H", "6"))
WINDOW_MIN = 60
VERIFY_MAX_AGE_H = 26
UA = {"User-Agent": "AtWhoMail-Watchdog/1.0"}   # Cloudflare blocks Python-urllib's default UA (1010)

# MTA-STS 訊號／政策（§5 #11）：訊號記錄曾無聲消失 → MTA-STS 實質失效卻無人知道。
# 訊號檢查走 DoH（JSON API）；主用 Cloudflare，失敗時退回 Google。
MTA_STS_NAME = os.environ.get("WATCHDOG_MTA_STS_NAME", "_mta-sts.atwho.org")
MTA_STS_EXPECT = os.environ.get("WATCHDOG_MTA_STS_EXPECT", "_mta-sts.mx.cloudflare.net")
MTA_STS_POLICY = os.environ.get("WATCHDOG_MTA_STS_POLICY", "https://mta-sts.atwho.org/.well-known/mta-sts.txt")
DOH_ENDPOINTS = ("https://cloudflare-dns.com/dns-query", "https://dns.google/resolve")

problems: list[str] = []


def read(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


def parse_iso(text: str):
    """ISO-8601 → aware datetime. Naive input is assumed UTC so comparisons never raise."""
    try:
        dt = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def age_min(ts) -> float | None:
    return None if ts is None else (datetime.now(timezone.utc) - ts).total_seconds() / 60.0


def check_agent_log() -> None:
    text = read(LOG)
    if not text:
        problems.append(f"agent.log 讀不到或不存在（{LOG}）→ 備份 agent 可能沒在跑")
        return
    stamps = re.findall(r'"ts":"([^"]+)"', text)
    ts = parse_iso(stamps[-1]) if stamps else None
    if ts is None:
        # 不提前 return：時間戳解析失敗不該讓後面的崩潰密度檢查被跳過
        problems.append(f"agent.log 找不到可解析的時間戳（{LOG}）")
    else:
        a = age_min(ts)
        if a is not None and a > STALE_MIN:
            problems.append(
                f"備份 agent 已 {a:.0f} 分鐘沒有任何日誌（門檻 {STALE_MIN} 分）"
                f"→ 可能已死或 supervisor 迴圈失效；最後一筆 {ts.isoformat()}"
            )
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=WINDOW_MIN)
    recent = 0
    for line in text.splitlines():
        if "supervisor restarting" not in line:
            continue
        m = re.match(r"\[([^\]]+)\]", line.strip())
        t = parse_iso(m.group(1)) if m else None
        if t is None or t >= cutoff:
            recent += 1
    if recent >= RESTART_LIMIT:
        problems.append(
            f"最近 {WINDOW_MIN} 分鐘內 agent 崩潰重啟 {recent} 次（門檻 {RESTART_LIMIT}）"
            "→ 有反覆性問題，請看 agent.log 的錯誤內容"
        )


def check_verify() -> None:
    text = read(VLOG)
    if not text:
        problems.append(f"verify.log 讀不到或不存在（{VLOG}）→ 每日完整性檢查可能沒在跑")
        return
    codes = re.findall(r"verify exit code=(-?\d+)", text)
    if not codes:
        problems.append("verify.log 找不到 'verify exit code=' → 檢查是否執行成功")
        return
    if codes[-1] != "0":
        problems.append(f"每日備份完整性檢查失敗：最後一次 verify exit code={codes[-1]}（應為 0）")
    stamps = re.findall(r"\[([^\]]+)\]", text)
    ts = parse_iso(stamps[-1]) if stamps else None
    a = age_min(ts)
    if a is not None and a > VERIFY_MAX_AGE_H * 60:
        problems.append(f"每日 verify 已 {a / 60:.0f} 小時未執行（預期每 24 小時一次）→ 排程可能失效")


def check_api() -> None:
    try:
        req = urllib.request.Request(API, headers=UA)
        with urllib.request.urlopen(req, timeout=15) as resp:
            code, body = resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        code, body = exc.code, exc.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        problems.append(f"API 健康檢查連不上：{exc}（{API}）")
        return
    if code != 200:
        problems.append(f"API 健康檢查回 HTTP {code}（預期 200）：{body[:200]}")
        return
    try:
        data = json.loads(body)
    except ValueError:
        problems.append(f"API 健康檢查回應不是 JSON：{body[:200]}")
        return
    if data.get("ok") is not True or data.get("db") != "ok":
        problems.append(f"API 健康檢查異常：{body[:200]}")


def check_instances() -> None:
    if os.environ.get("WATCHDOG_SKIP_PROC"):
        return
    # 2026-10-06 修正：排程器環境下原本會失敗（PATH 不完整 ＋ -Filter 巢狀雙引號）→ **靜默跳過本檢查**，
    # 等於這個檢查從未真正生效（watchdog.log 留有「無法查程序數」警告）。改用絕對路徑 powershell.exe，
    # 且條件全寫在 Where-Object（只用單引號，避免引號轉義）；同時限定 node.exe，避免把其他程序算成實例。
    ps = (os.environ.get("WATCHDOG_POWERSHELL") or shutil.which("powershell")
          or r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")
    query = ("Get-CimInstance Win32_Process | "
             "Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*src/index.ts*' } | "
             "Measure-Object | Select-Object -ExpandProperty Count")
    try:
        out = subprocess.run([ps, "-NoProfile", "-NonInteractive", "-Command", query],
                             capture_output=True, text=True, timeout=60).stdout.strip()
    except Exception as exc:  # noqa: BLE001
        print(f"（watchdog 注意：無法查程序數，略過此項：{exc}）", file=sys.stderr)
        return
    count = out.splitlines()[-1].strip() if out else ""
    if not count.isdigit():
        return
    n = int(count)
    if n == 0:
        problems.append("找不到 backup agent 程序（node src/index.ts）→ supervisor 應在 60 秒內拉起；超過請手動檢查")
    elif n > 1:
        problems.append(f"偵測到 {n} 個 backup agent 程序 → 可能同時寫入 PostgreSQL，請立即處理")


def _doh(name: str, rtype: str) -> dict:
    """DoH JSON 查詢：Cloudflare 為主、Google 為備。"""
    last: Exception | None = None
    for base in DOH_ENDPOINTS:
        url = f"{base}?name={name}&type={rtype}"
        try:
            req = urllib.request.Request(url, headers={**UA, "accept": "application/dns-json"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.loads(resp.read().decode("utf-8", "replace"))
        except Exception as exc:  # noqa: BLE001
            last = exc
    raise last if last else RuntimeError("no DoH endpoint reachable")


def check_mta_sts() -> None:
    """MTA-STS 訊號 CNAME 必須存在、政策端點必須可用（§5 #11 曾無聲消失）。"""
    try:
        d = _doh(MTA_STS_NAME, "CNAME")
    except Exception as exc:  # noqa: BLE001
        problems.append(f"MTA-STS 訊號無法查詢（{MTA_STS_NAME}）：{exc}")
        return
    answers = [str(a.get("data", "")).rstrip(".") for a in d.get("Answer", [])]
    if d.get("Status") != 0 or MTA_STS_EXPECT not in answers:
        problems.append(
            f"MTA-STS 訊號記錄異常（{MTA_STS_NAME} CNAME → {answers or 'NXDOMAIN'}，預期 {MTA_STS_EXPECT}）"
            "→ 寄件方查不到政策，MTA-STS 實質失效"
        )

    try:
        req = urllib.request.Request(MTA_STS_POLICY, headers=UA)
        with urllib.request.urlopen(req, timeout=15) as resp:
            code, body = resp.status, resp.read().decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001
        problems.append(f"MTA-STS 政策端點無法取得（{MTA_STS_POLICY}）：{exc}")
        return
    m = re.search(r"(?m)^mode:\s*(\S+)", body)
    if code != 200 or not m or m.group(1) not in ("none", "testing", "enforce"):
        problems.append(f"MTA-STS 政策內容異常（HTTP {code}）：{body[:120]!r}")


def admin_token() -> str | None:
    """Rescue token for /api/mail/send. Never printed, never emailed."""
    tok = os.environ.get("ADMIN_TOKEN")
    if tok:
        return tok.strip()
    try:
        with open(ENV_FILE, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if line.startswith("ADMIN_TOKEN="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        return None
    return None


def throttled(signature: str) -> str | None:
    """Return a human note if the same alert was already mailed recently."""
    try:
        with open(STATE, "r", encoding="utf-8") as fh:
            prev = json.load(fh)
        if prev.get("sig") == signature:
            prev_at = parse_iso(prev.get("at", ""))
            if prev_at is not None and age_min(prev_at) < THROTTLE_H * 60:
                return prev_at.astimezone().strftime("%Y-%m-%d %H:%M")
    except (OSError, ValueError):
        pass
    return None


def mark_sent(signature: str) -> None:
    try:
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        with open(STATE, "w", encoding="utf-8") as fh:
            json.dump({"sig": signature, "at": datetime.now(timezone.utc).isoformat()}, fh)
    except OSError:
        pass


def send_alert_email(subject: str, body: str) -> str:
    tok = admin_token()
    if not tok:
        return "未寄出（找不到 ADMIN_TOKEN）"
    payload = json.dumps({"from": ALERT_FROM, "to": ALERT_TO, "subject": subject, "text": body}).encode()
    headers = {"Content-Type": "application/json", "x-admin-token": tok, **UA}
    req = urllib.request.Request(API_SEND, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return f"已寄出告警信到 {ALERT_TO}（HTTP {resp.status}）"
    except urllib.error.HTTPError as exc:
        return f"寄信失敗（HTTP {exc.code}）：{exc.read().decode('utf-8', 'replace')[:150]}"
    except Exception as exc:  # noqa: BLE001
        return f"寄信失敗：{exc}"


def main() -> int:
    try:  # keep the log/email UTF-8 even under cmd.exe (CP950)
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass

    for fn in (check_agent_log, check_verify, check_api, check_instances, check_mta_sts):
        try:
            fn()
        except Exception as exc:  # noqa: BLE001
            problems.append(f"watchdog 檢查 {fn.__name__} 時發生例外：{exc}")

    if not problems:
        # 健康 → 清掉節流狀態：確保「恢復後又發生」的新事件能立即告警，
        # 而不是被上一次（可能只是換版瞬間的同簽章）記錄靜音 6 小時。
        try:
            os.remove(STATE)
        except OSError:
            pass
        return 0

    now = datetime.now()
    subject = f"[AtWhoMail 告警] {len(problems)} 項異常（{now.strftime('%m-%d %H:%M')}）"
    lines = [f"AtWhoMail 備份／服務告警（{now.strftime('%Y-%m-%d %H:%M')}）", ""]
    lines += [f"• {p}" for p in problems]
    lines += ["", "排查：",
              '  Get-Content D:\\Mail\\mail-backup\\logs\\agent.log -Tail 20',
              '  Get-Content D:\\Mail\\mail-backup\\logs\\verify.log -Tail 5',
              '  Get-ScheduledTask -TaskName "AtWhoMail Backup *" | Format-Table TaskName, State']
    body = "\n".join(lines)

    si = hashlib.sha1("\n".join(sorted(problems)).encode()).hexdigest()[:12]
    note = throttled(si)
    if note and not os.environ.get("WATCHDOG_NO_EMAIL"):
        lines.append("")
        lines.append(f"（同類告警已於 {note} 寄出，{THROTTLE_H:.0f} 小時內不重複寄送）")
        body = "\n".join(lines)
    else:
        result = "（已停用寄信）" if os.environ.get("WATCHDOG_NO_EMAIL") else send_alert_email(subject, body)
        lines.append("")
        lines.append(result)
        if "已寄出" in result:
            mark_sent(si)
        body = "\n".join(lines)

    print(f"⚠️ {subject}")
    for p in problems:
        print(f"• {p}")
    print("")
    print(lines[-1])
    return 0


if __name__ == "__main__":
    sys.exit(main())
