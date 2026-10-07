#!/usr/bin/env python3
"""End-to-end DKIM verification for AtWhoMail — loopback self-test.

Why this exists
---------------
DKIM is the one critical property that nothing else proves. Every other check can be green
(agent ticking, API healthy, MX/SPF correct, DNS records present) while outbound mail silently
loses its signature and lands in spam. The only real proof is: send a message, get the version
that Cloudflare actually signed, and verify that signature against the published public key.

How it works
------------
  1. POST /api/mail/send          - loopback mail (alerts@ -> test1@, unique subject marker)
  2. GET  /api/backup/changes     - poll for the RECEIVED copy (has raw_r2_key)
  3. GET  /api/backup/r2/object   - download the raw .eml (the post-signing bytes)
  4. verify                       - canonicalize per RFC 6376 and check body hash + RSA signature
  5. DELETE /api/mail/:id         - clean up both test copies (unless --keep)

Two RFC 6376 pitfalls, both hit for real on 2026-10-07 (they make a VALID signature look broken):
  1. FWS inside base64 tag values (bh=, b=) MUST be ignored. Header folding inserts spaces into
     the value; base64-decoding without stripping them fails or corrupts. (Symptom: body hash
     mismatch that "looks impossible".)
  2. Header names in h= that do not exist in the message contribute NOTHING to the hash -- not an
     empty value, not a CRLF. Cloudflare's h= lists 17 headers a normal message never has
     (reply-to, list-*, resent-*, ...). (Symptom: body hash OK but RSA verify fails.)
Also: the DKIM-Signature header itself is hashed with the b= value emptied and **no trailing CRLF**.

Usage
-----
  python dkim_verify.py                      # loopback self-test, then clean up
  python dkim_verify.py --keep               # keep the test messages
  python dkim_verify.py --wait 180           # longer wait for delivery
  python dkim_verify.py --to test1@atwho.org --from alerts@atwho.org
  python dkim_verify.py --raw some.eml       # verify an existing file, no sending
  python dkim_verify.py --json               # machine-readable result

Exit code: 0 = every DKIM signature that was expected verified; 1 = anything failed.
No third-party packages: DER/RSA are done with stdlib only.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

API = os.environ.get("DKIM_API", "https://atwhomail-api.ulhome.workers.dev")
ENV_FILE = os.environ.get("DKIM_ENV_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                        "..", "packages", "api", ".dev.vars"))
ENV_FILE = os.path.normpath(ENV_FILE)
UA = {"User-Agent": "AtWhoMail-DKIMVerify/1.0"}     # Cloudflare rejects python-urllib's default UA


# ─────────────────────────── HTTP helpers ───────────────────────────
def admin_token() -> str | None:
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


def http(method: str, path: str, token: str | None = None, body=None, raw=False):
    headers = dict(UA)
    if token:
        headers["x-admin-token"] = token
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(API + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            payload = resp.read()
            if raw:
                return resp.status, payload
            if not payload:                       # 204 No Content（例如 DELETE）——空內容不是錯誤
                return resp.status, None
            try:
                return resp.status, json.loads(payload.decode("utf-8", "replace"))
            except ValueError:
                return resp.status, payload.decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(payload)
        except ValueError:
            return exc.code, payload
    except Exception as exc:  # noqa: BLE001
        return 0, str(exc)


# ─────────────────────────── RFC 6376 canonicalization ───────────────────────────
def rel_header(name: bytes, value: bytes) -> bytes:
    """relaxed header canonicalization: unfold, collapse WSP, strip, lowercase name."""
    v = re.sub(rb"[ \t]+", b" ", value.replace(b"\r\n", b"")).strip()
    return name.lower() + b":" + v


def rel_body(body: bytes) -> bytes:
    """relaxed body canonicalization: collapse WSP per line, drop trailing empty lines."""
    lines = [re.sub(rb"[ \t]+", b" ", ln).rstrip(b" \t") for ln in body.replace(b"\r\n", b"\n").split(b"\n")]
    while lines and lines[-1] == b"":
        lines.pop()
    return b"\r\n".join(lines) + b"\r\n" if lines else b"\r\n"


def split_message(raw: bytes) -> tuple[list[list[bytes]], bytes]:
    """→ ([ (name, raw_value_with_folding) ], body) with CRLF line endings."""
    i = raw.find(b"\r\n\r\n")
    if i == -1:
        raw = raw.replace(b"\r\n", b"\n")
        i = raw.find(b"\n\n")
        head, body = raw[:i], raw[i + 2:]
    else:
        head, body = raw[:i], raw[i + 4:]
    head = head.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    body = body.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    # NOTE: 存的是**可變的 list**（不是 tuple）——摺疊續行時用 += 更新同一個物件；
    # 若一開始就存成 tuple，續行只會更新 cur[1]、而 list 裡留著第一行的舊值，
    # 導致「已摺疊的標頭被截斷」（DKIM-Signature 的 h=/bh=/b= 全都不見）。
    headers: list[list[bytes]] = []
    cur: list[bytes] | None = None
    for line in head.split(b"\r\n"):
        if line[:1] in (b" ", b"\t") and cur is not None:
            cur[1] += b"\r\n" + line
        else:
            m = re.match(rb"^([^:]+):(.*)$", line)
            if m:
                cur = [m.group(1), m.group(2)]
                headers.append(cur)
    return headers, body


# ─────────────────────────── DER / RSA (stdlib only) ───────────────────────────
def _tlv(buf: bytes, i: int):
    tag = buf[i]
    i += 1
    ln = buf[i]
    i += 1
    if ln & 0x80:
        n = ln & 0x7F
        ln = int.from_bytes(buf[i:i + n], "big")
        i += n
    return tag, buf[i:i + ln], i + ln


def rsa_pubkey(der: bytes) -> tuple[int, int]:
    """SubjectPublicKeyInfo DER → (n, e). Raises on anything malformed."""
    tag, seq, _ = _tlv(der, 0)
    if tag != 0x30:
        raise ValueError("SPKI 不是 SEQUENCE")
    _, _, i = _tlv(seq, 0)                        # AlgorithmIdentifier
    tag, bits, _ = _tlv(seq, i)                   # BIT STRING
    if tag != 0x03:
        raise ValueError("SPKI 缺少 BIT STRING")
    _, rsa_seq, _ = _tlv(bits[1:], 0)
    tag, nb, i = _tlv(rsa_seq, 0)
    if tag != 0x02:
        raise ValueError("缺少 modulus")
    tag, eb, _ = _tlv(rsa_seq, i)
    if tag != 0x02:
        raise ValueError("缺少 exponent")
    n, e = int.from_bytes(nb, "big"), int.from_bytes(eb, "big")
    if n.bit_length() < 1024 or e < 3:
        raise ValueError(f"金鑰不合理（n={n.bit_length()} bits, e={e}）")
    return n, e


def rsa_verify_sha256(n: int, e: int, sig: bytes, data: bytes) -> bool:
    """PKCS#1 v1.5, SHA-256 — no third-party crypto library needed."""
    k = (n.bit_length() + 7) // 8
    if len(sig) != k:
        return False
    em = pow(int.from_bytes(sig, "big"), e, n).to_bytes(k, "big")
    digest_info = bytes.fromhex("3031300d060960864801650304020105000420") + hashlib.sha256(data).digest()
    return em == b"\x00\x01" + b"\xff" * (k - 3 - len(digest_info)) + b"\x00" + digest_info


