# HerdrSetup：estro9k layout（CLI for Beginner）

Herdr（終端機／coding agent 桌面 app）的自訂 layout `estro9k` 與它用到的 mod。
原始檔放在這裡；Herdr 實際讀的是 `~/.config/herdr-app/`，由 `install.sh` 複製過去。

> 🌐 **互動式 HTML 介面介紹頁**：本儲存庫內建 [index.html](index.html)（零外部依賴，支援直接於瀏覽器、Herdr 右側 `cria-file-preview` 或 GitHub Pages 開啟），提供 1:1 互動式 Herdr `estro9k` 介面模擬器（可直接體驗右下角三段權限開關、左側 Agent 右鍵標記未讀藍點、並排預覽切圖與三合一用量面板）。

## 要改版面時

開一個 Claude 或 Codex 的 session，跟它說：

> 我要改 Herdr 版面，資料夾是 /Users/miles/Developer/ProjectHub/HerdrSetup，先讀裡面的 AGENTS.md。

接著描述想改什麼就好。AI 會照 [AGENTS.md](AGENTS.md) 的流程處理：先跟你討論，改完跑 `install.sh`、檢查錯誤，再截圖確認。不需要你自己執行任何指令。

## 長相

```
┌─────────────┬────────────────────────────────┬─────────────┐
│ Herdr       │ [分頁][分頁] +  Files Changes Plan To-do  ▣ │  ← better-tabs ＋ 面板開關
├─────────────┼────────────────────────────────┼─────────────┤
│ Spaces      │                                │ 右側面板    │
│  （空間）   │      終端機（卡片樣式）         │ 一次顯示一個│
├─────────────┤                                │             │
│ Agents      │                                │             │
├─────────────┤                                │             │
│ Claude 用量 │                                │             │  ← over9k-usage
│ Codex  用量 │                                │             │
│ Gemini 用量 │                                │             │
├─────────────┼────────────────────────────────┴─────────────┤
│ Settings    │ 狀態列                                        │
└─────────────┴──────────────────────────────────────────────┘
```

| 區塊 | mod | 來源 |
|---|---|---|
| 空間（上）、Agent（下） | `better-sidebar`（`agents` view） | munza/herdr-mods（estro） |
| 分頁列與面板按鈕、右上面板開關 | `better-tabs`、`better-sidebar`（`panel-toggle` view） | munza/herdr-mods（estro） |
| 左下用量 | `over9k-usage` | herunan/herdr-over9k |
| 右側 Files | `cria-files-extended` ＋ 預覽分頁 `cria-file-preview` | gsydler/herdr-cria（整合 HTML／Mermaid／音訊／影片） |
| 右側 Changes | Herdr 內建 `changes` | Herdr |
| 右側 Plan（跟著 agent 終端機的任務） | `agent-plans` | dendenlarin/herdr-agent-plans |
| 右側 To-do（跟著專案的待辦） | `over9k-todos` | herunan/herdr-over9k |
| 底部狀態列與三段權限開關 | `custom-status` | 由 Herdr `workspace-status` 客製擴充 |

layout 由 Herdr 0.1.16 內建 `main` 改出（`layouts/estro9k.json`）；內建 `main` 不動。

## 安裝、切換、移除

```sh
cd /Users/miles/Developer/ProjectHub/HerdrSetup
sh install.sh                 # 安裝或更新（可重複執行；舊版先備份到 backups/<時間>/）
sh install.sh --no-statusline # 不碰 Claude／共用狀態列
sh uninstall.sh               # 切回 main 並移除；資料檔保留
```

切換 layout：Herdr 裡按 `Cmd+Shift+L`。卡住時按 `Ctrl+Option+Shift+Esc` 會回到預設 `main`。

## 已客製化功能與操作速查（防遺失紀錄）

這套設定的原始碼全部保存在本資料夾（`/Users/miles/Developer/ProjectHub/HerdrSetup/`）。Herdr App 升級時只會重寫它自己的內建 `main` layout 與內建 mod，**不會覆蓋 `estro9k` 與自訂 mod**；就算換電腦或重置設定，只要跑一次 `sh install.sh` 就能 100% 還原。

### 1. 並排預覽與右側 Files 自動跟隨目錄（`cria-file-preview` ＋ `cria-files-extended`）
- **預設並排、不蓋住對話框**：
  - `Files` 面板標題列有 **`並排` / `分頁`** 切換鈕（預設為 **`並排`**）。
  - 在對話框按住 **`Cmd` + 點擊**圖片或檔案連結（支援一般路徑與 `file://` 超連結）、或在右側 `Files` 點擊檔案時，會在對話框右半邊**並排打開預覽框**。
