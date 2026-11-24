// The preview part: one file, shown by the viewer for its kind (viewers/), opened
// by files-extended in a tab or a split. props: { file: absolute path, on: machine or null }.
// A local file reloads when it changes on disk, keeping the viewer's Raw or zoom.
// The header: Back (after following a link), the name and folder (a click copies
// the name or the full path) and its size, the viewer's own controls, and the ⋯ menu.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, theme, notify, watchFolder, shared, setShared, exec, window, panes, focused, spaces, checking, run, nextCommand } from "herdr";
import { viewerFor, basename, extension } from "./kinds.js";
import { dirname, native, localPath, samePath, changedFile } from "./paths.js";
import { VIEWERS } from "./viewers/index.js";
import { openMenu } from "./menu.js";
import { iconButton } from "./viewers/controls.js";
import { previewId, MOVED, REQUEST, FOCUS_DIR } from "./open-file.js";
import { formatSize } from "./size.js";
import { programs } from "./programs.js";
import { systemOf } from "./platform.js";

const AUTO_FILE = "cria-file-preview.autoFile";
const AUTO_PANE = "cria-file-preview.autoPane";
const SIBLING_SCOPE = "cria-file-preview.siblingScope";
const PREVIEW_HEAD_SHARED = "cria-file-preview.head";
const MEDIA_VIEWERS = new Set(["image", "pdf", "pptx", "markdown", "html", "audio", "video"]);

export class Preview {
  init(_props, cx) {
    const p = props() ?? {};
    const { file, on = null, auto = false } = p;
    this.on = on;
    this.auto = Boolean(auto);
    this.system = systemOf(window()?.platform, on);
    this.history = [];
    this.siblings = [];
    this.siblingScope = (() => { try { return localStorage.getItem(SIBLING_SCOPE) || "all"; } catch { return "all"; } })();
    this.size = { width: 900, height: 700 };
    this.focusHandle = cx.focus_handle();
    this.focusHandle.focus();
    if (!checking()) {
      cx.timer.after(60, () => this.focusHandle.focus());
      cx.spawn(async (cx) => {
        for (;;) {
          const cmd = await nextCommand();
          if (cmd === "focus") {
            this.focusHandle.focus();
            cx.notify();
          }
        }
      });
    }
    this.tabId = p.tab || focused()?.tab || spaces()?.find((s) => s.active)?.tabs?.find((t) => t.active)?.id || null;
    this.paneId = null;
    this.wasPaneFocused = false;
    this.lastReqSeq = shared(REQUEST)?.seq ?? 0;
    if (this.auto) {
      const me = (panes() ?? []).find((x) => x.mod === "cria-file-preview" && (!this.tabId || x.tab === this.tabId));
      if (me) {
        this.paneId = me.pane;
        setShared(AUTO_PANE, me.pane);
      }
      cx.timer.every(500, (cx) => {
        const next = shared(AUTO_FILE);
        if (next && next !== this.file) {
          this.anchor = null;
          this.show(localPath(next, this.system), cx);
        }
      });
    }
    this.show(file && localPath(file, this.system), cx);
  }

