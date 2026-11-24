// cria-files-extended: Herdr's Files panel (its `files` 0.1.15) with a right-click menu.
// A file opens in cria-file-preview when that mod is installed, in a new tab or a split
// (block prop `open`: "tab", "split-right", "split-down"), else in Herdr's own
// read-only preview inside the panel. Block prop `icon_colors: false` paints every
// row icon in the theme's muted color.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Popup, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, props, run, notify, shared, setShared, appHome, checking } from "herdr";
import * as fs from "fs/promises";
import { openCommand, shownIn, previewId, OPEN, MOVED, REQUEST, MODE_KEY, FOCUS_DIR } from "./open-file.js";
import { openInEditor } from "./editor.js";
import { menuItems } from "./menu.js";
import { nameError, caseOnly, freeName, pasteProblem } from "./names.js";
import { baseName, caseBlind, parentOf, relativeTo } from "./paths.js";
import { recordPreviews } from "./previews.js";
import { iconFor } from "./icons.js";
import { systemOf, commands, labels, toolProbe, toolsFrom, win } from "./platform.js";
import { listCommand, parseListing, byKind, PER_FOLDER, TOTAL, EXPAND_LIMIT, STATUS, gitMarks } from "./listing.js";

const AUTO_KEY = "cria-files-extended.auto";
const AUTO_FILE = "cria-file-preview.autoFile";
const AUTO_PANE = "cria-file-preview.autoPane";
const AUTO_EXTS = {
  image: new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff", "heic"]),
  pdf: new Set(["pdf", "pptx", "ppt"]),
  html: new Set(["html", "htm", "xhtml"]),
  md: new Set(["md", "markdown", "mdx"]),
  av: new Set(["mp3", "m4a", "aac", "wav", "aif", "aiff", "flac", "ogg", "oga", "opus", "caf", "alac", "wma", "mp4", "m4v", "mov", "mkv", "webm", "avi"]),
};
const META_FILES = new Set(["STATUS.md", "AGENTS.md", "CLAUDE.md", "HANDOFF.md", "README.md", "TODO.md"]);

function loadAutoConfig() {
  const def = { enabled: false, types: { image: true, pdf: true, html: true, md: true, av: false }, skipMeta: true };
  try {
    const raw = JSON.parse(localStorage.getItem(AUTO_KEY) || "null");
    if (raw && typeof raw === "object") {
      return { enabled: Boolean(raw.enabled), types: { ...def.types, ...(raw.types || {}) }, skipMeta: raw.skipMeta !== false };
    }
  } catch {}
  return def;
}

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
// exec's longest wait: a big copy or delete takes longer than its default 30 seconds.
const LONG = 600000;
// Renders a new preview gets to show up in panes() before the panel stops waiting for it.
const PREVIEW_RENDERS = 30;
const failed = (what) => (e) => notify({ title: `Couldn't ${what}`, body: String(e?.message ?? e), level: "error" });

