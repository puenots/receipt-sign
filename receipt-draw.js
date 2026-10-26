// 領収書 1 枚を canvas に描く(サイン画面の送信用・管理画面のプレビューで共用)。
// r = { payee, dateJp, amount, proviso, address, name, phone }、sig = サインの canvas(なければ空欄)
window.drawReceipt = function (r, sig) {
  const W = 1400, H = 990; // A5 横の比率
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d");
  const serif = '"Hiragino Mincho ProN","Yu Mincho","YuMincho",serif';
  const sans = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif';
  g.fillStyle = "#fff"; g.fillRect(0, 0, W, H);
  g.fillStyle = "#111"; g.strokeStyle = "#111";

  const fit = (text, x, y, maxW, size, font, align = "left") => {
    let s = size;
    do { g.font = `${s}px ${font}`; s -= 1; } while (g.measureText(text).width > maxW && s > 12);
    g.textAlign = align; g.fillText(text, x, y); g.textAlign = "left";
  };
  const line = (x1, y, x2, w = 2) => { g.lineWidth = w; g.beginPath(); g.moveTo(x1, y); g.lineTo(x2, y); g.stroke(); };

  g.font = `bold 64px ${serif}`; g.textAlign = "center"; g.fillText("領　収　書", W / 2, 110); g.textAlign = "left";
  fit(`${r.payee}　様`, 80, 210, 760, 44, sans); line(80, 228, 860);
  fit(r.dateJp, W - 80, 210, 420, 34, sans, "right");

  g.lineWidth = 3; g.strokeRect(80, 270, W - 160, 130);
  g.font = `30px ${sans}`; g.fillText("金額", 120, 350);
  g.font = `bold 66px ${serif}`; g.fillText(`¥ ${Number(r.amount).toLocaleString("ja-JP")} −`, 260, 362);

  fit(`但し、${r.proviso}`, 80, 470, W - 160, 34, sans);
  g.font = `34px ${sans}`; g.fillText("上記、正に領収いたしました。", 80, 520);

  g.font = `24px ${sans}`; g.fillStyle = "#555"; g.fillText("〈受領者〉", 80, 600); g.fillStyle = "#111";
  const rows = [["ご住所", r.address, 670], ["お名前", r.name, 750], ["お電話番号", r.phone, 830]];
  for (const [label, val, y] of rows) {
    g.font = `28px ${sans}`; g.fillText(label, 80, y);
    fit(val || "", 260, y, 560, 34, sans);
    line(250, y + 14, 840, 1.5);
  }
  // サイン欄(右下)
  g.font = `24px ${sans}`; g.fillStyle = "#555"; g.fillText("サイン", 880, 600); g.fillStyle = "#111";
  g.lineWidth = 1.5; g.strokeRect(880, 615, W - 960, 240);
  if (sig) {
    const bw = W - 980, bh = 220, s = Math.min(bw / sig.width, bh / sig.height);
    g.drawImage(sig, 890 + (bw - sig.width * s) / 2, 625 + (bh - sig.height * s) / 2, sig.width * s, sig.height * s);
  }
  return c;
};