  syncPaneAndRequest(cx) {
    const live = panes() ?? [];
    if (!this.paneId) {
      const initFile = props()?.file;
      const candidates = live.filter((p) => p.mod === "cria-file-preview" && (!this.tabId || p.tab === this.tabId));
      const matched = (initFile && candidates.find((p) => p.props?.file === initFile)) || (candidates.length === 1 ? candidates[0] : candidates[candidates.length - 1]);
      if (matched) {
        this.paneId = matched.pane;
        this.tabId = matched.tab;
        if (!checking()) {
          const paneId = this.paneId;
          cx.timer.after(1, () => {
            if (this.auto) setShared(AUTO_PANE, paneId);
            this.publishHead();
          });
        }
      }
    }
    const myPane = this.paneId ? live.find((p) => p.pane === this.paneId) : live.find((p) => p.mod === "cria-file-preview" && (!this.tabId || p.tab === this.tabId));
    const isFocused = Boolean(myPane?.focused);
    if (isFocused && !this.wasPaneFocused && !checking()) {
      cx.timer.after(1, () => this.focusHandle.focus());
    }
    this.wasPaneFocused = isFocused;

    const req = shared(REQUEST);
    if (!req || !req.seq || req.seq === this.lastReqSeq) return;
    const matchPane = req.pane && this.paneId && req.pane === this.paneId;
    const matchTab = (!req.pane || !this.paneId) && req.tab && this.tabId && req.tab === this.tabId;
    const matchFallback = !this.paneId && !this.tabId;
    if (!matchPane && !matchTab && !matchFallback) return;
    this.lastReqSeq = req.seq;
    this.on = req.on ?? null;
    if (req.auto !== undefined) this.auto = Boolean(req.auto);
    const nextFile = req.file ? localPath(req.file, this.system) : null;
    cx.timer.after(1, (cx) => {
      this.focusHandle.focus();
      if (nextFile && !samePath(nextFile, this.file)) {
        if (this.file) this.history.push(this.file);
        this.anchor = null;
        this.show(nextFile, cx);
        this.moved();
      }
    });
  }

  focusPane() {
    this.focusHandle.focus();
    if (this.paneId && !this.wasPaneFocused) {
      try { run("pane.focus", { pane: this.paneId }); } catch {}
    }
  }

  env() {
    return {
      file: this.file,
      on: this.on,
      anchor: this.anchor,
      size: this.size,
      focus: () => this.focusPane(),
      stepSibling: (delta, cx) => this.stepSibling(delta, cx),
      navigate: (file, cx, anchor) => this.navigate(file, cx, anchor),
    };
  }

  publishHead() {
    if (checking()) return;
    const prev = shared(PREVIEW_HEAD_SHARED) ?? {};
    const entry = {
      pane: this.paneId,
      file: this.file,
      name: this.file ? basename(this.file) : "",
      dir: this.file ? native(dirname(this.file), this.system) : "",
      fullPath: this.file ? native(this.file, this.system) : "",
      bytes: this.bytes,
      sizeText: this.bytes != null ? formatSize(this.bytes) : "",
      auto: this.auto,
    };
    const next = { ...prev, latest: entry };
    if (this.paneId) next[this.paneId] = entry;
    setShared(PREVIEW_HEAD_SHARED, next);
  }

  // reload: the same file changed on disk; the old view stays until the new one is ready.
  show(file, cx, reload = false) {
    const previous = reload ? this.state : null;
    if (!reload) this.release();
    this.file = file; this.error = null;
    if (!reload) this.bytes = null;
    this.publishHead();
    if (!file) { this.error = "No file to show"; return; }
    if (!reload) {
      this.watch(cx);
      this.loadSiblings(file, cx);
      const dir = dirname(file);
      if (dir && !checking()) {
        const activeSpace = spaces()?.find((s) => s.active)?.id || null;
        setShared(FOCUS_DIR, { dir, file, on: this.on, space: activeSpace, tab: this.tabId, seq: Date.now() });
      }
    }
    const viewer = this.viewer = VIEWERS[viewerFor(file)];
    const env = this.env(), loading = this.loading = {};
    cx.spawn(async (cx) => {
      const r = await exec(...programs(this.system).bytes(file), { on: this.on }).catch(() => null);
      if (this.loading === loading) {
        this.bytes = r?.code === 0 ? Number(r.stdout.trim()) : null;
        this.publishHead();
        cx.notify();
      }
    });
    cx.spawn(async (cx) => {
      try {
        const state = await viewer.load(file, env, previous);
        if (this.loading !== loading) { viewer.release?.(state); return; }
        this.release();
        this.state = state;
        viewer.start?.(state, env, cx);
      } catch (e) { if (this.loading === loading) { this.release(); this.error = String(e?.message ?? e); } }
      finally { cx.notify(); }
    });
  }

