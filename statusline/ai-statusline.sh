#!/bin/sh
input=$(cat)
palette="${0%/*}/palette.json"

if [ "${1-}" = claude ]; then
    printf '%s' "$input" | sh "$HOME/.claude/herdr-usage-cache.sh" >/dev/null 2>&1 || true
fi

printf '%s' "$input" | jq -r --arg client "${1-}" --arg home "$HOME" --slurpfile palette "$palette" '
    def clean:
        gsub("[[:cntrl:]]"; " ") | sub("^ +"; "") | sub(" +$"; "");
    def rgb:
        ltrimstr("#") | ascii_downcase | explode
        | map(if . >= 97 then . - 87 else . - 48 end)
        | [.[0] * 16 + .[1], .[2] * 16 + .[3], .[4] * 16 + .[5]]
        | join(";");
    def block($background; $foreground):
        "\u001b[48;2;\($background | rgb)m\u001b[38;2;\($foreground | rgb)m \(.) \u001b[0m";
    def short_path:
        if . == $home then "~"
        elif startswith($home + "/") then "~" + .[($home | length):]
        else . end;

    $palette[0] as $colors
    | (if $client == "agy" then
           {model: (.model.display_name // .model.id // "Antigravity"),
            used: (if .context_window.context_window_size == 0 then null
                   else .context_window.used_percentage end),
            title: .conversation_title}
       else
           {model: (.model.display_name // "Claude"),
            used: .context_window.used_percentage,
            title: .session_name}
       end) as $status
    | [
        ($status.model | clean | block($colors.model; $colors.fg_dark)),
        ((.workspace.current_dir // .cwd // $home) | short_path | clean
         | block($colors.path; $colors.fg_dark)),
        (if ($status.used | type) == "number" then
            "Context \($status.used | floor)% used"
            | block((if $status.used >= $colors.threshold then $colors.context_warn else $colors.context end);
                    $colors.fg_light)
         else empty end),
        ($status.title | strings | clean | select(length > 0) | block($colors.thread; $colors.fg_dark))
      ]
    | join(" ")
' 2>/dev/null
# herdr-setup: agy usage cache
[ "${1-}" = agy ] && printf '%s' "$input" | sh "$HOME/.gemini/antigravity-cli/herdr-usage-cache.sh" >/dev/null 2>&1 || true