# ─────────────────────────── DKIM verification ───────────────────────────
def verify_dkim(raw: bytes, doh=None) -> list[dict]:
    """Verify every DKIM-Signature in a raw message. Returns one dict per signature."""
    headers, body = split_message(raw)
    body_hash = base64.b64encode(hashlib.sha256(rel_body(body)).digest()).decode()
    results: list[dict] = []

    for name, valraw in [(n, v) for n, v in headers if n.lower() == b"dkim-signature"]:
        flat = re.sub(rb"\s+", b" ", valraw.replace(b"\r\n", b" ")).strip().decode("utf-8", "replace")
        tags = {k: v for k, v in re.findall(r"([a-z]+)=([^;]+)", flat)}
        clean = lambda s: re.sub(r"\s", "", s)          # ← pitfall 1: kill FWS inside base64 values
        sel, dom = tags.get("s", ""), tags.get("d", "")
        res = {"selector": sel, "domain": dom, "algo": tags.get("a"), "canon": tags.get("c"),
               "body_hash_ok": False, "signature_ok": False, "key_bits": None, "error": None}
        try:
            res["body_hash_ok"] = body_hash == clean(tags.get("bh", ""))
            hlist = [x.strip().lower() for x in tags.get("h", "").split(":") if x.strip()]
            pool: dict[bytes, list[bytes]] = {}
            for hn, hv in headers:
                pool.setdefault(hn.lower(), []).append(hv)
            data = b""
            for hn in hlist:
                vals = pool.get(hn.encode())            # ← pitfall 2: skip non-existent headers entirely
                if not vals:
                    continue
                data += rel_header(hn.encode(), vals.pop()) + b"\r\n"
            sig_hdr = rel_header(b"dkim-signature", re.sub(rb"b=[^;]*", b"b=", valraw.replace(b"\r\n", b"")))
            keytxt = (doh or dns_txt)(f"{sel}._domainkey.{dom}")
            n, e = rsa_pubkey(base64.b64decode(re.sub(r"\s", "", keytxt)))
            res["key_bits"] = n.bit_length()
            # no trailing CRLF on the DKIM-Signature header itself
            res["signature_ok"] = rsa_verify_sha256(n, e, base64.b64decode(clean(tags.get("b", ""))), data + sig_hdr)
        except Exception as exc:  # noqa: BLE001
            res["error"] = f"{type(exc).__name__}: {exc}"
        results.append(res)
    return results


