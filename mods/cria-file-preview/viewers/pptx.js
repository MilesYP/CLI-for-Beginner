// PPTX / PPT presentation viewer for cria-file-preview.
// Parses .pptx slides (titles, hierarchical bullet points, tables, embedded media images,
// and speaker notes) using macOS/system python3 standard library (zipfile + xml.etree),
// staging embedded images into data/cria-file-preview/ for native GPUI rendering.
// Supports 16:9 Slide Cards view, Outline view, speaker notes toggle, trackpad pinch zoom,
// and "Open in App" (Keynote / PowerPoint).

import { div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, appHome, theme, window } from "herdr";
import { segmented } from "./controls.js";
import { zoomControl } from "./zoom.js";
import { wheelZoom, pinchZoom } from "../pan-zoom.js";
import { key, pruneCache } from "../media.js";

let views = 0;

const PPTX_PARSER_PY = String.raw`
import json, os, re, shutil, subprocess, sys, zipfile
import xml.etree.ElementTree as ET

src, cache_dir, file_key = sys.argv[1], sys.argv[2], sys.argv[3]
if not os.path.isfile(src):
    sys.stderr.write("File not found\n")
    sys.exit(1)

mtime = int(os.path.getmtime(src))
os.makedirs(cache_dir, exist_ok=True)

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}

def local_tag(tag):
    return tag.split("}", 1)[-1] if "}" in tag else tag

def image_dims(path):
    try:
        out = subprocess.check_output(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path], text=True, stderr=subprocess.DEVNULL)
        w = int(re.search(r"pixelWidth:\s*(\d+)", out).group(1))
        h = int(re.search(r"pixelHeight:\s*(\d+)", out).group(1))
        return w, h
    except Exception:
        return 640, 360

def parse_pptx(path):
    slides_out = []
    with zipfile.ZipFile(path, "r") as zf:
        names = set(zf.namelist())
        # Determine slide order from presentation.xml + rels if possible
        slide_paths = []
        if "ppt/presentation.xml" in names and "ppt/_rels/presentation.xml.rels" in names:
            try:
                rels_root = ET.fromstring(zf.read("ppt/_rels/presentation.xml.rels"))
                rid_to_target = {}
                for rel in rels_root:
                    rid = rel.attrib.get("Id")
                    target = rel.attrib.get("Target", "")
                    if rid and target:
                        t = target.lstrip("/")
                        if not t.startswith("ppt/"):
                            t = "ppt/" + t
                        rid_to_target[rid] = t
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
            sname = os.path.basename(spath)
            rels_path = f"ppt/slides/_rels/{sname}.rels"
            rid_map = {}
            notes_target = None
            if rels_path in names:
                try:
                    rroot = ET.fromstring(zf.read(rels_path))
                    for rel in rroot:
                        rid = rel.attrib.get("Id")
                        target = rel.attrib.get("Target", "")
                        rtype = rel.attrib.get("Type", "")
                        norm = os.path.normpath(os.path.join("ppt/slides", target)).replace("\\", "/")
                        if rid:
                            rid_map[rid] = norm
                        if "notesSlide" in rtype and norm in names:
                            notes_target = norm
                except Exception:
                    pass

            title = ""
            subtitle = ""
            bullets = []
            tables = []
            images = []

            # Walk shapes in spTree (note: in PresentationML, txBody is p:txBody, and paragraphs are a:p)
            for sp in sroot.findall(".//p:sp", NS):
                ph = sp.find(".//p:nvSpPr/p:nvPr/p:ph", NS)
                ph_type = ph.attrib.get("type", "") if ph is not None else ""
                is_title = ph_type in ("title", "ctrTitle")
                is_sub = ph_type in ("subTitle", "body") and not title and idx == 1

                paras = []
                for p_el in sp.findall(".//a:p", NS):
                    pPr = p_el.find("a:pPr", NS)
                    lvl = int(pPr.attrib.get("lvl", "0")) if pPr is not None and pPr.attrib.get("lvl", "").isdigit() else 0
                    texts = [t_el.text for t_el in p_el.findall(".//a:t", NS) if t_el.text]
                    line = " ".join("".join(texts).split())
                    if line:
                        paras.append((lvl, line))

                if not paras:
                    continue
                # Skip footer boilerplate like "Wadiz x CLICKFORCE | Confidential" or pure slide numbers
                if len(paras) == 1 and (paras[0][1].isdigit() or "Confidential" in paras[0][1]):
                    continue
                if is_title and not title:
                    title = " ".join(t for _, t in paras)
                elif is_sub and not subtitle:
                    subtitle = " ".join(t for _, t in paras)
                elif not title and len(paras) == 1 and len(paras[0][1]) <= 65:
                    title = paras[0][1]
                elif not subtitle and title and len(bullets) == 0 and len(paras) == 1 and len(paras[0][1]) <= 110:
                    subtitle = paras[0][1]
                else:
                    for lvl, line in paras:
                        if line != title and line != subtitle and "Confidential" not in line and not line.isdigit():
                            bullets.append({"level": lvl, "text": line})

            # Fallback if no title placeholder found: promote first short line
            if not title and bullets:
                first = bullets[0]["text"]
                if len(first) <= 60:
                    title = first
                    bullets = bullets[1:]

            # Extract tables
            for tbl in sroot.findall(".//a:tbl", NS):
                rows_data = []
                for tr in tbl.findall("a:tr", NS):
                    row_cells = []
                    for tc in tr.findall("a:tc", NS):
                        cell_texts = [t_el.text for t_el in tc.findall(".//a:t", NS) if t_el.text]
                        row_cells.append(" ".join("".join(cell_texts).split()))
                    if any(row_cells):
                        rows_data.append(row_cells)
                if rows_data:
                    tables.append(rows_data)

            # Extract embedded pictures
            img_idx = 0
            for blip in sroot.findall(".//a:blip", NS):
                embed_id = blip.attrib.get(f"{{{NS['r']}}}embed")
                media_path = rid_map.get(embed_id)
                if not media_path or media_path not in names:
                    continue
                ext = os.path.splitext(media_path)[1].lower().lstrip(".")
                if ext not in ("png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff"):
                    continue
                img_idx += 1
                out_name = f"{file_key}-{mtime}-s{idx}-i{img_idx}.{ext}"
                out_full = os.path.join(cache_dir, out_name)
                if not os.path.isfile(out_full):
                    with zf.open(media_path) as src_f, open(out_full, "wb") as dst_f:
                        shutil.copyfileobj(src_f, dst_f)
                w, h = image_dims(out_full)
                images.append({
                    "path": f"data/cria-file-preview/{out_name}",
                    "width": w,
                    "height": h,
                })

            # Extract speaker notes
            notes_lines = []
            if notes_target and notes_target in names:
                try:
                    nroot = ET.fromstring(zf.read(notes_target))
                    for sp in nroot.findall(".//p:sp", NS):
                        ph = sp.find(".//p:nvSpPr/p:nvPr/p:ph", NS)
                        ph_type = ph.attrib.get("type", "") if ph is not None else ""
                        if ph_type in ("sldImg", "sldNum", "hdr", "ftr"):
                            continue
                        for p_el in sp.findall(".//a:txBody/a:p", NS):
                            texts = [t_el.text for t_el in p_el.findall(".//a:t", NS) if t_el.text]
                            line = "".join(texts).strip()
                            if line and not line.isdigit():
                                notes_lines.append(line)
                except Exception:
                    pass

            slides_out.append({
                "n": idx,
                "title": title or f"Slide {idx}",
                "subtitle": subtitle,
                "bullets": bullets,
                "tables": tables,
                "images": images,
                "notes": "\n".join(notes_lines),
            })
    return slides_out

try:
    if zipfile.is_zipfile(src):
        slides = parse_pptx(src)
        print(json.dumps({"format": "pptx", "count": len(slides), "slides": slides}, ensure_ascii=False))
    else:
        # Legacy binary .ppt fallback: extract readable strings
        raw = open(src, "rb").read()
        utf16_chunks = [m.group(0).decode("utf-16le", errors="ignore").strip() for m in re.finditer(rb"(?:[\x20-\x7e\u4e00-\u9fff]\x00){4,}", raw)]
        lines = [c for c in utf16_chunks if len(c) >= 3 and not c.startswith("Microsoft") and "PowerPoint" not in c][:60]
        slides = [{
            "n": 1,
            "title": os.path.basename(src) + " (舊版 .ppt 格式)",
            "subtitle": "建議另存為 .pptx 或點擊右上角 Open in App 以 Keynote / PowerPoint 開啟",
            "bullets": [{"level": 0, "text": l} for l in lines],
            "tables": [],
            "images": [],
            "notes": "",
        }]
        print(json.dumps({"format": "ppt", "count": 1, "slides": slides}, ensure_ascii=False))
except Exception as e:
    sys.stderr.write(f"Cannot parse presentation: {e}\n")
    sys.exit(1)
`;

