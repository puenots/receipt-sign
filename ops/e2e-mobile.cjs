// スマホ表示の通しテスト(手元の dev-server に対して)。
//   node ops/dev-server.js 8150 &
//   NODE_PATH=~/puppeteer-test/node_modules node ops/e2e-mobile.cjs [スクショ置き場]
// iPhone は WebKit、Android は Chromium で開き、サイン画面・管理画面の操作と見た目の崩れを確かめる。
const { webkit, chromium, devices } = require("playwright");
const fs = require("fs");

const BASE = "http://localhost:8150";
const OUT = process.argv[2] || "/tmp/receipt-e2e";
fs.mkdirSync(OUT, { recursive: true });
const DEVICES = [["webkit", "iPhone SE"], ["webkit", "iPhone 15 Pro Max"], ["chromium", "Pixel 7"]];
const problems = [];
const check = (ok, msg) => { if (!ok) { problems.push(msg); console.log("  NG", msg); } else console.log("  ok", msg); };

// 画面の外にはみ出していないか・ボタンが他の要素に隠れていないか
async function layoutChecks(page, label, scope = "body") {
  const r = await page.evaluate((scope) => {
    const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const hidden = [];
    for (const b of document.querySelector(scope).querySelectorAll("button, input, select, a.btn")) {
      const rc = b.getBoundingClientRect();
      if (!rc.width || !rc.height || getComputedStyle(b).visibility === "hidden") continue;
      if (rc.bottom < 0 || rc.top > innerHeight) continue; // 画面外(スクロールすれば見える)は対象外
      const x = rc.left + rc.width / 2, y = Math.min(rc.top + rc.height / 2, innerHeight - 1);
      const hit = document.elementFromPoint(x, y);
      if (hit && hit !== b && !b.contains(hit) && !hit.contains(b) && hit.tagName !== "LABEL") hidden.push((b.id || b.textContent || b.name || b.tagName).trim().slice(0, 20) + " ← " + (hit.id || hit.tagName));
    }
    return { over, hidden };
  }, scope);
  check(r.over <= 1, `${label}: 横にはみ出さない(${r.over}px)`);
  check(!r.hidden.length, `${label}: 押せない部品なし ${r.hidden.join(", ")}`);
}

// サイン枠に「横に長い波線」を書く(枠の中の座標で指定し、画面の座標に直して PointerEvent を送る)
async function drawWave(page) {
  return page.evaluate(() => {
    const big = document.getElementById("big"), rot = document.getElementById("pad").classList.contains("rot");
    const r = big.getBoundingClientRect(), w = big.offsetWidth, h = big.offsetHeight;
    const toScreen = (cx, cy) => (rot ? [r.right - cy, r.top + cx] : [r.left + cx, r.top + cy]);
    const fire = (type, cx, cy) => {
      const [x, y] = toScreen(cx, cy);
      big.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, pointerType: "touch", bubbles: true, cancelable: true }));
    };
    fire("pointerdown", w * 0.1, h * 0.6);
    for (let i = 0; i <= 40; i++) fire("pointermove", w * (0.1 + i * 0.02), h * (0.55 + Math.sin(i / 3) * 0.2));
    fire("pointerup", w * 0.9, h * 0.6);
    // 実際に描いた線の位置(枠の中)を返す: 横長なら向きの変換が正しい
    const c = big.getContext("2d").getImageData(0, 0, big.width, big.height).data;
    let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
    for (let y = 0; y < big.height; y += 2) for (let x = 0; x < big.width; x += 2) if (c[(y * big.width + x) * 4 + 3] > 0) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return { inkW: x1 - x0, inkH: y1 - y0, canvas: [big.width, big.height], rot };
  });
}

async function newReceipt(adminPage, opts = {}) {
  await adminPage.click('[data-tab="tNew"]');
  await adminPage.selectOption("#nPerson", opts.personId ?? "");
  if (opts.hint) await adminPage.fill("#nHint", opts.hint);
  await adminPage.fill("#nAmount", String(opts.amount || 1000));
  await adminPage.click("#newForm button.main");
  const url = await (await adminPage.waitForSelector("#nOut .url code")).textContent();
  return url;
}

