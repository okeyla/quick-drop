# QuickDrop 快速傳檔

把 PDF、簡報、圖片等檔案臨時傳給別人的單頁網站。檔案上傳到 Supabase 的暫存區，對方用取件連結下載，下載後自動刪除。全程只走一般的 HTTPS，公司防火牆內也能用；兩邊不必同時在線。

## 使用方式

開啟網站後先輸入一次密碼解鎖：

- **上傳密碼**：開啟藍色的「上傳」和綠色的「下載」兩個區塊。
- **取件密碼**：只開啟「下載」區塊。

### 上傳

1. 在「上傳」區塊選檔案（或拖曳），可填備註，按「上傳並建立取件連結」。
2. 把取件連結傳給對方；對方開連結就能下載，不需要密碼。
3. 「對方下載後自動刪除」預設開啟：存檔成功後檔案就從伺服器移除。取消勾選則可以重複下載。
4. 沒人下載的檔案，到了保存期限（1 小時、24 小時、7 天）會自動刪除。

### 下載

- **用取件連結**：開連結、勾選檔案、按「下載所選」。適合只傳一次的對象。
- **用密碼**：解鎖後「下載」區塊會列出目前還在伺服器上的所有檔案，依批次分組，顯示備註、上傳時間、保存期限。可以勾選下載、按「刪除所選」從伺服器移除，或按「複製取件連結」把某一批的連結再傳給別人。
- 勾到「下載後刪除」的檔案時，下載前會先提醒：下載完其他人就看不到了。
- 電腦版 Chrome / Edge 一次選多個檔案時會請你選一個本機資料夾，檔案逐一存進去，不會壓縮；其他瀏覽器逐一下載。

清單只顯示還在伺服器上的檔案；已被下載刪除或過期的不會出現，也沒有下載歷史紀錄。

## 限制與注意事項

- 單檔上限 50 MB，暫存區總容量約 900 MB（Supabase 免費版）。
- 拿到取件連結的人就能下載那一批檔案，請只傳給要收的人。
- 知道取件密碼的人能看到、下載並刪除所有批次的檔案，請只給信任的人。
- 同一個網路位址在 15 分鐘內輸錯密碼 10 次，會被鎖 15 分鐘。
- 「在這台電腦記住」會把密碼存在瀏覽器裡，公用電腦不要勾；右上角「鎖定」可以清除。

## 架構

- `index.html`、`style.css`、`icon.svg`：純靜態前端，放 GitHub Pages 即可。後端網址寫在 `index.html` 的 `SUPABASE_URL`。
- `supabase/migrations/`：資料表與私有儲存桶。資料表開啟 RLS 且沒有任何 policy，瀏覽器無法直接讀寫。
- `supabase/functions/drop/index.ts`：Edge Function，驗證上傳密碼、簽發上傳與下載憑證、下載後刪除、清除過期檔案。部署時要關閉 JWT 驗證（函式自己做密碼與取件碼檢查）。
- `.github/workflows/keepalive.yml`：每日呼叫後端清除過期檔案，並避免免費專案因閒置被暫停。

## 設定密碼

資料庫只存密碼的 SHA-256。在 Supabase 的 SQL Editor 執行（把 `你的密碼` 換掉）。上傳密碼：

```sql
insert into public.config (key, value)
values ('upload_password_sha256', encode(sha256(convert_to('你的密碼', 'UTF8')), 'hex'))
on conflict (key) do update set value = excluded.value;
```

取件密碼（看上傳紀錄用，請和上傳密碼設成不同的）：

```sql
insert into public.config (key, value)
values ('download_password_sha256', encode(sha256(convert_to('你的取件密碼', 'UTF8')), 'hex'))
on conflict (key) do update set value = excluded.value;
```
