#!/bin/sh
# 把 Antigravity CLI（agy）交給狀態列的用量（quota、plan_tier）存成快取，給 Herdr 的 over9k-usage 面板讀。
# 用法：在 agy 的狀態列腳本裡，把 agy 傳進來的 JSON 用管線餵給本檔：
#   printf '%s' "$input" | sh ~/.gemini/antigravity-cli/herdr-usage-cache.sh
# 本檔不輸出任何文字，不影響狀態列顯示；缺 jq 或沒有 quota 時什麼都不做。
# 寫入：~/.cache/over9k/usage/antigravity.json，格式為 over9k-usage 讀的 {at, plan, quota}
#   quota 依 agy 原樣保留各額度（例如 gemini-5h、gemini-weekly、3p-5h、3p-weekly），
#   其中 reset_in_seconds 以 at 為起點，面板用 at + reset_in_seconds 算重置時間。
# 合併規則同 Claude 版：同一個額度只會被「更晚的時間窗」或「同一時間窗但用得更多」的讀數取代，
# 避免閒置中的舊 session 用過時數字蓋掉新的；已過重置時間的舊讀數直接丟掉。

command -v jq >/dev/null 2>&1 || exit 0
in=$(cat)
[ -n "$in" ] || exit 0

u="$HOME/.cache/over9k/usage"
mkdir -p "$u" 2>/dev/null || exit 0

# 同時只讓一個 session 寫入；中斷留下的鎖一分鐘後清掉。
lock="$u/antigravity.json.lock"
find "$lock" -maxdepth 0 -mmin +1 -exec rmdir {} + 2>/dev/null
mkdir "$lock" 2>/dev/null || exit 0
trap 'rmdir "$lock" 2>/dev/null' EXIT
trap 'exit 1' HUP INT TERM

old=$(jq -c 'select(type == "object")' "$u/antigravity.json" 2>/dev/null) || old=
[ -n "$old" ] || old=null

printf '%s' "$in" | jq -ce --argjson old "$old" '
  (now | floor) as $now
  | ($old.at // $now) as $oat
  # 換成絕對重置時間（秒），方便比較新舊讀數
  #（沒有重置時間的額度記為 null，一律以新讀數為準）
  | def absolute($at): if type == "object" then . + {_reset: (if .reset_in_seconds == null then null else $at + .reset_in_seconds end)} else null end;
    def further($new; $was):
      if ($new | type) == "object" and $new._reset == null then $new
      elif ($was | type) != "object" or $was._reset == null or $was._reset <= $now then $new
      elif ($new | type) != "object" then $was
      elif $new._reset > $was._reset + 60 then $new
      elif $new._reset < $was._reset - 60 then $was
      elif ($new.remaining_fraction // 1) <= ($was.remaining_fraction // 1) then $new
      else $was end;
  select((.quota | type) == "object" and (.quota | length) > 0)
  | .quota as $q
  | (($old.quota // {}) | if type == "object" then . else {} end) as $oq
  | {at: $now,
     plan: (.plan_tier // $old.plan // null),
     quota: ([($q | keys[]), ($oq | keys[])] | unique
             | map(. as $k
                   | further(($q[$k] | absolute($now)); ($oq[$k] | absolute($oat)))
                   | select(. != null and (._reset == null or ._reset > $now))
                   | {key: $k, value: ((if ._reset == null then . else .reset_in_seconds = (._reset - $now) end) | del(._reset))})
             | from_entries)}' \
  > "$u/antigravity.json.$$" 2>/dev/null && mv "$u/antigravity.json.$$" "$u/antigravity.json" || rm -f "$u/antigravity.json.$$"
exit 0
