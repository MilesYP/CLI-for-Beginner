#!/bin/sh
# 把 HerdrSetup 的 mods 與 layout 裝進 Herdr（~/.config/herdr-app），並接上 Claude 與 agy 用量快取。
# 可重複執行：已安裝的同名 mod／layout 會先備份到 HerdrSetup/backups/<時間>/ 再更新。
# 不會動到 Herdr 內建的 layout 與 mod，也不會改 keys.json。
#   sh install.sh            安裝或更新
#   sh install.sh --no-statusline   不碰 ~/.claude/statusline-cat.sh 與 ~/.config/ai-statusline/statusline.sh
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
APP="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$HERE/backups/$STAMP"
MODS="better-sidebar better-tabs over9k-usage over9k-todos agent-plans cria-files-extended cria-file-preview custom-status"
LAYOUT=estro9k
STATUSLINE="$HOME/.claude/statusline-cat.sh"
CACHE_SCRIPT="$HOME/.claude/herdr-usage-cache.sh"
MARK="# herdr-setup: usage cache"
AGY_STATUSLINE="$HOME/.config/ai-statusline/statusline.sh"
AGY_CACHE_SCRIPT="$HOME/.gemini/antigravity-cli/herdr-usage-cache.sh"
AGY_MARK="# herdr-setup: agy usage cache"

[ -d "$APP/mods" ] && [ -d "$APP/layouts" ] || { echo "找不到 Herdr 設定資料夾：${APP}（先開過一次 Herdr）" >&2; exit 1; }

backup() { # $1 = 要備份的路徑
  [ -e "$1" ] || return 0
  mkdir -p "$BACKUP"
  cp -R "$1" "$BACKUP/"
  echo "  已備份 $(basename "$1") → backups/$STAMP/"
}

echo "== 安裝 mods"
for m in $MODS; do
  backup "$APP/mods/$m"
  rm -rf "$APP/mods/$m.tmp"
  cp -R "$HERE/mods/$m" "$APP/mods/$m.tmp"
  rm -rf "$APP/mods/$m"
  mv "$APP/mods/$m.tmp" "$APP/mods/$m"
  echo "  $m"
done

echo "== 安裝 layout"
backup "$APP/layouts/$LAYOUT.json"
cp "$HERE/layouts/$LAYOUT.json" "$APP/layouts/$LAYOUT.json"
echo "  $LAYOUT"

