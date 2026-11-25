// Herdr bottom status bar with per-session 3-way AI Permission Switch:
//   - "ask"  (💬 每次都問, default)
//   - "safe" (🚧 刪改才問)
//   - "full" (🚀 最高權限)
// Syncs with ~/.cache/over9k/usage/permissions.json so Claude Code, agy, and Codex
// statuslines and PreToolUse / PermissionRequest hooks reflect the change immediately.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, agents, panes, focused, theme, run, window, keys, exec, hc, home, shared, setShared, notify, checking, props, layout, nextCommand, openOverlay, closeOverlay } from "herdr";

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

const SHELL_CMD_RE = /^(?:\$\s+|%\s+)?(?:herdr(?:-app)?|hc|git|cd|sh|bash|zsh|npm|npx|pnpm|yarn|bun|brew|python3?|pip3?|uv|ruby|node|curl|wget|ssh|scp|rsync|rm|cp|mv|mkdir|chmod|chown|cat|head|tail|grep|rg|find|ls|open|qlmanage|docker|kubectl|cargo|go|make|sudo|export|env|claude|codex|agy|ollama|sqlite3|defaults|launchctl|kill|pkill|lsof|ps|tar|unzip|zip)\b/;

function isNoiseLine(line) {
  const s = line.trim();
  if (!s) return false;
  if (/^[─━═\-_=]{8,}$/.test(s)) return true;
  if (/Context \d+% used/.test(s)) return true;
  if (/^\[hc\]/.test(s)) return true;
  if (/^\s*>\s*$/.test(line)) return true;
  if (/for shortcuts|auto mode on|ctrl\+o to expand|shift\+tab to cycle/i.test(s)) return true;
  return false;
}

