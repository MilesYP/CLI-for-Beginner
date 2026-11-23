#!/usr/bin/env python3
"""Unified permission mode manager and PreToolUse / PermissionRequest hook for Claude Code, agy, and Codex.

Modes (per Herdr terminal session, default = "ask"):
  - "ask"  (💬 每次都問): Ask before any file write/edit or shell command execution.
  - "safe" (🚧 刪改才問): Auto-allow normal reads/edits/commands; ask ONLY on file deletion,
                         forced overwrite of existing files, or destructive git/system commands.
  - "full" (🚀 最高權限): Auto-allow tool executions for the current session.

State file: ~/.cache/over9k/usage/permissions.json
Usage:
  permission-guard.py get [terminal_id] [cwd]
  permission-guard.py set <ask|safe|full> [terminal_id] [cwd]
  permission-guard.py hook <claude|agy|codex-pre|codex-perm>   (reads hook JSON from stdin)
"""

import glob
import json
import os
import re
import sys
import time

STATE_PATH = os.path.expanduser("~/.cache/over9k/usage/permissions.json")
AGY_TITLES_PATH = os.path.expanduser("~/.cache/over9k/usage/agy-titles.json")
AGY_BRAIN_GLOB = os.path.expanduser("~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl")
VALID_MODES = ("ask", "safe", "full")
DEFAULT_MODE = "ask"

READONLY_TOOLS = {
    # agy
    "read_file", "view_file", "view_file_outline", "view_code_item",
    "list_dir", "grep_search", "find_by_name", "search_web", "read_url_content",
    # Claude Code
    "Read", "Glob", "Grep", "LS", "WebSearch", "WebFetch", "TodoRead",
}

SHELL_TOOLS = {
    "run_command", "Bash", "bash", "shell", "exec_command", "container.exec", "local_shell",
}

WRITE_OVERWRITE_TOOLS = {
    "write_file", "Write", "create_file",
}

DESTRUCTIVE_CMD_RE = re.compile(
    r"""(?ix)
    (?:^|[;&|()\s`])
    (?:
        sudo\s+
      | (?:rm|rmdir|unlink|trash|shred|srm)\s+
      | find\b[^\n;|&]*\s-(?:delete|exec\s+rm)\b
      | (?:mv|cp)\s+[^\n;|&]*-[A-Za-z]*f[A-Za-z]*\b
      | dd\s+
      | truncate\s+
      | git\s+(?:
            reset\s+--hard\b
          | clean\b[^\n;|&]*-[A-Za-z]*f
          | checkout\s+--\b
          | restore\b
          | push\s+[^\n;|&]*(?:--force|-f\b)
          | branch\s+-D\b
        )
      | (?:mkfs|diskutil\s+erase|killall)\b
    )
    """
)


def load_state():
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {"default": DEFAULT_MODE, "sessions": {}}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    tmp = f"{STATE_PATH}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE_PATH)


def get_mode(term_id=None, cwd=None):
    state = load_state()
    sessions = state.get("sessions") or {}
    tid = term_id or os.environ.get("HC_TERMINAL_ID") or ""
    if tid and sessions.get(tid) in VALID_MODES:
        return sessions[tid]
    if cwd:
        real_cwd = os.path.realpath(cwd)
        for k in (f"cwd:{real_cwd}", f"cwd:{cwd}"):
            if sessions.get(k) in VALID_MODES:
                return sessions[k]
    default = state.get("default")
    return default if default in VALID_MODES else DEFAULT_MODE


def set_mode(mode, term_id=None, cwd=None):
    if mode not in VALID_MODES:
        mode = DEFAULT_MODE
    state = load_state()
    sessions = state.setdefault("sessions", {})
    if term_id:
        sessions[term_id] = mode
    if cwd:
        sessions[f"cwd:{cwd}"] = mode
        try:
            sessions[f"cwd:{os.path.realpath(cwd)}"] = mode
        except Exception:
            pass
    state["updated_at"] = int(time.time())
    save_state(state)
    return mode


