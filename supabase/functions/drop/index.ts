import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const BUCKET = "drops";
const MAX_FILE = 50 * 1024 * 1024;
const MAX_FILES = 50;
const QUOTA = 900 * 1024 * 1024; // 免費版總容量 1GB，留一點餘裕
const TTL_CHOICES = [60, 1440, 10080]; // 分鐘：1 小時、24 小時、7 天
const FAIL_WINDOW_MIN = 15; // 同一 IP 在這段時間內密碼錯太多次就暫時鎖住
const FAIL_MAX = 10;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
};

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

class Fail extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
const must = <T>(res: { data: T; error: { message: string } | null }): T => {
  if (res.error) throw new Error(res.error.message);
  return res.data;
};

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function newId() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => alphabet[b % alphabet.length]).join("");
}

async function removeFolder(id: string) {
  const objects = must(await db.storage.from(BUCKET).list(id, { limit: 1000 })) ?? [];
  if (objects.length) must(await db.storage.from(BUCKET).remove(objects.map((o) => `${id}/${o.name}`)));
}
async function removeDrop(id: string) {
  await removeFolder(id);
  must(await db.from("drops").delete().eq("id", id));
}
// 清掉過期的取件碼，以及沒有對應取件碼的殘留檔案（例如上傳到一半就被刪除）
async function cleanup() {
  const expired = must(await db.from("drops").select("id").lt("expires_at", new Date().toISOString())) ?? [];
  for (const d of expired) await removeDrop(d.id);
  const alive = new Set((must(await db.from("drops").select("id")) ?? []).map((d) => d.id));
  const folders = must(await db.storage.from(BUCKET).list("", { limit: 1000 })) ?? [];
  for (const f of folders) if (!alive.has(f.name)) await removeFolder(f.name);
  must(await db.from("auth_failures").delete().lt("at", new Date(Date.now() - 86400000).toISOString()));
}

async function getDrop(id: unknown, needReady = true) {
  if (typeof id !== "string" || !/^[a-z0-9]{12}$/.test(id)) throw new Fail(404, "取件連結不正確");
  const drop = must(await db.from("drops").select("*").eq("id", id).maybeSingle());
  if (!drop || new Date(drop.expires_at) < new Date() || (needReady && !drop.ready)) {
    throw new Fail(404, "取件連結已失效，檔案可能已被下載或已過期");
  }
  return drop;
}
async function getFile(dropId: string, fileId: unknown) {
  if (typeof fileId !== "string" || !/^[0-9a-f-]{36}$/.test(fileId)) throw new Fail(404, "找不到檔案");
  const file = must(await db.from("drop_files").select("*").eq("drop_id", dropId).eq("id", fileId).maybeSingle());
  if (!file) throw new Fail(404, "檔案已被下載並刪除");
  return file;
}

// 刪掉一個檔案；整批都沒檔案時連取件碼一起移除
async function removeFile(dropId: string, file: { id: string; path: string }) {
  must(await db.storage.from(BUCKET).remove([file.path]));
  must(await db.from("drop_files").delete().eq("id", file.id));
  const left = must(await db.from("drop_files").select("id").eq("drop_id", dropId).limit(1)) ?? [];
  if (!left.length) await removeDrop(dropId);
}
// 驗證密碼並回傳角色：上傳密碼可以上傳、看清單、刪除；取件密碼只能看清單、下載、刪除。
// 同一 IP 短時間內錯太多次會被暫時鎖住，避免被人猜密碼
async function checkPassword(ip: string, password: unknown, allowDownload: boolean): Promise<"upload" | "download"> {
  const since = new Date(Date.now() - FAIL_WINDOW_MIN * 60000).toISOString();
  const recent = await db.from("auth_failures").select("*", { count: "exact", head: true }).eq("ip", ip).gt("at", since);
  if (recent.error) throw new Error(recent.error.message);
  if ((recent.count ?? 0) >= FAIL_MAX) throw new Fail(429, `密碼錯誤次數過多，請 ${FAIL_WINDOW_MIN} 分鐘後再試`);
  const hash = await sha256(String(password ?? ""));
  const keys = ["upload_password_sha256", "download_password_sha256"];
  const cfg = must(await db.from("config").select("key, value").in("key", keys)) ?? [];
  if (cfg.some((c) => c.key === keys[0] && c.value === hash)) return "upload";
  if (allowDownload && cfg.some((c) => c.key === keys[1] && c.value === hash)) return "download";
  must(await db.from("auth_failures").insert({ ip }));
  throw new Fail(401, "密碼不正確");
}

