// Visual HTML Viewer for cria-file-preview:
// Renders full CSS / Flexbox / Grid / JS web pages into Retina high-DPI preview slices
// via headless Chrome/Brave/Edge (with automatic fallback to TextView.html), supporting:
//   - "視覺網頁 (Visual)" | "文字 (Text)" | "Raw" modes
//   - Desktop (1280px) / Mobile (430px) viewport toggle
//   - Smooth vertical scrolling + Trackpad two-finger pinch zoom (on_pinch) & Cmd+Wheel zoom
//   - "Open in browser ↗" for full interactive testing

import { div, image } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { exec, appHome, notify, theme, window } from "herdr";
import { readText, codeState, codeView } from "./text.js";
import { segmented, wrapButton } from "./controls.js";
import { zoomControl } from "./zoom.js";
import { wheelZoom, pinchZoom } from "../pan-zoom.js";
import { key, pruneCache } from "../media.js";

let views = 0;

const HTML_RENDER_PY = String.raw`
import json, os, re, subprocess, sys, urllib.parse

src, cache_dir, file_key, viewport = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
if not os.path.isfile(src):
    sys.stderr.write("HTML file not found\n")
    sys.exit(1)

mtime = int(os.path.getmtime(src))
os.makedirs(cache_dir, exist_ok=True)

vw = 430 if viewport == "mobile" else 1360
vh = 2400 if viewport == "mobile" else 2200
out_name = f"{file_key}-{mtime}-{viewport}.png"
out_full = os.path.join(cache_dir, out_name)

browsers = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
]
browser = next((b for b in browsers if os.path.isfile(b)), None)

if not browser:
    print(json.dumps({"rendered": False, "reason": "No Chromium-based browser found"}))
    sys.exit(0)

if not os.path.isfile(out_full):
    file_url = "file://" + urllib.parse.quote(os.path.abspath(src))
    cmd = [
        browser,
        "--headless",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=2",
        f"--window-size={vw},{vh}",
        f"--screenshot={out_full}",
        file_url,
    ]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)

if not os.path.isfile(out_full):
    print(json.dumps({"rendered": False, "reason": "Headless screenshot failed"}))
    sys.exit(0)

w, h = vw * 2, vh * 2
try:
    sips_out = subprocess.check_output(
        ["sips", "-g", "pixelWidth", "-g", "pixelHeight", out_full],
        text=True, stderr=subprocess.DEVNULL
    )
    w = int(re.search(r"pixelWidth:\s*(\d+)", sips_out).group(1))
    h = int(re.search(r"pixelHeight:\s*(\d+)", sips_out).group(1))
except Exception:
    pass

print(json.dumps({
    "rendered": True,
    "path": f"data/cria-file-preview/{out_name}",
    "width": w,
    "height": h,
    "viewport": viewport,
}))
`;