def clean_title_str(raw_str, max_len=28):
    if not isinstance(raw_str, str):
        return ""
    s = re.sub(r"[\x00-\x1f\x7f-\x9f]+", " ", raw_str).strip()
    if not s or s.lower() == "antigravity":
        return ""
    if len(s) > max_len:
        return s[:max_len].rstrip() + "…"
    return s


def extract_title_and_cwd_from_transcript(tpath):
    """Extract (first_user_title, latest_user_title, detected_cwd) from an agy transcript.jsonl."""
    first_title = ""
    latest_title = ""
    cwd_counts = {}
    home = os.path.expanduser("~")
    ignore_prefixes = (
        os.path.join(home, ".gemini"),
        os.path.join(home, ".config"),
        os.path.join(home, ".claude"),
        os.path.join(home, ".codex"),
        os.path.join(home, ".cache"),
        os.path.join(home, ".local"),
    )
    path_re = re.compile(r'(/Users/[^"\'\s\\]+)')
    req_re = re.compile(r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>", re.S)

    try:
        with open(tpath, "r", encoding="utf-8", errors="ignore") as f:
            for idx, line in enumerate(f):
                if '"USER_INPUT"' in line:
                    try:
                        obj = json.loads(line)
                        content = obj.get("content") or ""
                        m = req_re.search(content)
                        text = (m.group(1) if m else content).strip()
                        # Take the first meaningful line of the user prompt
                        for row in text.splitlines():
                            row = row.strip().lstrip("#>-* ")
                            if row:
                                t = clean_title_str(row, 28)
                                if t:
                                    if not first_title:
                                        first_title = t
                                    latest_title = t
                                break
                    except Exception:
                        pass
                if idx < 150:
                    for pm in path_re.finditer(line):
                        p = pm.group(1).rstrip(".,;:)]}")
                        if any(p.startswith(ip) for ip in ignore_prefixes):
                            continue
                        # Normalize to workspace root (e.g. /Users/miles/Developer/<Project> or /Users/miles/Desktop/<Project>)
                        parts = p.split("/")
                        if len(parts) >= 5 and parts[1] == "Users" and parts[3] in ("Developer", "Desktop", "Documents", "Projects"):
                            root = "/".join(parts[:5])
                            cwd_counts[root] = cwd_counts.get(root, 0) + 1
    except Exception:
        pass

    detected_cwd = ""
    if cwd_counts:
        detected_cwd = max(cwd_counts.items(), key=lambda kv: kv[1])[0]
    return first_title or latest_title, latest_title or first_title, detected_cwd


def sync_all_agy_titles(payload=None, cwd=None, term_id=None):
    """Scan active agy transcripts, update ~/.cache/over9k/usage/agy-titles.json, and return the title for (term_id, cwd)."""
    try:
        with open(AGY_TITLES_PATH, "r", encoding="utf-8") as f:
            cache = json.load(f)
            if not isinstance(cache, dict):
                cache = {}
    except Exception:
        cache = {}

    by_cwd = cache.setdefault("by_cwd", {})
    by_term = cache.setdefault("by_term", {})
    by_conv = cache.setdefault("by_conv", {})

    # 1. Check explicit title in stdin payload
    explicit = ""
    if isinstance(payload, dict):
        for k in ("conversation_title", "session_name", "title"):
            val = clean_title_str(payload.get(k))
            if val:
                explicit = val
                break
        if not explicit and isinstance(payload.get("conversation"), dict):
            explicit = clean_title_str(payload["conversation"].get("title"))
        if not cwd:
            cwd = (payload.get("workspace") or {}).get("current_dir") or payload.get("cwd") or ""

    # 2. Scan recent transcripts (sorted oldest -> newest so newest wins per cwd)
    tpaths = sorted(glob.glob(AGY_BRAIN_GLOB), key=lambda p: os.path.getmtime(p))[-20:]
    newest_unassigned_title = ""
    for tp in tpaths:
        conv_id = os.path.basename(os.path.dirname(os.path.dirname(os.path.dirname(tp))))
        ftitle, _ltitle, det_cwd = extract_title_and_cwd_from_transcript(tp)
        if not ftitle:
            continue
        by_conv[conv_id] = {"title": ftitle, "cwd": det_cwd, "mtime": int(os.path.getmtime(tp))}
        if det_cwd:
            by_cwd[det_cwd] = ftitle
            try:
                by_cwd[os.path.realpath(det_cwd)] = ftitle
            except Exception:
                pass
        elif time.time() - os.path.getmtime(tp) < 300:
            newest_unassigned_title = ftitle

    # 3. Resolve best title for current invocation
    resolved = explicit
    if not resolved and isinstance(payload, dict):
        raw_dump = json.dumps(payload)
        for cid, info in by_conv.items():
            if cid in raw_dump:
                resolved = info.get("title") or ""
                break

    if not resolved and cwd:
        real_cwd = os.path.realpath(cwd)
        resolved = by_cwd.get(real_cwd) or by_cwd.get(cwd) or ""

    if not resolved and term_id:
        resolved = by_term.get(term_id) or ""

    if not resolved and newest_unassigned_title:
        resolved = newest_unassigned_title

    if resolved:
        if cwd:
            by_cwd[cwd] = resolved
            try:
                by_cwd[os.path.realpath(cwd)] = resolved
            except Exception:
                pass
        if term_id:
            by_term[term_id] = resolved

    cache["updated_at"] = int(time.time())
    try:
        os.makedirs(os.path.dirname(AGY_TITLES_PATH), exist_ok=True)
        tmp = f"{AGY_TITLES_PATH}.tmp.{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False, indent=2)
        os.replace(tmp, AGY_TITLES_PATH)
    except Exception:
        pass

    return resolved


def extract_tool_info(payload):
    """Extract (tool_name, args_dict, cwd) across agy, Claude Code, and Codex hook payloads."""
    cwd = payload.get("cwd") or ""
    if not cwd:
        wps = payload.get("workspacePaths")
        if isinstance(wps, list) and wps:
            cwd = wps[0]
    # agy format: {"toolCall": {"name": "...", "args": {...}}}
    tc = payload.get("toolCall")
    if isinstance(tc, dict):
        name = tc.get("name") or ""
        args = tc.get("args") if isinstance(tc.get("args"), dict) else {}
        return name, args, cwd
    # Claude Code / Codex format: {"tool_name": "...", "tool_input": {...}}
    name = payload.get("tool_name") or ""
    inp = payload.get("tool_input")
    if isinstance(inp, str):
        try:
            inp = json.loads(inp)
        except Exception:
            inp = {"command": inp}
    args = inp if isinstance(inp, dict) else {}
    return name, args, cwd


def extract_command_string(args):
    for key in ("CommandLine", "command", "cmd", "script"):
        val = args.get(key)
        if isinstance(val, str) and val.strip():
            return val
        if isinstance(val, list) and val:
            return " ".join(str(x) for x in val)
    return ""


def is_destructive(tool_name, args, cwd):
    """Return (bool, reason) indicating if this tool call deletes or overwrites data."""
    if tool_name in SHELL_TOOLS or not tool_name:
        cmd = extract_command_string(args)
        if cmd and DESTRUCTIVE_CMD_RE.search(cmd):
            return True, f"偵測到刪除或強制覆蓋指令：{cmd[:80]}"
    if tool_name in WRITE_OVERWRITE_TOOLS:
        path = args.get("Path") or args.get("file_path") or args.get("path") or ""
        if path:
            full = path if os.path.isabs(path) else os.path.join(cwd or "", path)
            if os.path.exists(full):
                return True, f"即將覆蓋既有檔案：{os.path.basename(full)}"
    return False, ""


def handle_hook(client):
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except Exception:
        payload = {}

    tool_name, args, cwd = extract_tool_info(payload)
    mode = get_mode(os.environ.get("HC_TERMINAL_ID"), cwd)
    destructive, reason = is_destructive(tool_name, args, cwd)

    if client == "agy":
        if mode == "full":
            print(json.dumps({"decision": "allow"}))
            return
        if mode == "safe":
            if destructive:
                print(json.dumps({
                    "decision": "force_ask",
                    "reason": f"🚧 刪改才問模式：{reason}",
                }, ensure_ascii=False))
            else:
                print(json.dumps({"decision": "allow"}))
            return
        # mode == "ask" (default)
        if tool_name in READONLY_TOOLS:
            print(json.dumps({"decision": "allow"}))
        else:
            print(json.dumps({
                "decision": "force_ask",
                "reason": "💬 每次都問模式：請確認是否執行此操作",
            }, ensure_ascii=False))
        return

    if client == "claude":
        out = lambda dec, msg="": print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": dec,
                **({"permissionDecisionReason": msg} if msg else {}),
            }
        }, ensure_ascii=False))
        if mode == "full":
            out("allow")
            return
        if mode == "safe":
            if destructive:
                out("ask", f"🚧 刪改才問模式：{reason}")
            else:
                out("allow")
            return
        # mode == "ask"
        if tool_name in READONLY_TOOLS:
            out("allow")
        else:
            out("ask", "💬 每次都問模式：請確認是否執行此操作")
        return

    if client == "codex-perm":
        # Codex PermissionRequest hook
        if mode == "full":
            print(json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": {"behavior": "allow"},
                }
            }))
            return
        if mode == "safe" and not destructive:
            print(json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": {"behavior": "allow"},
                }
            }))
            return
        # For "ask" or destructive under "safe", return empty object so Codex prompts the user
        print("{}")
        return

    print("{}")


