// PPTX / PPT Presentation Viewer for cria-file-preview.
// Matches Google Drive / QuickLook vertical continuous visual slide preview style:
//   - Renders every slide at full 16:9 visual fidelity into high-DPI PNGs, stacked vertically
//     with a bottom-right "Page X / N" badge on each slide.
//   - Automatically uses a sibling exported .pdf if present and fresh, or converts the .pptx/.ppt
//     via macOS QuickLook (qlmanage -p) + CoreGraphics transparent vector rendering + Headless Chrome + PDFKit.
//   - Also provides an "大綱 (Outline)" tab extracted from the OpenXML slide structure.
//   - Supports trackpad two-finger pinch zoom (on_pinch), Cmd+Wheel zoom, and "Open in App ↗".

import { div, image } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle, InputState, Input } from "gpui-base";
import { exec, appHome, theme, window } from "herdr";
import { segmented } from "./controls.js";
import { zoomControl } from "./zoom.js";
import { wheelZoom, pinchZoom } from "../pan-zoom.js";
import { key, pruneCache } from "../media.js";

const GAP = 18;
let views = 0;

const PPTX_VISUAL_PY = String.raw`
import json, os, re, shutil, subprocess, sys, tempfile, urllib.parse, zipfile
import xml.etree.ElementTree as ET

src, cache_dir, file_key = sys.argv[1], sys.argv[2], sys.argv[3]
if not os.path.isfile(src):
    sys.stderr.write("Presentation file not found\n")
    sys.exit(1)

mtime = int(os.path.getmtime(src))
os.makedirs(cache_dir, exist_ok=True)
RENDER_VER = "v4"
meta_path = os.path.join(cache_dir, f"{file_key}-{mtime}-{RENDER_VER}-pptx.json")

if os.path.isfile(meta_path):
    try:
        cached = json.loads(open(meta_path, "r", encoding="utf-8").read())
        if cached.get("pages") and all(os.path.isfile(os.path.join(cache_dir, os.path.basename(p["path"]))) for p in cached["pages"]):
            print(json.dumps(cached, ensure_ascii=False))
            sys.exit(0)
    except Exception:
        pass

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}

def parse_outline(path):
    if not zipfile.is_zipfile(path):
        return []
    out = []
    try:
        with zipfile.ZipFile(path, "r") as zf:
            names = set(zf.namelist())
            slide_paths = []
            if "ppt/presentation.xml" in names and "ppt/_rels/presentation.xml.rels" in names:
                try:
                    rels_root = ET.fromstring(zf.read("ppt/_rels/presentation.xml.rels"))
                    rid_to_target = {}
                    for rel in rels_root:
                        rid = rel.attrib.get("Id")
                        target = rel.attrib.get("Target", "").lstrip("/")
                        if rid and target:
                            if not target.startswith("ppt/"):
                                target = "ppt/" + target
                            rid_to_target[rid] = target
                    pres_root = ET.fromstring(zf.read("ppt/presentation.xml"))
                    for sldId in pres_root.findall(".//p:sldId", NS):
                        rid = sldId.attrib.get(f"{{{NS['r']}}}id")
                        t = rid_to_target.get(rid)
                        if t and t in names:
                            slide_paths.append(t)
                except Exception:
                    slide_paths = []
            if not slide_paths:
                slide_paths = sorted(
                    [n for n in names if re.match(r"^ppt/slides/slide\d+\.xml$", n)],
                    key=lambda x: int(re.search(r"slide(\d+)\.xml$", x).group(1)),
                )
            for idx, spath in enumerate(slide_paths, start=1):
                sroot = ET.fromstring(zf.read(spath))
                title = ""
                bullets = []
                for sp in sroot.findall(".//p:sp", NS):
                    ph = sp.find(".//p:nvSpPr/p:nvPr/p:ph", NS)
                    ph_type = ph.attrib.get("type", "") if ph is not None else ""
                    is_title = ph_type in ("title", "ctrTitle")
                    paras = []
                    for p_el in sp.findall(".//a:p", NS):
                        texts = [t_el.text for t_el in p_el.findall(".//a:t", NS) if t_el.text]
                        line = " ".join("".join(texts).split())
                        if line:
                            paras.append(line)
                    if not paras:
                        continue
                    if len(paras) == 1 and (paras[0].isdigit() or "Confidential" in paras[0]):
                        continue
                    if is_title and not title:
                        title = " ".join(paras)
                    elif not title and len(paras) == 1 and len(paras[0]) <= 65:
                        title = paras[0]
                    else:
                        for line in paras:
                            if line != title and "Confidential" not in line and not line.isdigit():
                                bullets.append(line)
                out.append({"n": idx, "title": title or f"Slide {idx}", "summary": " · ".join(bullets[:6])})
    except Exception:
        pass
    return out

SWIFT_VEC_TO_PNG = """
import Foundation
import CoreGraphics
import ImageIO

let dir = CommandLine.arguments[1]
let fm = FileManager.default
if let items = try? fm.contentsOfDirectory(atPath: dir) {
    for name in items where name.hasSuffix(".pdf") {
        let pdfPath = dir + "/" + name
        let pngPath = dir + "/" + String(name.dropLast(4)) + "_vec.png"
        if fm.fileExists(atPath: pngPath) { continue }
        guard let doc = CGPDFDocument(URL(fileURLWithPath: pdfPath) as CFURL),
              let page = doc.page(at: 1) else { continue }
        let box = page.getBoxRect(.mediaBox)
        let w = max(16, Int(box.width * 2.0))
        let h = max(16, Int(box.height * 2.0))
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { continue }
        ctx.scaleBy(x: 2.0, y: 2.0)
        ctx.drawPDFPage(page)
        guard let cgImg = ctx.makeImage(),
              let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: pngPath) as CFURL, "public.png" as CFString, 1, nil) else { continue }
        CGImageDestinationAddImage(dest, cgImg, nil)
        CGImageDestinationFinalize(dest)
    }
}
"""

def clean_ql_html(pptx_path, html):
    if not zipfile.is_zipfile(pptx_path):
        return html
    m = re.search(r"div\.slide,\s*div\.loading-slide\s*\{\s*width:\s*(\d+);\s*height:\s*(\d+);", html)
    sw, sh = (int(m.group(1)), int(m.group(2))) if m else (960, 540)

    theme_colors = {
        "bg1": "FFFFFF", "lt1": "FFFFFF", "dk1": "000000", "tx1": "000000",
        "bg2": "F5EEF8", "lt2": "F5EEF8", "dk2": "301D40", "tx2": "301D40",
        "accent1": "45285C", "accent2": "9869B5", "accent3": "C85A32",
        "accent4": "E0A55A", "accent5": "2E6B4E", "accent6": "E2D6EC",
    }
    slide_data = []
    try:
        with zipfile.ZipFile(pptx_path, "r") as z:
            names = set(z.namelist())
            for tname in sorted(n for n in names if re.match(r"^ppt/theme/theme\d+\.xml$", n)):
                try:
                    troot = ET.fromstring(z.read(tname))
                    cscheme = troot.find(".//a:clrScheme", NS)
                    if cscheme is not None:
                        for child in cscheme:
                            k = child.tag.split("}")[-1]
                            srgb = child.find(".//a:srgbClr", NS)
                            sysclr = child.find(".//a:sysClr", NS)
                            if srgb is not None and "val" in srgb.attrib:
                                theme_colors[k] = srgb.attrib["val"]
                            elif sysclr is not None and "lastClr" in sysclr.attrib:
                                theme_colors[k] = sysclr.attrib["lastClr"]
                except Exception:
                    pass
            theme_colors["bg1"] = theme_colors.get("lt1", "FFFFFF")
            theme_colors["bg2"] = theme_colors.get("lt2", "F5EEF8")
            theme_colors["tx1"] = theme_colors.get("dk1", "000000")
            theme_colors["tx2"] = theme_colors.get("dk2", "301D40")

            emu_w, emu_h = 12192000, 6858000
            if "ppt/presentation.xml" in names:
                try:
                    proot = ET.fromstring(z.read("ppt/presentation.xml"))
                    sz = proot.find("p:sldSz", NS)
                    if sz is not None:
                        emu_w = int(sz.attrib.get("cx", emu_w))
                        emu_h = int(sz.attrib.get("cy", emu_h))
                except Exception:
                    pass

            def resolve_color(el):
                if el is None:
                    return None
                srgb = el.find("a:srgbClr", NS)
                if srgb is not None and "val" in srgb.attrib:
                    return "#" + srgb.attrib["val"]
                sch = el.find("a:schemeClr", NS)
                if sch is not None and "val" in sch.attrib:
                    return "#" + theme_colors.get(sch.attrib["val"], "FFFFFF")
                return None

            slide_files = sorted(
                [n for n in names if re.match(r"^ppt/slides/slide\d+\.xml$", n)],
                key=lambda x: int(re.search(r"slide(\d+)\.xml$", x).group(1)),
            )
            for sf in slide_files:
                sroot = ET.fromstring(z.read(sf))
                all_boxes = []
                filled_shapes = []
                for xfrm in sroot.findall(".//a:xfrm", NS):
                    off = xfrm.find("a:off", NS)
                    ext = xfrm.find("a:ext", NS)
                    if off is not None and ext is not None and "x" in off.attrib and "cx" in ext.attrib:
                        x = float(off.attrib["x"]) / emu_w * sw
                        y = float(off.attrib["y"]) / emu_h * sh
                        w = float(ext.attrib["cx"]) / emu_w * sw
                        h = float(ext.attrib["cy"]) / emu_h * sh
                        if w > 0 or h > 0:
                            all_boxes.append((x, y, w, h))
                for sp in sroot.findall(".//p:sp", NS):
                    spPr = sp.find("p:spPr", NS)
                    if spPr is None:
                        continue
                    xfrm = spPr.find("a:xfrm", NS)
                    if xfrm is None:
                        continue
                    off, ext = xfrm.find("a:off", NS), xfrm.find("a:ext", NS)
                    if off is None or ext is None or "x" not in off.attrib or "cx" not in ext.attrib:
                        continue
                    x = float(off.attrib["x"]) / emu_w * sw
                    y = float(off.attrib["y"]) / emu_h * sh
                    w = float(ext.attrib["cx"]) / emu_w * sw
                    h = float(ext.attrib["cy"]) / emu_h * sh
                    sfill = spPr.find("a:solidFill", NS)
                    fill_clr = resolve_color(sfill)
                    ln = spPr.find("a:ln", NS)
                    ln_clr = resolve_color(ln.find("a:solidFill", NS)) if ln is not None else None
                    prst = spPr.find("a:prstGeom", NS)
                    geom = prst.attrib.get("prst", "rect") if prst is not None else "rect"
                    if fill_clr or ln_clr:
                        filled_shapes.append({
                            "x": x, "y": y, "w": w, "h": h,
                            "fill": fill_clr, "stroke": ln_clr, "geom": geom,
                            "matched": False,
                        })
                slide_data.append((all_boxes, filled_shapes))
    except Exception:
        return html

    seen_pdfs = set()
    slide_idx = [0]

    def process_slide(match):
        s_html = match.group(0)
        idx = slide_idx[0]
        slide_idx[0] += 1
        if idx >= len(slide_data):
            return s_html
        all_boxes, filled_shapes = slide_data[idx]

        img_pattern = re.compile(r'<img\s+src="(Attachment\d+\.pdf)"\s+style="([^"]+)"[^>]*>')
        imgs = list(img_pattern.finditer(s_html))
        keep_flags = []
        for im in imgs:
            src, st = im.group(1), im.group(2)
            tm = re.search(r"top:(-?\d+);\s*left:(-?\d+);\s*width:(\d+);\s*height:(\d+)", st)
            if not tm:
                keep_flags.append(True)
                seen_pdfs.add(src)
                continue
            top, left, width, height = map(float, tm.groups())
            icx, icy = left + width / 2.0, top + height / 2.0
            matched_fs = None
            for fs in filled_shapes:
                if fs["matched"]:
                    continue
                fcx, fcy = fs["x"] + fs["w"] / 2.0, fs["y"] + fs["h"] / 2.0
                if abs(icx - fcx) <= 24 and abs(icy - fcy) <= 24 and abs(width - fs["w"]) <= 64 and abs(height - fs["h"]) <= 64:
                    matched_fs = fs
                    break
            if matched_fs is not None:
                matched_fs["matched"] = True
                keep_flags.append(True)
            else:
                is_ghost = src in seen_pdfs
                keep_flags.append(not is_ghost)
            seen_pdfs.add(src)

        unmatched_shapes = sorted(
            [fs for fs in filled_shapes if not fs["matched"]],
            key=lambda s: s["w"] * s["h"],
            reverse=True,
        )
        img_counter = [0]

        def remove_ghost_img(im):
            k = img_counter[0]
            img_counter[0] += 1
            return im.group(0) if keep_flags[k] else ""

        cleaned_html = img_pattern.sub(remove_ghost_img, s_html)

        # Insert each unmatched shape right before the first child element whose center lies inside the shape
        pos_el_pattern = re.compile(r'<(?:div|img)\b[^>]*style="position:absolute;\s*top:(-?\d+(?:\.\d+)?);\s*left:(-?\d+(?:\.\d+)?);\s*width:(\d+(?:\.\d+)?);\s*height:(\d+(?:\.\d+)?);[^"]*"[^>]*>')
        for fs in unmatched_shapes:
            radius = "50%" if fs["geom"] == "ellipse" else ("10px" if "round" in fs["geom"].lower() else "0px")
            fill_val = fs["fill"]
            stroke_val = fs["stroke"]
            bg = f"background-color:{fill_val};" if fill_val else ""
            bd = f"border:1px solid {stroke_val};" if stroke_val else ""
            top_v, left_v, w_v, h_v = fs["y"], fs["x"], fs["w"], fs["h"]
            shape_div = f'<div style="position:absolute; top:{top_v:.1f}px; left:{left_v:.1f}px; width:{w_v:.1f}px; height:{h_v:.1f}px; {bg} {bd} border-radius:{radius}; box-sizing:border-box;"></div>'

            insert_pos = None
            for pm in pos_el_pattern.finditer(cleaned_html):
                et, el, ew, eh = map(float, pm.groups())
                ecx, ecy = el + ew / 2.0, et + eh / 2.0
                # Element center is inside shape bounds and element is not larger than the shape itself
                if (left_v - 6 <= ecx <= left_v + w_v + 6) and (top_v - 6 <= ecy <= top_v + h_v + 6) and (ew * eh <= w_v * h_v * 1.15 + 100):
                    insert_pos = pm.start()
                    break
            if insert_pos is not None:
                cleaned_html = cleaned_html[:insert_pos] + shape_div + cleaned_html[insert_pos:]
            else:
                end_idx = cleaned_html.rfind("</div>")
                if end_idx >= 0:
                    cleaned_html = cleaned_html[:end_idx] + shape_div + cleaned_html[end_idx:]

        return cleaned_html

    return re.sub(r'<div class="slide"[^>]*>.*?(?=<div class="slide"|</body>)', process_slide, html, flags=re.S)

def valid_sibling_slide_pdf(cand_pdf, expected_slides):
    if expected_slides <= 0:
        return False
    check_jxa = """
    ObjC.import('Foundation'); ObjC.import('PDFKit');
    function run(argv) {
      var doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath($(argv[0])));
      if (!doc || doc.isNil()) return "0,0,0";
      var c = Number(doc.pageCount);
      if (c <= 0) return "0,0,0";
      var box = doc.pageAtIndex(0).boundsForBox(1);
      return c + "," + Math.round(box.size.width) + "," + Math.round(box.size.height);
    }
    """
    try:
        out = subprocess.check_output(["osascript", "-l", "JavaScript", "-e", check_jxa, cand_pdf], text=True, timeout=5).strip()
        c, w, h = [int(x) for x in out.split(",")]
        return c == expected_slides and w > h
    except Exception:
        return False

def build_pdf_from_pptx(pptx_path, target_pdf, expected_slides=0):
    # 1. Check if an exported sibling .pdf exists right next to the .pptx AND matches slide count & landscape aspect ratio
    stem = os.path.splitext(pptx_path)[0]
    for cand in (stem + ".pdf", stem + ".PDF"):
        if os.path.isfile(cand) and os.path.getmtime(cand) >= os.path.getmtime(pptx_path) - 86400:
            if valid_sibling_slide_pdf(cand, expected_slides):
                shutil.copyfile(cand, target_pdf)
                return True

    # 2. Otherwise convert via macOS QuickLook (qlmanage -p) + ghost shape cleanup + CoreGraphics transparent vector PNGs + Headless Chrome
    browsers = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ]
    browser = next((b for b in browsers if os.path.isfile(b)), None)
    if not browser:
        return False

    tmp_dir = tempfile.mkdtemp(prefix="herdr_pptx_")
    try:
        subprocess.run(["qlmanage", "-p", "-o", tmp_dir, pptx_path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        ql_dirs = [os.path.join(tmp_dir, d) for d in os.listdir(tmp_dir) if d.endswith(".qlpreview")]
        if not ql_dirs:
            return False
        ql_dir = ql_dirs[0]
        html_path = os.path.join(ql_dir, "Preview.html")
        if not os.path.isfile(html_path):
            return False

        with open(html_path, "r", encoding="utf-8", errors="ignore") as f:
            html = f.read()
        html = clean_ql_html(pptx_path, html)
        subprocess.run(["swift", "-e", SWIFT_VEC_TO_PNG, ql_dir], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=25)
        html = re.sub(r"(Attachment\d+)\.pdf", r"\1_vec.png", html)
        m = re.search(r"div\.slide,\s*div\.loading-slide\s*\{\s*width:\s*(\d+);\s*height:\s*(\d+);", html)
        sw, sh = (int(m.group(1)), int(m.group(2))) if m else (720, 405)
        print_css = f"""
        <style>
        @page {{ size: {sw}px {sh}px; margin: 0; }}
        html, body {{ margin: 0 !important; padding: 0 !important; background: #fff !important; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }}
        div.slide {{ margin: 0 !important; page-break-after: always !important; break-after: page !important; box-shadow: none !important; -webkit-box-shadow: none !important; }}
        div.loading-slide {{ display: none !important; }}
        </style>
        """
        html = html.replace("</head>", print_css + "</head>", 1)
        patched = os.path.join(ql_dir, "Preview_render.html")
        with open(patched, "w", encoding="utf-8") as f:
            f.write(html)
        file_url = "file://" + urllib.parse.quote(os.path.abspath(patched))
        subprocess.run([
            browser, "--headless", "--disable-gpu", "--no-pdf-header-footer",
            f"--print-to-pdf={target_pdf}", file_url
        ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=25)
        return os.path.isfile(target_pdf)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)

outline = parse_outline(src)
pdf_cache = os.path.join(cache_dir, f"{file_key}-{mtime}-{RENDER_VER}-slides.pdf")
if not os.path.isfile(pdf_cache):
    build_pdf_from_pptx(src, pdf_cache, expected_slides=len(outline))

pages = []
if os.path.isfile(pdf_cache):
    jxa = """
    ObjC.import('Foundation'); ObjC.import('AppKit'); ObjC.import('PDFKit');
    function run(argv) {
      var source = argv[0], dir = argv[1], prefix = argv[2], wide = Number(argv[3]);
      var fm = $.NSFileManager.defaultManager;
      var doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath($(source)));
      if (!doc || doc.isNil()) return "[]";
      var count = Math.min(Number(doc.pageCount), 200), out = [];
      for (var n = 1; n <= count; n++) {
        var name = prefix + '-s' + n + '.png', path = dir + '/' + name;
        var page = doc.pageAtIndex(n - 1), box = page.boundsForBox(1);
        var w = box.size.width, h = box.size.height;
        if (!fm.fileExistsAtPath($(path))) {
          var picture = page.thumbnailOfSizeForBox($.NSMakeSize(wide, wide * h / w), 1);
          var bitmap = $.NSBitmapImageRep.imageRepWithData(picture.TIFFRepresentation);
          var png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
          png.writeToFileAtomically($(path), true);
        }
        out.push({ n: n, path: 'data/cria-file-preview/' + name, width: w, height: h });
      }
      return JSON.stringify(out);
    }
    """
    prefix = f"{file_key}-{mtime}-{RENDER_VER}"
    raw_pages = subprocess.check_output(["osascript", "-l", "JavaScript", "-e", jxa, pdf_cache, cache_dir, prefix, "1600"], text=True)
    pages = json.loads(raw_pages.strip())

result = {
    "count": len(pages) or len(outline) or 1,
    "pages": pages,
    "outline": outline,
}
with open(meta_path, "w", encoding="utf-8") as mf:
    json.dump(result, mf, ensure_ascii=False)
print(json.dumps(result, ensure_ascii=False))
`;