- **共用同一預覽框（原地換圖，不開新分頁）**：
  - 只要當前分頁已開著預覽框，再點其他圖片或檔案時會**直接在同一個預覽框原地切換**，不會越切越多欄，也不會跳去新分頁。
- **右側 `Files` 自動切換到媒體檔目錄＋高亮**：
  - 預覽框開啟或切換圖片時，右側 `Files` 會**自動切換到該圖片所在的資料夾**，並將正在預覽的檔案**高亮標示**。
  - 當 `Files` 不在專案根目錄時，標題列會出現 **`↑`**（回上一層）與 **`⌂`**（返回專案根目錄）按鈕。
- **鍵盤方向鍵切圖＋觸控板兩指縮放**：
  - **鍵盤切圖**：預覽框或右側 `Files` 有焦點時，按鍵盤 **`←` / `→` / `↑` / `↓`**（或 `[` / `]`）直接切換上下一張圖片；按 **`Backspace`** 退回上一張看過的圖；點預覽框頂部 **`All` / `Media`** 可切換「全部檔案」或「只看圖片／文件／影音」。
  - **觸控板縮放**：游標移到圖片或 PDF 上，直接用**觸控板兩指張開／捏合（Pinch）**（或 `Cmd + 滾輪`）即可縮放；放大後用兩指滑動或滑鼠拖曳平移，點 **`Fit`** 恢復適應視窗。
- **`Auto` 自動預覽與 PPT 簡報預覽（`.pptx` / `.ppt`）**：
  - 點 `Files` 右上角 **`Auto`** 可展開類型篩選列（圖片／PDF/PPT／HTML／MD／影音／略過系統MD），當 agent 產出新檔案時會自動在並排預覽框更新。
  - **PPT / PPTX 簡報預覽器（`cria-file-preview/viewers/pptx.js`）**：點擊 `.pptx` 或 `.ppt` 即可在並排預覽框以 **16:9 投影片卡片**預覽（自動提取標題、多層級條列重點、表格、內嵌圖片與講者備忘稿），支援 **`單頁 | 連續 | 大綱`** 三種模式、`‹ 1 / N ›` 上下頁切換、觸控板兩指捏合縮放，以及 **`Open in App ↗`** 一鍵以 Keynote / PowerPoint 開啟。

### 2. 左下三合一用量與 Claude Credit 剩餘額度（`over9k-usage`）
- **Claude `Pro`**：由 `~/.claude/statusline-cat.sh` 結尾呼叫 `~/.claude/herdr-usage-cache.sh` 寫入 `~/.cache/over9k/usage/claude.json`；支援讀取 `organizationType` 顯示 `Pro` 標籤，並根據 `~/.cache/over9k/usage/claude-credit.json` 基準點與 `api-cost.py` 追蹤 **`Credit Est.`** 預估剩餘額度（點擊可展開切換 1d / 1w / 2w / 30d 與每日長條圖）。
- **Codex `Plus`**：直接讀取 `~/.codex/sessions/`，不需額外設定。
- **Gemini `Pro`（agy）**：由共用狀態列 `~/.config/ai-statusline/statusline.sh` 結尾呼叫 `~/.gemini/antigravity-cli/herdr-usage-cache.sh` 寫入 `~/.cache/over9k/usage/antigravity.json`。

### 3. 三套 Agent（Claude Code、agy、Codex）設定、三段權限開關、Hook 與 Credit 額度

本 repo 的 `statusline/` 與 `mods/` 已完整收錄三套 CLI 的共用狀態列、底部三段權限開關、對話標題腳本、Agent Plans Hook、Codex 複製標色設定以及 Claude Credit 額度計算程式：

- **底部狀態列三段權限開關（`mods/custom-status/` ＋ `statusline/permission-guard.py`）**：
  - 在 Herdr 視窗最底部狀態列右側提供針對**當前對話框 session** 獨立生效的三顆滑鼠點擊按鈕，並與每個 AI 終端機內的彩色狀態列即時連動（狀態儲存於 `~/.cache/over9k/usage/permissions.json`）：
    1. **`💬 每次都問`（預設，深石板藍底 `#3B4252`）**：寫入、修改檔案或執行終端機指令前，每次都會詢問你確認（純讀檔自動放行）。
    2. **`🚧 刪改才問`（皇家亮藍底 `#2563EB`）**：一般讀寫、改程式碼與跑測試自動放行；**只有遇到刪除檔案**（`rm`、`rmdir`、`unlink`、`trash`）、**覆蓋既有檔案**或**危險強制操作**（`mv -f`、`cp -f`、`git reset --hard`、`git clean`、`git checkout --`、`git push -f`）時才攔截並詢問你。
    3. **`🚀 最高權限`（烈焰橘紅底 `#EA580C`）**：當前對話 session 自動放行所有工具與指令。
