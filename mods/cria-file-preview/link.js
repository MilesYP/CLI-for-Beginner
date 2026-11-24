// Terminal link handler for cria-file-preview: Cmd-click (Ctrl-click on Linux/Windows)
// on any file path in terminal output opens it in cria-file-preview instead of an external app.
import { exec, focused, home, panes, run, setShared, shared, spaces } from "herdr";
import { OPEN, MOVED, REQUEST, MODE_KEY, FOCUS_DIR, shownIn, openCommand } from "./open-file.js";
import { dirname } from "./paths.js";

function cleanToken(str) {
  if (!str) return "";
  let s = String(str).trim();
  try { s = decodeURIComponent(s); } catch {}
  s = s.replace(/#[^#]*$/, "").replace(/:\d+(?::\d+)?$/, "").replace(/[),.;'"`\]>]+$/, "");
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
  if (!candidates.length) return "pass";

  // Find the first candidate that exists as a regular file on disk.
  let file = null;
  for (const cand of candidates) {
    const check = await exec("test", ["-f", cand], on ? { on } : undefined).catch(() => ({ code: 1 }));
    if (check.code === 0) {
      file = cand;
      break;
    }
  }
  if (!file) return "pass";

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