if [ "${1:-}" != "--no-statusline" ]; then
  echo "== 三套 CLI 共用狀態列與權限守門員 (~/.config/ai-statusline)"
  mkdir -p "$HOME/.config/ai-statusline"
  for f in "ai-statusline.sh:statusline.sh" "palette.json:palette.json" "codex_statusline.py:codex_statusline.py" "permission-guard.py:permission-guard.py"; do
    src="${f%%:*}"
    dst="${f##*:}"
    cp "$HERE/statusline/$src" "$HOME/.config/ai-statusline/$dst.tmp"
    chmod +x "$HOME/.config/ai-statusline/$dst.tmp" 2>/dev/null || true
    mv "$HOME/.config/ai-statusline/$dst.tmp" "$HOME/.config/ai-statusline/$dst"
  done
  backup "$HOME/.claude/settings.json"
  backup "$HOME/.codex/config.toml"
  backup "$HOME/.codex/AGENTS.md"
  python3 "$HOME/.config/ai-statusline/permission-guard.py" connect "$HERE/statusline" >/dev/null 2>&1 || true
  echo "  ~/.config/ai-statusline/ (statusline.sh, palette.json, codex_statusline.py, permission-guard.py)"
  echo "  已連接三套 CLI 權限開關 Hook（預設：🔒 每次都問）與 Codex 深色複製標色設定"

  echo "== Claude 用量快取"
  mkdir -p "$HOME/.claude"
  cp "$HERE/statusline/claude-usage-cache.sh" "$CACHE_SCRIPT"
  echo "  $CACHE_SCRIPT"
  if [ ! -f "$STATUSLINE" ]; then
    echo "  找不到 $STATUSLINE，略過（共用狀態列 statusline.sh 已內建呼叫 herdr-usage-cache.sh）"
  elif grep -q "$MARK" "$STATUSLINE"; then
    echo "  狀態列已接上，不重複追加"
  else
    backup "$STATUSLINE"
    # 原檔結尾沒有換行時先補一個，確保追加的是獨立兩行（移除時刪這兩行即還原）
    [ "$(tail -c 1 "$STATUSLINE" | od -An -c | tr -d ' ')" = '\n' ] || printf '\n' >> "$STATUSLINE"
    printf '%s\nprintf %s "$input" | sh "$HOME/.claude/herdr-usage-cache.sh" >/dev/null 2>&1 || true\n' "$MARK" "'%s'" >> "$STATUSLINE"
    echo "  已在 statusline-cat.sh 結尾追加一行（狀態列顯示不變）"
  fi

  echo "== Antigravity（agy）狀態列、標題與用量快取"
  if [ ! -d "$HOME/.gemini/antigravity-cli" ]; then
    echo "  找不到 ~/.gemini/antigravity-cli，略過（Gemini 用量不會顯示）"
  else
    cp "$HERE/statusline/agy-usage-cache.sh" "$AGY_CACHE_SCRIPT.tmp"
    cp "$HERE/statusline/agy-statusline.sh" "$HOME/.gemini/antigravity-cli/statusline.sh.tmp"
    cp "$HERE/statusline/agy-title.sh" "$HOME/.gemini/antigravity-cli/title.sh.tmp"
    chmod +x "$HOME/.gemini/antigravity-cli/statusline.sh.tmp" "$HOME/.gemini/antigravity-cli/title.sh.tmp" "$AGY_CACHE_SCRIPT.tmp" 2>/dev/null || true
    mv "$AGY_CACHE_SCRIPT.tmp" "$AGY_CACHE_SCRIPT"
    mv "$HOME/.gemini/antigravity-cli/statusline.sh.tmp" "$HOME/.gemini/antigravity-cli/statusline.sh"
    mv "$HOME/.gemini/antigravity-cli/title.sh.tmp" "$HOME/.gemini/antigravity-cli/title.sh"
    echo "  $AGY_CACHE_SCRIPT (+ statusline.sh, title.sh)"
    if [ ! -f "$AGY_STATUSLINE" ]; then
      echo "  找不到 $AGY_STATUSLINE（三套 CLI 共用狀態列），略過（Gemini 用量不會顯示）"
    elif grep -q "$AGY_MARK" "$AGY_STATUSLINE"; then
      echo "  狀態列已接上，不重複追加"
    else
      backup "$AGY_STATUSLINE"
      [ "$(tail -c 1 "$AGY_STATUSLINE" | od -An -c | tr -d ' ')" = '\n' ] || printf '\n' >> "$AGY_STATUSLINE"
      # 只在 agy 呼叫（參數 agy）時寫快取；放在結尾，狀態列文字已先輸出，顯示不變
      printf '%s\n[ "${1-}" = agy ] && printf %s "$input" | sh "$HOME/.gemini/antigravity-cli/herdr-usage-cache.sh" >/dev/null 2>&1 || true\n' "$AGY_MARK" "'%s'" >> "$AGY_STATUSLINE"
      echo "  已在共用狀態列結尾追加一行（只在 agy 呼叫時執行，狀態列顯示不變）"
    fi
  fi
fi

echo "== 檢查"
fail=0
for m in $MODS; do
  if herdr-app check "$APP/mods/$m" >/dev/null 2>&1; then echo "  ✓ $m"; else echo "  ✗ $m"; herdr-app check "$APP/mods/$m" || true; fail=1; fi
done
[ "$fail" = 0 ] || { echo "有 mod 檢查失敗，見上方訊息" >&2; exit 1; }
echo
echo "完成。在 Herdr 按 Cmd+Shift+L 切換 layout，或執行："
echo "  herdr-app do layout.switch '{\"name\":\"$LAYOUT\"}'"
