#!/usr/bin/env bash
# 安裝 docs/INDEX 的 pre-commit hook 到本 repo（可重複執行）
#
#   bash scripts/git-hooks/install.sh
#
# 會把 scripts/git-hooks/pre-commit 複製到 .git/hooks/pre-commit 並加上執行權限。
# 若 .git/hooks/pre-commit 已存在且不是本專案的版本，會先備份為 pre-commit.bak。

set -eu

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

SRC="$ROOT/scripts/git-hooks/pre-commit"
DST="$ROOT/.git/hooks/pre-commit"

[ -f "$SRC" ] || { echo "找不到 $SRC"; exit 1; }

if [ -f "$DST" ] && ! grep -q "docs-index" "$DST" 2>/dev/null; then
  BAK="$DST.bak.$(date +%Y%m%d%H%M%S)"
  cp "$DST" "$BAK"
  echo "已備份原有 hook → $BAK"
fi

cp "$SRC" "$DST"
chmod +x "$DST" 2>/dev/null || true

echo "✅ 已安裝 $DST"
echo "   測試：node scripts/docs-index.mjs --check && echo OK"
