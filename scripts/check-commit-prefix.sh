#!/usr/bin/env bash
#
# 校验：**travel v2 期间，凡是改动 `src/domains/**` 的提交，commit message 必须带合法前缀**
#
# 用法：bash scripts/check-commit-prefix.sh [基线，默认 m2-travel-only]
# 退出码：0 = 全部合规；1 = 存在无前缀提交（逐条列出 sha + subject）；2 = 用法/环境错误
#
# ★ 为什么必须存在这个脚本（设计文档 §13.2.1）
#   M3 判据的主留痕层是 **commit message 前缀**（techDocs 不入库）。约定本身不会自我执行：
#   漏写一个 `[fix]`，表 A 就少算一行，而**没有任何信号告诉你少算了** —— 脚本照样出结果，
#   判据照样"不成立"。这是**静默扭曲数据**，与本项目最忌讳的静默失败同族。
#
# ⚠️ 口径（这是本项目刚踩过的坑，改脚本前先看懂）
#   `git show --numstat` 对**每个变更文件输出一行**（`增\t删\t路径`）。
#   本脚本**只把它当布尔量用** —— "这个提交有没有触碰过 src/domains"，
#   **不是**在数行数。
#     · 数文件个数 = `... | wc -l`
#     · 数行数     = `... | awk '{a+=$1;d+=$2} END{print a+d+0}'`
#   这两个数与本脚本无关；要数行数请用 `scripts/segment-lines.sh`。
# ---------------------------------------------------------------------------
set -euo pipefail

BASE="${1:-m2-travel-only}"
# 合法前缀（设计文档 K13）：[feat] / [fix] / [refactor] / [docs] / [test] / [chore]
VALID_PREFIX='^\[(feat|fix|refactor|docs|test|chore)\]'

if ! git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null; then
  echo "✗ 基线不存在：${BASE}（用法：bash scripts/check-commit-prefix.sh [基线]）" >&2
  exit 2
fi

bad=0
checked=0
scanned=0

while IFS= read -r sha; do
  [ -z "$sha" ] && continue
  scanned=$((scanned + 1))

  # 该提交是否触碰过 src/domains/**。
  # awk：读到第一行且字段数 >0 → exit 1（碰过）；一行都没有 → 正常结束 exit 0（没碰过）。
  if git show --numstat --format='' --no-renames "$sha" -- src/domains | awk '{ exit (NF > 0) }'; then
    continue
  fi

  checked=$((checked + 1))
  subject="$(git log -1 --format='%s' "$sha")"
  if ! printf '%s' "$subject" | grep -Eq "$VALID_PREFIX"; then
    printf '✗ %s  %s\n' "${sha:0:8}" "$subject"
    bad=1
  fi
done < <(git log --format='%H' "${BASE}..HEAD")

if [ "$bad" -ne 0 ]; then
  echo "—— 以上提交改动了 src/domains/** 但没有合法前缀，判据表 A/B 会少算这些行 ——" >&2
  exit 1
fi

printf '✓ 全部 src/domains/** 提交均带合法前缀（基线 %s：扫描 %d 个提交，其中 %d 个触碰 src/domains/**）\n' \
  "$BASE" "$scanned" "$checked"
exit 0
