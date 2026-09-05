# bni-hub

BNI 分會會務工具（LINE 掃碼簽到＋幹部台）。一套程式 `app/` 給所有分會共用，每個分會只需要一份 `chapters/<slug>/config.json` 加一份對外服務的 `<slug>/` 頁面。

第一個分會：`hongli`（BNI 宏力分會）→ https://zense-tw.github.io/bni-hub/hongli/

## 目錄結構

- `app/` —— 共用前端程式（LIFF 初始化、GAS 呼叫、畫面渲染）。⛔ 不准出現任何分會專屬字串（分會名、LIFF ID、GAS 網址），一律從 `chapters/<slug>/config.json` 讀。
- `chapters/<slug>/config.json` —— 該分會的設定：LIFF ID、GAS 部署網址、告知文字版本等。
- `<slug>/` —— 該分會實際服務的網頁（簽到頁、`<slug>/admin/` 幹部台、`<slug>/privacy/` 個資告知頁）。
- `gas/Code.gs` —— 後端程式原始碼，貼進分會試算表的 Apps Script 編輯器。

## 部署一個新分會的 GAS 後端（給人看的步驟，不是程式會自動做的事）

1. 用**分會的** Google 帳號打開分會的試算表。
2. 上方選單：擴充功能 → Apps Script。
3. 把編輯器裡預設的 `Code.gs` 內容全部刪掉，貼上本 repo `gas/Code.gs` 的完整內容。存檔。
4. 右上角「部署」→「新增部署作業」→ 類型選「網頁應用程式」：
   - 執行身分：**我**（也就是當下登入的這個分會帳號）
   - 誰可以存取：**任何人**
5. 按「部署」，第一次會跳出 Google 的授權畫面，按「允許」。
6. 複製拿到的網址（長得像 `https://script.google.com/macros/s/xxxxx/exec`），這就是 `gasUrl`。
7. 把 `gasUrl` 填進 `chapters/<slug>/config.json`，推上 GitHub。
8. 隨便呼叫一次（例如瀏覽器打開 `<gasUrl>?op=config`），六個分頁（members／bindings／events／attendance／consents／config）會自動被建出來，不用手動先建。
9. 打開試算表的 `config` 分頁，把幹部的 LINE 識別碼填進 `adminUserIds` 那一列（用逗號分隔）——這個識別碼會在幹部第一次打開 `<slug>/admin/` 但還沒被列入白名單時，畫面上直接顯示出來，複製貼上即可。

## 驗收（一句指令）

```bash
G="<GAS部署網址>"; E="20260906"
curl -s "$G?op=arrivals&e=$E" | head -c 300; echo
curl -s "$G?op=arrivals&e=NOPE" | grep -q '查無' && echo "對照組✅"
curl -s -X POST "$G" -d '{"op":"checkin","userId":"Ufake","e":"'$E'"}' | grep -qi 'reject\|拒' && echo "偽造被擋✅"
```