- **左側 Agent 列右鍵選單「恢復成未讀樣式（藍點）」（`mods/better-sidebar/views/agents.js`）**：
  - 在左側 `Agents` 清單中對任一 Agent 按**滑鼠右鍵**會彈出下拉選單，可點選 **`標記為未讀（顯示藍點）`** 將已讀的空心灰圓環恢復為未讀實心藍點與亮白標題（並提供 **`標記為已讀（清除藍點）`** 與 **`釘選到最上方 / 取消釘選`**）；下次左鍵點擊該 Agent 查看對話時會自動恢復為已讀。
- **Codex 複製內容自動標色與深色主題（`statusline/codex-AGENTS.md` ＋ `cli-beginner-dark.tmTheme`）**：
  - `install.sh` 會自動安裝 `~/.codex/themes/cli-beginner-dark.tmTheme` 並將 `~/.codex/config.toml` 的 `theme` 設為 `"cli-beginner-dark"`（為多行複製區塊加上深藍底色與亮青色文字），同時更新 `~/.codex/AGENTS.md` 規定 `📋 ：` 後方的待複製內容一律以反引號包住上色。
- **共用彩色狀態列（`statusline/`）**：
  - 統一顯示：`[模型] [目前路徑] [Context 已用百分比（達 70% 自動轉紅）] [對話標題]`，配色定義於 `statusline/palette.json`。
  - **Claude Code（`~/.claude/settings.json`）**：
    ```json
    {
      "statusLine": {
        "type": "command",
        "command": "sh \"$HOME/.config/ai-statusline/statusline.sh\" claude"
      }
    }
    ```
  - **Antigravity CLI `agy`（`~/.gemini/antigravity-cli/settings.json`）**：
    - 固定輸入框於畫面底部：在 `agy` 內輸入 `/config` 將 **`Rendering Mode`** 設為 **`full screen (altscreen)`**。
    - 狀態列與分頁標題（讓 Herdr 側欄顯示 `agy` 對話主題）：
      ```json
      {
        "statusLine": {
          "enabled": true,
          "type": "command",
          "command": "~/.gemini/antigravity-cli/statusline.sh"
        },
        "title": {
          "command": "~/.gemini/antigravity-cli/title.sh"
        }
      }
      ```
  - **Codex CLI（`~/.codex/config.toml`）**：
    - 使用 `statusline/codex_statusline.py` 作為 MCP statusline provider（在 Codex 內執行 `/statusline` → 選擇 **AI 狀態列**）。
- **Agent Plans 任務同步 Hook（`mods/agent-plans/hook/plan.py`）**：
  - 已內建在 `mods/agent-plans/hook/plan.py` 中。在 Herdr 右側 **Plan** 面板點右上角 `⚙` → 按下 Claude Code 或 Codex 的 **Connect**，面板就會自動幫你把 `plan.py` 掛進 `~/.claude/settings.json` 的 `hooks`（或 `~/.codex/config.toml`），即時同步 Agent 的 TodoWrite / Plan 進度。
- **Claude Credit 剩餘額度設定（`mods/over9k-usage/api-cost.py`）**：
  - 計算邏輯已內建於 `mods/over9k-usage/api-cost.py` 與 `main.js`。
  - 欲初始化或校準你的 Claude 預付額度基準點，將 `statusline/claude-credit.example.json` 複製為 `~/.cache/over9k/usage/claude-credit.json` 並填入當下餘額與時間：
    ```json
    {
      "balance": 46.53,
      "as_of": "2026-11-24T00:19:00+08:00"
    }
    ```
    Herdr 左下角的 `Credit Est.` 就會從該時間點起自動扣除本機對話新增的 Token 估算花費，顯示即時預估剩餘金額。

## 各面板注意事項

