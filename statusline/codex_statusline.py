"""A Codex statusline provider using newline-delimited MCP over stdio."""

import json
import math
import os
from pathlib import Path
import re
import sys


URI = "ui://ai-statusline/footer"
PALETTE = Path(__file__).with_name("palette.json")
PERMS_FILE = Path.home() / ".cache" / "over9k" / "usage" / "permissions.json"
TOOL = {
    "name": "statusline",
    "title": "AI 狀態列",
    "description": "Show the current model, workspace, context usage, permission mode, and conversation title.",
    "inputSchema": {"type": "object", "properties": {}},
    "_meta": {
        "openai/ui": {"entrypoints": [{"type": "statusline", "resourceUri": URI}]}
    },
}


def clean(value):
    if not isinstance(value, str):
        return ""
    return re.sub(r"[\x00-\x1f\x7f-\x9f]", " ", value).strip()[:1024]


def block(value, background, foreground):
    return {
        "type": "row",
        "props": {"gap": 0, "wrap": "nowrap", "background": background},
        "children": [{
            "type": "text", "props": {"color": foreground}, "children": [f" {value} "],
        }],
    }


def resolve_perm_mode(raw_cwd):
    try:
        data = json.loads(PERMS_FILE.read_text(encoding="utf-8"))
        sessions = data.get("sessions") or {}
        tid = os.environ.get("HC_TERMINAL_ID") or ""
        if tid and sessions.get(tid) in ("ask", "safe", "full"):
            return sessions[tid]
        if raw_cwd:
            real_cwd = os.path.realpath(raw_cwd)
            for k in (f"cwd:{real_cwd}", f"cwd:{raw_cwd}"):
                if sessions.get(k) in ("ask", "safe", "full"):
                    return sessions[k]
        d = data.get("default")
        if d in ("ask", "safe", "full"):
            return d
    except Exception:
        pass
    return "ask"


def render(state):
    """Build the footer from the displayed thread and the shared palette."""
    colors = json.loads(PALETTE.read_text(encoding="utf-8"))
    thread = state.get("thread") or {}
    model = thread.get("model") or {}
    name = clean(model.get("display_name")) or "Codex"
    level = clean(model.get("reasoning_level"))
    raw_cwd = clean((thread.get("workspace") or {}).get("cwd"))
    cwd = raw_cwd
    home = str(Path.home())
    if cwd == home or cwd.startswith(home + "/"):
        cwd = "~" + cwd[len(home):]
    dark = colors["fg_dark"]
    light = colors["fg_light"]
    children = [block(f"{name} {level}" if level else name, colors["model"], dark)]
    if cwd:
        children.append(block(cwd, colors["path"], dark))
    context = (thread.get("usage") or {}).get("context") or {}
    percent = context.get("used_percentage")
    if type(percent) in (int, float) and math.isfinite(percent):
        color = "context_warn" if percent >= colors["threshold"] else "context"
        children.append(block(f"Context {math.floor(percent)}% used", colors[color], light))

    perm = resolve_perm_mode(raw_cwd)
    if perm == "full":
        children.append(block("🚀 最高權限", colors.get("perm_full", "#EA580C"), light))
    elif perm == "safe":
        children.append(block("🚧 刪改才問", colors.get("perm_safe", "#2563EB"), light))
    else:
        children.append(block("💬 每次都問", colors.get("perm_ask", "#3B4252"), light))

    title = clean(thread.get("name"))
    if title:
        children.append(block(title, colors["thread"], dark))
    return {"type": "row", "props": {"gap": 1, "wrap": "nowrap"}, "children": children}


def respond(method, params):
    if method == "initialize":
        return {
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {}, "resources": {}},
            "serverInfo": {"name": "ai-statusline", "version": "1.0"},
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": [TOOL]}
    if method == "tools/call":
        if params.get("name") != TOOL["name"]:
            raise ValueError("Unknown tool name")
        return {
            "content": [{"type": "text", "text": f"The statusline resource is {URI}."}]
        }
    if method == "resources/list":
        return {
            "resources": [
                {"name": "footer", "uri": URI, "mimeType": "application/json"}
            ]
        }
    if method == "resources/templates/list":
        return {"resourceTemplates": []}
    if method == "resources/read":
        if params.get("uri") != URI:
            raise ValueError("Unknown resource URI")
        state = params.get("_meta", {}).get("com.openai/codex-statusline-state", {})
        return {
            "contents": [
                {
                    "uri": URI,
                    "mimeType": "application/json",
                    "text": json.dumps(render(state), ensure_ascii=False),
                }
            ]
        }
    raise KeyError(method)


def main():
    for line in sys.stdin.buffer:
        reply = {"jsonrpc": "2.0", "id": None}
        try:
            request = json.loads(line)
            if not isinstance(request, dict) or not isinstance(
                request.get("method"), str
            ):
                reply["error"] = {"code": -32600, "message": "Invalid request"}
            elif "id" not in request:
                continue
            else:
                reply["id"] = request["id"]
                reply["result"] = respond(request["method"], request.get("params", {}))
        except json.JSONDecodeError:
            reply["error"] = {"code": -32700, "message": "Parse error"}
        except KeyError:
            reply["error"] = {"code": -32601, "message": "Method not found"}
        except (TypeError, ValueError, AttributeError):
            reply["error"] = {"code": -32602, "message": "Invalid parameters"}
        print(json.dumps(reply), flush=True)


if __name__ == "__main__":
    main()