function extractCopyBlocks(rawText) {
  if (!rawText) return [];
  const rawLines = rawText.replace(/\r\n/g, "\n").split("\n");
  const lines = rawLines.map((l) => l.replace(/\s+$/, ""));
  const blocks = [];
  const seen = new Set();

  const addBlock = (tag, content, priority = 1) => {
    const clean = String(content || "").trim();
    if (!clean || clean.length < 2) return;
    if (seen.has(clean)) return;
    seen.add(clean);
    blocks.push({ tag, content: clean, priority, lines: clean.split("\n").length });
  };

  // 1. "📋 複製以下內容 ... 複製到這裡為止" delimited blocks
  for (let i = 0; i < lines.length; i++) {
    if (/📋\s*複製以下內容/.test(lines[i])) {
      const buf = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (/複製到這裡為止/.test(lines[j])) break;
        if (!isNoiseLine(lines[j])) buf.push(lines[j]);
      }
      if (buf.length > 0) {
        const minIndent = buf.filter((l) => l.trim()).reduce((m, l) => Math.min(m, l.match(/^ */)[0].length), 99);
        const dedented = buf.map((l) => (l.trim() ? l.slice(Math.min(minIndent, l.match(/^ */)[0].length)) : "")).join("\n");
        addBlock("📋 待複製內容", dedented, 3);
      }
      i = j;
    }
  }

  // 2. Single-line "📋 ：..." or "📋 : ..."
  for (const line of lines) {
    const m = line.match(/📋\s*[：:]\s*(.+)$/);
    if (m && m[1] && !/複製以下內容/.test(m[1])) {
      const val = m[1].trim().replace(/^`+|`+$/g, "");
      if (val) addBlock("📋 待複製", val, 3);
    }
  }

  // 3. Markdown fenced code blocks (```lang ... ```)
  for (let i = 0; i < lines.length; i++) {
    const fm = lines[i].match(/^\s*```([A-Za-z0-9_+-]*)\s*$/);
    if (fm) {
      const lang = fm[1] || "code";
      const buf = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (/^\s*```\s*$/.test(lines[j])) break;
        buf.push(lines[j]);
      }
      if (buf.length > 0) {
        addBlock(lang, buf.join("\n"), 2);
      }
      i = j;
    }
  }

  // 4. Shell commands / indented code blocks rendered by Claude Code, Codex, or agy
  let cmdBuf = [];
  const flushCmd = () => {
    if (cmdBuf.length > 0) {
      const minIndent = cmdBuf.filter((l) => l.trim()).reduce((m, l) => Math.min(m, l.match(/^ */)[0].length), 99);
      const text = cmdBuf.map((l) => (l.trim() ? l.slice(Math.min(minIndent, l.match(/^ */)[0].length)) : "")).join("\n").trim();
      if (text) addBlock("sh", text, 1);
      cmdBuf = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isNoiseLine(line)) {
      flushCmd();
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      flushCmd();
      continue;
    }
    const strippedBullet = trimmed.replace(/^[•·\-*]\s+/, "");
    const looksLikeCmd = SHELL_CMD_RE.test(trimmed) || (trimmed.startsWith("`") && trimmed.endsWith("`") && SHELL_CMD_RE.test(trimmed.slice(1, -1).trim()));
    if (looksLikeCmd && trimmed.length <= 240 && !/[。！？]$/.test(trimmed)) {
      cmdBuf.push(line.replace(/^\s*[$%]\s+/, "").replace(/^(\s*)`(.+)`$/, "$1$2"));
    } else if (cmdBuf.length > 0 && (/^\s{2,}(?:--|-|\||&&|\\|['"{[\]}])/.test(line) || /\\\s*$/.test(cmdBuf[cmdBuf.length - 1]))) {
      cmdBuf.push(line);
    } else {
      flushCmd();
      // Also capture inline backticked shell commands inside prose lines
      const inlineMatches = strippedBullet.matchAll(/`([^`]{6,180})`/g);
      for (const im of inlineMatches) {
        const inner = im[1].trim();
        if (SHELL_CMD_RE.test(inner)) {
          addBlock("sh", inner, 1);
        }
      }
    }
  }
  flushCmd();

  // Reverse so newest blocks appear at the top (highest priority / most recent first)
  blocks.reverse();

  // Always include a fallback "最近輸出" card if nothing matched
  if (blocks.length === 0) {
    const tail = lines.filter((l) => l.trim() && !isNoiseLine(l)).slice(-20).join("\n").trim();
    if (tail) blocks.push({ tag: "最近輸出", content: tail, priority: 0, lines: tail.split("\n").length });
  }
  return blocks.slice(0, 15);
}

const OPTIONS = [
  { id: "ask",  label: "💬 每次都問", bg: "#3B4252", fg: "#FFFFFF", tip: "嚴格模式（預設）：寫入、修改檔案或執行指令前每次都會詢問你" },
  { id: "safe", label: "🚧 刪改才問", bg: "#2563EB", fg: "#FFFFFF", tip: "安全防護：一般讀寫與測試自動放行；只有刪除檔案或強制覆蓋時才詢問你" },
  { id: "full", label: "🚀 最高權限", bg: "#EA580C", fg: "#FFFFFF", tip: "最高權限：當前對話 session 自動放行所有讀寫與指令" },
];

export default class CustomStatus extends View {
  init(_props, cx) {
    const viewMode = props()?.view;
    this.isPaneHeader = viewMode === "pane-header";
    this.isCopyPicker = viewMode === "copy-picker";
    this.hovered = false;
    this.loaded = false;
    this.copyItems = [];
    this.copyLoading = false;
    this.copyError = null;
    this.copiedIdx = -1;
    if (this.isCopyPicker && !checking()) {
      this.loadCopyBlocks(cx);
    } else if (!this.isPaneHeader && !this.isCopyPicker && !checking()) {
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

  loadCopyBlocks(cx) {
    const term = props()?.terminal;
    if (!term) {
      this.copyError = "目前沒有可讀取的終端機視窗";
      this.copyLoading = false;
      cx.notify();
      return;
    }
    this.copyLoading = true;
    this.copyError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["read", term, "--lines", "200"]);
        if (r?.code === 0) {
          this.copyItems = extractCopyBlocks(r.stdout || "");
        } else {
          this.copyError = r?.stderr?.trim() || "讀取終端機內容失敗";
        }
      } catch (e) {
        this.copyError = String(e?.message ?? e);
      } finally {
        this.copyLoading = false;
        cx.notify();
      }
    });
  }

  openCopyPicker(target) {
    if (!target?.terminal) {
      notify({ title: "找不到目標終端機", body: "請先點擊一個對話視窗再開啟複製面板", level: "warning", timeout: 2200 });
      return;
    }
    openOverlay({
      mod: "custom-status",
      props: { view: "copy-picker", terminal: target.terminal, name: target.name || target.terminal },
      kind: "dialog",
      width: 680,
      height: 540,
    });
  }

  renderCopyPicker(cx) {
    const t = theme();
    const overlayId = props()?.overlay;
    const titleName = props()?.name || "當前終端機";
    const copyCard = (item, idx) => {
      const isCopied = this.copiedIdx === idx;
      const previewLines = item.content.split("\n");
      const shownText = previewLines.length > 14 ? [...previewLines.slice(0, 14), `…（共 ${previewLines.length} 行，點擊複製全部）`].join("\n") : item.content;
      return v_flex()
        .id(`copy-card-${idx}`)
        .w_full()
        .rounded(10)
        .bg(t.surface)
        .border_1()
        .border_color(isCopied ? t.done : t.border)
        .overflow_hidden()
        .child(
          h_flex()
            .w_full()
            .h(34)
            .px(12)
            .gap(8)
            .items_center()
            .bg(t.chrome)
            .border_b(1)
            .border_color(t.border)
            .child(div().text_size(11.5).font_semibold().text_color(t.muted).child(item.tag))
            .child(div().text_size(11).text_color(t.dim).child(`${item.lines} 行`))
            .child(div().flex_1())
            .child(
              h_flex()
                .id(`copy-card-btn-${idx}`)
                .h(24)
                .px(10)
                .gap(5)
                .items_center()
                .rounded(6)
                .cursor_pointer()
                .bg(isCopied ? "#16A34A" : t.raised)
                .text_color(isCopied ? "#FFFFFF" : t.foreground)
                .hover((s) => (isCopied ? s.opacity(0.92) : s.bg(t.accent).text_color(t.background)))
                .on_click((_e, cx) => {
                  cx.write_to_clipboard(item.content);
                  this.copiedIdx = idx;
                  cx.notify();
                  notify({
                    title: `已複製（${item.tag}）`,
                    body: item.content.length > 90 ? item.content.slice(0, 90) + "…" : item.content,
                    level: "success",
                    timeout: 2200,
                  });
                  if (overlayId) {
                    cx.timer.after(260, () => {
                      try { closeOverlay(overlayId); } catch {}
                    });
                  }
                })
                .child(div().text_size(11.5).font_semibold().child(isCopied ? "✓ 已複製" : "📋 複製"))
            )
        )
        .child(
          div()
            .w_full()
            .p(12)
            .bg(t.background)
            .text_size(12.5)
            .text_color(t.foreground)
            .font_family("Menlo")
            .child(shownText)
        );
    };

    return v_flex()
      .id("copy-picker-dialog")
      .size_full()
      .bg(t.background)
      .text_color(t.foreground)
      .child(
        h_flex()
          .w_full()
          .h(44)
          .px(14)
          .gap(8)
          .items_center()
          .bg(t.chrome)
          .border_b(1)
          .border_color(t.border)
          .child(div().text_size(13.5).font_semibold().child(`📋 可複製區塊（${titleName}）`))
          .child(div().text_size(11.5).text_color(t.dim).child(this.copyLoading ? "讀取中…" : `共 ${this.copyItems.length} 筆`))
          .child(div().flex_1())
          .child(
            div()
              .id("copy-picker-refresh")
              .h(26)
              .px(9)
              .flex()
              .items_center()
              .rounded(6)
              .cursor_pointer()
              .text_size(11.5)
              .bg(t.raised)
              .text_color(t.muted)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => this.loadCopyBlocks(cx))
              .child("↻ 重新整理")
          )
          .child(
            div()
              .id("copy-picker-close")
              .h(26)
              .px(9)
              .flex()
              .items_center()
              .rounded(6)
              .cursor_pointer()
              .text_size(11.5)
              .text_color(t.dim)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => { if (overlayId) try { closeOverlay(overlayId); } catch {} })
              .child("Esc")
          )
      )
      .child(
        v_flex()
          .id("copy-picker-list")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .p(14)
          .gap(12)
          .when(this.copyLoading, (el) => el.child(div().p(12).text_size(12.5).text_color(t.dim).child("正在掃描當前對話中的指令與程式碼區塊…")))
          .when(Boolean(this.copyError), (el) => el.child(div().p(12).text_size(12.5).text_color(t.ansi1).child(this.copyError)))
          .when(!this.copyLoading && !this.copyError && this.copyItems.length === 0, (el) =>
            el.child(div().p(12).text_size(12.5).text_color(t.dim).child("目前畫面上沒有偵測到可複製的程式碼或指令區塊。"))
          )
          .when(!this.copyLoading && this.copyItems.length > 0, (el) => el.children(this.copyItems.map((it, i) => copyCard(it, i))))
      );
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

  render(cx) {
    if (this.isCopyPicker || props()?.view === "copy-picker") {
      return this.renderCopyPicker(cx);
    }
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
      .child(
        div()
          .id("status-copy-blocks-btn")
          .h(22)
          .px(9)
          .flex()
          .items_center()
          .rounded(6)
          .cursor_pointer()
          .bg(t.surface)
          .border_1()
          .border_color(t.border)
          .text_size(11.2)
          .font_semibold()
          .text_color(t.foreground)
          .hover((s) => s.bg(t.hover).border_color(t.accent))
          .tooltip("一鍵檢視並複製當前對話裡的程式碼與待複製區塊")
          .on_click(() => this.openCopyPicker(target))
          .child("📋 複製區塊")
      )
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
