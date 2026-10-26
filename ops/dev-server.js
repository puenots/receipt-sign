// 手元確認用: 静的ファイル+API(メモリ保存)を 1 つのポートで出す。
// node ops/dev-server.js 8150  → http://localhost:8150/admin/ (パスワード dev)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeHandler } from "../api/src/index.js";
import { memoryStore } from "../api/src/store.js";
import { hashPassword } from "../api/src/core.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.argv[2] || 8150);
const store = memoryStore();
store.evidenceUrl = async (key, _name, inline) => `/mem/evidence/${encodeURIComponent(key)}${inline ? "?inline=1" : ""}`;
store.exportUrl = async (key) => `/mem/export/${encodeURIComponent(key)}`;
const handler = makeHandler({ store, env: { ADMIN_PASS_HASH: hashPassword("dev"), SESSION_KEY: "dev", SITE_URL: `http://localhost:${port}` } });
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname.startsWith("/api/")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const out = await handler({
      rawPath: url.pathname, body: chunks.length ? Buffer.concat(chunks).toString() : undefined,
      queryStringParameters: Object.fromEntries(url.searchParams),
      requestContext: { http: { method: req.method, sourceIp: req.socket.remoteAddress } },
      headers: { ...req.headers, origin: req.headers.origin || `http://localhost:${port}` },
    });
    res.writeHead(out.statusCode, out.headers); return res.end(out.body);
  }
  if (url.pathname.startsWith("/mem/")) { // 署名つき URL の代わり
    const [, , kind, ...rest] = url.pathname.split("/");
    const key = decodeURIComponent(rest.join("/"));
    const buf = kind === "evidence" ? store.evidence.get(key) : store.data.get(key);
    if (!buf) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": kind === "evidence" ? "application/pdf" : "application/zip" }); return res.end(buf);
  }
  if (url.pathname === "/config.js") { // 手元では本番 API ではなくこのサーバーの API を使う
    res.writeHead(200, { "content-type": TYPES[".js"] }); return res.end('window.RECEIPT_API = "";');
  }
  let file = path.join(root, url.pathname);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`http://localhost:${port}/admin/  (password: dev)`));
