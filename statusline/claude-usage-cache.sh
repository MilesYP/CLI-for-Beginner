#!/bin/sh
# 把 Claude Code 交給狀態列的用量上限（rate_limits）存成快取，給 Herdr 的 over9k-usage 面板讀。
# 用法：在狀態列腳本裡，把 Claude Code 傳進來的 JSON 用管線餵給本檔：
#   printf '%s' "$input" | sh ~/.claude/herdr-usage-cache.sh
# 本檔不輸出任何文字，不影響狀態列顯示；缺 jq 或沒有 rate_limits 時什麼都不做。
# 寫入：~/.cache/over9k/usage/claude.json（格式與 over9k 的 claude-statusline.sh 相同）
# 合併規則取自 over9k：同一個時間窗只會被「更晚的時間窗」或「用量更高」的讀數取代，
# 避免閒置中的舊 session 用過時數字蓋掉新的。

command -v jq >/dev/null 2>&1 || exit 0
in=$(cat)
[ -n "$in" ] || exit 0

u="$HOME/.cache/over9k/usage"
mkdir -p "$u" 2>/dev/null || exit 0

# 同時只讓一個 session 寫入；中斷留下的鎖一分鐘後清掉。
lock="$u/claude.json.lock"
find "$lock" -maxdepth 0 -mmin +1 -exec rmdir {} + 2>/dev/null
mkdir "$lock" 2>/dev/null || exit 0
trap 'rmdir "$lock" 2>/dev/null' EXIT
trap 'exit 1' HUP INT TERM

old=$(jq -c 'select(type == "object")' "$u/claude.json" 2>/dev/null) || old=
[ -n "$old" ] || old=null

printf '%s' "$in" | jq -ce --argjson old "$old" '
  def further($new; $was):
    if ($was | type) != "object" or ($was.resets_at // 0) <= now then $new
    elif ($new | type) != "object" then $was
    elif ($new.resets_at // 0) > ($was.resets_at // 0) + 60 then $new
    elif ($new.resets_at // 0) < ($was.resets_at // 0) - 60 then $was
    elif ($new.used_percentage // 0) >= ($was.used_percentage // 0) then $new
    else $was end;
  select(.rate_limits != null)
  | {at: (now | floor),
     five_hour: further(.rate_limits.five_hour; $old.five_hour),
     seven_day: further(.rate_limits.seven_day; $old.seven_day)}' \
  > "$u/claude.json.$$" 2>/dev/null && mv "$u/claude.json.$$" "$u/claude.json" || rm -f "$u/claude.json.$$"
exit 0
