import { Redis } from "@upstash/redis";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/* Linked banks live in one Redis hash: item_id -> {item_id, institution, token (encrypted), added}.
   Plaid access tokens are encrypted with AES-256-GCM before they're stored,
   so the database alone is useless without ENCRYPTION_KEY. */

const KEY = "bbs:items";
let redis = null;

function db() {
  if (redis) return redis;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("No database connected. In Vercel, add Upstash Redis to this project (Storage tab) and redeploy.");
  redis = new Redis({ url, token });
  return redis;
}

function key() {
  const k = process.env.ENCRYPTION_KEY || "";
  if (k.length < 32) throw new Error("ENCRYPTION_KEY is missing or shorter than 32 characters. Set it in Vercel and redeploy.");
  return createHash("sha256").update(k).digest();
}

export function encrypt(text) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}

export function decrypt(blob) {
  const [iv, tag, enc] = blob.split(".").map((s) => Buffer.from(s, "base64"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v);

export async function saveItem({ item_id, access_token, institution }) {
  const rec = { item_id, institution: institution || "Bank", token: encrypt(access_token), added: new Date().toISOString() };
  await db().hset(KEY, { [item_id]: JSON.stringify(rec) });
  return { item_id, institution: rec.institution, added: rec.added };
}

/* With tokens decrypted, for server-side Plaid calls only. Never return these to a client. */
export async function getItems() {
  const all = (await db().hgetall(KEY)) || {};
  return Object.values(all).map(parse).map((r) => ({ ...r, access_token: decrypt(r.token) }));
}

export async function getItem(item_id) {
  const r = await db().hget(KEY, item_id);
  if (!r) return null;
  const rec = parse(r);
  return { ...rec, access_token: decrypt(rec.token) };
}

/* Safe to show: no tokens. */
export async function listItemsPublic() {
  const all = (await db().hgetall(KEY)) || {};
  return Object.values(all).map(parse).map(({ item_id, institution, added }) => ({ item_id, institution, added }));
}

export async function deleteItem(item_id) {
  await db().hdel(KEY, item_id);
}