function openExternalApp(file, on) {
  const platform = window()?.platform;
  if (on) return;
  if (platform === "macos") exec("open", [file]).catch(() => null);
  else if (platform === "windows") exec("cmd", ["/c", "start", "", file]).catch(() => null);
  else exec("xdg-open", [file]).catch(() => null);
}

function jump(state, n) {
  n = Math.max(1, Math.min(state.count, n));
  state.visible = n - 1;
  state.scroll.scroll_to_item(n - 1, "top");
}

export default {
  id: "pptx",
  async load(file, env, previous) {
    if (env.on) throw new Error("PPTX previews work for files on this computer only");
    const dir = `${appHome().split("\\").join("/")}/data/cria-file-preview`;
    const k = key(file);
    const r = await exec("python3", ["-c", PPTX_VISUAL_PY, file, dir, k]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot read this presentation");
    pruneCache();
    const parsed = JSON.parse(r.stdout.trim());
    const pages = parsed.pages ?? [];
    const outline = parsed.outline ?? [];
    const count = pages.length || outline.length || 1;
    const ratio = pages[0] ? pages[0].height / pages[0].width : 9 / 16;
    const state = {
      file,
      count,
      pages,
      outline,
      ratio,
      mode: previous?.mode ?? "slides", // "slides" | "outline"
      visible: 0,
      zoom: previous?.zoom ?? null,
      id: `cria-file-preview-pptx-${++views}`,
      scroll: VirtualListScrollHandle.new(),
      goto: InputState.new({ placeholder: "Go to" }),
    };
    state.goto.on("submit", (_e, cx) => {
      const n = parseInt(state.goto.value(), 10);
      if (n > 0) {
        state.mode = "slides";
        jump(state, n);
      }
      state.goto.set_value("");
      cx.notify();
    });
    return state;
  },

  toolbar(state, env) {
    const t = theme();
    const page = state.visible + 1, last = state.count;
    const step = (id, label, n) =>
      div()
        .id(`pptx-${id}`)
        .w(24)
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
              state.mode = "slides";
              jump(state, n);
              cx.notify();
            }),
        )
        .child(label);

    return h_flex()
      .gap(6)
      .items_center()
      .text_size(12)
      .child(
        segmented([
          ["pptx-slides", "投影片", state.mode === "slides", () => { state.mode = "slides"; }],
          ["pptx-outline", "大綱", state.mode === "outline", () => { state.mode = "outline"; }],
        ]),
      )
      .child(
        h_flex()
          .gap(2)
          .p(2)
          .rounded(7)
          .bg(t.chrome)
          .items_center()
          .child(step("prev", "‹", page - 1))
          .child(div().min_w(58).text_center().text_color(t.foreground).child(`${page} / ${state.count}`))
          .child(step("next", "›", page + 1)),
      )
      .child(zoomControl(state, state.zoom ?? 1))
      .child(
        div()
          .id("pptx-open-app")
          .px(9)
          .py(4)
          .rounded(6)
          .cursor_pointer()
          .bg(t.raised)
          .text_color(t.foreground)
          .hover((s) => s.bg(t.hover))
          .tooltip("以 Microsoft PowerPoint 或 Keynote 開啟原始簡報")
          .on_click(() => openExternalApp(env.file, env.on))
          .child("Open in App ↗"),
      );
  },

  render(state, env) {
    const t = theme();
    if (state.mode === "outline" || !state.pages.length) {
      return v_flex()
        .id(`${state.id}-outline`)
        .size_full()
        .overflow_y_scrollbar()
        .p(16)
        .gap(8)
        .bg(t.canvas)
        .children(
          state.outline.map((s) =>
            h_flex()
              .id(`${state.id}-out-${s.n}`)
              .w_full()
              .p(12)
              .gap(12)
              .rounded(9)
              .items_center()
              .cursor_pointer()
              .bg(s.n === state.visible + 1 ? t.selected : t.surface)
              .border_1()
              .border_color(s.n === state.visible + 1 ? t.accent : t.border)
              .hover((st) => st.bg(t.hover))
              .on_click((_e, cx) => {
                state.mode = "slides";
                jump(state, s.n);
                cx.notify();
              })
              .child(
                div()
                  .w(32)
                  .h(24)
                  .rounded(5)
                  .bg(t.raised)
                  .flex()
                  .items_center()
                  .justify_center()
                  .text_size(11.5)
                  .font_semibold()
                  .text_color(t.accent)
                  .child(String(s.n)),
              )
              .child(
                v_flex()
                  .flex_1()
                  .min_w(0)
                  .gap(2)
                  .child(div().font_semibold().text_size(13.5).text_color(t.foreground).truncate().child(s.title))
                  .when(Boolean(s.summary), (el) =>
                    el.child(div().text_size(12).text_color(t.muted).truncate().child(s.summary)),
                  ),
              ),
          ),
        );
    }

    const width = Math.max(200, (Math.min(env.size.width, 1200) - 36) * (state.zoom ?? 1));
    const height = (p) => Math.round(width * (p ? p.height / p.width : state.ratio));

    const slideItem = (i) => {
      const p = state.pages[i];
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
            .shadow_lg()
            .border_1()
            .border_color(t.border)
            .child(image(p.path).w(width).h(h).flex_none())
            // Google Drive-style bottom-right "Page X / N" badge
            .child(
              div()
                .absolute()
                .right(12)
                .bottom(10)
                .px(10)
                .py(4)
                .rounded(6)
                .bg("#14171fd9")
                .border_1()
                .border_color("#ffffff22")
                .text_size(12)
                .font_semibold()
                .text_color("#ffffff")
                .child(`Page ${i + 1} / ${state.count}`),
            ),
        );
    };

    return v_flex()
      .id(`${state.id}-view`)
      .flex_1()
      .min_h(0)
      .relative()
      .bg("#0d0f14")
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
                  state.pages.length,
                  state.pages.map((p) => height(p) + GAP),
                  (i) => `s${i}`,
                  (range) => {
                    state.visible = range.start;
                    return Array.from({ length: range.end - range.start }, (_, k) => slideItem(range.start + k));
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
    state.goto?.release();
  },
};
