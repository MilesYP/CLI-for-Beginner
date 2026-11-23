#!/bin/sh
# 移除 HerdrSetup 裝進 Herdr 的 mods、layout 與狀態列追加行。資料檔（待辦清單、Plan 紀錄、用量快取）保留。
# Agent Plans 若已按過 Connect，請先在 Plan 面板按一次移除 hook，或執行：
#   python3 ~/.config/herdr-app/mods/agent-plans/hook/plan.py disconnect claude
set -eu
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
LAYOUT=estro9k
STATUSLINE="$HOME/.claude/statusline-cat.sh"
MARK="# herdr-setup: usage cache"

# 先切回內建 main，避免正在顯示的 layout 消失
herdr-app do layout.switch '{"name":"main"}' >/dev/null 2>&1 || true

for m in better-sidebar better-tabs over9k-usage over9k-todos agent-plans cria-files-extended cria-file-preview custom-status; do
  [ -d "$APP/mods/$m" ] && rm -rf "$APP/mods/$m" && echo "已移除 mod $m"
done
[ -f "$APP/layouts/$LAYOUT.json" ] && rm -f "$APP/layouts/$LAYOUT.json" && echo "已移除 layout $LAYOUT"

if [ -f "$STATUSLINE" ] && grep -q "$MARK" "$STATUSLINE"; then
  tmp="$STATUSLINE.tmp.$$"
  awk -v m="$MARK" '$0 == m { skip = 1; next } skip { skip = 0; next } { print }' "$STATUSLINE" > "$tmp" && cat "$tmp" > "$STATUSLINE" && rm -f "$tmp"
  echo "已從 statusline-cat.sh 移除追加行"
fi
rm -f "$HOME/.claude/herdr-usage-cache.sh"

AGY_STATUSLINE="$HOME/.config/ai-statusline/statusline.sh"
AGY_MARK="# herdr-setup: agy usage cache"
if [ -f "$AGY_STATUSLINE" ] && grep -q "$AGY_MARK" "$AGY_STATUSLINE"; then
  tmp="$AGY_STATUSLINE.tmp.$$"
  awk -v m="$AGY_MARK" '$0 == m { skip = 1; next } skip { skip = 0; next } { print }' "$AGY_STATUSLINE" > "$tmp" && cat "$tmp" > "$AGY_STATUSLINE" && rm -f "$tmp"
  echo "已從共用狀態列移除 agy 追加行"
fi
rm -f "$HOME/.gemini/antigravity-cli/herdr-usage-cache.sh"
echo "完成。"