(async () => {
  const wk = await webkit.launch(), ch = await chromium.launch();
  const admin = await (await ch.newContext({ ...devices["Pixel 7"] })).newPage();
  admin.on("pageerror", (e) => check(false, "管理画面 JS エラー " + e.message));
  await admin.goto(BASE + "/admin/");
  await admin.fill("#pw", "dev"); await admin.click("#loginForm button");
  await admin.waitForSelector("#app:not(.hide)");
  await layoutChecks(admin, "管理画面(Pixel 7)");
  // 名簿に 1 人
  await admin.click('[data-tab="tPeople"]');
  await admin.fill("#pName", "山田 太郎"); await admin.fill("#pAddress", "横浜市中区本牧町1-1"); await admin.fill("#pPhone", "090-0000-0000");
  await admin.click("#pSave"); await admin.waitForFunction(() => document.querySelectorAll("#people .r").length === 1);
  const personId = await admin.$eval("#nPerson", (s) => s.options[0].value);

  for (const [engine, dev] of DEVICES) {
    console.log(`\n== ${dev} (${engine})`);
    const br = engine === "webkit" ? wk : ch;
    const ctx = await br.newContext({ ...devices[dev] });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => check(false, `${dev}: JS エラー ${e.message}`));
    const tag = dev.replace(/ /g, "_");

    // 1) 名簿にない人: 郵便番号→住所→サイン→送信
    const url = await newReceipt(admin, { hint: dev });
    await p.goto(url.replace("http://localhost:8150", BASE)); await p.waitForSelector("#form:not(.hide)");
    await layoutChecks(p, `${dev} サイン画面`);
    check((await p.inputValue("#name")) === "", `${dev}: 名簿外は名前が空`);
    await p.fill("#zip", "231-0801"); await p.waitForTimeout(400);
    check((await p.inputValue("#address")) === "神奈川県横浜市中区新山下", `${dev}: 郵便番号で住所が出る`);
    await p.fill("#address", "神奈川県横浜市中区新山下1-2-3");
    await p.fill("#name", "テスト 花子");
    // サインなしで送ると止まる
    await p.click("#send");
    check(/サインを書いて/.test(await p.textContent("#err")), `${dev}: サインなしは送れない`);
    await p.click("#sigbox"); await p.waitForSelector("#pad:not(.hide)"); await p.waitForTimeout(500);
    const vp = p.viewportSize();
    const padBox = await p.$eval("#pad", (e) => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
    check(Math.abs(padBox[2] - vp.width) <= 1 && Math.abs(padBox[3] - vp.height) <= 1, `${dev}: 書く画面が全体を覆う ${padBox.map(Math.round)} vs ${vp.width}x${vp.height}`);
    const sel = await p.evaluate(() => getComputedStyle(document.getElementById("big")).webkitUserSelect || getComputedStyle(document.getElementById("big")).userSelect);
    check(sel === "none", `${dev}: 書く画面は文字選択できない`);
    await layoutChecks(p, `${dev} 書く画面`, "#pad");
    const ink = await drawWave(p);
    check(ink.inkW > ink.inkH * 2, `${dev}: 線が枠の向きどおりに描ける(rot=${ink.rot} 幅${ink.inkW}×高さ${ink.inkH})`);
    await p.screenshot({ path: `${OUT}/${tag}-pad.png` });
    await p.click("#padOk"); await p.waitForTimeout(200);
    const prev = await p.$eval("#sigbox img", (im) => [im.naturalWidth, im.naturalHeight]).catch(() => null);
    check(prev && prev[0] > prev[1] * 1.5, `${dev}: 決定後のサインは横長 ${prev}`);
    await p.click("#send"); await p.waitForSelector("#done:not(.hide)", { timeout: 15000 }).catch(() => {});
    check(await p.isVisible("#done"), `${dev}: 送信できる`);
    const copy = await p.getAttribute("#copy", "href");
    const pdf = await p.evaluate(async (u) => { const r = await fetch(u); const b = new Uint8Array(await r.arrayBuffer()); return String.fromCharCode(...b.slice(0, 5)); }, copy);
    check(pdf === "%PDF-", `${dev}: 控え PDF が開ける`);
    await p.screenshot({ path: `${OUT}/${tag}-done.png` });
    // 同じ URL はもう使えない
    await p.goto(url); await p.reload(); await p.waitForSelector("#fail:not(.hide)");
    check(/使えません/.test(await p.textContent("#failmsg")), `${dev}: 送信済み URL は使えない`);

    // 2) 名簿の人: 名前・住所が入っている、やめる/書き直す
    const url2 = await newReceipt(admin, { personId });
    await p.goto(url2); await p.reload(); await p.waitForSelector("#form:not(.hide)");
    check((await p.inputValue("#name")) === "山田 太郎" && (await p.inputValue("#address")).startsWith("横浜市"), `${dev}: 名簿の人は名前・住所入り`);
    await p.click("#sigbox"); await p.waitForTimeout(400); await drawWave(p);
    await p.click("#padCancel"); await p.waitForTimeout(100);
    check(!(await p.$("#sigbox img")), `${dev}: やめるとサインは入らない`);
    await p.click("#sigbox"); await p.waitForTimeout(400); await drawWave(p); await p.click("#padClear");
    const blank = await p.evaluate(() => { const b = document.getElementById("big"); return !b.getContext("2d").getImageData(0, 0, b.width, b.height).data.some((v, i) => i % 4 === 3 && v); });
    check(blank, `${dev}: 書き直すで消える`);
    await p.click("#padCancel");
    await ctx.close();
  }

  // 電波が切れたときは日本語の案内が出て、もう一度送れる
  console.log("\n== 通信エラー");
  {
    const ctx = await wk.newContext({ ...devices["iPhone SE"] }); const p = await ctx.newPage();
    const url = await newReceipt(admin, { personId });
    await p.goto(url); await p.waitForSelector("#form:not(.hide)");
    await p.click("#sigbox"); await p.waitForTimeout(400); await drawWave(p); await p.click("#padOk");
    await p.route("**/api/sign", (r) => (r.request().method() === "POST" ? r.abort() : r.continue()));
    await p.click("#send"); await p.waitForTimeout(500);
    check(/通信できませんでした/.test(await p.textContent("#err")), "通信エラーは日本語で出る");
    check(!(await p.isDisabled("#send")), "通信エラーのあと送信ボタンが押せる");
    await p.unroute("**/api/sign"); await p.click("#send"); await p.waitForSelector("#done:not(.hide)", { timeout: 15000 }).catch(() => {});
    check(await p.isVisible("#done"), "もう一度押すと送れる");
    await ctx.close();
  }

  // 3) 管理画面: 修正・再サイン・経理 ZIP
  console.log("\n== 管理画面");
  await Promise.all([admin.waitForResponse((r) => r.url().endsWith("/api/receipts")), admin.click('[data-tab="tList"]')]);
  await admin.waitForTimeout(200); // 読み直した一覧が描き終わるまで
  const pendingEdit = await admin.$('#list .r.pending button:has-text("内容を直す")');
  await pendingEdit.click(); await admin.fill('.edit input[name=amount]', "2500"); await admin.click(".edit button.main");
  const edited = await admin.waitForFunction(() => [...document.querySelectorAll("#list .amt")].some((e) => e.textContent.includes("2,500")), null, { timeout: 8000 }).then(() => true, () => false);
  check(edited, "未サインの金額を直せる(一覧を開くと最新になっている)");
  await admin.click('#list .r.signed button:has-text("金額を直して再サイン")');
  await admin.fill('.edit input[name=amount]', "3000"); await admin.click(".edit button.main");
  await admin.waitForSelector("#list .r.void");
  check(await admin.isVisible("#list .r.void"), "再サインで旧が取消になる");
  await layoutChecks(admin, "一覧");
  await admin.click('[data-tab="tKeiri"]'); await admin.fill("#kMonth", ""); await admin.click("#kGo");
  await admin.waitForSelector("#kMsg a", { timeout: 15000 });
  check(/件をまとめました/.test(await admin.textContent("#kMsg")), "経理 ZIP ができる");
  await admin.screenshot({ path: `${OUT}/admin-keiri.png` });

  await wk.close(); await ch.close();
  console.log(`\n問題 ${problems.length} 件`);
  for (const m of problems) console.log(" -", m);
  process.exit(problems.length ? 1 : 0);
})().catch((e) => { console.error("FAIL", e); process.exit(2); });