- **Plan**：要先在面板 ⚙ 裡按 Claude Code／Codex 的 Connect，才會在 `~/.claude/settings.json`（Codex 為 `~/.codex/config.toml`）加 hook，有備份；再按一次移除。只支援 Claude Code 與 Codex。資料在 `~/.config/herdr-app/data/agent-plans/`，一週未更新自動刪。
- **To-do**：清單存在 `~/.local/share/over9k/todos/<專案>.md`，不寫進專案。例外：專案原本就有 `TODO.md` 時，打勾會同步劃掉相同文字那行；在「From TODO.md」刪建議會刪掉那行；開啟某專案的 Sync 會建立 `TODO.md`（並加進 `.git/info/exclude`）。
  - 面板上「Let agents keep these lists → Set up」需要 over9k 的 Options mod（沒安裝），按了只會失敗、不會改任何檔案。若日後要讓 agent 自動記待辦，需另外評估：它會寫 `~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md` 與 hook。

## 第三方來源版本

| repo | commit | 取用內容 | 授權 |
|---|---|---|---|
| github.com/munza/herdr-mods | `f3e7881`（2026-11-23） | `better-sidebar`（**已客製**：Agent 列右鍵下拉選單標記未讀藍點／已讀／釘選）、`better-tabs`（未修改） | `mods/LICENSE-herdr-mods` |
| github.com/herunan/herdr-over9k | `193e9cc`（2026-11-21） | `over9k-usage`（**已深度客製**：Claude `Pro` 標籤與 `Credit Est.` 剩餘額度追蹤）、`over9k-todos`（未修改） | `mods/LICENSE-herdr-over9k` |
| github.com/dendenlarin/herdr-agent-plans | `b48d853`（2026-11-20） | `mods/agent-plans`（未修改） | `mods/LICENSE-herdr-agent-plans` |
| github.com/gsydler/herdr-cria | `6cff06a`（2026-11-23） | `cria-files-extended`（**已深度客製**：並排／分頁切換、自動跟隨預覽檔目錄＋高亮＋`↑`/`⌂` 導覽、方向鍵切檔、`Auto` 自動預覽篩選 UI）、`cria-file-preview`（**已深度客製**：同分頁並排共用預覽框原地換檔、`Cmd+點擊` 含 `file://` 連結攔截、`All`/`Media` 與四方向鍵切檔、觸控板兩指捏合 `on_pinch` 縮放） | `mods/LICENSE-herdr-cria` |
| github.com/jjongkwann/herdr-files-plus | `7563016`（2026-11-23） | HTML 結構預覽＋瀏覽器外開、Markdown Mermaid 離線渲染（整合進 `cria-file-preview`） | `mods/LICENSE-herdr-files-plus-jjong` |
| github.com/ondrapopik/herdr-files-plus | `a21720e`（2026-11-23） | 音訊內嵌播放條（`ffplay`）與影片外開邏輯（整合進 `cria-file-preview`） | `mods/LICENSE-herdr-files-plus-ondra` |

> ⚠️ **防覆蓋提醒**：`cria-files-extended`、`cria-file-preview`、`over9k-usage`、`better-sidebar` 與 `custom-status` 均包含針對使用習慣的客製化功能，**不可直接拿上游 repo 原版覆蓋**。未修改的 3 個 mod（`better-tabs`、`over9k-todos`、`agent-plans`）若需更新，可下載對應資料夾覆蓋後執行 `sh install.sh`。

## 資料夾

```
HerdrSetup/
  README.md                 本檔（給人看）
  AGENTS.md                 給 AI 的修改規則（Claude、Codex 共用）
  CLAUDE.md                 Claude 入口，指向 AGENTS.md
  install.sh / uninstall.sh
  evidence/                 安裝驗收截圖
  layouts/estro9k.json
  mods/<7 個 mod>/ 與 LICENSE-*（含 agent-plans/hook/plan.py 與 over9k-usage/api-cost.py）
  statusline/
    ai-statusline.sh        三套 CLI 共用彩色狀態列（安裝至 ~/.config/ai-statusline/statusline.sh）
    palette.json            三套 CLI 共用色盤與 70% Context 警示門檻
    codex_statusline.py     Codex 專用 MCP 狀態列 provider
    claude-usage-cache.sh   Claude 用量快取腳本（安裝為 ~/.claude/herdr-usage-cache.sh）
    agy-usage-cache.sh      agy 用量快取腳本（安裝為 ~/.gemini/antigravity-cli/herdr-usage-cache.sh）
    agy-statusline.sh       agy 狀態列入口（安裝為 ~/.gemini/antigravity-cli/statusline.sh）
    agy-title.sh            agy 對話標題腳本（安裝為 ~/.gemini/antigravity-cli/title.sh）
    claude-credit.example.json  Claude Credit 剩餘額度基準檔範本（可複製至 ~/.cache/over9k/usage/claude-credit.json）
  backups/<時間>/           install.sh 覆蓋前的本機備份（已由 .gitignore 排除不上傳）
```
