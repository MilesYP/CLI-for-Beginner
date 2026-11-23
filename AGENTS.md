# HerdrSetup 修改規則（給 AI）

彥邦（使用者）要改 Herdr 版面時，會指定這個資料夾。本檔是 Claude、Codex 共用的工作規則；`CLAUDE.md` 只是入口。
用繁體中文回覆，解釋術語。他不寫程式，改完要用白話說明改了什麼、怎麼看到效果。

## 0. 先知道的事

- **Herdr**：使用者的終端機／coding agent 桌面 app（他有時會打成 Herder）。它只讀 `~/.config/herdr-app/`，檔案一改，約 1 秒內自動套用，不用重開 app。
- **本資料夾是原始檔**，`~/.config/herdr-app/` 裡的是安裝後的複本。**一律改這裡，再跑 `install.sh` 同步**；不要直接改 `~/.config/herdr-app/` 裡的複本，否則下次安裝會被蓋掉。
- 本資料夾在 ProjectHub 底下，**ProjectHub 的單一寫入者規則適用**（見 §1）。
- Herdr 官方說明：`~/.config/herdr-app/AGENTS.md`，每次 Herdr 啟動都會重寫成該版本的內容。動手前一定要先讀它的相關章節（Layouts、Keys、Commands、Mods），不要憑記憶寫 layout 欄位。

## 1. 開工前（ProjectHub 規則）

1. 讀 `/Users/miles/Developer/ProjectHub/AGENTS.md` 與 `STATUS.md`。
2. `STATUS.md` 的 `coordination.writer_id` 是 `null` 才能開工：登記自己為寫入者，並把工作項目 **PH-004**（Herdr 自訂 layout）的 `owner` 設成自己、`state` 改 `in_progress`。版面調整、更新 mod 都沿用 PH-004；只有目標完全不同的新功能（例如 MCP 串接）才另開新 ID。
3. `writer_id` 已被別的 session 佔用：保持唯讀，告訴使用者，不要動手。
4. 收尾：在 PH-004 寫入 `checkpoint`、`verification`、`updated_at`、`updated_by`，`state` 改回 `done`，`owner` 與 `writer_id` 清回 `null`，然後跑 `/usr/bin/ruby tests/validate_status.rb`（在 ProjectHub 根目錄）。
5. 文件裡看到 iCloud 舊路徑（`~/Library/Mobile Documents/com~apple~CloudDocs/ProjectHub`），直接改成 `/Users/miles/Developer/ProjectHub`。

## 2. 改版面的流程

1. **先討論再動手**：使用者偏好先釐清需求，他明確說「開始實作」才改檔。看不到效果他會不放心，必要時先用 ASCII 示意圖說明。
2. 改 `layouts/estro9k.json`（或新增其他 layout 檔）。改到 mod 的話，改 `mods/<名稱>/`。
3. 執行 `sh install.sh`：它會先備份到 `backups/<時間>/`、同步檔案，再對每個 mod 跑 `herdr-app check`。
4. 驗證，三項都要做：
   - `herdr-app status`：`errors` 要是空的。
   - `ls ~/.config/herdr-app/*.error`：不能有錯誤檔。layout 寫壞時，Herdr 會沿用上一個正常的版本，並把原因寫在 `layout.error`。
   - `herdr-app shot <路徑>.png` 截圖，實際看過畫面再回報。截圖存到 scratchpad；要留作證據才放 `evidence/`。
5. 要讓使用者立刻看到：`herdr-app do layout.switch '{"name":"estro9k"}'`。
6. 改了結構，就同步更新 `README.md` 的示意圖和表格。

**救急**：畫面壞掉時，使用者按 `Ctrl+Option+Shift+Esc` 一定會回到內建 `main`。`sh uninstall.sh` 會全部移除，並切回 `main`。

## 3. 這個 layout 的硬性限制（改壞最常見的原因）

這些區塊 id 被 mod 寫死，**不能改名，也不能拆開**：

| id | 誰依賴它 | 用途 |
|---|---|---|
| `panel`、`panel-body` | better-tabs、agent-plans | 右側面板的外框與堆疊（stack） |
| `plans` | agent-plans | Plan 面板必須是 `panel-body` 的子項、id 固定 `plans` |
| `usage` | over9k-usage | 用量區塊要叫 `usage`，否則它會改成「獨立模式」，在視窗底部畫成一條橫列 |
| `tabs-row`、`tabs` | better-tabs | 分頁列換行時會調整 `tabs-row` 的高度 |

- 右側面板按鈕在 `tabs` 區塊的 `props.buttons` 裡，每顆的 `action.target` 要對應 `panel-body` 底下某個子區塊的 id。
- `panel` 寬度維持 368px（可在 280～900 之間），因為這些 mod 是照這個寬度畫的。
- Herdr 內建的 layout（`main`、`terminals`、`win98`）和內建 mod 是唯讀的，每次啟動都會被還原。不要改它們；要改，先 `herdr-app do layout.clone`。
- **客製化 mod 保護（嚴禁直接用上游覆蓋）**：`mods/` 裡共有 7 個 mod，其中 **`cria-files-extended`、`cria-file-preview`、`over9k-usage` 為高度客製化修改版**（包含並排預覽共用原地換圖、`Cmd+點擊` `file://` 連結預覽、右側 `Files` 自動跟隨媒體檔目錄＋高亮＋`↑`/`⌂` 導覽、預覽框與 `Files` 四方向鍵切圖、觸控板兩指捏合 `on_pinch` 縮放、`Auto` 自動預覽篩選、Claude `Pro` 標籤與 `Credit Est.` 剩餘額度追蹤，詳見 `README.md`）。修改時必須在既有程式碼基礎上增修，**絕對不可從上游 repo 重新下載整包覆蓋**。其餘 4 個未修改的第三方 mod 若要修改，也須先在 `README.md` 來源表註明「已修改」。

## 4. 加新 mod 或更新 mod

- 公開的 layout 和 mod 可以在 herdr.dev/layouts、herdr.dev/mods 找，或用 `gh search repos --topic herdr-mod`（layout 用 `herdr-layout`）。
- 安裝前先讀完它所有的檔案，並告訴使用者：它會不會連網、會不會執行程式（`exec`、`hc`）、會不會讀寫自己資料夾以外的檔案、會不會改 `~/.claude`、`~/.codex` 這類 agent 設定。使用者同意後才裝。
- 下載到 scratchpad 的獨立資料夾，只把 `mods/<名稱>/` 複製到本資料夾的 `mods/`，並在 `install.sh` 的 `MODS` 清單加上它的名稱，在 `README.md` 的來源表記下 repo、commit、授權。
- mod 的 `keys.json` 要併進使用者的 `~/.config/herdr-app/keys.json` 前，先問使用者。改過 keys.json 之後，Herdr 升級就不會再自動加入新的預設快捷鍵。

## 5. 不要做的事

- 不要直接改 `~/.config/herdr-app/` 裡由本資料夾安裝的複本。
- 不要在沒問過使用者的情況下，替他按 Agent Plans 的 Connect、執行 over9k 的 `setup.sh`、安裝 `todo` 指令或 agent 規則。這些會改 `~/.claude/settings.json`、`~/.claude/CLAUDE.md`、`~/.codex/`。
- 不要改 `~/.claude/statusline-cat.sh` 除了標記 `# herdr-setup: usage cache` 那兩行以外的內容。
- 不要 commit、push 或部署（ProjectHub 目前沒有 Git）。