function openExternalApp(file, on) {
  const platform = window()?.platform;
  if (on) return;
  if (platform === "macos") exec("open", [file]).catch(() => null);
  else if (platform === "windows") exec("cmd", ["/c", "start", "", file]).catch(() => null);
  else exec("xdg-open", [file]).catch(() => null);
}

export default {
  id: "pptx",
  async load(file, env, previous) {
    if (env.on) throw new Error("PPTX previews work for files on this computer only");
    const dir = `${appHome().split("\\").join("/")}/data/cria-file-preview`;
    const k = key(file);
    const r = await exec("python3", ["-c", PPTX_PARSER_PY, file, dir, k]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot read this presentation");
    pruneCache();
    const parsed = JSON.parse(r.stdout.trim());
    const slides = parsed.slides?.length ? parsed.slides : [{
      n: 1, title: "Empty presentation", subtitle: "", bullets: [], tables: [], images: [], notes: ""
    }];
    const current = Math.max(1, Math.min(slides.length, previous?.current ?? 1));
    return {
      file,
      count: slides.length,
      slides,
      current,
      mode: previous?.mode ?? "slide", // "slide" | "all" | "outline"
      showNotes: previous?.showNotes ?? true,
      zoom: previous?.zoom ?? null,
      id: `cria-file-preview-pptx-${++views}`,
    };
  },

  toolbar(state, env) {
    const t = theme();
    const cur = state.current, total = state.count;
    const step = (id, label, target) =>
      div()
        .id(`pptx-${id}`)
        .w(24)
        .h(22)
        .flex()
        .items_center()
        .justify_center()
        .rounded(5)
        .text_color(target >= 1 && target <= total ? t.muted : t.dim)
        .when(target >= 1 && target <= total, (el) =>
          el
            .cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => {
              state.current = target;
              if (state.mode === "outline") state.mode = "slide";
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
          ["pptx-slide", "單頁", state.mode === "slide", () => { state.mode = "slide"; }],
          ["pptx-all", "連續", state.mode === "all", () => { state.mode = "all"; }],
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
          .child(step("prev", "‹", cur - 1))
          .child(div().min_w(54).text_center().text_color(t.foreground).child(`${cur} / ${total}`))
          .child(step("next", "›", cur + 1)),
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
          .tooltip("以 Keynote 或 PowerPoint 開啟原始簡報")
          .on_click(() => openExternalApp(env.file, env.on))
          .child("Open in App ↗"),
      );
  },

  render(state, env) {
    const t = theme();
    const scale = state.zoom ?? 1;
    const cardW = Math.max(280, Math.min(env.size.width - 40, 920) * scale);

    const renderSlideCard = (s, isCurrent) => {
      const hasNotes = Boolean(state.showNotes && s.notes);
      return v_flex()
        .id(`${state.id}-card-${s.n}`)
        .w(cardW)
        .min_h(Math.round(cardW * 0.5625))
        .flex_none()
        .rounded(12)
        .bg(t.surface)
        .border_1()
        .border_color(isCurrent ? t.accent : t.border)
        .shadow_md()
        .overflow_hidden()
        // Top slide accent bar + slide number header
        .child(
          h_flex()
            .w_full()
            .h(36)
            .px(18)
            .items_center()
            .justify_between()
            .bg(t.raised)
            .border_b(1)
            .border_color(t.border)
            .child(
              h_flex()
                .gap(8)
                .items_center()
                .child(
                  div()
                    .px(7)
                    .py(1)
                    .rounded(5)
                    .bg(t.selected)
                    .text_size(11)
                    .font_semibold()
                    .text_color(t.accent)
                    .child(`SLIDE ${s.n}`),
                )
                .when(Boolean(s.subtitle), (el) =>
                  el.child(div().text_size(11.5).text_color(t.muted).truncate().child(s.subtitle)),
                ),
            )
            .child(div().text_size(11).text_color(t.dim).child(`${s.n} / ${state.count}`)),
        )
        // Slide main body
        .child(
          v_flex()
            .flex_1()
            .p(Math.round(22 * scale))
            .gap(Math.round(14 * scale))
            .child(
              div()
                .text_size(Math.round(21 * scale))
                .font_bold()
                .text_color(t.foreground)
                .child(s.title),
            )
            .when(Boolean(s.subtitle), (el) =>
              el.child(
                div()
                  .text_size(Math.round(14.5 * scale))
                  .text_color(t.muted)
                  .child(s.subtitle),
              ),
            )
            // Bullet points
            .when(s.bullets?.length > 0, (el) =>
              el.child(
                v_flex()
                  .gap(Math.round(8 * scale))
                  .children(
                    s.bullets.map((b) => {
                      const lvl = Math.min(4, b.level || 0);
                      const marker = lvl === 0 ? "●" : lvl === 1 ? "○" : "▪";
                      return h_flex()
                        .pl(lvl * Math.round(18 * scale))
                        .gap(8)
                        .items_start()
                        .child(
                          div()
                            .text_size(Math.round(11 * scale))
                            .text_color(lvl === 0 ? t.accent : t.dim)
                            .mt(2)
                            .child(marker),
                        )
                        .child(
                          div()
                            .flex_1()
                            .text_size(Math.round((lvl === 0 ? 14.5 : 13.5) * scale))
                            .text_color(lvl === 0 ? t.foreground : t.muted)
                            .child(b.text),
                        );
                    }),
                  ),
              ),
            )
            // Embedded images
            .when(s.images?.length > 0, (el) =>
              el.child(
                h_flex()
                  .flex_wrap()
                  .gap(12)
                  .pt(6)
                  .children(
                    s.images.map((img) => {
                      const maxW = Math.min(cardW - 60, Math.round(360 * scale));
                      const ratio = img.height && img.width ? img.height / img.width : 0.6;
                      const w = Math.max(120, Math.min(maxW, Math.round(img.width * scale)));
                      const h = Math.round(w * ratio);
                      return image(img.path).w(w).h(h).flex_none().rounded(8).border_1().border_color(t.border);
                    }),
                  ),
              ),
            )
            // Tables
            .when(s.tables?.length > 0, (el) =>
              el.children(
                s.tables.map((tbl) =>
                  v_flex()
                    .mt(6)
                    .rounded(8)
                    .border_1()
                    .border_color(t.border)
                    .overflow_hidden()
                    .children(
                      tbl.map((row, rIdx) =>
                        h_flex()
                          .w_full()
                          .bg(rIdx === 0 ? t.raised : t.background)
                          .border_b(rIdx < tbl.length - 1 ? 1 : 0)
                          .border_color(t.border)
                          .children(
                            row.map((cell) =>
                              div()
                                .flex_1()
                                .px(10)
                                .py(6)
                                .text_size(Math.round(12.5 * scale))
                                .font_weight(rIdx === 0 ? "semibold" : "normal")
                                .text_color(rIdx === 0 ? t.foreground : t.muted)
                                .child(cell || " "),
                            ),
                          ),
                      ),
                    ),
                ),
              ),
            )
            .when(!s.bullets?.length && !s.images?.length && !s.tables?.length && !s.subtitle, (el) =>
              el.child(div().text_size(13).text_color(t.dim).child("（此頁投影片僅含背景或自訂圖形）")),
            ),
        )
        // Speaker Notes footer
        .when(hasNotes, (el) =>
          el.child(
            v_flex()
              .w_full()
              .px(18)
              .py(10)
              .gap(4)
              .bg(t.chrome)
              .border_t(1)
              .border_color(t.border)
              .child(div().text_size(11).font_semibold().text_color(t.dim).child("📝 講者備忘稿 (Speaker Notes)"))
              .child(div().text_size(12.5).text_color(t.muted).child(s.notes)),
          ),
        );
    };

    if (state.mode === "outline") {
      return v_flex()
        .id(`${state.id}-outline`)
        .size_full()
        .overflow_y_scrollbar()
        .p(16)
        .gap(8)
        .bg(t.canvas)
        .children(
          state.slides.map((s) =>
            h_flex()
              .id(`${state.id}-out-${s.n}`)
              .w_full()
              .p(12)
              .gap(12)
              .rounded(9)
              .items_center()
              .cursor_pointer()
              .bg(s.n === state.current ? t.selected : t.surface)
              .border_1()
              .border_color(s.n === state.current ? t.accent : t.border)
              .hover((st) => st.bg(t.hover))
              .on_click((_e, cx) => {
                state.current = s.n;
                state.mode = "slide";
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
                  .when(s.bullets?.length > 0, (el) =>
                    el.child(
                      div()
                        .text_size(12)
                        .text_color(t.muted)
                        .truncate()
                        .child(s.bullets.map((b) => b.text).join(" · ")),
                    ),
                  ),
              ),
          ),
        );
    }

    const shownSlides =
      state.mode === "all"
        ? state.slides
        : [state.slides[state.current - 1] ?? state.slides[0]];

    return v_flex()
      .id(`${state.id}-view`)
      .size_full()
      .overflow_y_scrollbar()
      .overflow_x_scrollbar()
      .p(20)
      .gap(20)
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
      .children(shownSlides.map((s) => renderSlideCard(s, s.n === state.current)));
  },
};
