// HTML: structural preview (headings, lists, tables, links) via TextView.html,
// Raw source toggle, and an "Open in browser" button for full CSS/JS rendering.
import { div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { exec, notify, theme, window } from "herdr";
import { readText, codeState, codeView } from "./text.js";
import { rawToggle, wrapButton } from "./controls.js";

let views = 0;

function openCommand(platform, file) {
  if (platform === "macos") return ["open", [file]];
  if (platform === "windows") return ["explorer.exe", [file.replace(/\//g, "\\")]];
  return ["xdg-open", [file]];
}

export default {
  id: "html",
  async load(file, env, previous) {
    const text = await readText(file, env.on);
    const raw = previous?.raw ?? false;
    return {
      text,
      raw,
      editor: raw ? codeState(text, "html") : null,
      id: `cria-file-preview-html-${++views}`,
    };
  },

  toolbar(state, env) {
    const t = theme();
    const platform = window()?.platform ?? "macos";
    return h_flex().gap(6).items_center()
      .when(!env.on, (el) => el.child(
        div().id("cria-file-preview-open-browser").h(26).px(10).flex().items_center().rounded(6).cursor_pointer()
          .text_size(12).bg(t.chrome).text_color(t.muted).hover((s) => s.bg(t.raised).text_color(t.foreground))
          .tooltip("Open in default browser")
          .on_click((_e, cx) => {
            const [cmd, args] = openCommand(platform, env.file);
            cx.spawn(async () => {
              const r = await exec(cmd, args).catch((e) => ({ code: 1, stderr: String(e) }));
              if (r.code !== 0) notify({ title: "Cannot open in browser", body: r.stderr || "Failed to launch browser", level: "warning" });
            });
          })
          .child("Open in browser")))
      .when(state.raw, (el) => el.child(wrapButton(state, "html")))
      .child(rawToggle(state, "Preview", "html"));
  },

  render(state) {
    if (state.raw) return codeView(state.editor);
    return v_flex().id(state.id).flex_1().min_h(0).w_full().max_w(920).mx_auto().px(40).py(24)
      .child(TextView.html(`${state.id}-view`, state.text).selectable(true).scrollable(true).size_full());
  },

  release: (state) => state.editor?.release(),
};