def dns_txt(name: str) -> str:
    """DoH TXT lookup (Cloudflare, then Google). Returns the 'p=' value or raises."""
    last: Exception | None = None
    for base in ("https://cloudflare-dns.com/dns-query", "https://dns.google/resolve"):
        try:
            req = urllib.request.Request(f"{base}?name={name}&type=TXT", headers={**UA, "accept": "application/dns-json"})
            with urllib.request.urlopen(req, timeout=20) as resp:
                d = json.loads(resp.read().decode("utf-8", "replace"))
            if d.get("Status") != 0:
                raise LookupError(f"DoH Status={d.get('Status')}")
            txt = "".join(str(a.get("data", "")).strip('"').replace('" "', "") for a in d.get("Answer", []))
            if "p=" not in txt:
                raise LookupError(f"TXT 沒有 p=（{txt[:60]!r}）")
            return txt.split("p=", 1)[1].split(";")[0].strip()
        except Exception as exc:  # noqa: BLE001
            last = exc
    raise last if last else RuntimeError("no DoH endpoint reachable")


# ─────────────────────────── loopback: send / fetch / verify ───────────────────────────
def find_marker_rows(marker: str, token: str, minutes: int = 15) -> list[tuple[int, dict]]:
    """所有主旨等於 marker 的 messages 列（寄件備份 + 收到的正本）。"""
    cursor_ms = int(time.time() * 1000) - minutes * 60 * 1000
    status, ch = http("GET", f"/api/backup/changes?limit=200&c_messages={cursor_ms}_0", token)
    if status != 200 or not isinstance(ch, dict):
        return []
    out = []
    for entry in ch.get("created", []) + ch.get("updated", []):
        row = entry.get("row") or {}
        if entry.get("table") == "messages" and row.get("subject") == marker:
            out.append((int(row["id"]), row))
    return out


