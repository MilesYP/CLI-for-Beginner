// Visual HTML Viewer for cria-file-preview:
// Supports HTML files of ANY size (including > 1 MiB files with embedded base64 images)
// without throwing the 1 MiB text limit error.
// Renders full CSS / Flexbox / Grid / JS web pages into Retina high-DPI preview pages
// via headless Chrome/Brave/Edge, with:
//   - "視覺網頁 (Visual)" | "文字 (Text)" | "Raw" modes
//   - Desktop (1360px) / Mobile (430px) viewport toggle
//   - Smooth vertical scrolling + Trackpad two-finger pinch zoom (on_pinch) & Cmd+Wheel zoom
//   - "Open in browser ↗" for full interactive testing

import { div, image } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { exec, appHome, notify, theme, window } from "herdr";
import { readLongText, codeState, codeView } from "./text.js";
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

# Render HTML to PDF via Headless Chrome, then render pages to sharp Retina PNGs via macOS PDFKit
# so multi-screen / 1.9MB+ long HTML documents render every section without getting cut off!
pdf_name = f"{file_key}-{mtime}-{viewport}.pdf"
pdf_full = os.path.join(cache_dir, pdf_name)
meta_full = os.path.join(cache_dir, f"{file_key}-{mtime}-{viewport}.json")

if os.path.isfile(meta_full):
    try:
        data = json.loads(open(meta_full, "r", encoding="utf-8").read())
        if data.get("pages") and all(os.path.isfile(os.path.join(cache_dir, os.path.basename(p["path"]))) for p in data["pages"]):
            print(json.dumps(data))
            sys.exit(0)
    except Exception:
        pass

vw = 430 if viewport == "mobile" else 1280
file_url = "file://" + urllib.parse.quote(os.path.abspath(src))

if not os.path.isfile(pdf_full):
    cmd = [
        browser,
        "--headless",
        "--disable-gpu",
        "--no-pdf-header-footer",
        f"--window-size={vw},1600",
        f"--print-to-pdf={pdf_full}",
        file_url,
    ]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=25)

if not os.path.isfile(pdf_full):
    print(json.dumps({"rendered": False, "reason": "Headless PDF print failed"}))
    sys.exit(0)

jxa = """
ObjC.import('Foundation'); ObjC.import('AppKit'); ObjC.import('PDFKit');
function run(argv) {
  var source = argv[0], dir = argv[1], prefix = argv[2], wide = Number(argv[3]);
  var fm = $.NSFileManager.defaultManager;
  var doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath($(source)));
  if (!doc || doc.isNil()) throw new Error('Cannot read generated PDF');
  var count = Math.min(Number(doc.pageCount), 30), pages = [];
  for (var n = 1; n <= count; n++) {
    var name = prefix + '-p' + n + '.png', path = dir + '/' + name;
    var page = doc.pageAtIndex(n - 1), box = page.boundsForBox(1);
    var w = box.size.width, h = box.size.height;
    if (!fm.fileExistsAtPath($(path))) {
      var picture = page.thumbnailOfSizeForBox($.NSMakeSize(wide, wide * h / w), 1);
      var bitmap = $.NSBitmapImageRep.imageRepWithData(picture.TIFFRepresentation);
      var png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
      png.writeToFileAtomically($(path), true);
    }
    pages.push({ n: n, path: 'data/cria-file-preview/' + name, width: w, height: h });
  }
  return JSON.stringify({ rendered: true, count: Number(doc.pageCount), pages: pages });
}
"""

prefix = f"{file_key}-{mtime}-{viewport}"
wide = 1000 if viewport == "mobile" else 1600
out = subprocess.check_output(["osascript", "-l", "JavaScript", "-e", jxa, pdf_full, cache_dir, prefix, str(wide)], text=True)
with open(meta_full, "w", encoding="utf-8") as mf:
    mf.write(out.strip())
print(out.strip())
`;

function openCommand(platform, file) {
  if (platform === "macos") return ["open", [file]];
  if (platform === "windows") return ["explorer.exe", [file.replace(/\//g, "\\")]];
  return ["xdg-open", [file]];
}

async function renderHtmlPages(file, viewport) {
  const dir = `${appHome().split("\\").join("/")}/data/cria-file-preview`;
  const k = key(file);
  const r = await exec("python3", ["-c", HTML_RENDER_PY, file, dir, k, viewport]).catch(() => null);
  if (!r || r.code !== 0 || !r.stdout.trim()) return null;
  try {
    const parsed = JSON.parse(r.stdout.trim());
    return parsed?.rendered && parsed?.pages?.length ? parsed : null;
  } catch {
    return null;
  }
}

export default {
  id: "html",
  async load(file, env, previous) {
    const viewport = previous?.viewport ?? "desktop";
    const [longRes, visual] = await Promise.all([
      readLongText(file, env.on).catch(() => ({ text: "", cut: true })),
      !env.on ? renderHtmlPages(file, viewport) : Promise.resolve(null),
    ]);
    if (!env.on) pruneCache();
    const text = longRes.text || "";
    const mode = previous?.mode ?? (visual ? "visual" : "text");
    return {
      file,
      text,
      cut: Boolean(longRes.cut),
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
      const pic = await renderHtmlPages(state.file, nextVp);
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
                  .tooltip("桌面版視角")
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
                  .tooltip("手機版視角")
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
    if (state.mode === "visual" && state.visual?.pages?.length) {
      const scale = state.zoom ?? 1;
      const maxFitW = state.viewport === "mobile"
        ? Math.min(env.size.width - 32, 460)
        : Math.max(280, Math.min(env.size.width - 28, 1200));
      const dispW = Math.round(maxFitW * scale);

      return v_flex()
        .id(`${state.id}-visual-scroll`)
        .size_full()
        .overflow_y_scrollbar()
        .overflow_x_scrollbar()
        .p(14)
        .gap(12)
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
        .children(
          state.visual.pages.map((p) => {
            const ratio = p.height / p.width;
            const dispH = Math.round(dispW * ratio);
            return image(p.path)
              .w(dispW)
              .h(dispH)
              .flex_none()
              .rounded(8)
              .border_1()
              .border_color(t.border)
              .shadow_md();
          }),
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
