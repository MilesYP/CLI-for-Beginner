// Audio: plays in an inline card using ffplay (no extra window) with play/pause,
// -10s/+10s seek, clickable progress bar, and "Open in app" fallback.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, theme, notify } from "herdr";
import { basename } from "../kinds.js";

const FFPLAY = 'P=$(command -v ffplay || echo /opt/homebrew/bin/ffplay); [ -x "$P" ] || P=/usr/local/bin/ffplay; ';
const FFPROBE = 'P=$(command -v ffprobe || echo /opt/homebrew/bin/ffprobe); [ -x "$P" ] || P=/usr/local/bin/ffprobe; ';

function clock(s) {
  s = Math.max(0, Math.floor(s || 0));
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h
    ? `${h}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
    : `${m}:${String(s % 60).padStart(2, "0")}`;
}

function position(state) {
  const p = state.playing ? state.offset + (Date.now() - state.startedAt) / 1000 : state.offset;
  return state.duration ? Math.min(p, state.duration) : p;
}

function killProc(state) {
  if (state?.pid) {
    exec("kill", [String(state.pid)]).catch(() => null);
    state.pid = null;
  }
}

async function launch(state, at) {
  const r = await exec("sh", ["-c", FFPLAY + '[ -x "$P" ] || exit 127; "$P" -nodisp -autoexit -loglevel quiet -ss "$2" -i "$1" </dev/null >/dev/null 2>&1 & echo $!', "audio", state.file, String(at)]);
  const pid = Number(r.stdout.trim());
  if (r.code !== 0 || !pid) throw new Error("Cannot start ffplay (install ffmpeg or use Open in app)");
  if (!state.alive) {
    exec("kill", [String(pid)]).catch(() => null);
    return;
  }
  state.pid = pid;
  state.offset = at;
  state.startedAt = Date.now();
  state.playing = true;
  state.error = null;
}

function toggle(state, cx) {
  if (state.playing) {
    state.offset = position(state);
    state.playing = false;
    killProc(state);
    cx.notify();
    return;
  }
  const at = state.duration && state.offset >= state.duration - 0.5 ? 0 : state.offset;
  cx.spawn(async (cx) => {
    try { await launch(state, at); }
    catch (e) { state.error = String(e?.message ?? e); }
    finally { cx.notify(); }
  });
}

function seek(state, seconds, cx) {
  const at = Math.max(0, state.duration ? Math.min(seconds, state.duration - 0.25) : seconds);
  if (!state.playing) {
    state.offset = at;
    cx.notify();
    return;
  }
  killProc(state);
  state.playing = false;
  state.offset = at;
  cx.spawn(async (cx) => {
    try { await launch(state, at); }
    catch (e) { state.error = String(e?.message ?? e); }
    finally { cx.notify(); }
  });
}

let views = 0;

export default {
  id: "audio",
  async load(file, env) {
    if (env.on) throw new Error("Audio playback is supported only for local files");
    const d = await exec("sh", ["-c", FFPROBE + '[ -x "$P" ] && "$P" -v error -show_entries format=duration -of default=nw=1:nk=1 -i "$1"', "audio", file]).catch(() => null);
    return {
      id: `cria-file-preview-audio-${++views}`,
      file,
      name: basename(file),
      duration: Number(d?.stdout?.trim()) || 0,
      offset: 0,
      playing: false,
      pid: null,
      startedAt: 0,
      error: null,
      alive: true,
    };
  },

  start(state, _env, cx) {
    cx.spawn(async (cx) => {
      while (state.alive) {
        await cx.sleep(500);
        if (!state.alive) break;
        if (state.playing && state.pid) {
          const alive = (await exec("kill", ["-0", String(state.pid)]).catch(() => ({ code: 1 }))).code === 0;
          if (!state.alive) break;
          if (!alive) {
            state.playing = false;
            state.pid = null;
            state.offset = state.duration || position(state);
          }
          cx.notify();
        }
      }
    });
  },

  toolbar(_state, env) {
    const t = theme();
    return div().id("cria-file-preview-audio-open").h(26).px(10).flex().items_center().rounded(6).cursor_pointer()
      .text_size(12).bg(t.chrome).text_color(t.muted).hover((s) => s.bg(t.raised).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.spawn(async () => {
          const r = await exec("open", [env.file]).catch((e) => ({ code: 1, stderr: String(e) }));
          if (r.code !== 0) notify({ title: "Cannot open audio", body: r.stderr || "Failed", level: "warning" });
        });
      })
      .child("Open in app");
  },

  render(state) {
    const t = theme();
    const pos = position(state);
    const frac = state.duration ? Math.min(1, pos / state.duration) : 0;
    const btn = (id, label, onClick, primary = false) => div().id(`${state.id}-${id}`).px(12).py(6).rounded(6).cursor_pointer()
      .text_size(12).bg(primary ? t.accent : t.raised).text_color(primary ? t.background : t.foreground)
      .hover((s) => s.opacity(0.88)).on_click((_e, cx) => onClick(cx)).child(label);

    return v_flex().id(state.id).flex_1().items_center().justify_center().p(24)
      .child(v_flex().w(440).max_w_full().p(20).gap(14).rounded(10).bg(t.surface).border_1().border_color(t.border)
        .child(h_flex().justify_between().items_center().gap(12)
          .child(div().flex_1().min_w(0).truncate().font_semibold().text_size(14).child(state.name))
          .child(div().flex_none().text_size(12).text_color(t.dim).child(`${clock(pos)} / ${state.duration ? clock(state.duration) : "–:––"}`)))
        .child(div().id(`${state.id}-bar`).h(8).w_full().rounded(4).bg(t.border).cursor_pointer()
          .on_mouse_down("left", (e, cx) => {
            if (state.duration && e.local_position && e.bounds?.width) {
              seek(state, state.duration * e.local_position.x / e.bounds.width, cx);
            }
          })
          .child(div().h(8).rounded(4).bg(t.accent).w(`${(frac * 100).toFixed(2)}%`)))
        .child(h_flex().gap(8).items_center()
          .child(btn("play", state.playing ? "❚❚ Pause" : "▶ Play", (cx) => toggle(state, cx), true))
          .child(btn("back", "−10s", (cx) => seek(state, pos - 10, cx)))
          .child(btn("fwd", "+10s", (cx) => seek(state, pos + 10, cx))))
        .when(Boolean(state.error), (el) => el.child(div().text_size(12).text_color(t.ansi1).child(state.error))));
  },

  release(state) {
    state.alive = false;
    killProc(state);
  },
};
