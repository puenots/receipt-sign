// 領収書の純粋ロジック(保存先や AWS に依存しない)。
import crypto from "node:crypto";

export const PAYEE = "株式会社ストーンアップ";
export const TOKEN_DAYS = 30;
export const SESSION_HOURS = 12;

export const KINDS = {
  shukyaku: "イベント協力費（集客）",
  setsuei: "会場設営・撤収作業代",
  dj: "DJ出演料",
  kyoryoku: "イベント協力費",
};

export function jpDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${y}年${m}月${d}日`;
}

export function proviso(kind, date, event) {
  if (!KINDS[kind]) throw new Error(`unknown kind: ${kind}`);
  if (kind === "kyoryoku") return "イベント協力費として";
  const head = [jpDate(date), (event || "").trim()].filter(Boolean).join(" ");
  return `${head} ${KINDS[kind]}として`;
}

export function randomToken() {
  return crypto.randomBytes(18).toString("base64url");
}

export function newId(prefix, now = new Date()) {
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `${prefix}-${ymd}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

// --- 管理者パスワードとセッション ---
export function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) {
  const h = crypto.scryptSync(pw, salt, 32).toString("hex");
  return `scrypt$${salt}$${h}`;
}

export function verifyPassword(pw, stored) {
  const [alg, salt, h] = (stored || "").split("$");
  if (alg !== "scrypt" || !salt || !h) return false;
  const got = crypto.scryptSync(pw, salt, 32);
  const want = Buffer.from(h, "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export function signSession(key, now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ exp: now + SESSION_HOURS * 3600e3 })).toString("base64url");
  const mac = crypto.createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifySession(key, token, now = Date.now()) {
  const [body, mac] = (token || "").split(".");
  if (!body || !mac) return false;
  const want = crypto.createHmac("sha256", key).update(body).digest("base64url");
  if (mac.length !== want.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return false;
  try { return JSON.parse(Buffer.from(body, "base64url").toString()).exp > now; } catch { return false; }
}

// --- 領収書の状態遷移 ---
function validate({ amount, date, kind }) {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error("金額が正しくありません");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) throw new Error("日付が正しくありません");
  if (!KINDS[kind]) throw new Error("但し書きの種類が正しくありません");
}

export function createReceipt({ person, amount, date, event, kind }, now = new Date()) {
  validate({ amount, date, kind });
  const at = now.toISOString();
  return {
    id: newId("R", now),
    personId: person.id,
    name: person.name, address: person.address || "", phone: person.phone || "",
    amount, date, event: (event || "").trim(), kind,
    proviso: proviso(kind, date, event),
    status: "pending",
    token: randomToken(),
    tokenExpiresAt: new Date(now.getTime() + TOKEN_DAYS * 86400e3).toISOString(),
    createdAt: at,
    history: [{ at, action: "作成", amount }],
  };
}

export function updatePending(r, changes, now = new Date()) {
  if (r.status !== "pending") throw new Error("サイン済み・取消済みの領収書は直せません(再サインを使ってください)");
  const next = { ...r, ...pick(changes, ["amount", "date", "event", "kind"]) };
  validate(next);
  next.event = (next.event || "").trim();
  next.proviso = proviso(next.kind, next.date, next.event);
  const diff = {};
  for (const k of ["amount", "date", "event", "kind"]) if (r[k] !== next[k]) diff[k] = { from: r[k], to: next[k] };
  next.history = [...r.history, { at: now.toISOString(), action: "変更", diff }];
  return next;
}

// サイン済みを取消して、直した内容で新しい未サインを作る。旧は消さない。
export function voidAndReissue(r, person, changes, now = new Date()) {
  if (r.status !== "signed") throw new Error("サイン済みの領収書だけ再サインにできます");
  const fresh = createReceipt({ person, amount: r.amount, date: r.date, event: r.event, kind: r.kind, ...pick(changes, ["amount", "date", "event", "kind"]) }, now);
  fresh.replaces = r.id;
  fresh.history = [{ at: now.toISOString(), action: "再発行", from: r.id, amount: { from: r.amount, to: fresh.amount } }];
  const old = {
    ...r, status: "void", replacedBy: fresh.id, voidedAt: now.toISOString(),
    history: [...r.history, { at: now.toISOString(), action: "取消", replacedBy: fresh.id }],
  };
  return { old, fresh };
}

export function tokenUsable(r, now = new Date()) {
  return r && r.status === "pending" && new Date(r.tokenExpiresAt) > now;
}

export function applySignature(r, { name, address, phone, sha256, ip, ua }, now = new Date()) {
  if (!tokenUsable(r, now)) throw new Error("この URL は使えません");
  if (!String(name || "").trim()) throw new Error("お名前を入れてください");
  const at = now.toISOString();
  return {
    ...r, status: "signed",
    name: name.trim(), address: (address || "").trim(), phone: (phone || "").trim(),
    signedAt: at, sha256, ip, ua,
    history: [...r.history, { at, action: "サイン" }],
  };
}

export function pdfFileName(r) {
  const safe = r.name.replace(/[\\/:*?"<>|\s]+/g, "");
  return `${r.date}_${safe}_${r.amount}.pdf`;
}

// サイン画面に見せてよい項目だけ(履歴・IP 等は出さない)。
export function publicView(r) {
  return {
    id: r.id, payee: PAYEE, amount: r.amount, date: r.date, dateJp: jpDate(r.date),
    proviso: r.proviso, name: r.name, address: r.address, phone: r.phone,
  };
}

function pick(o, keys) {
  const out = {};
  for (const k of keys) if (o && o[k] !== undefined) out[k] = o[k];
  return out;
}
