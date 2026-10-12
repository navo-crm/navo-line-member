import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LINE_LOGIN_CHANNEL_ID = Deno.env.get("LINE_LOGIN_CHANNEL_ID")!;
const NAVO_ADMIN_EMAIL = (Deno.env.get("NAVO_ADMIN_EMAIL") || "").trim().toLowerCase();
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};
function reply(status: number, body: unknown) { return new Response(JSON.stringify(body), { status, headers: cors }); }
async function sha256(text: string) {
  const bytes = new TextEncoder().encode(text.trim().toUpperCase());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  const n = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  return String(n % 100000000).padStart(8, "0");
}
async function verifyLineIdToken(idToken: string) {
  if (!LINE_LOGIN_CHANNEL_ID) throw new Error("伺服器尚未設定 LINE_LOGIN_CHANNEL_ID");
  const form = new URLSearchParams({ id_token: idToken, client_id: LINE_LOGIN_CHANNEL_ID });
  const res = await fetch("https://api.line.me/oauth2/v2.1/verify", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form });
  const data = await res.json();
  if (!res.ok || !data.sub || String(data.aud) !== LINE_LOGIN_CHANNEL_ID) throw new Error("LINE 身分驗證失敗，請關閉後重新從官方帳號開啟會員頁。");
  if (data.exp && Number(data.exp) * 1000 < Date.now()) throw new Error("LINE 登入已過期，請重新開啟會員頁。");
  return { lineUserId: String(data.sub), displayName: String(data.name || "NAVO 會員") };
}
async function adminEmailFromRequest(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token || !NAVO_ADMIN_EMAIL) throw new Error("尚未完成 NAVO 管理員授權設定。");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user?.email || data.user.email.toLowerCase() !== NAVO_ADMIN_EMAIL) throw new Error("只有指定的 NAVO 管理員可以產生會員驗證碼。");
  return data.user;
}
async function profileForLine(lineUserId: string, displayName: string) {
  let { data: binding, error: bErr } = await admin.from("navo_line_members").select("customer_id,bound_at,display_name").eq("line_user_id", lineUserId).maybeSingle();
  if (bErr) throw bErr;
  // First-time LINE users are registered automatically as unlinked NAVO members.
  // Existing customer bindings are never overwritten or cleared here.
  if (!binding) {
    const { error: insertErr } = await admin.from("navo_line_members").insert({ line_user_id: lineUserId, customer_id: null, display_name: displayName });
    if (insertErr && insertErr.code !== "23505") throw insertErr;
    const reread = await admin.from("navo_line_members").select("customer_id,bound_at,display_name").eq("line_user_id", lineUserId).maybeSingle();
    if (reread.error) throw reread.error;
    binding = reread.data;
  } else if (!binding.display_name && displayName) {
    await admin.from("navo_line_members").update({ display_name: displayName }).eq("line_user_id", lineUserId).is("customer_id", null);
  }
  if (!binding || !binding.customer_id) return { bound: false, registered: true, member: { name: binding?.display_name || displayName } };
  const { data: customer, error: cErr } = await admin.from("customers").select("id,name").eq("id", binding.customer_id).maybeSingle();
  if (cErr) throw cErr;
  if (!customer) return { bound: false, registered: true, member: { name: binding.display_name || displayName } };
  const { data: purchases, error: pErr } = await admin.from("purchases").select("id,amount,purchase_date,category,product,trips(name)").eq("customer_id", customer.id).order("purchase_date", { ascending: false }).limit(1000);
  if (pErr) throw pErr;
  const rows = purchases || [];
  const total = rows.reduce((s: number, p: any) => s + Number(p.amount || 0), 0);
  const year = new Date().getFullYear();
  const yearRows = rows.filter((p: any) => String(p.purchase_date || "").startsWith(`${year}-`));
  const yearTotal = yearRows.reduce((s: number, p: any) => s + Number(p.amount || 0), 0);
  const level = total >= 100000 ? "鑽石 VIP" : total >= 50000 ? "白金 VIP" : total >= 20000 ? "金卡 VIP" : total >= 5000 ? "熟客" : "新客";
  const countryTotals: Record<string, number> = {};
  const categoryTotals: Record<string, number> = {};
  for (const p of rows) {
    const tripName = String(p.trips?.name || "");
    const country = ["日本", "韓國", "泰國", "香港"].find(c => tripName.includes(c)) || "其他／未設定";
    countryTotals[country] = (countryTotals[country] || 0) + Number(p.amount || 0);
    const category = String(p.category || "其他／未設定");
    categoryTotals[category] = (categoryTotals[category] || 0) + Number(p.amount || 0);
  }
  const preferredCountry = Object.entries(countryTotals).sort((a, b) => b[1] - a[1])[0]?.[0] || "尚無資料";
  const favoriteCategory = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1])[0]?.[0] || "尚無資料";
  const now = Date.now();
  const couponsRes = await admin.from("navo_vip_coupons").select("id,title,amount,minimum_spend,status,issued_at,expires_at,note").eq("customer_id", customer.id).in("status", ["active"]).order("issued_at", { ascending: false });
  if (couponsRes.error) throw couponsRes.error;
  const coupons = (couponsRes.data || []).filter((c: any) => !c.expires_at || new Date(c.expires_at).getTime() >= now);
  return {
    bound: true,
    member: { name: customer.name, level, totalSpend: total, yearSpend: yearTotal, purchaseCount: rows.length, averageOrder: rows.length ? Math.round(total / rows.length) : 0, preferredCountry, favoriteCategory, lastPurchaseDate: rows[0]?.purchase_date || null, boundAt: binding.bound_at },
    recentPurchases: rows.slice(0, 10).map((p: any) => ({ date: p.purchase_date, amount: Number(p.amount || 0), category: p.category || "其他", product: p.product || "", trip: p.trips?.name || "未指定場次" })),
    coupons: coupons.map((c: any) => ({ id: c.id, title: c.title, amount: Number(c.amount || 0), minimumSpend: Number(c.minimum_spend || 0), expiresAt: c.expires_at, note: c.note || "" })),
  };
}
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
  try {
    const body = await req.json();
    if (body.action === "create-code") {
      const user = await adminEmailFromRequest(req);
      const customerId = String(body.customerId || "").trim();
      if (!customerId) return reply(400, { error: "請先選擇客戶。" });
      const { data: customer, error: customerError } = await admin.from("customers").select("id,name").eq("id", customerId).maybeSingle();
      if (customerError) throw customerError;
      if (!customer) return reply(404, { error: "找不到這位客戶。" });
      const { data: alreadyBound, error: boundError } = await admin.from("navo_line_members").select("id").eq("customer_id", customerId).maybeSingle();
      if (boundError) throw boundError;
      if (alreadyBound) return reply(409, { error: "這位客戶已綁定 LINE。若要更換，請先由管理員處理解除綁定。" });
      const code = randomCode();
      const codeHash = await sha256(code);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const { error: insertError } = await admin.from("navo_line_bind_codes").insert({ customer_id: customerId, code_hash: codeHash, created_by: user.id, expires_at: expiresAt });
      if (insertError) throw insertError;
      return reply(200, { ok: true, code, customerName: customer.name, expiresAt });
    }
    const idToken = String(body.idToken || "");
    if (!idToken) return reply(400, { error: "沒有取得 LINE 登入憑證，請重新開啟會員頁。" });
    const line = await verifyLineIdToken(idToken);
    if (body.action === "bind") {
      const code = String(body.code || "").replace(/\s/g, "");
      if (!/^\d{8}$/.test(code)) return reply(400, { error: "請輸入 8 位數驗證碼。" });
      const { data, error } = await admin.rpc("navo_bind_line_member", { p_code_hash: await sha256(code), p_line_user_id: line.lineUserId });
      if (error) throw error;
      if (!data?.ok) return reply(400, { error: data?.message || "驗證碼綁定失敗。" });
      return reply(200, { ok: true, message: "綁定成功！歡迎加入 NAVO 會員。" });
    }
    if (body.action === "profile") return reply(200, await profileForLine(line.lineUserId, line.displayName));
    return reply(400, { error: "不支援的操作。" });
  } catch (e) {
    console.error(e);
    return reply(400, { error: e instanceof Error ? e.message : "發生未知錯誤。" });
  }
});
