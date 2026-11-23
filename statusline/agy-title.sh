#!/bin/sh
# 輸出 agy 目前對話標題（conversation_title）給終端機標題，讓 Herdr 側欄與分頁顯示工作主題。
# 尚未有對話標題時輸出 Antigravity，讓 Herdr 維持顯示程式名稱與專案資料夾。
input=$(cat)
[ -n "$input" ] || { printf 'Antigravity'; exit 0; }

title=$(printf '%s' "$input" | jq -r '
  (.conversation_title // "")
  | gsub("[[:cntrl:]]"; " ")
  | sub("^ +"; "")
  | sub(" +$"; "")
' 2>/dev/null)

if [ -n "$title" ]; then
  printf '%s' "$title"
else
  printf 'Antigravity'
fi
