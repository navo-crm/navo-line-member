NAVO LINE 會員端（第一階段）
================================

這包包含：
- member.html：LINE 會員中心（會員等級、消費摘要、喜好國家、近期消費、抵用券）
- admin.html：管理員產生一次性綁定碼的頁面
- config.js：已填入 NAVO 專案公開 URL／publishable key，只需填入 LIFF ID
- config.example.js：前端公開設定範例
- supabase/migration.sql：新增 LINE 綁定與抵用券資料表，不更動既有消費資料
- supabase/functions/navo-line-member/index.ts：驗證 LINE ID token、綁定會員、回傳會員摘要、產生綁定碼
- supabase/config.toml：讓 Edge Function 自行驗證 LINE ID token；管理操作另驗證 NAVO 管理員帳號

重要限制：這是可部署的第一階段程式包，不代表 LINE/Supabase 已替你設定或部署完成。正式使用前需完成下方設定與測試。

A. LINE 設定（先做）
1. 在 LINE Official Account Manager 開啟「Messaging API」，建立/連結 Messaging API channel。官方流程：https://developers.line.biz/en/docs/messaging-api/getting-started/
2. 在 LINE Developers Console 確認 Messaging API channel 所屬 Provider。
3. 在同一個 Provider 建立 LINE Login channel（不要另建在不同 Provider），並設定為 Published；LIFF 需建立在 LINE Login channel。官方說明：https://developers.line.biz/en/docs/liff/getting-started/
4. 在 LINE Login channel 新增 LIFF app：Endpoint URL 指向部署後的 https://你的 GitHub Pages 網址/member.html；Scopes 至少選 openid、profile。取得 LIFF ID。
5. LINE Official Account 圖文選單的「會員中心」按鈕使用 LIFF URL：https://liff.line.me/你的_LIFF_ID
6. Messaging API channel 的 Channel Secret / Channel Access Token 不需要放進這個會員頁，也不要貼到聊天或提交到 GitHub。後續要做推播時再放進 Supabase Edge Function Secrets。

B. 部署前端
1. 編輯 config.js，只需把 LIFF_ID 的 YOUR_LIFF_ID 換成 LINE Developers 給你的 LIFF ID。專案 URL 與 publishable key 已先填好。
2. 將 member.html、admin.html、config.js 放在同一個網站根目錄。config.js 只放公開的 URL、publishable key、LIFF ID；不要放任何 secret。
3. admin.html 是管理頁，不要放在 LINE 圖文選單公開給客戶；建議先用不公開的獨立路徑或限制存取。它本身仍需要後端 allowlist 才能產生驗證碼。

C. Supabase 設定
1. 打開 Supabase SQL Editor，執行 supabase/migration.sql。它只新增 navo_line_bind_codes、navo_line_members、navo_vip_coupons 與綁定函式，不會刪除 customers/purchases/trips。
2. 在 Supabase Edge Functions 部署函式 navo-line-member，並一併套用 supabase/config.toml 的 verify_jwt=false 設定。可使用 Supabase Dashboard 建立 Function，或本機 Supabase CLI 部署。
3. 在 Edge Function Secrets 設定：
   LINE_LOGIN_CHANNEL_ID = LINE Login channel 的 Channel ID（不是 Messaging API channel ID）
   NAVO_ADMIN_EMAIL = 妳登入現有 NAVO CRM 使用的管理員 Email（需與 Supabase Auth 使用者 email 完全相符）
   SUPABASE_URL、SUPABASE_SERVICE_ROLE_KEY 依 Supabase Edge Function 環境提供/設定。Secret key 僅放伺服器端，絕不可放進 config.js 或 HTML。
4. Supabase 的 Edge Function 需能讀取 SUPABASE_SERVICE_ROLE_KEY。若專案使用新式 sb_secret_ 金鑰，請把相應的 server-only secret 設為 SUPABASE_SERVICE_ROLE_KEY；不要使用 publishable key 代替。
5. 在 Supabase Auth 使用者中確認 NAVO 管理員 Email 存在且可以登入。admin.html 會用該帳號登入，後端也會比對 NAVO_ADMIN_EMAIL。

D. 使用流程
1. NAVO 管理員開 admin.html，以現有 CRM Email/密碼登入。
2. 選一位客戶，產生 8 位數、15 分鐘有效的一次性驗證碼。
3. 私訊該客戶驗證碼（不要貼公開群組）。
4. 舊客從官方帳號圖文選單進入會員中心，輸入驗證碼完成綁定。
5. 新客第一次開啟會員中心會自動建立 LINE 會員身分，不需管理員手動綁定；若有既有 CRM 消費紀錄，日後可輸入一次性驗證碼連結。
6. 之後再次開啟會員中心會自動顯示本人會員資料（尚未連結 CRM 的新客會看到歡迎畫面）。

安全與功能說明
- LINE ID token 由 Edge Function 送 LINE 官方端驗證，前端不能單靠使用者傳入的 LINE user ID 認證。
- 一次性驗證碼以 SHA-256 雜湊存入資料庫，15 分鐘到期、成功後不可重用。
- 新客第一次開啟會員中心時，後端會自動建立未綁定的 LINE 會員列；不會憑 LINE 暱稱猜測或讀取任何既有 CRM 消費資料。若新客之後要把 NAVO CRM 的消費紀錄顯示在會員中心，仍需在 CRM 建立客戶資料後，使用一次性驗證碼安全配對；目前沒有電話／LINE ID 自動匹配欄位，因此不會假裝已自動同步。
- LINE 綁定資料表與抵用券表已啟用 RLS，前端角色不能直接讀寫；Edge Function 以 service role 操作。
- 第一版只讀取會員與抵用券；不會自行發券、核銷、修改消費紀錄或推播群發。
- 偏好國家由代購場次名稱中包含的「日本／韓國／泰國／香港」推算；若場次命名不含國家會歸為「其他／未設定」。
- 正式公開前請先用管理員/測試 LINE 帳號完成：錯誤碼、過期碼、重複綁定、不同 LINE 帳號、未綁定資料、近期消費與抵用券顯示等測試。
