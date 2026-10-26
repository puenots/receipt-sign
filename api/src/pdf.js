// 出演者のスマホで描いた領収書画像(PNG)を PDF にし、下に受付番号・日時・画像の指紋を印字する。
import crypto from "node:crypto";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

export function isPng(buf) {
  return buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

export function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function jst(iso) {
  return new Date(new Date(iso).getTime() + 9 * 3600e3).toISOString().replace("T", " ").slice(0, 19) + " JST";
}

export async function buildPdf({ png, receiptId, signedAt, hash }) {
  const doc = await PDFDocument.create();
  doc.setTitle(`Receipt ${receiptId}`);
  doc.setCreationDate(new Date(signedAt));
  const img = await doc.embedPng(png);
  const W = 595.28, H = 419.53, M = 18, FOOT = 26; // A5 横
  const page = doc.addPage([W, H]);
  const scale = Math.min((W - 2 * M) / img.width, (H - 2 * M - FOOT) / img.height);
  const w = img.width * scale, h = img.height * scale;
  page.drawImage(img, { x: (W - w) / 2, y: M + FOOT + (H - 2 * M - FOOT - h) / 2, width: w, height: h });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const gray = rgb(0.35, 0.35, 0.35);
  page.drawText(`Receipt No: ${receiptId}    Signed at: ${jst(signedAt)}`, { x: M, y: M + 12, size: 7, font, color: gray });
  page.drawText(`SHA-256 (receipt image): ${hash}`, { x: M, y: M + 2, size: 7, font, color: gray });
  return Buffer.from(await doc.save());
}
