// Terminal link handler for cria-file-preview: Cmd-click (Ctrl-click on Linux/Windows)
// on any file path in terminal output opens it in cria-file-preview instead of an external app.
import { exec, focused, home, panes, run, setShared, shared, spaces } from "herdr";
import { OPEN, MOVED, REQUEST, MODE_KEY, FOCUS_DIR, shownIn, openCommand } from "./open-file.js";
import { dirname } from "./paths.js";

function candidatePath(link, source) {
  if (link?.path) return link.path;
  let raw = (link?.url ?? link?.raw ?? "").trim();
  if (!raw) return null;
  if (/^file:\/\//i.test(raw)) {
    raw = raw.replace(/^file:\/\/(localhost)?/i, "");
    try { raw = decodeURIComponent(raw); } catch {}
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return null;
  }
  raw = raw.replace(/#[^#]*$/, "").replace(/:\d+(?::\d+)?$/, "");
  if (!raw) return null;
  if (raw.startsWith("~/") || raw === "~") {
    const h = home?.() || "";
    if (h) raw = `${h.replace(/[\\/]+$/, "")}${raw.slice(1)}`;
  }
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) return raw;
  const cwd = source?.cwd;
  if (!cwd) return null;
  const sep = cwd.includes("\\") ? "\\" : "/";
  return `${cwd.replace(/[\\/]+$/, "")}${sep}${raw.replace(/^\.[\\/]/, "")}`;
}

export async function handleLink(click) {
  const { link, source } = click ?? {};
  const on = source?.machine || null;
  const file = candidatePath(link, source);
  if (!file) return "pass";

  // Only intercept existing regular files; let folders or missing paths fall back to default.
  const check = await exec("test", ["-f", file], on ? { on } : undefined).catch(() => ({ code: 1 }));
  if (check.code !== 0) return "pass";

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
    await run("pane.focus", { pane: inTab.pane }).catch(() => null);
    return "handled";
  }

  if (mode === "split-right" || mode === "split-down") {
    const basePane = source?.pane || (currentTab ? (livePanes.find((p) => p.tab === currentTab && p.terminal) || livePanes.find((p) => p.tab === currentTab))?.pane : null) || null;
    const [cmd, args] = openCommand({ file, on, mode, pane: basePane, tab: currentTab });
    await run(cmd, args);
    return "handled";
  }

  const alive = new Set(livePanes.map((p) => p.pane));
  const existing = shownIn(shared(OPEN), shared(MOVED), file, on, alive);
  if (existing) {
    await run("pane.focus", { pane: existing });
    return "handled";
  }

  const [cmd, args] = openCommand({ file, on, mode, tab: currentTab });
  await run(cmd, args);
  return "handled";
}
