// Herdr bottom status bar with per-session 3-way AI Permission Switch:
//   - "ask"  (💬 每次都問, default)
//   - "safe" (🚧 刪改才問)
//   - "full" (🚀 最高權限)
// Syncs with ~/.cache/over9k/usage/permissions.json so Claude Code, agy, and Codex
// statuslines and PreToolUse / PermissionRequest hooks reflect the change immediately.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, panes, focused, theme, run, window, keys, exec, home, shared, setShared, notify, checking, props, layout, nextCommand } from "herdr";

const PERM_SHARED = "herdr.permissions";
const AGY_TITLES_SHARED = "herdr.agy-titles";
const PREVIEW_HEAD_SHARED = "cria-file-preview.head";
const GUARD_REL = ".config/ai-statusline/permission-guard.py";

function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter((child) => !child.hidden);
    children = [visible.find((child) => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

function progIcon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function shortFolder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

const OPTIONS = [
  { id: "ask",  label: "💬 每次都問", bg: "#3B4252", fg: "#FFFFFF", tip: "嚴格模式（預設）：寫入、修改檔案或執行指令前每次都會詢問你" },
  { id: "safe", label: "🚧 刪改才問", bg: "#2563EB", fg: "#FFFFFF", tip: "安全防護：一般讀寫與測試自動放行；只有刪除檔案或強制覆蓋時才詢問你" },
  { id: "full", label: "🚀 最高權限", bg: "#EA580C", fg: "#FFFFFF", tip: "最高權限：當前對話 session 自動放行所有讀寫與指令" },
];

export default class CustomStatus extends View {
  init(_props, cx) {
    this.isPaneHeader = props()?.view === "pane-header";
    this.hovered = false;
    this.loaded = false;
    if (!this.isPaneHeader && !checking()) {
      this.syncFromDisk(cx);
      cx.timer.every(6000, (cx) => this.syncAgyTitles(cx));
      cx.spawn(async () => {
        for (;;) {
          const cmd = await nextCommand();
          if (cmd === "close-preview-and-panel") {
            this.closePreviewAndPanel();
          }
        }
      });
    }
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

  paneButton(t, id, iconName, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane/${iconName}.svg`).size(14));
  }

  renderPaneHeader() {
    const t = theme();
    const paneId = props()?.pane;
    const p = (panes() ?? []).find((x) => x.pane === paneId);
    if (!p) return div();
    const pane = p.pane;
    const bottom = paneFrame(layout())?.header?.position === "bottom";

    if (p.mod === "cria-file-preview") {
      const headMap = shared(PREVIEW_HEAD_SHARED) ?? {};
      const propFile = p.props?.file || "";
      const propName = propFile ? propFile.split(/[\\/]/).pop() : "";
      const propDir = propFile ? propFile.replace(/[\\/][^\\/]+$/, "") : "";
      const info = headMap[pane] || (propFile ? { name: propName, dir: propDir, fullPath: propFile } : headMap.latest) || {};
      const fileName = info.name || propName || "cria-file-preview";
      const fileDir = shortFolder(info.dir || propDir || "");
      const fullPath = info.fullPath || info.file || propFile || "";
      const sizeText = info.sizeText || "";
      const isAuto = Boolean(info.auto);

      return h_flex()
        .id(`pane-head-${pane}`)
        .size_full()
        .px(10)
        .gap(8)
        .items_center()
        .bg(t.background)
        .when(bottom, (el) => el.border_t(1))
        .when(!bottom, (el) => el.border_b(1))
        .border_color(t.border)
        .text_size(12)
        .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
        .on_click(() => run("pane.focus", { pane }))
        .when(isAuto, (el) =>
          el.child(
            div().flex_none().px(5).py(1).rounded(4).bg(t.accent).text_color(t.background).text_size(10).font_semibold().child("AUTO")
          )
        )
        .child(
          div()
            .id(`ph-copy-name-${pane}`)
            .flex_none()
            .truncate()
            .max_w(280)
            .font_semibold()
            .text_color(t.foreground)
            .cursor_pointer()
            .hover((s) => s.text_color(t.accent))
            .tooltip("點擊複製檔案名稱")
            .on_click((_e, cx) => {
              cx.stop_propagation();
              if (fileName) {
                cx.write_to_clipboard(fileName);
                notify({ title: "已複製檔案名稱", body: fileName, level: "success", timeout: 2200 });
              }
            })
            .child(fileName)
        )
        .when(Boolean(fileDir), (el) =>
          el.child(
            div()
              .id(`ph-copy-path-${pane}`)
              .flex_shrink(1)
              .min_w(0)
              .truncate()
              .text_size(11.5)
              .text_color(t.dim)
              .cursor_pointer()
              .hover((s) => s.text_color(t.accent))
              .tooltip(`點擊複製完整路徑：${fullPath}`)
              .on_click((_e, cx) => {
                cx.stop_propagation();
                if (fullPath) {
                  cx.write_to_clipboard(fullPath);
                  notify({ title: "已複製完整檔案路徑", body: fullPath, level: "success", timeout: 2200 });
                }
              })
              .child(fileDir)
          )
        )
        .when(Boolean(sizeText), (el) =>
          el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(sizeText))
        )
        .child(div().flex_1())
        .when(this.hovered, (el) =>
          el
            .child(this.paneButton(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
            .child(this.paneButton(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
            .child(this.paneButton(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
            .child(this.paneButton(t, `ph-x-${pane}`, "close", "pane.close", { pane }))
        );
    }

    const name = p.name || ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = progIcon(p.program, 14, t.dim);
    const st = p.status;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .when(bottom, (el) => el.border_t(1))
      .when(!bottom, (el) => el.border_b(1))
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(shortFolder(p.cwd)))
      .when(st === "working", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", (el) => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, (el) =>
        el
          .child(this.paneButton(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
          .child(this.paneButton(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
          .child(this.paneButton(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
          .child(this.paneButton(t, `ph-x-${pane}`, "close", "pane.close", { pane }))
      );
  }

  syncAgyTitles(cx) {
    const guard = `${home()}/${GUARD_REL}`;
    cx.spawn(async (cx) => {
      const r = await exec("python3", [guard, "sync-titles"]).catch(() => null);
      if (r?.code === 0 && r.stdout.trim()) {
        try {
          const parsed = JSON.parse(r.stdout);
          if (parsed && typeof parsed === "object") {
            setShared(AGY_TITLES_SHARED, parsed);
            cx.notify();
          }
        } catch {}
      }
    });
  }

  syncFromDisk(cx) {
    this.syncAgyTitles(cx);
    const file = `${home()}/.cache/over9k/usage/permissions.json`;
    cx.spawn(async (cx) => {
      const r = await exec("cat", [file]).catch(() => null);
      if (r?.code === 0 && r.stdout.trim()) {
        try {
          const parsed = JSON.parse(r.stdout);
          if (parsed && typeof parsed === "object") {
            setShared(PERM_SHARED, parsed);
          }
        } catch {}
      }
      this.loaded = true;
      cx.notify();
    });
  }

  activeTarget() {
    const f = focused();
    const allPanes = panes() ?? [];
    const activeSpace = spaces()?.find((s) => s.active);
    const activeTab = f?.tab || activeSpace?.tabs?.find((t) => t.active)?.id || null;
    if (f?.terminal) {
      const p = allPanes.find((x) => x.terminal === f.terminal);
      return { terminal: f.terminal, cwd: p?.cwd || f?.cwd || activeSpace?.folder || null, name: p?.program?.name || p?.title || f.terminal };
    }
    if (activeTab) {
      const termPane = allPanes.find((x) => x.tab === activeTab && x.terminal);
      if (termPane) {
        return { terminal: termPane.terminal, cwd: termPane.cwd || activeSpace?.folder || null, name: termPane.program?.name || termPane.title || termPane.terminal };
      }
    }
    return { terminal: null, cwd: f?.cwd || activeSpace?.folder || null, name: activeSpace?.name || "Session" };
  }

  currentMode(target) {
    const data = shared(PERM_SHARED) ?? {};
    const sessions = data.sessions ?? {};
    if (target.terminal && VALID(sessions[target.terminal])) return sessions[target.terminal];
    if (target.cwd && VALID(sessions[`cwd:${target.cwd}`])) return sessions[`cwd:${target.cwd}`];
    return VALID(data.default) ? data.default : "ask";
  }

  selectMode(mode, target, cx) {
    const prev = shared(PERM_SHARED) ?? { default: "ask", sessions: {} };
    const sessions = { ...(prev.sessions ?? {}) };
    if (target.terminal) sessions[target.terminal] = mode;
    if (target.cwd) sessions[`cwd:${target.cwd}`] = mode;
    const next = { ...prev, default: prev.default || "ask", sessions, updated_at: Date.now() };
    setShared(PERM_SHARED, next);
    cx.notify();

    if (!checking()) {
      const guard = `${home()}/${GUARD_REL}`;
      cx.spawn(async () => {
        await exec("python3", [guard, "set", mode, target.terminal || "", target.cwd || ""]).catch(() => null);
      });
      const opt = OPTIONS.find((o) => o.id === mode);
      notify({
        title: `${target.name || "當前對話"} 權限已切換為：${opt?.label || mode}`,
        body: opt?.tip || "",
        level: "info",
        timeout: 2200,
      });
    }
  }

  hint() {
    const mac = window()?.platform === "macos";
    const mod = { cmd: mac ? "⌘" : "Ctrl+", ctrl: mac ? "⌃" : "Ctrl+", shift: mac ? "⇧" : "Shift+", alt: mac ? "⌥" : "Alt+", option: mac ? "⌥" : "Alt+" };
    const b = keys().find((k) => k.section === "global" && k.action === "app.palette");
    const parts = b && b.keys.endsWith("--") ? [...b.keys.slice(0, -2).split("-"), "-"] : b?.keys.split("-");
    const key = parts && parts.map((p) => mod[p.toLowerCase()] ?? p.toUpperCase()).join("");
    return key ? `${key}  commands` : "commands";
  }

  render() {
    if (this.isPaneHeader || props()?.view === "pane-header") {
      return this.renderPaneHeader();
    }
    const t = theme();
    const space = spaces().find((s) => s.active);
    const list = agents();
    const needs = list.filter((a) => a.status === "blocked").length;
    const target = this.activeTarget();
    const activeMode = this.currentMode(target);
    const label = (icon, text) => h_flex().gap(6).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(13)).child(text);

    return h_flex().id("custom-status-bar").size_full().px(14).gap(14).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(space?.branch), (el) => el.child(label("branch", space.branch)))
      .child(h_flex().gap(6).items_center().child(div().size(6).rounded(3).bg(t.dim)).child(`${list.length} ${list.length === 1 ? "agent" : "agents"}`)
        .when(needs > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${needs} ${needs === 1 ? "needs" : "need"} you`))))
      .child(div().flex_1())
      .child(h_flex().id("perm-switch-group").gap(4).items_center().px(5).py(2).rounded(6).bg(t.surface).border_1().border_color(t.border)
        .child(div().px(4).text_size(11).text_color(t.dim).child(`權限 (${target.name || "當前"}):`))
        .children(OPTIONS.map((opt) => {
          const on = activeMode === opt.id;
          return div().id(`perm-btn-${opt.id}`).h(20).px(8).flex().items_center().rounded(4).cursor_pointer()
            .text_size(11).font_semibold()
            .bg(on ? opt.bg : t.chrome)
            .text_color(on ? opt.fg : t.muted)
            .hover((s) => on ? s.opacity(0.92) : s.bg(t.hover).text_color(t.foreground))
            .tooltip(opt.tip)
            .on_click((_e, cx) => this.selectMode(opt.id, target, cx))
            .child(opt.label);
        })))
      .child(div().id("palette").text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(() => run("app.palette")).child(this.hint()));
  }
}

function VALID(m) {
  return m === "ask" || m === "safe" || m === "full";
}