def connect_hooks(repo_statusline_dir=None):
    """Connect PreToolUse / PermissionRequest hooks for Claude Code, agy, and Codex,
    and install Codex dark theme + copy highlight rule in AGENTS.md."""
    home = os.path.expanduser("~")
    guard_cmd = f'python3 "{home}/.config/ai-statusline/permission-guard.py" hook'

    # 1. Claude Code (~/.claude/settings.json)
    claude_cfg = os.path.join(home, ".claude", "settings.json")
    if os.path.isfile(claude_cfg):
        try:
            with open(claude_cfg, "r", encoding="utf-8") as f:
                data = json.load(f)
            hooks = data.setdefault("hooks", {})
            pre = hooks.setdefault("PreToolUse", [])
            cmd_str = f'{guard_cmd} claude'
            already = any(
                any(h.get("command") == cmd_str for h in item.get("hooks", []))
                for item in pre if isinstance(item, dict)
            )
            if not already:
                pre.append({
                    "matcher": ".*",
                    "hooks": [{"type": "command", "command": cmd_str, "timeout": 5}],
                })
            # Remove static ask rules that force prompts even on Read() or override dynamic hook
            perms = data.get("permissions")
            if isinstance(perms, dict) and isinstance(perms.get("ask"), list):
                perms["ask"] = [
                    r for r in perms["ask"]
                    if r not in ("Read(/Users/miles/*)", "Write(/Users/miles/*)", "Edit(/Users/miles/*)")
                ]
            with open(claude_cfg, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
                f.write("\n")
        except Exception as e:
            sys.stderr.write(f"[permission-guard] claude settings error: {e}\n")

    # 2. Antigravity CLI agy (~/.gemini/config/hooks.json)
    agy_hooks_path = os.path.join(home, ".gemini", "config", "hooks.json")
    try:
        os.makedirs(os.path.dirname(agy_hooks_path), exist_ok=True)
        agy_data = {}
        if os.path.isfile(agy_hooks_path):
            with open(agy_hooks_path, "r", encoding="utf-8") as f:
                raw = f.read().strip()
                if raw:
                    agy_data = json.loads(raw)
        agy_data["permission-guard"] = {
            "enabled": True,
            "PreToolUse": [
                {
                    "matcher": ".*",
                    "hooks": [
                        {
                            "type": "command",
                            "command": f'{guard_cmd} agy',
                            "timeout": 5,
                        }
                    ],
                }
            ],
        }
        with open(agy_hooks_path, "w", encoding="utf-8") as f:
            json.dump(agy_data, f, ensure_ascii=False, indent=2)
            f.write("\n")
    except Exception as e:
        sys.stderr.write(f"[permission-guard] agy hooks error: {e}\n")

    # 3. Codex CLI (~/.codex/config.toml, ~/.codex/themes/cli-beginner-dark.tmTheme, ~/.codex/AGENTS.md)
    codex_dir = os.path.join(home, ".codex")
    if os.path.isdir(codex_dir):
        if repo_statusline_dir:
            theme_src = os.path.join(repo_statusline_dir, "cli-beginner-dark.tmTheme")
            if os.path.isfile(theme_src):
                themes_dir = os.path.join(codex_dir, "themes")
                os.makedirs(themes_dir, exist_ok=True)
                with open(theme_src, "rb") as sf, open(os.path.join(themes_dir, "cli-beginner-dark.tmTheme"), "wb") as df:
                    df.write(sf.read())
            agents_src = os.path.join(repo_statusline_dir, "codex-AGENTS.md")
            if os.path.isfile(agents_src):
                with open(agents_src, "rb") as sf, open(os.path.join(codex_dir, "AGENTS.md"), "wb") as df:
                    df.write(sf.read())

        codex_cfg = os.path.join(codex_dir, "config.toml")
        if os.path.isfile(codex_cfg):
            try:
                with open(codex_cfg, "r", encoding="utf-8") as f:
                    text = f.read()
                # Replace light theme catppuccin-latte with high-contrast dark theme
                text = re.sub(
                    r'(?m)^theme\s*=\s*"catppuccin-latte"\s*$',
                    'theme = "cli-beginner-dark"',
                    text,
                )
                block_start = "# >>> permission-guard (Herdr Permission Switch)"
                block_end = "# <<< permission-guard"
                hook_block = (
                    f"{block_start}\n"
                    f"[[hooks.PermissionRequest]]\n"
                    f"[[hooks.PermissionRequest.hooks]]\n"
                    f'type = "command"\n'
                    f"command = '{guard_cmd} codex-perm || true'\n"
                    f"timeout = 5\n"
                    f"{block_end}\n"
                )
                if block_start in text and block_end in text:
                    pattern = re.compile(re.escape(block_start) + r".*?" + re.escape(block_end) + r"\n?", re.S)
                    text = pattern.sub(hook_block, text)
                else:
                    if not text.endswith("\n"):
                        text += "\n"
                    text += "\n" + hook_block
                with open(codex_cfg, "w", encoding="utf-8") as f:
                    f.write(text)
            except Exception as e:
                sys.stderr.write(f"[permission-guard] codex config error: {e}\n")


def main():
    argv = sys.argv[1:]
    if not argv:
        print(get_mode())
        return
    cmd = argv[0]
    if cmd == "get":
        term = argv[1] if len(argv) > 1 else None
        cwd = argv[2] if len(argv) > 2 else None
        print(get_mode(term, cwd))
    elif cmd == "set":
        mode = argv[1] if len(argv) > 1 else DEFAULT_MODE
        term = argv[2] if len(argv) > 2 else None
        cwd = argv[3] if len(argv) > 3 else None
        print(set_mode(mode, term, cwd))
    elif cmd == "hook":
        client = argv[1] if len(argv) > 1 else "claude"
        handle_hook(client)
    elif cmd == "connect":
        src_dir = argv[1] if len(argv) > 1 else os.path.dirname(os.path.abspath(__file__))
        connect_hooks(src_dir)
        # Ensure permissions.json exists with default = "ask"
        st = load_state()
        if st.get("default") not in VALID_MODES:
            st["default"] = DEFAULT_MODE
        save_state(st)
        sync_all_agy_titles()
        print("connected")
    elif cmd == "agy-title":
        term = argv[1] if len(argv) > 1 else os.environ.get("HC_TERMINAL_ID", "")
        cwd = argv[2] if len(argv) > 2 else ""
        raw = sys.stdin.read() if not sys.stdin.isatty() else ""
        try:
            payload = json.loads(raw) if raw.strip() else {}
        except Exception:
            payload = {}
        title = sync_all_agy_titles(payload, cwd, term)
        print(title or "Antigravity", end="")
    elif cmd == "sync-titles":
        sync_all_agy_titles()
        try:
            with open(AGY_TITLES_PATH, "r", encoding="utf-8") as f:
                print(f.read(), end="")
        except Exception:
            print("{}")
    else:
        print(DEFAULT_MODE)


if __name__ == "__main__":
    main()