  loadSiblings(file, cx) {
    const dir = dirname(file);
    if (!dir) { this.siblings = []; return; }
    const token = this.siblingsToken = {};
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'for p in "$1"/*; do [ -f "$p" ] && printf "%s\\n" "${p##*/}"; done | LC_ALL=C sort', "siblings", dir], this.on ? { on: this.on } : undefined).catch(() => null);
      if (this.siblingsToken !== token) return;
      const sep = dir.includes("\\") ? "\\" : "/";
      const base = dir.replace(/[\\/]+$/, "");
      this.siblings = (r?.code === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [])
        .map((name) => `${base}${sep}${name}`);
      cx.notify();
    });
  }

  siblingList() {
    if (this.siblingScope !== "media") return this.siblings;
    const filtered = this.siblings.filter((f) => MEDIA_VIEWERS.has(viewerFor(f)));
    if (this.file && !filtered.some((f) => samePath(f, this.file))) filtered.push(this.file);
    return filtered;
  }

  stepSibling(delta, cx) {
    this.focusPane();
    const list = this.siblingList();
    if (list.length < 2) return;
    const idx = list.findIndex((f) => samePath(f, this.file));
    const nextIdx = idx < 0 ? 0 : (idx + delta + list.length) % list.length;
    this.anchor = null;
    this.show(list[nextIdx], cx);
    this.moved();
    cx.notify();
  }

  toggleSiblingScope(cx) {
    this.focusPane();
    this.siblingScope = this.siblingScope === "all" ? "media" : "all";
    try { localStorage.setItem(SIBLING_SCOPE, this.siblingScope); } catch {}
    cx.notify();
  }

  closePreviewAndPanel() {
    const live = panes() ?? [];
    const targetPane = this.paneId || live.find((p) => p.mod === "cria-file-preview" && (!this.tabId || p.tab === this.tabId))?.pane;
    const termPane = live.find((p) => p.terminal && (!this.tabId || p.tab === this.tabId))?.pane;
    try { run("layout.hide", { id: "panel" }); } catch {}
    if (targetPane) {
      try { run("pane.close", { pane: targetPane }); } catch {}
    }
    if (termPane) {
      try { run("pane.focus", { pane: termPane }); } catch {}
    }
  }

  onKey(e, cx) {
    const k = (e.key || e.keystroke || "").toLowerCase();
    if (k === "escape" || k === "esc") {
      cx.stop_propagation();
      this.closePreviewAndPanel();
      return;
    }
    if (k === "left" || k === "arrowleft" || k === "up" || k === "arrowup" || k === "[") {
      this.stepSibling(-1, cx);
      cx.stop_propagation();
    } else if (k === "right" || k === "arrowright" || k === "down" || k === "arrowdown" || k === "]") {
      this.stepSibling(1, cx);
      cx.stop_propagation();
    } else if (k === "backspace" && this.history.length > 0) {
      this.back(cx);
      cx.stop_propagation();
    }
  }

  watch(cx) {
    if (this.on) return;
    const file = this.file, token = this.watching = {};
    cx.spawn(async (cx) => {
      try {
        while (this.watching === token) {
          const changed = await watchFolder(dirname(file));
          if (this.watching === token && changedFile(changed, file)) this.show(file, cx, true);
        }
      } catch {}
    });
  }

  navigate(file, cx, anchor) {
    this.history.push(this.file);
    this.anchor = anchor;
    this.show(file, cx);
    this.moved();
    cx.notify();
  }

  back(cx) {
    const file = this.history.pop();
    if (file) { this.anchor = null; this.show(file, cx); this.moved(); cx.notify(); }
  }

  // Tells files-extended what this preview shows now, so it isn't reused for the file it opened with.
  moved() {
    const opened = props()?.file, id = previewId(opened, this.on);
    setShared(MOVED, { ...(shared(MOVED) ?? {}), [id]: samePath(this.file, opened) ? opened : this.file });
  }

  release() {
    if (this.state) this.viewer?.release?.(this.state);
    this.state = null;
  }

  close() { this.watching = null; this.release(); }

  // The name or the folder, which a click copies: the name, or the file's full path.
  copier(id, label, what, t) {
    const text = what === "name" ? basename(this.file ?? "") : native(this.file ?? "", this.system);
    return div().id(id).min_w(0).truncate().cursor_pointer().hover((s) => s.text_color(t.accent))
      .tooltip(what === "name" ? "Copy the file name" : "Copy the full path")
      .on_click((_e, cx) => {
        cx.write_to_clipboard(text);
        notify({ title: what === "name" ? "File name copied to the clipboard" : "Path copied to the clipboard", body: text, level: "success", timeout: 2500 });
      }).child(label);
  }

  render(cx) {
    this.syncPaneAndRequest(cx);
    const t = theme(), env = this.env(), viewer = this.viewer, state = this.state;
    const control = (id, label, tip, action) => div().id(id).h(26).px(9).flex().items_center().rounded(6).cursor_pointer().text_size(12)
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(action).child(label);
    const siblings = this.siblingList();
    const sibIdx = siblings.findIndex((f) => samePath(f, this.file));
    const sibNav = h_flex().gap(2).items_center().px(4).py(2).rounded(6).bg(t.chrome)
      .child(div().id("cria-file-preview-scope").h(22).px(7).flex().items_center().rounded(5).cursor_pointer()
        .text_size(11).bg(t.raised).text_color(this.siblingScope === "media" ? t.accent : t.muted)
        .hover((s) => s.text_color(t.foreground))
        .tooltip(this.siblingScope === "media" ? "切換：只切媒體／文件 ↔ 全部檔案（目前：媒體／文件）" : "切換：全部檔案 ↔ 只切媒體／文件（目前：全部檔案）")
        .on_click((_e, cx) => this.toggleSiblingScope(cx))
        .child(this.siblingScope === "media" ? "Media" : "All"))
      .when(siblings.length > 1, (el) => el
        .child(div().id("cria-file-preview-prev").h(22).px(6).flex().items_center().rounded(5).cursor_pointer()
          .text_size(13).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("上一個檔案 (← 或 [)").on_click((_e, cx) => this.stepSibling(-1, cx)).child("‹"))
        .child(div().px(4).text_size(11).text_color(t.dim).child(`${sibIdx >= 0 ? sibIdx + 1 : 1}/${siblings.length}`))
        .child(div().id("cria-file-preview-next").h(22).px(6).flex().items_center().rounded(5).cursor_pointer()
          .text_size(13).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("下一個檔案 (→ 或 ])").on_click((_e, cx) => this.stepSibling(1, cx)).child("›")));
    return v_flex().id("cria-file-preview").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.focusHandle).on_key_down((e, cx) => this.onKey(e, cx))
      .on_mouse_down("left", () => this.focusPane())
      .child(h_flex().h(38).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .when(this.history.length > 0, (el) => el.child(control("cria-file-preview-back", "←", `Back to ${basename(this.history.at(-1))}`, (_e, cx) => this.back(cx))))
        .child(div().flex_1().min_w(0))
        .when(Boolean(this.file && this.siblings.length > 0), (el) => el.child(sibNav))
        .when(Boolean(state && viewer?.toolbar), (el) => el.child(viewer.toolbar(state, env)))
        .when(Boolean(this.file), (el) => el.child(iconButton("more", "more", "Open in editor, reveal, copy the path…", false, () => openMenu(this.file, this.on)))))
      .child(v_flex().id("cria-file-preview-body").flex_1().min_h(0).on_size_change((size, cx) => { this.size = size; cx.notify(); })
        .child(state ? viewer.render(state, env, cx) : div().p(14).text_color(this.error ? t.ansi1 : t.dim).child(this.error ?? "Loading…")));
  }
}
