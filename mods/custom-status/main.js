// Herdr bottom status bar with per-session 3-way AI Permission Switch:
//   - "ask"  (💬 每次都問, default)
//   - "safe" (🚧 刪改才問)
//   - "full" (🚀 最高權限)
// Syncs with ~/.cache/over9k/usage/permissions.json so Claude Code, agy, and Codex
// statuslines and PreToolUse / PermissionRequest hooks reflect the change immediately.

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, panes, focused, theme, run, window, keys, exec, home, shared, setShared, notify, checking } from "herdr";

const PERM_SHARED = "herdr.permissions";
const GUARD_REL = ".config/ai-statusline/permission-guard.py";

const OPTIONS = [
  { id: "ask",  label: "💬 每次都問", bg: "#3B4252", fg: "#FFFFFF", tip: "嚴格模式（預設）：寫入、修改檔案或執行指令前每次都會詢問你" },
  { id: "safe", label: "🚧 刪改才問", bg: "#2563EB", fg: "#FFFFFF", tip: "安全防護：一般讀寫與測試自動放行；只有刪除檔案或強制覆蓋時才詢問你" },
  { id: "full", label: "🚀 最高權限", bg: "#EA580C", fg: "#FFFFFF", tip: "最高權限：當前對話 session 自動放行所有讀寫與指令" },
];

export default class CustomStatus extends View {
  init(_props, cx) {
    this.loaded = false;
    if (!checking()) {
      this.syncFromDisk(cx);
    }
  }

  syncFromDisk(cx) {
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
