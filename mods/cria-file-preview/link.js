// Terminal link handler for cria-file-preview: Cmd-click (Ctrl-click on Linux/Windows)
// on any file path in terminal output opens it in cria-file-preview instead of an external app.
import { exec, focused, home, notify, panes, run, setShared, shared, spaces } from "herdr";
import { OPEN, MOVED, REQUEST, MODE_KEY, FOCUS_DIR, shownIn, openCommand } from "./open-file.js";
import { dirname } from "./paths.js";

function cleanToken(str) {
  if (!str) return "";
  let s = String(str).trim();
  try { s = decodeURIComponent(s); } catch {}
  s = s.replace(/\uFFFD+$/g, "").replace(/#[^#]*$/, "").replace(/:\d+(?::\d+)?$/, "").replace(/[),.;'"`\]>]+$/, "");
  return s.trim();
}

function expandHome(p, h) {
  if (!p) return "";
  if (p === "~") return h || p;
  if (p.startsWith("~/")) return h ? `${h.replace(/[\\/]+$/, "")}${p.slice(1)}` : p;
  return p;
}

function candidatePaths(link, source) {
  const h = (home?.() || "").replace(/[\\/]+$/, "");
  const out = [];
  const push = (p) => {
    const c = expandHome(cleanToken(p), h);
    if (c && !out.includes(c)) out.push(c);
  };

  const inputs = [link?.url, link?.raw, link?.path].filter(Boolean);
  for (const inp of inputs) {
    let raw = String(inp).trim();
    if (!raw) continue;

    // 1. Check if a file:// URI is embedded anywhere in the token (e.g. agy TUI concatenated markdown link)
    const fileUriMatch = raw.match(/file:\/\/(?:localhost)?(\/[^\s"'<>)\]]+)/i);
    if (fileUriMatch) {
      push(fileUriMatch[1]);
    }
    if (/^file:\/\//i.test(raw)) {
      push(raw.replace(/^file:\/\/(localhost)?/i, ""));
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      continue;
    }

    // 2. Check if an inline ~/... path is glued after display text (e.g. "檔名.pptx~/Desktop/..." or "/cwd/檔名.pptx~/Desktop/...")
    const tildeIdx = raw.lastIndexOf("~/");
    if (tildeIdx >= 0) {
      push(raw.slice(tildeIdx));
    }

    // 3. Check if a /Users/... or /tmp/... or /var/... path is glued inside the string
    const absMatch = raw.match(/(\/(?:Users|tmp|private|var|opt|Applications|Library|Volumes)\/[^\s"'<>)\]]+)$/);
    if (absMatch) {
      push(absMatch[1]);
    }

    // 4. Direct path or relative path resolution
    const cleaned = cleanToken(raw);
    if (!cleaned) continue;
    if (cleaned.startsWith("~/") || cleaned.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cleaned)) {
      push(cleaned);
    } else {
      const activeSpace = spaces()?.find((s) => s.active);
      const bases = [source?.cwd, activeSpace?.folder, activeSpace?.folder ? `${activeSpace.folder}/HerdrSetup` : null, h].filter(Boolean);
      for (const base of bases) {
        const sep = base.includes("\\") ? "\\" : "/";
        push(`${base.replace(/[\\/]+$/, "")}${sep}${cleaned.replace(/^\.[\\/]/, "")}`);
      }
    }
  }
  return out;
}

export async function handleLink(click) {
  const { link, source } = click ?? {};
  const on = source?.machine || null;
  const candidates = candidatePaths(link, source);

  // Find the first candidate that exists as a regular file on disk.
  let file = null;
  for (const cand of candidates) {
    const check = await exec("test", ["-f", cand], on ? { on } : undefined).catch(() => ({ code: 1 }));
    if (check.code === 0) {
      file = cand;
      break;
    }
  }

  // Fallback for agy TUI truncated OSC 8 UTF-8 URIs (which end with \uFFFD after byte truncation)
  // or wrapped/glued links: strip trailing replacement chars and match by parent directory prefix or Spotlight.
  if (!file && !on) {
    const rawStr = cleanToken(link?.url || link?.raw || link?.path || "");
    if (rawStr && !/^https?:\/\//i.test(rawStr) && !/^mailto:/i.test(rawStr)) {
      const h = (home?.() || "").replace(/[\\/]+$/, "");
      const activeSpace = spaces()?.find((s) => s.active);
      const searchDirs = [source?.cwd, activeSpace?.folder, h ? `${h}/Desktop` : null, h ? `${h}/Developer` : null].filter(Boolean);
      const pyResolve = String.raw`
import os, subprocess, sys
cands = [c.rstrip("\ufffd").strip() for c in sys.argv[1].split("\n") if c.strip()]
dirs = [d for d in sys.argv[2:] if d and os.path.isdir(d)]

# 1. Exact parent-dir prefix match (handles OSC 8 byte-truncated UTF-8 paths like ".../Mula_首次開通統一金流")
for cand in cands:
    parent = os.path.dirname(cand)
    base_pref = os.path.basename(cand)
    if parent and os.path.isdir(parent) and len(base_pref) >= 2:
        matches = []
        for name in os.listdir(parent):
            if name.startswith("~$") or name.startswith("."):
                continue
            p = os.path.join(parent, name)
            if os.path.isfile(p) and (name.startswith(base_pref) or base_pref in name):
                matches.append((os.path.getmtime(p), p))
        if matches:
            matches.sort(key=lambda x: x[0], reverse=True)
            print(matches[0][1])
            sys.exit(0)

# 2. Spotlight mdfind fallback by last path segment
for cand in cands:
    frag = os.path.basename(cand)
    if len(frag) < 4:
        continue
    try:
        out = subprocess.check_output(["mdfind", "-name", frag], text=True, timeout=2).splitlines()
        for p in out:
            if os.path.isfile(p) and any(p.startswith(d) for d in dirs):
                print(p)
                sys.exit(0)
        for p in out:
            if os.path.isfile(p):
                print(p)
                sys.exit(0)
    except Exception:
        pass
`;
      const candPayload = candidates.join("\n");
      if (candPayload) {
        const r = await exec("python3", ["-c", pyResolve, candPayload, ...searchDirs]).catch(() => null);
        const found = r?.code === 0 ? r.stdout.trim().split(/\r?\n/)[0] : "";
        if (found) file = found;
      }
    }
  }

  if (!file) {
    // If it looks like a local file/path click (not http/https) that still couldn't be resolved,
    // record it for inspection and pass through.
    const rawPreview = String(link?.url || link?.raw || link?.path || "");
    if (rawPreview && !/^https?:\/\//i.test(rawPreview) && !/^mailto:/i.test(rawPreview)) {
      setShared("cria-file-preview.lastFailedClick", { link, source, candidates, at: Date.now() });
    }
    return "pass";
  }

  const livePanes = panes() ?? [];
  const mode = shared(MODE_KEY) || "split-right";
  const activeSpace = source?.space || focused()?.space || spaces()?.find((s) => s.active)?.id || null;
  const currentTab = source?.tab || focused()?.tab || spaces()?.find((s) => s.active)?.tabs?.find((t) => t.active)?.id || null;
  const dir = dirname(file);

  // Sync the right-hand Files panel to the directory of the clicked file.
  if (dir) {
    setShared(FOCUS_DIR, { dir, file, on, space: activeSpace, tab: currentTab, seq: Date.now() });
  }

  // Always reuse an existing preview pane in the current tab so clicking another image
  // switches in place without opening extra tabs or splits.
  const inTab = currentTab
    ? livePanes.find((p) => p.mod === "cria-file-preview" && p.tab === currentTab)
    : livePanes.find((p) => p.mod === "cria-file-preview");
  if (inTab) {
    setShared(REQUEST, { pane: inTab.pane, tab: inTab.tab, file, on, seq: Date.now() });
    try { run("pane.focus", { pane: inTab.pane }); } catch {}
    return "handled";
  }

  if (mode === "split-right" || mode === "split-down") {
    const basePane = source?.pane || (currentTab ? (livePanes.find((p) => p.tab === currentTab && p.terminal) || livePanes.find((p) => p.tab === currentTab))?.pane : null) || null;
    const [cmd, args] = openCommand({ file, on, mode, pane: basePane, tab: currentTab });
    try { run(cmd, args); } catch {}
    return "handled";
  }

  const alive = new Set(livePanes.map((p) => p.pane));
  const existing = shownIn(shared(OPEN), shared(MOVED), file, on, alive);
  if (existing) {
    try { run("pane.focus", { pane: existing }); } catch {}
    return "handled";
  }

  const [cmd, args] = openCommand({ file, on, mode, tab: currentTab });
  try { run(cmd, args); } catch {}
  return "handled";
}
