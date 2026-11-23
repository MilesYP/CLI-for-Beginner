#!/bin/sh
# 輸出 agy 目前對話標題（conversation_title 或自動自 transcript.jsonl 擷取首句主題）給終端機標題，讓 Herdr 側欄與分頁顯示工作主題。
input=$(cat)
guard="$HOME/.config/ai-statusline/permission-guard.py"

if [ -f "$guard" ]; then
  title=$(printf '%s' "$input" | python3 "$guard" agy-title "${HC_TERMINAL_ID-}" 2>/dev/null)
  if [ -n "$title" ]; then
    printf '%s' "$title"
    exit 0
  fi
fi

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
