# HuaiDJ 磁碟工具箱

製作開機 USB、依 DJ 設備挑選格式、保存 rekordbox USB 匯出資料。桌面程式、CLI、MCP 和 Skill 共用同一套核心。

## 先選一種用法

- **給 AI agent 用：**下載 [極簡 Skill ZIP](https://github.com/yutianyu111602-glitch/huaidj-disk-toolkit/releases/download/v0.1.0/huaidj-disk-toolkit-v0.1.0-skill.zip)，把其中單一 `huaidj-disk-toolkit` 資料夾放到 agent 的 Skill 位置。需要時，內附 bootstrap 會下載固定 `v0.1.0` 核心及缺少的官方依賴，並核對 SHA-256。
- **直接開 Windows 軟體：**乾淨的 Windows 請先下載並核驗同一 release 的 `install.ps1`，依 [桌面安裝步驟](docs/CONNECT.md#windows-desktop-setup) 預覽，再以 `-RuntimeOnly -Apply` 安裝。它會取得 [Windows 軟體／MCP 主包](https://github.com/yutianyu111602-glitch/huaidj-disk-toolkit/releases/download/v0.1.0/huaidj-disk-toolkit-v0.1.0-windows-x64.zip) 和缺少的 Node.js／PowerShell，再按回傳路徑開啟程式，不需自行編譯。已有依賴時可完整解壓主包，開啟 `app/HuaiDJ.DiskToolkit.exe`；桌面 .NET 執行環境已隨包提供。

要直接接入目前的 agent，複製 [英文 README 頂部的一段接入 prompt](README.md#copy-this-prompt-to-your-agent) 即可。它會先沿用可用的 `huaidj-rufus` 連線，缺少時才預覽並套用目前 client 的設定。詳細步驟見 [CONNECT](docs/CONNECT.md)。安裝連線不代表授權格式化磁碟。

## 第一次使用

1. 先確認選到哪支 USB；磁碟代號及編號可能改變。
2. 選擇用途和實際播放器型號，例如 CDJ-3000。USB 的 SanDisk 等品牌不能用來推定 DJ 播放器型號。
3. 查看智慧建議及來源；韌體、分割方式或相容性標示「未知」，代表尚未確認。
4. 先預覽操作範圍，再確認要格式化單一分割區，還是清除整支 USB。格式化會刪除該範圍的資料。

製作好 Linux USB 後，原生雙系統安裝仍要另行重開機及操作安裝程式。工具不會自動替你改動內部系統分割區。

## FAT32、exFAT、NTFS 怎麼選

| 格式 | 適合的情況 |
| --- | --- |
| FAT32 | Windows、Mac 及較舊 DJ 設備之間常見的共同選擇；單一檔案必須小於 4 GiB。大容量格式化需看所用後端限制。 |
| exFAT | 適合大檔案及較新的設備；仍須確認指定型號與韌體支援，不能套用到所有 CDJ/XDJ。 |
| NTFS | 常見於 Windows 資料碟及部分 Windows 安裝媒體；很多 DJ 播放器不支援，Mac 原生寫入也有限制。 |

分割方式 MBR／GPT 是另一項條件。一般建議不能冒充逐型號確認；CDJ-3000 明文不支援 GUID，也不等於已實測確認所有 MBR 媒體。超過工具 MBR 容量界線時會拒絕，不會偷偷改 GPT 或截短容量。

## rekordbox 的「新舊 DB」與磁碟格式不同

- **桌面主資料庫：**電腦上的收藏與準備資料，不是這個工具的 USB 還原目標。
- **Device Library：**傳統 USB／SD 匯出資料，供相應的舊款設備使用。
- **OneLibrary：**Device Library Plus 在 rekordbox 7.2.5 後使用的新名稱；不表示所有舊款播放器都能直接使用。不同型號可能需要同時保留相應的匯出資料。
- **Engine DJ library：**另一套準備／播放資料，不能直接等同 rekordbox 的格式。

FAT32／exFAT 決定磁碟如何存檔；資料庫版本和播放器韌體決定匯出的播放資料能否使用。只改副檔名或格式化磁碟，不能完成資料庫轉換或修復。

工具可診斷匯出資料、按日期／宣告的匯出軟體版本列出快照，並預覽受控還原。先正常關閉 rekordbox。快照以匯出 metadata 為主，**不是歌曲完整備份**；目前受控還原限同一已識別 Windows USB 的 metadata，不還原桌面主庫或音樂原件。

## 已測與未測

Windows 格式後端已在自有隔離 VHD 測過 FAT、FAT32、NTFS、exFAT、UDF 及 GPT／MBR。這不等同實體 USB 控制器或 DJ 播放器驗收。

Zorin OS 18.1 Core 曾使用保留的 **FFEC 基線引擎**完成真 USB DD 寫入與完整映像長度 SHA-256 讀回匹配；尚未開機或安裝內部系統。最新 **3bc 擴充引擎**已實作標準 Windows ISO、格式選項及大型 FAT32，並通過編譯和 53 項純原生檢查；此版本的 production／實碟驗收仍為 **NOT_RUN**，不能把舊基線結果套用過來。

桌面版已完成 Windows x64 self-contained 編譯；已實際觀察啟動、繁中排版、格式判定條件和未確認的格式化預覽，見 [部分介面驗收](tests/acceptance/desktop-windows-partial.json)。使用者停止操作後，其他分頁、語言、DPI／鍵盤、桌面寫入及真實播放器、真庫還原驗收仍未完成。macOS／Linux 目前提供參考查詢及 stdio，**不提供實體磁碟寫入**。實際固定 release 下載與安裝驗收也須和離線 installer 測試分開。

## 開源授權

主專案採 **GPL-3.0-or-later**，保留 Rufus 與其他第三方權利及對應來源。.NET 等第三方原有 MIT 授權和 notices 原樣附上，不會被改標成我們的授權。見 [LICENSE](LICENSE) 與 [第三方聲明](THIRD_PARTY_NOTICES.md)。

完整 CLI 工作流、參數及進階限制見 [英文 README](README.md)。