async function directory(path, on) {
  const list = async (system) => {
    const [program, args] = listCommand(path, system), r = await exec(program, args, { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    return parseListing(r.stdout, system);
  };
  try { return await list(systemOf(window()?.platform, on)); }
  catch (e) {
    // Another machine with no sh is a Windows one, as Herdr's own panel assumes.
    if (on && String(e).includes("cannot start sh: program not found")) return list("windows");
    throw e;
  }
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.menuFocus = cx.focus_handle();
    this.last = null; this.unfolds = 0; this.pendingPreviews = new Map();
    this.tools = new Set();
    this.baseCwd = null;
    this.overrideDir = null;
    this.activeFile = null;
    this.lastFocusSeq = shared(FOCUS_DIR)?.seq ?? 0;
    this.mode = (() => {
      try {
        const saved = localStorage.getItem(MODE_KEY);
        if (saved === "tab" || saved === "split-right" || saved === "split-down") return saved;
      } catch {}
      return props()?.open || "split-right";
    })();
    if (!checking()) setShared(MODE_KEY, this.mode);
    this.auto = loadAutoConfig();
    this.autoSince = Math.floor(Date.now() / 1000);
    this.lastAutoFile = null;
    this.lastAutoMtime = 0;
    // Optional programs some menu actions need; Windows has its own (platform.js).
    const probe = toolProbe(window()?.platform);
    if (probe) cx.spawn(async cx => {
      const r = await exec(...probe).catch(() => null);
      this.tools = toolsFrom(r?.stdout ?? "");
      cx.notify();
    });
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  syncFocusDir() {
    const fd = shared(FOCUS_DIR);
    if (!fd || !fd.seq || fd.seq === this.lastFocusSeq) return;
    const space = spaces().find((s) => s.active);
    if (fd.space && space && fd.space !== space.id) return;
    this.lastFocusSeq = fd.seq;
    if (fd.file) this.activeFile = fd.file;
    if (fd.dir) {
      this.overrideDir = { cwd: fd.dir, on: fd.on ?? null, space: space?.id ?? fd.space ?? null };
    }
  }

  location() {
    this.syncFocusDir();
    const space = spaces().find(s => s.active), f = focused(), last = this.last;
    const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
    const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
    const baseCwd = (pane?.mod && last?.space === space?.id && this.baseCwd) ? this.baseCwd : (pane?.cwd || f?.cwd || space?.folder);
    this.baseCwd = baseCwd;
    if (this.overrideDir && (!space?.id || !this.overrideDir.space || this.overrideDir.space === space.id) && this.overrideDir.cwd) {
      return (this.last = { cwd: this.overrideDir.cwd, on: this.overrideDir.on ?? on, space: space?.id });
    }
    // A mod's pane (a Cria file preview) has no folder: keep showing the tree it was opened from.
    if (pane?.mod && last?.space === space?.id) return last;
    return (this.last = { cwd: baseCwd, on, space: space?.id });
  }

  resetToBaseDir(cx) {
    this.overrideDir = null;
    this.refresh(cx);
    cx.notify();
  }

  goParentDir(cx) {
    if (!this.root) return;
    const parent = parentOf(this.root.replace(/\/+$/, "")) || "/";
    if (parent === this.root) return;
    const space = spaces().find((s) => s.active);
    this.overrideDir = { cwd: parent, on: this.on, space: space?.id ?? null };
    this.refresh(cx);
    cx.notify();
  }

  key() { return JSON.stringify(this.location()); }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && this.key() === context.key;
  }

  // Entries in the tree, leaving out folder `except`'s.
  entryCount(except) {
    return [...this.entries].reduce((n, [p, e]) => (p === except ? n : n + e.length), 0);
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = this.entryCount(path);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort(byKind));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = this.location(), next = this.key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.top = null; this.menu?.form?.input.release(); this.menu = null; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false; this.again = false; this.expandCapped = false; this.pendingPreviews.clear(); this.unfolds++;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd) return;
    // A change during a refresh may be missed by it: refresh once more after.
    if (this.loading) { this.again = true; return; }
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          if (path && !this.folders.has(path)) continue;
          try { await this.loadFolder(path, context); }
          catch (e) {
            // A folder gone or unreadable stops being unfolded; the tree's own folder failing is an error.
            if (!path) throw e;
            this.forget(path);
          }
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        let marks = {};
        if (top?.code === 0) {
          const status = await exec("git", STATUS, { cwd, on }).catch(() => null);
          if (status?.code === 0) marks = gitMarks(status.stdout, top.stdout.trim(), TOTAL);
        }
        if (!this.current(context)) return;
        this.marks = marks; this.top = top?.code === 0 ? top.stdout.trim() : null; this.error = null; this.watch(cwd, cx);
        if (this.auto.enabled && !on) this.checkAutoPreview(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally {
        if (this.context === context) {
          this.loading = false;
          if (this.again) { this.again = false; this.refresh(cx); }
        }
        cx.notify();
      }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      this.forget(path);
      this.unfolds++;
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // Unfolds a folder and every folder under it, breadth first, up to the tree's entry limit
  // and EXPAND_LIMIT folders. A fold or Collapse all meanwhile stops it.
  expandAll(path, cx) {
    const context = this.context, unfolds = this.unfolds;
    cx.spawn(async cx => {
      const queue = [path];
      let opened = 0;
      while (queue.length && this.current(context) && this.unfolds === unfolds && this.entryCount() < TOTAL) {
        if (opened++ >= EXPAND_LIMIT) { this.expandCapped = true; break; }
        const folder = queue.shift();
        this.folders.add(folder);
        if (!this.entries.has(folder)) {
          try { await this.loadFolder(folder, context); } catch { this.folders.delete(folder); continue; }
        }
        for (const e of this.entries.get(folder) ?? []) if (e.dir) queue.push(`${folder}/${e.name}`);
        cx.notify();
      }
      cx.notify();
    });
  }

  collapseAll(cx) {
    for (const folder of this.folders) this.entries.delete(folder);
    this.folders.clear();
    this.unfolds++;
    this.expandCapped = false;
    cx.notify();
  }

  // Herdr's own preview, used when cria-file-preview isn't installed.
  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // Looked for at each click, not once: the panel can load before the mod is copied in.
  open(path, cx) {
    const context = this.context, file = `${this.root}/${path}`, on = this.on;
    this.activeFile = file;
    const dir = parentOf(file);
    const space = spaces().find((s) => s.active);
    if (dir && dir !== this.root) {
      this.overrideDir = { cwd: dir, on, space: space?.id ?? null };
      if (!checking()) setShared(FOCUS_DIR, { dir, file, on, space: space?.id ?? null, seq: Date.now() });
    }
    cx.spawn(async cx => {
      const installed = await fs.exists(`${appHome().split("\\").join("/")}/mods/cria-file-preview/main.js`).catch(() => false);
      if (!this.current(context) && this.activeFile !== file) return;
      if (installed) this.preview(file, on); else this.show(path, cx);
      cx.notify();
    });
  }

  // A file already open in a preview is shown there; otherwise a new preview opens and,
  // once it appears in panes(), it is recorded for next time.
  preview(file, on, isAuto = false) {
    const livePanes = panes() ?? [];
    const currentTab = focused()?.tab || spaces()?.find((s) => s.active)?.tabs?.find((t) => t.active)?.id || null;
    const mode = this.mode || props()?.open || "split-right";
    const dir = parentOf(file);
    const space = spaces().find((s) => s.active);
    this.activeFile = file;
    if (dir && !checking()) {
      this.overrideDir = { cwd: dir, on, space: space?.id ?? null };
      setShared(FOCUS_DIR, { dir, file, on, space: space?.id ?? null, tab: currentTab, seq: Date.now() });
    }

    const inTab = currentTab
      ? livePanes.find((p) => p.mod === "cria-file-preview" && p.tab === currentTab)
      : livePanes.find((p) => p.mod === "cria-file-preview");
    if (inTab) {
      setShared(REQUEST, { pane: inTab.pane, tab: inTab.tab, file, on, auto: isAuto, seq: Date.now() });
      if (!isAuto) {
        try { run("pane.focus", { pane: inTab.pane }); } catch {}
      }
      return;
    }

    if (mode === "split-right" || mode === "split-down") {
      const basePane = (currentTab
        ? (livePanes.find((p) => p.tab === currentTab && p.terminal) || livePanes.find((p) => p.tab === currentTab))
        : null)?.pane || null;
      const [command, args] = openCommand({ file, on, mode, pane: basePane, tab: currentTab, auto: isAuto });
      try { run(command, args); } catch (e) { failed("open the file")(e); }
      return;
    }

    const previews = new Set(livePanes.filter((p) => p.mod === "cria-file-preview").map((p) => p.pane));
    const pane = shownIn(shared(OPEN), shared(MOVED), file, on, previews);
    const id = previewId(file, on), [command, args] = pane ? ["pane.focus", { pane }] : openCommand({ file, on, mode, tab: currentTab, auto: isAuto });
    if (!pane) this.pendingPreviews.set(id, { before: previews, renders: 0 });
    try { run(command, args); } catch (e) { this.pendingPreviews.delete(id); failed("open the file")(e); }
  }

  toggleMode(cx) {
    this.mode = this.mode === "tab" ? "split-right" : "tab";
    try { localStorage.setItem(MODE_KEY, this.mode); } catch {}
    if (!checking()) setShared(MODE_KEY, this.mode);
    cx.notify();
  }

  recordNewPreviews() {
    for (const [id, p] of this.pendingPreviews) if (++p.renders > PREVIEW_RENDERS) this.pendingPreviews.delete(id);
    const previews = panes().filter((p) => p.mod === "cria-file-preview").map((p) => p.pane);
    const made = recordPreviews([...this.pendingPreviews].map(([id, p]) => [id, p.before]), previews, shared(OPEN), shared(MOVED));
    if (!made) return;
    for (const id of made.done) this.pendingPreviews.delete(id);
    setShared(OPEN, made.open);
    setShared(MOVED, made.moved);
  }

  // A right press on a row names the target; the panel's own handler, after it, opens
  // the menu where the press was. A press beside the rows opens nothing.
  openMenu(e, cx) {
    if (this.file || !this.pressed) return;
    this.closeMenu(cx);
    this.menu = { target: this.pressed, x: e.local_position?.x ?? 0, y: e.local_position?.y ?? 0, at: -1 };
    this.pressed = null;
    this.focusMenu(cx);
    cx.notify();
  }

  // The menu's keys reach the panel's root, which tracks menuFocus. The click that opened
  // the menu can move the keyboard back after this handler, so the focus is asked again.
  focusMenu(cx) {
    this.menuFocus.focus();
    cx.timer.after(100, () => { if (this.menu && !this.menu.form) this.menuFocus.focus(); });
  }

  stepActiveFile(delta) {
    const list = (this.entries.get("") ?? []).filter((e) => !e.dir).map((e) => `${this.root}/${e.name}`);
    if (list.length < 2) return false;
    const idx = this.activeFile ? list.indexOf(this.activeFile) : -1;
    const nextIdx = idx < 0 ? 0 : (idx + delta + list.length) % list.length;
    this.preview(list[nextIdx], this.on);
    return true;
  }

  closePreviewAndPanel() {
    const f = focused();
    const activeSpace = spaces()?.find((s) => s.active);
    const currentTab = f?.tab || activeSpace?.tabs?.find((t) => t.active)?.id || null;
    const live = panes() ?? [];
    const previewPanes = live.filter((p) => p.mod === "cria-file-preview" && (!currentTab || p.tab === currentTab));
    const termPane = live.find((p) => p.terminal && (!currentTab || p.tab === currentTab))?.pane;
    try { run("layout.hide", { id: "panel" }); } catch {}
    for (const pp of previewPanes) {
      try { run("pane.close", { pane: pp.pane }); } catch {}
    }
    if (termPane) {
      try { run("pane.focus", { pane: termPane }); } catch {}
    }
  }

  menuKey(e, cx) {
    const menu = this.menu;
    if (!menu) {
      const k = (e.key || e.keystroke || "").toLowerCase();
      if (k === "escape" || k === "esc") {
        cx.stop_propagation();
        this.closePreviewAndPanel();
        return;
      }
      if (k === "left" || k === "arrowleft" || k === "up" || k === "arrowup" || k === "[") {
        if (this.stepActiveFile(-1)) { cx.stop_propagation(); cx.notify(); }
      } else if (k === "right" || k === "arrowright" || k === "down" || k === "arrowdown" || k === "]") {
        if (this.stepActiveFile(1)) { cx.stop_propagation(); cx.notify(); }
      }
      return;
    }
    if (menu.form) return;
    if (menu.confirm) {
      // A held Enter, left from the menu's own Enter on Delete…, confirms nothing.
      if (e.key === "enter" && !e.is_held) this.deleteNow(cx);
      else if (e.key === "escape") this.closeMenu(cx);
      return;
    }
    const rows = this.menuRows().filter((it) => it !== "-" && it.enabled), at = menu.at;
    if (e.key === "down") menu.at = (at + 1) % rows.length;
    else if (e.key === "up") menu.at = at < 0 ? rows.length - 1 : (at + rows.length - 1) % rows.length;
    else if (e.key === "enter" && !e.is_held && at >= 0) return this.act(rows[at].id, cx);
    else if (e.key === "escape") return this.closeMenu(cx);
    else return;
    cx.notify();
  }

  closeMenu(cx) {
    this.menu?.form?.input.release();
    this.menu = null;
    cx.notify();
  }

  abs(path) { return path ? `${this.root}/${path}` : this.root; }

  // Where a new or pasted item goes: into the target folder, or beside the target file.
  folderOf({ path, dir }) { return dir ? path : parentOf(path); }

  act(id, cx) {
    const { path, dir } = this.menu.target, on = this.on, file = this.abs(path);
    if (id === "delete") { this.menu.confirm = true; this.focusMenu(cx); return cx.notify(); }
    if (id === "new-file" || id === "new-folder" || id === "rename") return this.ask(id, cx);
    this.closeMenu(cx);
    const system = this.system(), cmd = this.commands(file), names = labels(system);
    const desktop = (command, what) => this.exec(command).catch(failed(what));
    const copy = (text, what) => { cx.write_to_clipboard(text); notify({ title: `${what} copied to the clipboard`, body: text, level: "success", timeout: 2500 }); };
    switch (id) {
      case "editor": return openInEditor(file, on).catch(failed("open the editor"));
      case "default": return desktop(cmd.open(file), "open the file");
      case "reveal": return desktop(cmd.reveal(file), names.reveal.toLowerCase());
      case "terminal":
        try { return run("terminal.open", { folder: dir ? file : parentOf(file) || "/", place: "tab" }); }
        catch (e) { return failed("open a terminal")(e); }
      case "cut": case "copy": this.clipboard = { file, dir, on, cut: id === "cut" }; return;
      case "paste": return this.paste(this.folderOf({ path, dir }), this.clipboard, cx);
      case "duplicate": return this.paste(this.folderOf({ path, dir: false }), { file, dir, on, cut: false }, cx);
      case "name": return copy(baseName(file), "Name");
      case "path": return copy(system === "windows" ? win(file) : file, "Path");
      case "relative": return copy(relativeTo(file, this.top, this.root, system), "Relative path");
      case "expand": return this.expandAll(path, cx);
      case "fold": return this.toggle(path, cx);
      case "fold-parent": return this.toggle(parentOf(path), cx);
      case "collapse": return this.collapseAll(cx);
      case "trash": return this.removeWith(cmd.trash, path, names.trash, cx);
    }
  }

  // Delete's confirmation, accepted.
  deleteNow(cx) {
    const { path } = this.menu.target;
    this.closeMenu(cx);
    this.removeWith(this.commands().remove, path, "Deleted", cx, "delete it");
  }

  // Trash or Delete `path`, with a toast titled `title`.
  removeWith(command, path, title, cx, what = title.toLowerCase()) {
    const file = this.abs(path);
    this.change(what, cx, async () => {
      await this.exec(command(file));
      this.forget(path);
      notify({ title: `${title}: ${baseName(file)}`, level: "success", timeout: 2500 });
    });
  }

  system() { return systemOf(window()?.platform, this.on); }
  commands(file) { return commands(this.system(), this.tools, file); }

  async exec([program, args]) {
    const r = await exec(program, args, { on: this.on, timeout: LONG });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `${program} exited with ${r.code}`);
  }

  // Folders gone from disk (or moved away) stop being unfolded.
  forget(path) {
    for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) { this.folders.delete(folder); this.entries.delete(folder); }
  }

  // A change on disk; then the folder it returns is shown unfolded and the tree reloads.
  change(what, cx, work) {
    const context = this.context;
    cx.spawn(async cx => {
      try {
        const folder = await work();
        if (this.context !== context) return;
        if (folder && !this.folders.has(folder)) this.toggle(folder, cx);
        this.refresh(cx);
      } catch (e) { failed(what)(e); }
      finally { cx.notify(); }
    });
  }

  // Copies (or, after Cut, moves) `item` into `folder`; a name already there gets " copy".
  paste(folder, item, cx) {
    if (!item || item.on !== this.on) return;
    const dest = this.abs(folder), name = baseName(item.file), system = this.system();
    const problem = pasteProblem(item, dest, system);
    if (problem === "inside") return failed("paste")(new Error("A folder can't go inside itself"));
    if (problem === "here") return;
    this.change(item.cut ? "move it" : "paste it", cx, async () => {
      const taken = new Set((await directory(dest, this.on)).map((e) => e.name));
      await this.exec(this.commands()[item.cut ? "move" : "copy"](item.file, `${dest}/${freeName(name, taken, item.dir, caseBlind(system))}`));
      if (item.cut && this.clipboard === item) this.clipboard = null;
      if (item.cut && item.file.startsWith(this.root + "/")) this.forget(item.file.slice(this.root.length + 1));
      return folder;
    });
  }

  // New file, New folder and Rename ask for a name in place of the menu.
  ask(kind, cx) {
    const name = baseName(this.menu.target.path);
    const input = InputState.new({ placeholder: kind === "new-folder" ? "Folder name" : "File name", value: kind === "rename" ? name : "" });
    input.on("submit", (_e, cx) => this.submit(cx));
    this.menu.form = { kind, input, error: null };
    input.focus();
    cx.notify();
  }

  submit(cx) {
    const form = this.menu?.form;
    if (!form) return;
    const { path } = this.menu.target, name = form.input.value().trim(), rename = form.kind === "rename";
    const folder = rename ? parentOf(path) : this.folderOf(this.menu.target), oldName = rename ? baseName(path) : null;
    const old = this.abs(path), target = `${this.abs(folder)}/${name}`;
    const taken = new Set((this.entries.get(folder) ?? []).map((e) => e.name));
    form.error = nameError(name, { old: oldName, taken, system: this.system() });
    if (form.error) return cx.notify();
    this.closeMenu(cx);
    if (rename) {
      if (name === oldName) return;
      return this.change("rename it", cx, async () => {
        await this.exec(this.commands().rename(old, target, caseOnly(oldName, name)));
        this.forget(path);
      });
    }
    this.change(form.kind === "new-file" ? "create the file" : "create the folder", cx, async () => {
      await this.exec(this.commands()[form.kind === "new-file" ? "newFile" : "newFolder"](target));
      return folder;
    });
  }

  surface(id, width, t) {
    return v_flex().id(id).w(width).rounded(10).bg(t.popover).border_1().border_color(t.border).shadow_lg().text_size(12.8)
      .on_mouse_down_out((_e, cx) => this.closeMenu(cx));
  }

  button(id, label, bg, fg, run) {
    return h_flex().id(id).h(28).px(12).items_center().rounded(7).bg(bg).text_color(fg).cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => run(cx)).child(label);
  }

  // Delete asks first, in place of the menu: Enter deletes, Esc cancels.
  confirmView(t) {
    const { path, dir } = this.menu.target;
    return this.surface("files-confirm", 260, t).p(14).gap(10)
      .child(div().font_semibold().truncate().child(`Delete ${baseName(path)}?`))
      .child(div().text_color(t.muted).child(dir ? "The folder and everything in it are deleted for good, not moved to the Trash." : "The file is deleted for good, not moved to the Trash."))
      .child(h_flex().justify_end().gap(8)
        .child(this.button("files-confirm-no", "Cancel", t.raised, t.foreground, (cx) => this.closeMenu(cx)))
        .child(this.button("files-confirm-yes", "Delete", t.ansi1, t.background, (cx) => this.deleteNow(cx))));
  }

  formView(t) {
    const { kind, input, error } = this.menu.form, { path } = this.menu.target, rename = kind === "rename";
    const folder = this.folderOf(this.menu.target);
    return this.surface("files-form", 260, t).p(12).gap(8)
      .on_key_down((e, cx) => { if (e.key === "escape") this.closeMenu(cx); })
      .child(div().font_semibold().truncate().child(rename ? `Rename ${baseName(path)}` : kind === "new-file" ? "New file" : "New folder"))
      .when(!rename, (el) => el.child(div().text_size(11.5).text_color(t.dim).truncate().child(`in ${folder || baseName(this.root)}/`)))
      .child(Input.new(input).text_size(12.8))
      .when(Boolean(error), (el) => el.child(div().text_size(11.5).text_color(t.ansi1).child(error)))
      .child(h_flex().justify_end().gap(8)
        .child(this.button("files-form-no", "Cancel", t.raised, t.foreground, (cx) => this.closeMenu(cx)))
        .child(this.button("files-form-yes", rename ? "Rename" : "Create", t.solid, t.solid_foreground, (cx) => this.submit(cx))));
  }

  menuRows() {
    return menuItems(this.menu.target, { can: this.commands(this.abs(this.menu.target.path)), labels: labels(this.system()), open: (p) => this.folders.has(p), anyOpen: this.folders.size > 0, canPaste: this.clipboard?.on === this.on });
  }

  menuView(t) {
    if (this.menu.confirm) return this.confirmView(t);
    if (this.menu.form) return this.formView(t);
    const list = this.menuRows(), rows = list.filter((it) => it !== "-" && it.enabled);
    return this.surface("files-menu", 220, t).p(5)
      .children(list.map((it) => it === "-"
        ? div().mx(7).my(4).h(1).bg(t.border)
        : h_flex().id(`files-menu-${it.id}`).h(31).px(8).rounded(7).items_center().text_color(it.enabled ? t.foreground : t.dim)
          .when(it.enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.act(it.id, cx)))
          .when(it.enabled && rows[this.menu.at] === it, (el) => el.bg(t.selected))
          .child(it.label)));
  }

  saveAuto() {
    try { localStorage.setItem(AUTO_KEY, JSON.stringify(this.auto)); } catch {}
  }

  toggleAuto(cx) {
    this.auto.enabled = !this.auto.enabled;
    if (this.auto.enabled) {
      this.autoSince = Math.floor(Date.now() / 1000) - 2;
      this.lastAutoFile = null;
      this.lastAutoMtime = 0;
    }
    this.saveAuto();
    cx.notify();
  }

  toggleAutoType(key, cx) {
    if (key === "skipMeta") this.auto.skipMeta = !this.auto.skipMeta;
    else this.auto.types[key] = !this.auto.types[key];
    this.saveAuto();
    cx.notify();
  }

  autoMatch(path) {
    const name = baseName(path);
    if (this.auto.skipMeta && META_FILES.has(name)) return false;
    const dot = name.lastIndexOf(".");
    if (dot <= 0) return false;
    const ext = name.slice(dot + 1).toLowerCase();
    for (const [k, set] of Object.entries(AUTO_EXTS)) {
      if (this.auto.types[k] && set.has(ext)) return true;
    }
    return false;
  }

  checkAutoPreview(root, cx) {
    const script = 'find "$1" -maxdepth 4 -type f -not -path "*/.git/*" -not -path "*/node_modules/*" -not -path "*/backups/*" -not -path "*/.cache/*" -print0 2>/dev/null | xargs -0 stat -f "%m\t%N" 2>/dev/null | sort -rn | head -n 30';
    cx.spawn(async () => {
      const r = await exec("sh", ["-c", script, "auto", root]).catch(() => null);
      if (!r || r.code !== 0 || !this.auto.enabled) return;
      for (const line of r.stdout.split(/\r?\n/)) {
        const tab = line.indexOf("\t");
        if (tab < 0) continue;
        const mtime = Number(line.slice(0, tab)), path = line.slice(tab + 1);
        if (!mtime || mtime < this.autoSince) break;
        if (!this.autoMatch(path)) continue;
        if (path === this.lastAutoFile && mtime <= this.lastAutoMtime) return;
        this.lastAutoFile = path;
        this.lastAutoMtime = mtime;
        setShared(AUTO_FILE, path);
        const mode = this.mode || props()?.open || "split-right";
        if (mode === "split-right" || mode === "split-down") {
          this.preview(path, null, true);
          return;
        }
        const livePanes = panes() ?? [];
        const autoPaneId = shared(AUTO_PANE);
        const hasAuto = livePanes.some((p) => (autoPaneId && p.pane === autoPaneId) || (p.mod === "cria-file-preview" && p.props?.auto));
        if (!hasAuto) {
          await run("tab.new", { name: "Auto Preview", mod: "cria-file-preview", props: { file: path, on: null, auto: true } });
        }
        return;
      }
    });
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      const fullPath = `${this.root}/${path}`;
      const isActive = Boolean(!entry.dir && this.activeFile && this.activeFile === fullPath);
      const target = this.menu?.target.path === path, icon = iconFor(entry.name, entry.dir, open);
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .when(target, el => el.bg(t.hover))
        .when(isActive, el => el.bg(t.selected).text_color(t.accent).font_semibold())
        .on_click((_e, cx) => {
          this.menuFocus.focus();
          if (entry.dir) this.toggle(path, cx); else this.open(path, cx);
        })
        .on_mouse_down("right", () => { this.pressed = { path, dir: entry.dir }; })
        .child(entry.dir ? svg(`mods/cria-files-extended/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/cria-files-extended/icons/${icon.icon}.svg`).size(14).flex_none().text_color(props()?.icon_colors === false ? t.muted : t[icon.color] ?? t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  render(cx) {
    if (this.key() !== this.context?.key) this.refresh(cx);
    if (this.pendingPreviews.size) this.recordNewPreviews();
    const t = theme(), menu = this.menu;
    return v_flex().id("files").relative().size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .track_focus(this.menuFocus).on_key_down((e, cx) => this.menuKey(e, cx))
      .on_mouse_down("right", (e, cx) => this.openMenu(e, cx))
      .child(h_flex().w_full().h(42).flex_none().flex_shrink_0().px(14).gap(6).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).flex_none().cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().flex_none().font_semibold().child("Files"))
        .when(Boolean(!this.file && this.root && this.baseCwd && this.root !== this.baseCwd), el => el
          .child(div().id("files-up-dir").flex_none().px(6).py(2).rounded(5).cursor_pointer().text_size(11)
            .bg(t.raised).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
            .tooltip("回上一層目錄")
            .on_click((_e, cx) => this.goParentDir(cx)).child("↑"))
          .child(div().id("files-home-dir").flex_none().px(6).py(2).rounded(5).cursor_pointer().text_size(11)
            .bg(t.raised).text_color(t.accent).hover(s => s.bg(t.hover).text_color(t.foreground))
            .tooltip(`返回專案根目錄 (${baseName(this.baseCwd)})`)
            .on_click((_e, cx) => this.resetToBaseDir(cx)).child("⌂")))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim)
          .tooltip(this.root || "")
          .child(this.file ?? (this.root ? baseName(this.root) : "")))
        .child(
          div().id("files-mode-toggle").flex_none().flex_shrink_0().px(8).py(3).rounded(5).cursor_pointer().text_size(11).font_semibold()
            .bg(this.mode !== "tab" ? t.selected : t.raised)
            .text_color(this.mode !== "tab" ? t.foreground : t.muted)
            .hover(s => s.opacity(0.88))
            .tooltip(this.mode !== "tab" ? "目前：並排預覽（不蓋住對話框，共用同一預覽框）。點擊改為開新分頁" : "目前：開新分頁預覽。點擊改為並排預覽")
            .on_click((_e, cx) => this.toggleMode(cx))
            .child(this.mode !== "tab" ? "並排" : "分頁"))
        .when(!this.on, el => el.child(
          div().id("files-auto-toggle").flex_none().flex_shrink_0().px(8).py(3).rounded(5).cursor_pointer().text_size(11).font_semibold()
            .bg(this.auto.enabled ? t.accent : t.raised)
            .text_color(this.auto.enabled ? t.background : t.muted)
            .hover(s => s.opacity(0.88))
            .tooltip(this.auto.enabled ? "關閉自動預覽" : "開啟自動預覽：資料夾有新產出檔時自動更新預覽分頁")
            .on_click((_e, cx) => this.toggleAuto(cx))
            .child("Auto"))))
      .when(this.auto.enabled && !this.on && !this.file, el => {
        const chip = (k, label) => {
          const on = k === "skipMeta" ? this.auto.skipMeta : Boolean(this.auto.types[k]);
          return div().id(`files-auto-${k}`).flex_none().px(7).py(2).rounded(5).cursor_pointer().text_size(11)
            .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.dim)
            .hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.toggleAutoType(k, cx))
            .child(`${on ? "✓ " : ""}${label}`);
        };
        return el.child(v_flex().id("files-auto-filters").w_full().flex_none().flex_shrink_0().px(10).py(6).gap(5).border_b(1).border_color(t.border).bg(t.surface)
          .child(h_flex().w_full().gap(5).items_center()
            .child(chip("image", "圖片"))
            .child(chip("pdf", "PDF/PPT"))
            .child(chip("html", "HTML"))
            .child(chip("md", "MD"))
            .child(chip("av", "影音")))
          .child(h_flex().w_full().gap(5).items_center().justify_between()
            .child(chip("skipMeta", "略過系統MD"))
            .child(div().id("files-auto-off").flex_none().px(7).py(2).rounded(5).cursor_pointer().text_size(11)
              .bg(t.chrome).text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => this.toggleAuto(cx))
              .child("關閉 Auto"))));
      })
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))
        .when(this.expandCapped, el => el.child(div().p(8).text_size(11).text_color(t.dim).child(`Expand all stopped at ${EXPAND_LIMIT} folders`)))))
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")))
      .when(Boolean(menu), el => el.child(Popup.new("files-menu-anchor", div().size(0)).absolute().left(menu.x).top(menu.y).anchor("top_left").content(this.menuView(t))));
  }
}
