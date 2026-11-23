// Video: opens in the system player (QuickTime/IINA/VLC), falling back to an ffplay window.
import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { exec, theme, notify } from "herdr";
import { basename, extension } from "../kinds.js";

const FFPLAY = 'P=$(command -v ffplay || echo /opt/homebrew/bin/ffplay); [ -x "$P" ] || P=/usr/local/bin/ffplay; ';

async function playVideo(file) {
  const r = await exec("open", [file]).catch(() => ({ code: 1 }));
  if (r.code === 0) return;
  const f = await exec("sh", ["-c", FFPLAY + '[ -x "$P" ] && "$P" -autoexit -loglevel quiet -window_title "$2" -i "$1" </dev/null >/dev/null 2>&1 & echo $!', "video", file, basename(file)]);
  if (f.code !== 0 || !f.stdout.trim()) {
    throw new Error("No player for this video (install IINA/VLC or ffmpeg for ffplay)");
  }
}

let views = 0;

export default {
  id: "video",
  async load(file, env) {
    if (env.on) throw new Error("Video playback is supported only for local files");
    return {
      id: `cria-file-preview-video-${++views}`,
      file,
      name: basename(file),
      ext: extension(file).toUpperCase(),
    };
  },

  render(state) {
    const t = theme();
    return v_flex().id(state.id).flex_1().items_center().justify_center().p(24)
      .child(v_flex().w(400).max_w_full().p(20).gap(14).items_center().rounded(10).bg(t.surface).border_1().border_color(t.border)
        .child(div().text_size(11).px(8).py(2).rounded(4).bg(t.raised).text_color(t.muted).child(state.ext || "VIDEO"))
        .child(div().w_full().truncate().text_center().font_semibold().text_size(14).child(state.name))
        .child(div().text_size(12).text_color(t.dim).text_center().child("Herdr has no built-in video decoder. Launch in system player or ffplay."))
        .child(div().id(`${state.id}-play`).px(16).py(8).rounded(6).cursor_pointer().bg(t.accent).text_color(t.background)
          .text_size(12.5).font_semibold().hover((s) => s.opacity(0.88))
          .on_click((_e, cx) => {
            cx.spawn(async () => {
              try { await playVideo(state.file); }
              catch (e) { notify({ title: "Cannot play video", body: String(e?.message ?? e), level: "error" }); }
            });
          })
          .child("▶ Play Video")));
  },
};
