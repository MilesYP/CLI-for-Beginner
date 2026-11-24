// Visual HTML Viewer for cria-file-preview:
// Uses v_virtual_list + VirtualListScrollHandle + Scrollbar.vertical (matching pdf.js and pptx.js)
// so even 1.9 MB+ multi-page HTML files scroll and zoom smoothly without freezing the UI thread.
//   - "視覺網頁 (Visual)" | "Raw" modes (loads raw text on-demand only when Raw is clicked)
//   - Desktop (1280px) / Mobile (430px) viewport toggle
//   - Page navigation ‹ 1 / N › + bottom-right "Page X / N" badge
//   - Trackpad two-finger pinch zoom (on_pinch) & Cmd+Wheel zoom
//   - "Open in browser ↗" for full interactive testing

import { div, image } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { exec, appHome, notify, theme, window } from "herdr";
import { readLongText, codeState, codeView } from "./text.js";
import { segmented, wrapButton } from "./controls.js";
import { zoomControl } from "./zoom.js";
import { wheelZoom, pinchZoom } from "../pan-zoom.js";
import { key, pruneCache } from "../media.js";

const GAP = 16;
let views = 0;

const HTML_RENDER_PY = String.raw`
import json, os, re, subprocess, sys, urllib.parse

src, cache_dir, file_key, viewport = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
if not os.path.isfile(src):
    sys.stderr.write("HTML file not found\n")
    sys.exit(1)

mtime = int(os.path.getmtime(src))
os.makedirs(cache_dir, exist_ok=True)
RENDER_VER = "v2"

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

pdf_name = f"{file_key}-{mtime}-{viewport}-{RENDER_VER}.pdf"
pdf_full = os.path.join(cache_dir, pdf_name)
meta_full = os.path.join(cache_dir, f"{file_key}-{mtime}-{viewport}-{RENDER_VER}.json")

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
  var count = Math.min(Number(doc.pageCount), 40), pages = [];
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

prefix = f"{file_key}-{mtime}-{viewport}-{RENDER_VER}"
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

function jump(state, n) {
  const count = state.visual?.pages?.length || 1;
  n = Math.max(1, Math.min(count, n));
  state.visible = n - 1;
  state.scroll.scroll_to_item(n - 1, "top");
}

export default {
  id: "html",
  async load(file, env, previous) {
    const viewport = previous?.viewport ?? "desktop";
    const visual = !env.on ? await renderHtmlPages(file, viewport) : null;
    if (!env.on) pruneCache();
    let text = "";
    let editor = null;
    const mode = previous?.mode === "raw" ? "raw" : "visual";
    if (mode === "raw" || !visual) {
      const longRes = await readLongText(file, env.on, 262144).catch(() => ({ text: "", cut: true }));
      text = longRes.text || "";
      editor = codeState(text, "html");
    }
    const pages = visual?.pages ?? [];
    const ratio = pages[0] ? pages[0].height / pages[0].width : 1.4;
    return {
      file,
      on: env.on,
      text,
      mode: visual ? mode : "raw", // "visual" | "raw"
      viewport, // "desktop" | "mobile"
      visual,
      ratio,
      visible: 0,
      loadingViewport: false,
      loadingRaw: false,
      zoom: previous?.zoom ?? null,
      editor,
      scroll: VirtualListScrollHandle.new(),
      id: `cria-file-preview-html-${++views}`,
    };
  },

  switchToRaw(state, cx) {
    state.mode = "raw";
    if (state.editor || state.loadingRaw) {
      cx.notify();
      return;
    }
    state.loadingRaw = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const longRes = await readLongText(state.file, state.on, 262144).catch(() => ({ text: "", cut: true }));
      state.text = longRes.text || "";
      state.editor = codeState(state.text, "html");
      state.loadingRaw = false;
      cx.notify();
    });
  },

  switchViewport(state, nextVp, cx) {
    if (state.viewport === nextVp || state.loadingViewport) return;
    state.viewport = nextVp;
    state.loadingViewport = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const pic = await renderHtmlPages(state.file, nextVp);
      if (pic && pic.pages?.length) {
        state.visual = pic;
        state.ratio = pic.pages[0].height / pic.pages[0].width;
        state.visible = 0;
      }
      state.loadingViewport = false;
      cx.notify();
    });
  },

  toolbar(state, env) {
    const t = theme();
    const platform = window()?.platform ?? "macos";
    const pages = state.visual?.pages ?? [];
    const page = state.visible + 1;
    const last = pages.length || 1;
    const step = (id, label, n) =>
      div()
        .id(`html-${id}`)
        .w(22)
        .h(22)
        .flex()
        .items_center()
        .justify_center()
        .rounded(5)
        .text_color(n >= 1 && n <= last ? t.muted : t.dim)
        .when(n >= 1 && n <= last, (el) =>
          el
            .cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => {
              jump(state, n);
              cx.notify();
            }),
        )
        .child(label);

    return h_flex()
      .gap(6)
      .items_center()
      .text_size(12)
      .when(Boolean(state.visual), (el) =>
        el.child(
          segmented([
            ["html-visual", "網頁預覽", state.mode === "visual", () => { state.mode = "visual"; }],
            ["html-raw", "原始碼", state.mode === "raw", (_e, cx) => this.switchToRaw(state, cx)],
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
                  .px(7)
                  .py(2)
                  .rounded(5)
                  .cursor_pointer()
                  .bg(state.viewport === "desktop" ? t.raised : t.chrome)
                  .text_color(state.viewport === "desktop" ? t.foreground : t.muted)
                  .hover((s) => s.text_color(t.foreground))
                  .tooltip("桌面版寬度 (1280px)")
                  .on_click((_e, cx) => this.switchViewport(state, "desktop", cx))
                  .child("桌面"),
              )
              .child(
                div()
                  .id("html-vp-mobile")
                  .px(7)
                  .py(2)
                  .rounded(5)
                  .cursor_pointer()
                  .bg(state.viewport === "mobile" ? t.raised : t.chrome)
                  .text_color(state.viewport === "mobile" ? t.foreground : t.muted)
                  .hover((s) => s.text_color(t.foreground))
                  .tooltip("手機版寬度 (430px)")
                  .on_click((_e, cx) => this.switchViewport(state, "mobile", cx))
                  .child("手機"),
              ),
          )
          .when(last > 1, (el2) =>
            el2.child(
              h_flex()
                .gap(2)
                .p(2)
                .rounded(7)
                .bg(t.chrome)
                .items_center()
                .child(step("prev", "‹", page - 1))
                .child(div().min_w(46).text_center().text_color(t.foreground).child(`${page} / ${last}`))
                .child(step("next", "›", page + 1)),
            ),
          )
          .child(zoomControl(state, state.zoom ?? 1)),
      )
      .when(state.mode === "raw" && Boolean(state.editor), (el) => el.child(wrapButton(state, "html")))
      .when(!env.on, (el) =>
        el.child(
          div()
            .id("cria-file-preview-open-browser")
            .h(26)
            .px(9)
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
    if (state.mode === "raw") {
      if (state.loadingRaw || !state.editor) {
        return div().p(16).text_color(t.muted).child("正在載入 HTML 原始碼…");
      }
      return codeView(state.editor);
    }

    const pages = state.visual?.pages ?? [];
    if (!pages.length) {
      return div().p(16).text_color(t.muted).child("正在渲染網頁畫面…");
    }

    const baseMaxW = state.viewport === "mobile"
      ? Math.min(Math.max(240, env.size.width - 36), 460)
      : Math.max(260, Math.min(env.size.width - 36, 1200));
    const width = Math.round(baseMaxW * (state.zoom ?? 1));
    const height = (p) => Math.round(width * (p ? p.height / p.width : state.ratio));

    const renderPageItem = (i) => {
      const p = pages[i];
      const h = height(p);
      return div()
        .h(h + GAP)
        .w_full()
        .flex()
        .justify_center()
        .pt(GAP)
        .child(
          div()
            .w(width)
            .h(h)
            .flex_none()
            .relative()
            .rounded(6)
            .overflow_hidden()
            .border_1()
            .border_color(t.border)
            .shadow_md()
            .bg("#FFFFFF")
            .when(Boolean(p), (el) => el.child(image(p.path).w(width).h(h).flex_none()))
            .when(pages.length > 1, (el) =>
              el.child(
                div()
                  .absolute()
                  .right(12)
                  .bottom(10)
                  .px(9)
                  .py(3)
                  .rounded(6)
                  .bg("#18181BCC")
                  .text_size(11)
                  .font_semibold()
                  .text_color("#F4F4F5")
                  .child(`Page ${i + 1} / ${pages.length}`),
              ),
            ),
        );
    };

    return v_flex()
      .id(`${state.id}-view`)
      .flex_1()
      .min_h(0)
      .relative()
      .bg(t.canvas)
      .on_mouse_down("left", () => env.focus?.())
      .on_scroll_wheel((e, cx) => {
        if (e.modifiers?.control || e.modifiers?.platform) {
          state.zoom = wheelZoom(state.zoom ?? 1, e.delta.y);
        }
        cx.notify();
      })
      .on_pinch((e, cx) => {
        if (e.delta) {
          state.zoom = pinchZoom(state.zoom ?? 1, e.delta);
          cx.notify();
        }
      })
      .child(
        div()
          .id(`${state.id}-x`)
          .size_full()
          .overflow_x_scrollbar()
          .child(
            v_flex()
              .min_w(width + 36)
              .h_full()
              .child(
                v_virtual_list(
                  state.id,
                  pages.length,
                  pages.map((p) => height(p) + GAP),
                  (i) => `hp${i}`,
                  (range) => {
                    state.visible = range.start;
                    return Array.from({ length: range.end - range.start }, (_, k) =>
                      renderPageItem(range.start + k),
                    );
                  },
                )
                  .track_scroll(state.scroll)
                  .flex_1()
                  .min_h(0),
              ),
          ),
      )
      .child(Scrollbar.vertical(state.id).viewport_from_layout().absolute().inset_0());
  },

  release(state) {
    state.scroll?.release();
    state.editor?.release();
  },
};
