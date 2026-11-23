## macOS 本機瀏覽器驗收

- 在這台 Mac 上，受限的 Codex 沙箱曾使 Playwright 啟動的 Google Chrome for Testing 在 macOS 應用程式註冊階段當機，重複產生系統提示。
- 凡以 exec_command 啟動本機 Playwright／Chromium／Chrome for Testing（含建置工具、截圖、畫面驗收與臨時 Python／JavaScript 腳本），直接透過 sandbox_permissions="require_escalated" 走正常授權流程。不要先在受限沙箱試跑，也不要在失敗後換參數或換瀏覽器反覆重試。這條指引不授予額外權限；仍須遵守當次工具的批准結果。
- 募啦規格站的 tools/spec-build/browser_runtime.py 提供啟動前檢查，臨時 Python 腳本應匯入 ensure_browser_launch_allowed() 並在啟動 Playwright 前呼叫。收到 BROWSER_REQUIRES_APPROVED_EXEC 表示驗收尚未執行，應改走正常獲准的執行路徑，不可略過驗收。
- 保留原有瀏覽器版本／channel、字型、視窗、截圖、DOM 量測與斷言；不得用停用系統當機通知、全域停用沙箱或略過畫面驗收來處理。內建瀏覽器工具沿用其既有權限流程。

## 給使用者複製的內容（強制標色）

- 需要使用者複製的**單行**指令、程式碼或文字：獨立一行，以 `📋 ：` 開頭（圖示與冒號留在反引號外），**後面要複製的原文一律放進 Markdown 行內程式碼（單反引號 `` `...` ``）**，讓 Codex 終端機自動套用醒目的程式碼配色。
  - 正確範例：📋 ：`printf '%s\n' 'Codex 複製測試'`
  - 正確範例：📋 ：`cd ~/Developer/m5sticks3 && git push`
  - 禁止寫法：不可將 `📋 ：` 後方的待複製內容裸露為一般純文字（沒有反引號就不會上色）。
- 需要使用者複製的**多行**內容：在上方單獨一行標示 `📋 ：`，下方若為指令／程式碼則放入標註對應語言的程式碼區塊（如 ```` ```sh ````）；若為多行純文字或交接 Prompt，請將每一非空行以單反引號 `` `...` `` 包住（或使用 ```sh 區塊以套用高亮配色），避免使用完全不上色的 ```` ```text ````。
