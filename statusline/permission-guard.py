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

import json
import os
import re
import sys
import time

STATE_PATH = os.path.expanduser("~/.cache/over9k/usage/permissions.json")
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
        print("connected")
    else:
        print(DEFAULT_MODE)


if __name__ == "__main__":
    main()
