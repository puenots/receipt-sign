import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeHandler } from "../src/index.js";
import { memoryStore } from "../src/store.js";
import { hashPassword } from "../src/core.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const env = { ADMIN_PASS_HASH: hashPassword("secret"), SESSION_KEY: "k", SITE_URL: "https://receipt.djue.me" };

function setup() {
  const store = memoryStore();
  let t = new Date("2026-10-26T00:00:00Z");
  const h = makeHandler({ store, env, now: () => t, sleep: async () => {} });
  let session = "";
  const call = async (method, p, body, extra = {}) => {
    const [rawPath, qs] = p.split("?");
    const res = await h({
      rawPath, body: body ? JSON.stringify(body) : undefined,
      queryStringParameters: qs ? Object.fromEntries(new URLSearchParams(qs)) : undefined,
      requestContext: { http: { method, sourceIp: "203.0.113.5" } },
      headers: { origin: "https://receipt.djue.me", "user-agent": "iPhone test", authorization: `Bearer ${session}`, ...extra },
    });
    return { status: res.statusCode, headers: res.headers, json: res.body ? JSON.parse(res.body) : null };
  };
  return { store, call, login: async () => { session = (await call("POST", "/api/login", { password: "secret" })).json.session; }, setTime: (d) => { t = d; } };
}

test("ログインしないと管理 API は 401・パスワード違いも 401", async () => {
  const { call } = setup();
  assert.equal((await call("GET", "/api/people")).status, 401);
  assert.equal((await call("POST", "/api/login", { password: "bad" })).status, 401);
});

test("CORS は receipt.djue.me と localhost だけ", async () => {
  const { call } = setup();
  assert.equal((await call("OPTIONS", "/api/sign")).headers["access-control-allow-origin"], "https://receipt.djue.me");
  assert.equal((await call("OPTIONS", "/api/sign", null, { origin: "http://localhost:8150" })).headers["access-control-allow-origin"], "http://localhost:8150");
  assert.equal((await call("OPTIONS", "/api/sign", null, { origin: "https://evil.example" })).headers["access-control-allow-origin"], undefined);
});

test("作成→サイン→PDF→再サイン→経理 ZIP まで一周", async () => {
  const { store, call, login } = setup();
  await login();
  const p = (await call("POST", "/api/people", { name: "山田 太郎", address: "横浜市中区1-1", phone: "090-1111-2222" })).json.person;
  const c = await call("POST", "/api/receipts", { personId: p.id, amount: "15000", date: "2026-10-24", event: "STILL045", kind: "shukyaku" });
  assert.equal(c.status, 200);
  const token = c.json.url.split("#")[1];
  assert.match(c.json.url, /^https:\/\/receipt\.djue\.me\/s\/#/);

  // サイン前は金額変更できる(URL 同じ)
  const u = await call("POST", "/api/receipts/update", { id: c.json.receipt.id, changes: { amount: "12000" } });
  assert.equal(u.json.receipt.amount, 12000);
  assert.equal(u.json.url, c.json.url);

  // サイン画面: 住所は API からだけ出る・履歴は出ない
  const v = await call("GET", `/api/sign?t=${token}`);
  assert.equal(v.json.receipt.amount, 12000);
  assert.equal(v.json.receipt.address, "横浜市中区1-1");
  assert.equal(v.json.receipt.history, undefined);
  assert.equal(v.json.receipt.proviso, "2026年10月24日 STILL045 イベント協力費（集客）として");

  // 送信: 壊れた画像は 400
  assert.equal((await call("POST", "/api/sign", { t: token, name: "山田 太郎", png: "AAAA" })).status, 400);
  const s = await call("POST", "/api/sign", { t: token, name: "山田 太郎", address: "横浜市中区2-2", phone: "090-1111-2222", png: PNG });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const id = c.json.receipt.id;
  assert.ok(store.evidence.get(`${id}.pdf`).subarray(0, 5).toString() === "%PDF-");
  assert.equal((await store.getJSON(`people/${p.id}.json`)).address, "横浜市中区2-2"); // 名簿も直る
  const rec = await store.getJSON(`receipts/${id}.json`);
  assert.equal(rec.ip, "203.0.113.5");
  assert.equal(rec.ua, "iPhone test");
  assert.match(rec.sha256, /^[0-9a-f]{64}$/);

  // 2 回目は使えない・サイン後は直せない
  assert.equal((await call("POST", "/api/sign", { t: token, name: "x", png: PNG })).status, 410);
  assert.equal((await call("POST", "/api/receipts/update", { id, changes: { amount: 1 } })).status, 400);

  // PDF ダウンロード URL にファイル名
  assert.match((await call("GET", `/api/receipts/pdf?id=${id}`)).json.url, /2026-10-24_%E5%B1%B1/);

  // 再サイン: 旧は取消で残り、新しい URL
  const re = await call("POST", "/api/receipts/reissue", { id, changes: { amount: 20000 } });
  assert.equal(re.json.old.status, "void");
  assert.equal(re.json.receipt.amount, 20000);
  assert.notEqual(re.json.url, c.json.url);
  const t2 = re.json.url.split("#")[1];
  assert.equal((await call("POST", "/api/sign", { t: t2, name: "山田 太郎", address: "横浜", phone: "090", png: PNG })).status, 200);

  // 経理 ZIP
  const ex = await call("POST", "/api/export", { month: "2026-10" });
  assert.equal(ex.status, 200, JSON.stringify(ex.json));
  assert.equal(ex.json.count, 2);
  const key = ex.json.url.replace("mem://export/", "").split("?")[0];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rs-"));
  fs.writeFileSync(path.join(dir, "a.zip"), store.data.get(key));
  // macOS の unzip は UTF-8 フラグを表示に使わないので Python で読む
  const listing = execFileSync("python3", ["-I", "-c", "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print('\\n'.join(z.namelist()))", path.join(dir, "a.zip")]).toString();
  assert.match(listing, /領収書一覧\.csv/);
  assert.match(listing, /合計\.html/);
  assert.match(listing, /取消\/2026-10-24_山田太郎_12000\.pdf/);
  assert.match(listing, /2026-10-24_山田太郎_20000\.pdf/);
  assert.equal((await call("POST", "/api/export", { month: "2025-01" })).status, 404);

  // 同じ人・日・金額が 2 枚でも ZIP の中で名前がぶつからない
  const c3 = await call("POST", "/api/receipts", { personId: p.id, amount: 20000, date: "2026-10-24", event: "STILL045", kind: "shukyaku" });
  await call("POST", "/api/sign", { t: c3.json.url.split("#")[1], name: "山田 太郎", png: PNG });
  const ex2 = await call("POST", "/api/export", { month: "2026-10" });
  const key2 = ex2.json.url.replace("mem://export/", "").split("?")[0];
  fs.writeFileSync(path.join(dir, "b.zip"), store.data.get(key2));
  const names = execFileSync("python3", ["-I", "-c", "import sys,zipfile;n=zipfile.ZipFile(sys.argv[1]).namelist();assert len(n)==len(set(n)),n;print(len(n))", path.join(dir, "b.zip")]).toString().trim();
  assert.equal(names, "5");
});

test("期限切れの URL は 410", async () => {
  const { call, login, setTime } = setup();
  await login();
  const p = (await call("POST", "/api/people", { name: "A" })).json.person;
  const c = await call("POST", "/api/receipts", { personId: p.id, amount: 100, date: "2026-10-24", kind: "dj" });
  setTime(new Date("2026-12-01T00:00:00Z"));
  assert.equal((await call("GET", `/api/sign?t=${c.json.url.split("#")[1]}`)).status, 410);
});
