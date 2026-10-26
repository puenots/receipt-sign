import test from "node:test";
import assert from "node:assert/strict";
import * as c from "../src/core.js";

const person = { id: "P-1", name: "山田 太郎", address: "横浜市中区1-1", phone: "090-0000-0000" };
const now = new Date("2026-10-26T00:00:00Z");

test("但し書き: 日付とイベント名が入る / 協力費は単独", () => {
  assert.equal(c.proviso("shukyaku", "2026-10-24", "STILL045"), "2026年10月24日 STILL045 イベント協力費（集客）として");
  assert.equal(c.proviso("setsuei", "2026-10-24", ""), "2026年10月24日 会場設営・撤収作業代として");
  assert.equal(c.proviso("dj", "2026-07-25", "BLOCK6"), "2026年7月25日 BLOCK6 DJ出演料として");
  assert.equal(c.proviso("kyoryoku", "2026-10-24", "STILL045"), "イベント協力費として");
  assert.throws(() => c.proviso("x", "2026-10-24", ""));
});

test("パスワードとセッション", () => {
  const h = c.hashPassword("pw");
  assert.ok(c.verifyPassword("pw", h));
  assert.ok(!c.verifyPassword("bad", h));
  assert.ok(!c.verifyPassword("pw", "garbage"));
  const s = c.signSession("k", 1000);
  assert.ok(c.verifySession("k", s, 2000));
  assert.ok(!c.verifySession("other", s, 2000));
  assert.ok(!c.verifySession("k", s, 1000 + 13 * 3600e3));
  assert.ok(!c.verifySession("k", s.slice(0, -2) + "xx", 2000));
});

test("作成: 未サイン・30 日のトークン・入力チェック", () => {
  const r = c.createReceipt({ person, amount: 15000, date: "2026-10-24", event: "STILL045", kind: "shukyaku" }, now);
  assert.equal(r.status, "pending");
  assert.match(r.id, /^R-20261026-[0-9A-F]{6}$/);
  assert.equal(r.tokenExpiresAt, "2026-11-25T00:00:00.000Z");
  assert.equal(r.name, "山田 太郎");
  assert.throws(() => c.createReceipt({ person, amount: 0, date: "2026-10-24", kind: "dj" }));
  assert.throws(() => c.createReceipt({ person, amount: 1.5, date: "2026-10-24", kind: "dj" }));
  assert.throws(() => c.createReceipt({ person, amount: 100, date: "10/24", kind: "dj" }));
});

test("サイン前は金額を直せて履歴が残る・トークンは同じ", () => {
  const r = c.createReceipt({ person, amount: 15000, date: "2026-10-24", event: "STILL045", kind: "shukyaku" }, now);
  const u = c.updatePending(r, { amount: 12000, kind: "setsuei" }, now);
  assert.equal(u.amount, 12000);
  assert.equal(u.token, r.token);
  assert.equal(u.proviso, "2026年10月24日 STILL045 会場設営・撤収作業代として");
  assert.deepEqual(u.history.at(-1).diff.amount, { from: 15000, to: 12000 });
});

test("サイン後は直せない・取消+再発行で旧は残る", () => {
  const r = c.createReceipt({ person, amount: 15000, date: "2026-10-24", event: "STILL045", kind: "shukyaku" }, now);
  const s = c.applySignature(r, { name: "山田 太郎", address: "横浜", phone: "090", sha256: "ab", ip: "1.2.3.4", ua: "iPhone" }, now);
  assert.equal(s.status, "signed");
  assert.throws(() => c.updatePending(s, { amount: 1 }));
  assert.throws(() => c.applySignature(s, { name: "x" }, now), /使えません/);
  const { old, fresh } = c.voidAndReissue(s, person, { amount: 20000 }, now);
  assert.equal(old.status, "void");
  assert.equal(old.replacedBy, fresh.id);
  assert.equal(old.sha256, "ab");
  assert.equal(fresh.status, "pending");
  assert.equal(fresh.amount, 20000);
  assert.equal(fresh.replaces, s.id);
  assert.notEqual(fresh.token, s.token);
});

test("期限切れトークンは使えない・名前は必須", () => {
  const r = c.createReceipt({ person, amount: 100, date: "2026-10-24", kind: "dj" }, now);
  assert.ok(c.tokenUsable(r, now));
  assert.ok(!c.tokenUsable(r, new Date("2026-12-01T00:00:00Z")));
  assert.throws(() => c.applySignature(r, { name: " " }, now), /お名前/);
  assert.throws(() => c.applySignature(r, { name: "A", address: " " }, now), /ご住所/);
});

test("ファイル名と公開ビュー", () => {
  const r = c.createReceipt({ person, amount: 15000, date: "2026-10-24", event: "STILL045", kind: "shukyaku" }, now);
  assert.equal(c.pdfFileName(r), "2026-10-24_山田太郎_15000.pdf");
  const v = c.publicView(r);
  assert.equal(v.payee, "株式会社ストーンアップ");
  assert.equal(v.dateJp, "2026年10月24日");
  assert.equal(v.history, undefined);
  assert.equal(v.token, undefined);
});