// deno-lint-ignore no-explicit-any
const actions: Record<string, (b: any, ip: string) => Promise<unknown>> = {
  // 上傳者：驗證密碼，建立取件碼，回傳每個檔案的一次性上傳憑證
  async create(b, ip) {
    await checkPassword(ip, b.password, false);
    const files = b.files;
    if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) throw new Fail(400, `一次最多 ${MAX_FILES} 個檔案`);
    for (const f of files) {
      if (typeof f?.name !== "string" || !f.name || f.name.length > 255) throw new Fail(400, "檔名不正確");
      if (!Number.isInteger(f.size) || f.size < 0 || f.size > MAX_FILE) throw new Fail(400, `「${f.name}」超過 50 MB`);
    }
    if (!TTL_CHOICES.includes(b.ttlMinutes)) throw new Fail(400, "保存期限不正確");

    await cleanup();
    const stored = must(await db.from("drop_files").select("size")) ?? [];
    const used = stored.reduce((n, f) => n + Number(f.size), 0);
    const incoming = files.reduce((n: number, f: { size: number }) => n + f.size, 0);
    if (used + incoming > QUOTA) throw new Fail(507, "暫存空間不足，請等現有檔案被下載或過期後再試");

    const id = newId();
    const expiresAt = new Date(Date.now() + b.ttlMinutes * 60000).toISOString();
    const note = typeof b.note === "string" ? b.note.trim().slice(0, 100) : "";
    must(await db.from("drops").insert({ id, note, delete_after_download: b.deleteAfter !== false, expires_at: expiresAt }));
    // 逐筆建立，確保回傳的順序和網頁送來的檔案順序一致
    const uploads = [];
    for (const f of files) {
      const path = `${id}/${crypto.randomUUID()}`;
      must(await db.from("drop_files").insert({ drop_id: id, name: f.name, size: f.size, path }));
      const signed = must(await db.storage.from(BUCKET).createSignedUploadUrl(path));
      uploads.push({ path, token: signed.token });
    }
    return { id, expiresAt, uploads };
  },

  // 上傳者：全部傳完後呼叫。沒傳成功的檔案從清單拿掉，取件連結才開始生效
  async commit(b) {
    const drop = await getDrop(b.id, false);
    const objects = must(await db.storage.from(BUCKET).list(drop.id, { limit: 1000 })) ?? [];
    const present = new Set(objects.map((o) => `${drop.id}/${o.name}`));
    const rows = must(await db.from("drop_files").select("id, path").eq("drop_id", drop.id)) ?? [];
    const missing = rows.filter((r) => !present.has(r.path)).map((r) => r.id);
    if (missing.length === rows.length) {
      await removeDrop(drop.id);
      throw new Fail(400, "沒有任何檔案上傳成功");
    }
    if (missing.length) must(await db.from("drop_files").delete().in("id", missing));
    must(await db.from("drops").update({ ready: true }).eq("id", drop.id));
    return { files: rows.length - missing.length };
  },

  async list(b) {
    const drop = await getDrop(b.id);
    const files = must(await db.from("drop_files").select("id, name, size").eq("drop_id", drop.id).order("name")) ?? [];
    return { deleteAfter: drop.delete_after_download, expiresAt: drop.expires_at, files };
  },

  // 上傳紀錄：用取件密碼（或上傳密碼）列出所有還在的檔案
  async browse(b, ip) {
    const role = await checkPassword(ip, b.password, true);
    const drops = must(
      await db.from("drops")
        .select("id, note, delete_after_download, expires_at, created_at, drop_files(id, name, size)")
        .eq("ready", true)
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false }),
    ) ?? [];
    return {
      role,
      drops: drops.map((d) => ({
        id: d.id, note: d.note, deleteAfter: d.delete_after_download, expiresAt: d.expires_at, createdAt: d.created_at,
        files: [...d.drop_files].sort((x, y) => x.name.localeCompare(y.name)),
      })),
    };
  },

  async download(b) {
    const drop = await getDrop(b.id);
    const file = await getFile(drop.id, b.fileId);
    const signed = must(await db.storage.from(BUCKET).createSignedUrl(file.path, 600, { download: file.name }));
    // 只回傳路徑，由網頁接上自己設定的網域
    const u = new URL(signed.signedUrl);
    return { url: u.pathname + u.search };
  },

  // 下載者存檔完成後呼叫：開啟「下載後自動刪除」時把檔案從伺服器移除
  async done(b) {
    const drop = await getDrop(b.id);
    if (!drop.delete_after_download) return { deleted: false };
    await removeFile(drop.id, await getFile(drop.id, b.fileId));
    return { deleted: true };
  },

  // 上傳紀錄裡手動刪除單一檔案：需要取件密碼或上傳密碼
  async remove(b, ip) {
    await checkPassword(ip, b.password, true);
    const drop = await getDrop(b.id);
    await removeFile(drop.id, await getFile(drop.id, b.fileId));
    return { deleted: true };
  },

  // 持有取件連結的人可以立即刪除整批檔案
  async delete(b) {
    const drop = await getDrop(b.id, false);
    await removeDrop(drop.id);
    return { deleted: true };
  },

  // 每日排程呼叫：清過期檔案，同時避免免費專案因閒置被暫停
  async ping() {
    await cleanup();
    return { ok: true };
  },
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "只接受 POST" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const name = String(body?.action);
    if (!Object.hasOwn(actions, name)) return json({ error: "不支援的操作" }, 400);
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
    return json(await actions[name](body, ip));
  } catch (e) {
    if (e instanceof Fail) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "伺服器發生錯誤，請稍後再試" }, 500);
  }
});
