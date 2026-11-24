# Remote Relay for Magpie

在 Magpie 裡啟停 Claude Code 的 Model Relay。啟用後用 Claude Code 的 `/provider` 切換單一對話的模型。停用時自動復原 Claude 設定，等進行中的模型請求結束後停止轉發站。

Remote Relay 是 `cablate/model-relay` 的 Magpie 控制插件。轉發、子代理分流、429 備援與 HTTPS 代理由已安裝的 Model Relay 執行。本專案實作 Magpie 控制頁、程序啟停與設定復原。感謝 CabLate 提供原版插件，原版採 MIT 授權。 [原始儲存庫](https://github.com/cablate/model-relay) · [原版授權](https://github.com/cablate/model-relay/blob/main/LICENSE)

## 安裝

需要 Linux、Node.js 20 以上、`flock`、Magpie 和 Claude Code。Magpie 啟動時使用的 `PATH` 要找得到 `node`。

### 1. 設定 Model Relay

如果已用 `user` 範圍安裝 Model Relay，且已有格式 2 的 `~/.claude/model-relay.json`，可直接前往下一步。曾用 Remote Relay 停用轉發時，`~/.claude/.magpie-remote-relay/model-relay.json` 是同一份設定，也可以直接前往下一步。第一次使用時，在終端機執行以下指令。

```sh
claude plugin marketplace add cablate/model-relay
claude plugin install model-relay@model-relay --scope user
```

開啟 Claude Code 後輸入 `/reload-plugins`，再輸入 `/provider setup` 設定供應商和備援。完成後確認設定檔已建立。若把供應商金鑰寫成 `env:變數名`，要從帶有該環境變數的環境啟動 Magpie。 [Model Relay 繁體中文設定指南](https://github.com/cablate/model-relay/blob/main/README.zh-TW.md#安裝)

### 2. 將 Remote Relay 加入 Magpie

在 Magpie 開啟 **設定 → 插件 → 已安裝**，點選新增插件，貼上以下來源後安裝。

```text
github:Sn0wl3r0ker/remote-relay
```

安裝完成後，從側欄點選 **Remote Relay** 或 **模型轉發**。控制頁第一次開啟時會自動初始化。也可以用 Magpie CLI 安裝同一份插件。

```sh
magpie plugin add github:Sn0wl3r0ker/remote-relay
```

如果先前透過本機路徑安裝 Remote Relay，在原本的控制頁按 **停用並復原**。看到「已停用」後，從 Magpie 的已安裝清單移除本機路徑那筆，再貼上 GitHub 來源。

## 在 Magpie 啟停轉發

1. 如果 Claude 已連到 Magpie 閘道，先到 Magpie 的 **Agents** 頁面中斷 Claude 的連線。
2. 打開 **模型轉發**，按 **啟用轉發**。看到「轉發中」後，重新啟動 Claude Code。用 `/provider` 選擇目前對話的供應商，或由現有的模型別名和備援設定決定路由。
3. 用完後按 **停用並復原**。插件會先復原設定，再等進行中的模型請求結束並停止轉發站。看到「已停用」後，重新啟動 Claude Code，讓它讀取復原後的設定。

如果第一次打開控制頁就顯示「偵測到現有的 Model Relay 設定」，可直接按 **停用並復原**，也可按 **啟用轉發**將現有轉發納入管理。由 Remote Relay 啟用的轉發，也能在 Magpie 的 **設定 → 插件 → 已安裝**停用或移除插件時一併關閉。重新打開插件後，回到 **模型轉發**按 **啟用轉發**。

Model Relay 設為 `proxy.enabled: true` 時，Remote Relay 會先確認本機 HTTPS 代理可完成 TLS 交握，再讓新開的 Claude Code 對話使用該代理。若你已在用 Remote Control，停用轉發會斷開仍經由代理的連線。 [Model Relay 的 Remote Control 指南](https://github.com/cablate/model-relay/blob/main/README.zh-TW.md)

### 從終端機切換

如果你另外下載了原始碼，可在 `remote-relay` 資料夾中執行以下指令。

| 指令 | 用途 |
| --- | --- |
| `node relayctl.mjs status` | 查看狀態及轉發站是否在監聽。 |
| `node relayctl.mjs on` | 啟用轉發。 |
| `node relayctl.mjs off` | 復原 Claude 設定並停止轉發。 |

如果你用 `CLAUDE_CONFIG_DIR` 自訂 Claude 設定目錄，請在啟動 Magpie 和執行終端機指令時帶入相同的變數。

## 停用時會復原什麼

- 啟用前，插件記錄它會接管的欄位。停用時會逐項復原 API 位址、HTTPS 代理、憑證路徑、模型別名及 Claude Code 中的 Model Relay 插件狀態。操作期間若有其他工具改了同一個欄位，控制頁會列出保留的變更。
- 接管原本就已啟用的轉發時，第一次停用會從目前設定移除能辨識的 Model Relay 連線欄位。其餘設定以當下的值為準。
- 停用期間，供應商設定暫存在 `~/.claude/.magpie-remote-relay/model-relay.json`，讓已載入插件的 Claude 視窗無法再從原檔啟動轉發站。下次啟用會將原檔移回 `~/.claude/model-relay.json`。如果要在停用期間調整供應商，請編輯暫存的那份設定檔。

## 常見問題

| 情況 | 處理方式 |
| --- | --- |
| 切換後 Claude 還在走舊路由 | 結束舊對話並重新開啟 Claude Code。若仍使用舊路由，檢查啟動 Claude 的 shell、專案設定和啟動指令是否另外指定 `ANTHROPIC_BASE_URL` 或代理。 |
| 控制頁找不到 Model Relay 設定 | 確認原版插件以 `user` 範圍安裝，並用 `/provider setup` 完成格式 2 設定。若用 `CLAUDE_CONFIG_DIR`，確認 Magpie 指到同一份設定。 |
| Magpie 找不到 Node.js | 從載入 Node.js 20 以上的終端機啟動 Magpie，或在插件選項設 `nodePath` 為 Node.js 的絕對路徑。 |
| 控制頁連不上 | 控制頁在第一次開啟時選用本機連接埠。如果這個連接埠已被占用，到 Magpie 的插件選項修改 `port`，保留其他選項，再重開控制頁。Model Relay 的轉發站由它自己的設定檔指定連接埠。 |

## 執行測試

安裝 OpenSSL 後，在專案目錄執行測試。

```sh
node --test
```

測試使用臨時 Claude 設定目錄和本機測試端點，涵蓋反覆切換、接管既有 HTTPS 代理、保留外部變更、原生停用後等待請求結束、TLS 驗證失敗時撤回變更、損壞的設定檔以及連接埠占用。轉發與備援的整合驗證使用 Magpie 網頁版、實際的 Model Relay 和模擬供應商。 [Magpie 插件介面](https://usemagpie.ai/docs/plugins)
