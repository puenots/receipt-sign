// Lambda Function URL の入口。ルーティングだけをここに置く。
import * as core from "./core.js";
import { s3Store } from "./store.js";
import { buildPdf, isPng, sha256 } from "./pdf.js";
import { selectReceipts, buildExportFiles } from "./export.js";
import { makeZip } from "./zip.js";

const MAX_PNG = 4 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function makeHandler({ store, env, now = () => new Date(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const siteUrl = env.SITE_URL || "https://receipt.djue.me";
  // ?r= は領収書ごとに違うので、スマホに古いページが残っていても必ず最新を読む(トークンはサーバーに残らない # の後ろ)
  const signUrl = (r) => `${siteUrl}/s/?r=${r.id}#${r.token}`;
  const allowed = (origin) => origin === siteUrl || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin || "");

  const getReceipt = async (id) => {
    const r = await store.getJSON(`receipts/${id}.json`);
    if (!r) throw new HttpError(404, "見つかりません");
    return r;
  };
  const saveReceipt = async (r) => {
    await store.putJSON(`receipts/${r.id}.json`, r);
    await store.putJSON(`tokens/${r.token}.json`, { id: r.id });
  };
  const byToken = async (t) => {
    const m = t && (await store.getJSON(`tokens/${t}.json`));
    const r = m && (await store.getJSON(`receipts/${m.id}.json`));
    if (!core.tokenUsable(r, now())) throw new HttpError(410, "この URL は使えません(送信済み・期限切れ・作り直し済みのどれかです)。送ってくれた人に連絡してください。");
    return r;
  };
  const getPerson = async (id) => {
    const p = await store.getJSON(`people/${id}.json`);
    if (!p) throw new HttpError(404, "名簿にいません");
    return p;
  };

  const routes = {
    "POST /api/login": async ({ body }) => {
      if (!core.verifyPassword(String(body.password || ""), env.ADMIN_PASS_HASH)) {
        await sleep(1000);
        throw new HttpError(401, "パスワードが違います");
      }
      return { session: core.signSession(env.SESSION_KEY, now().getTime()) };
    },

    "GET /api/people": async () => ({ people: (await store.listJSON("people/")).sort((a, b) => a.name.localeCompare(b.name, "ja")) }),
    "POST /api/people": async ({ body }) => {
      if (!String(body.name || "").trim()) throw new HttpError(400, "名前を入れてください");
      const prev = body.id ? await getPerson(body.id) : { id: core.newId("P", now()) };
      const p = { ...prev, name: body.name.trim(), address: (body.address || "").trim(), phone: (body.phone || "").trim(), updatedAt: now().toISOString() };
      await store.putJSON(`people/${p.id}.json`, p);
      return { person: p };
    },

    "GET /api/receipts": async () => ({ receipts: (await store.listJSON("receipts/")).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((r) => ({ ...r, url: r.status === "pending" ? signUrl(r) : null })) }),
    "POST /api/receipts": async ({ body }) => {
      const person = body.personId ? await getPerson(body.personId) : null;
      const r = core.createReceipt({ person, nameHint: body.nameHint, amount: Number(body.amount), date: body.date, event: body.event, kind: body.kind }, now());
      await saveReceipt(r);
      return { receipt: r, url: signUrl(r) };
    },
    "POST /api/receipts/update": async ({ body }) => {
      const r = core.updatePending(await getReceipt(body.id), numAmount(body.changes), now());
      await saveReceipt(r);
      return { receipt: r, url: signUrl(r) };
    },
    "POST /api/receipts/reissue": async ({ body }) => {
      const cur = await getReceipt(body.id);
      const { old, fresh } = core.voidAndReissue(cur, await getPerson(cur.personId), numAmount(body.changes), now());
      await saveReceipt(fresh);
      await saveReceipt(old);
      return { old, receipt: fresh, url: signUrl(fresh) };
    },
    "GET /api/receipts/pdf": async ({ query }) => {
      const r = await getReceipt(query.id);
      if (r.status === "pending") throw new HttpError(400, "まだサインされていません");
      return { url: await store.evidenceUrl(`${r.id}.pdf`, core.pdfFileName(r)) };
    },
    "POST /api/export": async ({ body }) => {
      const rows = selectReceipts(await store.listJSON("receipts/"), { month: body.month, event: body.event });
      if (!rows.length) throw new HttpError(404, "その条件の領収書はありません");
      const label = [body.month, body.event].filter(Boolean).join("_") || "全部";
      const title = `領収書まとめ ${label}`;
      const zip = makeZip(await buildExportFiles(rows, store, { title }), now());
      const key = `exports/${now().toISOString().replace(/[:.]/g, "")}.zip`;
      await store.putExport(key, zip);
      return { url: await store.exportUrl(key, `領収書まとめ_${label}.zip`), count: rows.length };
    },

    "GET /api/sign": async ({ query }) => ({ receipt: core.publicView(await byToken(query.t)) }),
    "POST /api/sign": async ({ body, ip, ua }) => {
      const r = await byToken(body.t);
      const png = Buffer.from(String(body.png || ""), "base64");
      if (!isPng(png) || png.length > MAX_PNG) throw new HttpError(400, "サインの画像が正しく送れませんでした。もう一度お試しください。");
      const hash = sha256(png);
      const signed = core.applySignature(r, { name: body.name, address: body.address, phone: body.phone, sha256: hash, ip, ua }, now());
      const pdf = await buildPdf({ png, receiptId: r.id, signedAt: signed.signedAt, hash });
      await store.putEvidence(`${r.id}.png`, png, "image/png");
      await store.putEvidence(`${r.id}.pdf`, pdf, "application/pdf");
      // 名簿の人は書き直した内容で更新、名簿にない人は名簿に追加(次回から選べる)
      const p = (r.personId && (await store.getJSON(`people/${r.personId}.json`))) || { id: core.newId("P", now()) };
      await store.putJSON(`people/${p.id}.json`, { ...p, name: signed.name, address: signed.address, phone: signed.phone, updatedAt: signed.signedAt });
      signed.personId = p.id;
      await saveReceipt(signed);
      await store.putJSON(`log/${r.id}/${signed.signedAt}.json`, { action: "sign", at: signed.signedAt, ip, ua, sha256: hash, pdfSha256: sha256(pdf) });
      return { ok: true, copyUrl: await store.evidenceUrl(`${r.id}.pdf`, core.pdfFileName(signed), true) };
    },
  };
  const PUBLIC = new Set(["POST /api/login", "GET /api/sign", "POST /api/sign"]);

  return async (event) => {
    const method = event.requestContext?.http?.method || "GET";
    const origin = event.headers?.origin;
    const cors = allowed(origin)
      ? { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type,authorization", "access-control-allow-methods": "GET,POST,OPTIONS", vary: "origin" }
      : {};
    const reply = (status, obj) => ({ statusCode: status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors }, body: JSON.stringify(obj) });
    if (method === "OPTIONS") return { statusCode: 204, headers: cors };
    try {
      const key = `${method} ${event.rawPath}`;
      const fn = routes[key];
      if (!fn) throw new HttpError(404, "not found");
      if (!PUBLIC.has(key)) {
        const auth = (event.headers?.authorization || "").replace(/^Bearer /, "");
        if (!core.verifySession(env.SESSION_KEY, auth, now().getTime())) throw new HttpError(401, "ログインし直してください");
      }
      let body = {};
      if (event.body) body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body);
      const res = await fn({ body, query: event.queryStringParameters || {}, ip: event.requestContext?.http?.sourceIp, ua: event.headers?.["user-agent"] });
      return reply(200, res);
    } catch (e) {
      if (e instanceof HttpError) return reply(e.status, { error: e.message });
      if (e instanceof SyntaxError) return reply(400, { error: "送信内容が読めません" });
      if (/が正しくありません|直せません|再サイン|使えません|お名前|ご住所/.test(e.message)) return reply(400, { error: e.message });
      console.error(e);
      return reply(500, { error: "サーバーでエラーが起きました" });
    }
  };
}

function numAmount(changes = {}) {
  return changes.amount === undefined ? changes : { ...changes, amount: Number(changes.amount) };
}

let cached;
export const handler = (event) => {
  cached ||= makeHandler({
    store: s3Store({ dataBucket: process.env.DATA_BUCKET, pdfBucket: process.env.PDF_BUCKET }),
    env: process.env,
  });
  return cached(event);
};
