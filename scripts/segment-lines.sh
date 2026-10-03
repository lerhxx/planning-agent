#!/usr/bin/env bash
#
# 按 commit 前缀统计 travel v2 期间**逐文件**的 `+行 / -行`（设计文档 §13.1 的表 A / B / C）
#
# 用法：bash scripts/segment-lines.sh [fix|feat|refactor] [基线，默认 m2-travel-only]
#   bash scripts/segment-lines.sh fix       # 表 A · 缺陷修复增量（与 M2 同口径，可直接比）
#   bash scripts/segment-lines.sh feat      # 表 B · 新增功能增量（M2 没有这张表）
#   bash scripts/segment-lines.sh refactor  # 表 C 的第三列
#
# ⚠️ 口径（与 check-commit-prefix.sh**相反**，改脚本前先看懂）
#   本脚本数的是**行数** —— 末尾 awk 累加了 numstat 的 `$1`/`$2` 两列。
#   `--numstat` 本身对**每个变更文件只输出一行**（`增\t删\t路径`）：
#     · `| wc -l`                                  → 数出来的是**文件个数**
#     · `| awk '{a+=$1;d+=$2} END{print a+d+0}'`   → 数出来的才是**行数**
#   本表要的是行数，所以用后者。别把两个口径混着讲。
#
# 统计范围（与判据一致）：`src/domains/travel`、`shared`、`src/core`
#   —— 前两者是"契约段增量"，`src/core` 是"破 0 增量"。
#   ★ 刻意用 `--no-renames`：开启改名检测时 numstat 的路径列会变成 `old => new`，
#     awk 取 `$3` 会拿到半个路径，统计结果就错了。
# ---------------------------------------------------------------------------
set -euo pipefail

KIND="${1:-fix}"
BASE="${2:-m2-travel-only}"

case "$KIND" in
  fix | feat | refactor | docs | test | chore) ;;
  *)
    echo "✗ 用法：bash scripts/segment-lines.sh [fix|feat|refactor|docs|test|chore] [基线]" >&2
    exit 2
    ;;
esac

if ! git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null; then
  echo "✗ 基线不存在：${BASE}" >&2
  exit 2
fi

printf '# 表：按文件统计 [%s] 提交的行数增量（基线 %s..HEAD）\n' "$KIND" "$BASE"
printf '# 口径：行数（numstat 两列累加），不是文件个数\n\n'

git log --format='%H' "${BASE}..HEAD" --grep="^\\[${KIND}\\]" \
  | while IFS= read -r sha; do
      [ -z "$sha" ] && continue
      git show --numstat --format='' --no-renames "$sha" -- src/domains/travel shared src/core
    done \
  | awk '
      NF >= 3 {
        add[$3] += ($1 == "-" ? 0 : $1)
        del[$3] += ($2 == "-" ? 0 : $2)
        total_add += ($1 == "-" ? 0 : $1)
        total_del += ($2 == "-" ? 0 : $2)
      }
      END {
        for (f in add) printf "%-58s +%-6d -%-6d (净 %+d)\n", f, add[f], del[f], add[f] - del[f]
        # 合计行的文件名列刻意**不含空格**：否则 `sort -k2` 的字段会错位。
        printf "%-58s +%-6d -%-6d (净 %+d)\n", "==TOTAL==", total_add, total_del, total_add - total_del
      }
    ' \
  | sort -k2 -rn

printf '\n# 说明：空的（无任何 [%s] 提交）也是合法结果 —— 它本身就是"这类改动为零"的证据。\n' "$KIND"