function openCommand(platform, file) {
  if (platform === "macos") return ["open", [file]];
  if (platform === "windows") return ["explorer.exe", [file.replace(/\//g, "\\")]];
  return ["xdg-open", [file]];
}

async function renderHtmlImage(file, viewport) {
  const dir = `${appHome().split("\\").join("/")}/data/cria-file-preview`;
  const k = key(file);
  const r = await exec("python3", ["-c", HTML_RENDER_PY, file, dir, k, viewport]).catch(() => null);
  if (!r || r.code !== 0 || !r.stdout.trim()) return null;
  try {
    const parsed = JSON.parse(r.stdout.trim());
    return parsed?.rendered ? parsed : null;
  } catch {
    return null;
  }
}

export default {
  id: "html",
  async load(file, env, previous) {
    const text = await readText(file, env.on);
    const viewport = previous?.viewport ?? "desktop";
    let visual = null;
    if (!env.on) {
      visual = await renderHtmlImage(file, viewport);
      pruneCache();
    }
    const mode = previous?.mode ?? (visual ? "visual" : "text");
    return {
      file,
      text,
      mode, // "visual" | "text" | "raw"
      viewport, // "desktop" | "mobile"
      visual,
      loadingViewport: false,
      zoom: previous?.zoom ?? null,
      editor: mode === "raw" ? codeState(text, "html") : null,
      id: `cria-file-preview-html-${++views}`,
    };
  },

  switchViewport(state, nextVp, cx) {
    if (state.viewport === nextVp || state.loadingViewport) return;
    state.viewport = nextVp;
    state.loadingViewport = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const pic = await renderHtmlImage(state.file, nextVp);
      if (pic) state.visual = pic;
      state.loadingViewport = false;
      cx.notify();
    });
  },

  toolbar(state, env) {
    const t = theme();
    const platform = window()?.platform ?? "macos";
    return h_flex()
      .gap(6)
      .items_center()
      .text_size(12)
      .when(Boolean(state.visual), (el) =>
        el.child(
          segmented([
            ["html-visual", "視覺網頁", state.mode === "visual", () => { state.mode = "visual"; }],
            ["html-text", "文字", state.mode === "text", () => { state.mode = "text"; }],
            ["html-raw", "Raw", state.mode === "raw", () => {
              state.mode = "raw";
              if (!state.editor) state.editor = codeState(state.text, "html");
            }],
          ]),
        ),
      )
      .when(!state.visual, (el) =>
        el.child(
          segmented([
            ["html-text-only", "Preview", state.mode !== "raw", () => { state.mode = "text"; }],
            ["html-raw-only", "Raw", state.mode === "raw", () => {
              state.mode = "raw";
              if (!state.editor) state.editor = codeState(state.text, "html");
            }],
          ]),
        ),
      )
      .when(state.mode === "visual" && Boolean(state.visual), (el) =>
        el
          .child(
            h_flex()
              .gap(2)
              .p(2)
              .rounded(7)
              .bg(t.chrome)
              .items_center()
              .child(
                div()
                  .id("html-vp-desktop")
                  .px(8)
                  .py(3)
                  .rounded(5)
                  .cursor_pointer()
                  .bg(state.viewport === "desktop" ? t.raised : t.chrome)
                  .text_color(state.viewport === "desktop" ? t.foreground : t.muted)
                  .hover((s) => s.text_color(t.foreground))
                  .tooltip("桌面版寬度 (1360px)")
                  .on_click((_e, cx) => this.switchViewport(state, "desktop", cx))
                  .child("🖥 桌面"),
              )
              .child(
                div()
                  .id("html-vp-mobile")
                  .px(8)
                  .py(3)
                  .rounded(5)
                  .cursor_pointer()
                  .bg(state.viewport === "mobile" ? t.raised : t.chrome)
                  .text_color(state.viewport === "mobile" ? t.foreground : t.muted)
                  .hover((s) => s.text_color(t.foreground))
                  .tooltip("手機版寬度 (430px)")
                  .on_click((_e, cx) => this.switchViewport(state, "mobile", cx))
                  .child("📱 手機"),
              ),
          )
          .child(zoomControl(state, state.zoom ?? 1)),
      )
      .when(state.mode === "raw", (el) => el.child(wrapButton(state, "html")))
      .when(!env.on, (el) =>
        el.child(
          div()
            .id("cria-file-preview-open-browser")
            .h(26)
            .px(10)
            .flex()
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .bg(t.raised)
            .text_color(t.foreground)
            .hover((s) => s.bg(t.hover))
            .tooltip("在預設瀏覽器開啟完整互動網頁")
            .on_click((_e, cx) => {
              const [cmd, args] = openCommand(platform, env.file);
              cx.spawn(async () => {
                const r = await exec(cmd, args).catch((e) => ({ code: 1, stderr: String(e) }));
                if (r.code !== 0)
                  notify({
                    title: "Cannot open in browser",
                    body: r.stderr || "Failed to launch browser",
                    level: "warning",
                  });
              });
            })
            .child("Open in browser ↗"),
        ),
      );
  },

  render(state, env) {
    const t = theme();
    if (state.mode === "raw") return codeView(state.editor);
    if (state.mode === "visual" && state.visual) {
      const scale = state.zoom ?? 1;
      const maxFitW = state.viewport === "mobile"
        ? Math.min(env.size.width - 32, 430)
        : Math.max(280, env.size.width - 28);
      const dispW = Math.round(maxFitW * scale);
      const ratio = state.visual.height / state.visual.width;
      const dispH = Math.round(dispW * ratio);

      return v_flex()
        .id(`${state.id}-visual-scroll`)
        .size_full()
        .overflow_y_scrollbar()
        .overflow_x_scrollbar()
        .p(14)
        .items_center()
        .bg(t.canvas)
        .on_scroll_wheel((e, cx) => {
          if (e.modifiers?.control || e.modifiers?.platform) {
            state.zoom = wheelZoom(state.zoom ?? 1, e.delta.y);
            cx.notify();
          }
        })
        .on_pinch((e, cx) => {
          if (e.delta) {
            state.zoom = pinchZoom(state.zoom ?? 1, e.delta);
            cx.notify();
          }
        })
        .when(state.loadingViewport, (el) =>
          el.child(div().p(8).text_size(12).text_color(t.muted).child("正在切換網頁視角…")),
        )
        .child(
          image(state.visual.path)
            .w(dispW)
            .h(dispH)
            .flex_none()
            .rounded(10)
            .border_1()
            .border_color(t.border)
            .shadow_lg(),
        );
    }
    return v_flex()
      .id(state.id)
      .flex_1()
      .min_h(0)
      .w_full()
      .max_w(920)
      .mx_auto()
      .px(40)
      .py(24)
      .child(TextView.html(`${state.id}-view`, state.text).selectable(true).scrollable(true).size_full());
  },

  release: (state) => state.editor?.release(),
};
