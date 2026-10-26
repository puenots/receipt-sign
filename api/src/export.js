// 経理に渡すまとめ(一覧 CSV・合計表 HTML・PDF 一式)を作る。
import { KINDS, PAYEE, jpDate, pdfFileName } from "./core.js";

const jst = (iso) => (iso ? new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().replace("T", " ").slice(0, 19) : "");
const STATUS = { pending: "未サイン", signed: "サイン済", void: "取消" };

export function selectReceipts(receipts, { month, event }) {
  return receipts
    .filter((r) => (!month || r.date.startsWith(month)) && (!event || r.event === event))
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name, "ja"));
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  const head = ["受付番号", "日付", "イベント", "相手", "住所", "電話", "但し書き", "種類", "金額", "状態", "送信日時(日本時間)", "PDFファイル", "画像SHA-256", "取消→再発行先"];
  const lines = rows.map((r) => [
    r.id, r.date, r.event, r.name, r.address, r.phone, r.proviso, KINDS[r.kind], r.amount, STATUS[r.status],
    jst(r.signedAt), r.status === "pending" ? "" : (r.status === "void" ? "取消/" : "") + pdfFileName(r), r.sha256 || "", r.replacedBy || "",
  ].map(csvCell).join(","));
  return "﻿" + [head.join(","), ...lines].join("\r\n") + "\r\n";
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const yen = (n) => "¥" + n.toLocaleString("ja-JP");

function sumBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const v = m.get(k) || { count: 0, total: 0 };
    v.count++; v.total += r.amount;
    m.set(k, v);
  }
  return [...m.entries()];
}

export function toSummaryHtml(rows, { title }) {
  const signed = rows.filter((r) => r.status === "signed");
  const table = (entries, label) => `<table><tr><th>${label}</th><th>件数</th><th>合計</th></tr>${entries.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${v.count}</td><td class="n">${yen(v.total)}</td></tr>`).join("")}<tr class="tot"><td>合計</td><td class="n">${signed.length}</td><td class="n">${yen(signed.reduce((n, r) => n + r.amount, 0))}</td></tr></table>`;
  const list = (rs) => `<table><tr><th>日付</th><th>相手</th><th>但し書き</th><th>金額</th><th>状態</th><th>PDF</th></tr>${rs.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.name)}</td><td>${esc(r.proviso)}</td><td class="n">${yen(r.amount)}</td><td>${STATUS[r.status]}${r.replacedBy ? `(再発行 ${esc(r.replacedBy)})` : ""}</td><td>${r.status === "pending" ? "-" : esc((r.status === "void" ? "取消/" : "") + pdfFileName(r))}</td></tr>`).join("")}</table>`;
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font-family:-apple-system,"Hiragino Sans","Yu Gothic",sans-serif;margin:24px;color:#111}h1{font-size:20px}h2{font-size:16px;margin-top:24px}
table{border-collapse:collapse;margin:6px 0 12px;font-size:13px}th,td{border:1px solid #999;padding:4px 10px;text-align:left}th{background:#eee}.n{text-align:right}.tot td{font-weight:700;background:#f6f6f6}
.note{font-size:12px;color:#555}@media print{body{margin:0}}</style></head><body>
<h1>${esc(title)}</h1>
<p class="note">宛名: ${esc(PAYEE)} / 合計はサイン済みのみ(未サイン・取消は含まない)/ 作成: ${jpDate(new Date().toISOString().slice(0, 10))}</p>
<h2>但し書き別</h2>${table(sumBy(signed, (r) => KINDS[r.kind]), "種類")}
<h2>イベント別</h2>${table(sumBy(signed, (r) => `${r.date} ${r.event || "(イベント名なし)"}`), "イベント")}
<h2>一覧</h2>${list(rows)}
<p class="note">取消: 金額などを直すためにサインし直してもらったもの。元の領収書は「取消」フォルダに残しています。各 PDF の下に受付番号・送信日時・画像の SHA-256 を印字しています。</p>
</body></html>`;
}

export async function buildExportFiles(rows, store, { title }) {
  const files = [
    { name: "領収書一覧.csv", data: toCsv(rows) },
    { name: "合計.html", data: toSummaryHtml(rows, { title }) },
  ];
  const used = new Set();
  for (const r of rows) {
    if (r.status === "pending") continue;
    let name = (r.status === "void" ? "取消/" : "") + pdfFileName(r);
    if (used.has(name)) name = name.replace(/\.pdf$/, `_${r.id}.pdf`); // 同じ人・日・金額が 2 枚あるとき
    used.add(name);
    files.push({ name, data: await store.getEvidence(`${r.id}.pdf`) });
  }
  return files;
}
