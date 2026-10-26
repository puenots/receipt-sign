// 保存先。本番は S3、テストはメモリ。どちらも同じ形の関数を持つ。
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function disposition(filename, inline = false) {
  return `${inline ? "inline" : "attachment"}; filename="receipt.${filename.split(".").pop()}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function s3Store({ dataBucket, pdfBucket, region = "ap-northeast-1" }) {
  const s3 = new S3Client({ region });
  const getJSON = async (key) => {
    try {
      const o = await s3.send(new GetObjectCommand({ Bucket: dataBucket, Key: key }));
      return JSON.parse(await o.Body.transformToString());
    } catch (e) {
      if (e.name === "NoSuchKey") return null;
      throw e;
    }
  };
  return {
    getJSON,
    putJSON: (key, obj) => s3.send(new PutObjectCommand({ Bucket: dataBucket, Key: key, Body: JSON.stringify(obj), ContentType: "application/json" })),
    async listJSON(prefix) {
      const keys = [];
      let token;
      do {
        const o = await s3.send(new ListObjectsV2Command({ Bucket: dataBucket, Prefix: prefix, ContinuationToken: token }));
        for (const c of o.Contents || []) keys.push(c.Key);
        token = o.NextContinuationToken;
      } while (token);
      return Promise.all(keys.map(getJSON));
    },
    // 証拠ファイル(PDF・画像)は Object Lock のバケットへ。上書き・削除できない。
    putEvidence: (key, bytes, contentType) => s3.send(new PutObjectCommand({ Bucket: pdfBucket, Key: key, Body: bytes, ContentType: contentType })),
    async getEvidence(key) {
      const o = await s3.send(new GetObjectCommand({ Bucket: pdfBucket, Key: key }));
      return Buffer.from(await o.Body.transformToByteArray());
    },
    // inline=true はその場で表示(iPhone は「ダウンロード」扱いだと白いタブになるため、相手の控えは表示にする)
    evidenceUrl: (key, filename, inline = false) => getSignedUrl(s3, new GetObjectCommand({ Bucket: pdfBucket, Key: key, ResponseContentDisposition: disposition(filename, inline), ResponseContentType: "application/pdf" }), { expiresIn: 3600 }),
    putExport: (key, bytes) => s3.send(new PutObjectCommand({ Bucket: dataBucket, Key: key, Body: bytes, ContentType: "application/zip" })),
    exportUrl: (key, filename) => getSignedUrl(s3, new GetObjectCommand({ Bucket: dataBucket, Key: key, ResponseContentDisposition: disposition(filename) }), { expiresIn: 3600 }),
  };
}

export function memoryStore() {
  const data = new Map();
  const evidence = new Map();
  const clone = (o) => (o == null ? null : JSON.parse(JSON.stringify(o)));
  return {
    data, evidence,
    getJSON: async (key) => clone(data.get(key)),
    putJSON: async (key, obj) => { data.set(key, clone(obj)); },
    listJSON: async (prefix) => [...data.keys()].filter((k) => k.startsWith(prefix)).sort().map((k) => clone(data.get(k))),
    putEvidence: async (key, bytes) => {
      if (evidence.has(key)) throw new Error("locked");
      evidence.set(key, Buffer.from(bytes));
    },
    getEvidence: async (key) => evidence.get(key),
    evidenceUrl: async (key, filename, inline = false) => `mem://evidence/${key}?name=${encodeURIComponent(filename)}${inline ? "&inline=1" : ""}`,
    putExport: async (key, bytes) => { data.set(key, Buffer.from(bytes)); },
    exportUrl: async (key, filename) => `mem://export/${key}?name=${encodeURIComponent(filename)}`,
  };
}
