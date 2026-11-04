// サインされたら keiju にメールで知らせる(SES)。NOTIFY_TO が無ければ何もしない。
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { pdfFileName } from "./core.js";

const jst = (iso) => new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().replace("T", " ").slice(0, 16);

export function signedMail(r, siteUrl) {
  const yen = `¥${r.amount.toLocaleString("ja-JP")}`;
  return {
    subject: `【領収書】${r.name} さんがサインしました ${yen}`,
    text: [
      `${r.name} さんが領収書にサインして送信しました。`,
      "",
      `金額: ${yen}`,
      `但し書き: ${r.proviso}`,
      `日付: ${r.date}`,
      `ご住所: ${r.address}`,
      `お電話: ${r.phone || "-"}`,
      `受付番号: ${r.id}`,
      `送信日時: ${jst(r.signedAt)}(日本時間)`,
      "",
      "領収書の PDF を添付しています。",
      `管理画面: ${siteUrl}/admin/`,
    ].join("\n"),
  };
}

// SES の Raw でテキスト本文+PDF 添付を送る
export function rawMime({ from, to, subject, text, pdf, pdfName }) {
  const b = "----receipt" + Date.now().toString(36);
  const b64 = (s) => Buffer.from(s).toString("base64");
  const wrap = (s) => s.replace(/.{1,76}/g, "$&\r\n");
  return [
    `From: ${from}`, `To: ${to}`, `Subject: =?UTF-8?B?${b64(subject)}?=`, "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${b}"`, "", `--${b}`,
    "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap(b64(text)),
    `--${b}`, `Content-Type: application/pdf; name="receipt.pdf"`, "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="receipt.pdf"; filename*=UTF-8''${encodeURIComponent(pdfName)}`, "",
    wrap(pdf.toString("base64")), `--${b}--`, "",
  ].join("\r\n");
}

export function mailNotifier(env) {
  if (!env.NOTIFY_TO || !env.NOTIFY_FROM) return async () => {};
  const ses = new SESv2Client({ region: env.AWS_REGION || "ap-northeast-1" });
  return async (r, pdf) => {
    const { subject, text } = signedMail(r, env.SITE_URL || "https://receipt.djue.me");
    const data = rawMime({ from: env.NOTIFY_FROM, to: env.NOTIFY_TO, subject, text, pdf, pdfName: pdfFileName(r) });
    await ses.send(new SendEmailCommand({ Content: { Raw: { Data: Buffer.from(data) } } }));
  };
}