def run_loopback(args, token: str) -> tuple[bytes, str]:
    marker = f"[DKIM self-test] {datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}"
    print(f"→ 寄出測試信：{args.from_addr} → {args.to}")
    status, res = http("POST", "/api/mail/send", token,
                       {"from": args.from_addr, "to": [args.to], "subject": marker,
                        "text": "DKIM loopback self-test - safe to delete."})
    if status != 200:
        raise SystemExit(f"寄信失敗（HTTP {status}）：{str(res)[:300]}")
    # 注意：messageId 是 RFC Message-ID 標頭（<…@atwho.org>），不是資料列 id → 清理時用主旨反查
    print(f"  已寄出 messageId={res.get('messageId') if isinstance(res, dict) else None}  主旨={marker}")

    deadline = time.time() + args.wait
    print(f"→ 等待收到的正本（最多 {args.wait}s）…", end="", flush=True)
    while time.time() < deadline:
        for rid, row in find_marker_rows(marker, token):
            # 只認「收到的正本」（folder=inbox）：寄件備份的 raw .eml 是**送出前**的內容，
            # 還沒有 Cloudflare 加的 DKIM 簽章（主旨相同，很容易誤取 → 297 bytes、無簽章）。
            if row.get("folder") != "inbox" or not row.get("raw_r2_key"):
                continue
            print(f" 收到（id={rid}）")
            st2, raw = http("GET", f"/api/backup/r2/object?key={urllib.parse.quote(row['raw_r2_key'])}",
                            token, raw=True)
            if st2 != 200 or not isinstance(raw, bytes):
                raise SystemExit(f"取原始郵件失敗（HTTP {st2}）：{str(raw)[:200]}")
            print(f"→ 取回已簽章正本 {len(raw)} bytes（{row['raw_r2_key']}）")
            return raw, marker
        print(".", end="", flush=True)
        time.sleep(5)
    raise SystemExit("等候逾時：沒收到回送的信（Email Routing / catch-all 可能有問題）")


def cleanup_messages(marker: str, token: str) -> None:
    """軟刪除本次自測產生的所有列（寄件備份＋收到的正本）。"""
    rows = find_marker_rows(marker, token)
    if not rows:
        print("  （找不到測試信，可能已被清理）")
    for rid, _row in rows:
        st, _ = http("DELETE", f"/api/mail/{rid}", token)
        print(f"  清理測試信 id={rid} → HTTP {st}")


# ─────────────────────────── main ───────────────────────────
def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass

    ap = argparse.ArgumentParser(description="AtWhoMail DKIM end-to-end verification")
    ap.add_argument("--to", dest="to", default="test1@atwho.org", help="loopback 收件地址（須 active）")
    ap.add_argument("--from", dest="from_addr", default="alerts@atwho.org", help="寄件地址（須 active）")
    ap.add_argument("--wait", type=int, default=120, help="等待收到的秒數")
    ap.add_argument("--raw", help="只驗證既有 .eml 檔（不寄信）")
    ap.add_argument("--keep", action="store_true", help="保留測試信（預設會清理）")
    ap.add_argument("--json", action="store_true", help="輸出 JSON")
    args = ap.parse_args()

    marker: str | None = None
    if args.raw:
        with open(args.raw, "rb") as fh:
            raw = fh.read()
        print(f"→ 讀取 {args.raw}（{len(raw)} bytes）")
    else:
        token = admin_token()
        if not token:
            raise SystemExit(f"找不到 ADMIN_TOKEN（環境變數或 {ENV_FILE}）")
        raw, marker = run_loopback(args, token)

    results = verify_dkim(raw)
    if not results:
        print("\n❌ 這封信沒有任何 DKIM-Signature（寄信端沒有加簽！）")
        return 1

    ok = all(r["body_hash_ok"] and r["signature_ok"] for r in results)
    if args.json:
        print(json.dumps({"ok": ok, "signatures": results}, ensure_ascii=False, indent=2))
    else:
        print(f"\n=== DKIM 驗證結果（{len(results)} 個簽章）===")
        for i, r in enumerate(results, 1):
            print(f"[{i}] d={r['domain']}  s={r['selector']}  a={r['algo']}  c={r['canon']}  key={r['key_bits']}-bit")
            print(f"    ① body hash : {'✅ 相符' if r['body_hash_ok'] else '❌ 不符'}")
            print(f"    ② RSA 簽章  : {'✅ 通過' if r['signature_ok'] else '❌ 失敗'}" + (f"   ({r['error']})" if r["error"] else ""))
        print()
        print("結論：DKIM " + ("✅ 有效（密碼學驗證通過）" if ok else "❌ 有問題"))

    if marker and not args.keep and not args.raw:
        token = admin_token()
        print("\n→ 清理測試信")
        cleanup_messages(marker, token)

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
