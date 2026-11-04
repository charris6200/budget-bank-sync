import { timingSafeEqual } from "node:crypto";

/* Every route except the static setup page needs the bridge secret.
   Claude sends it as a request header you set on the custom connector;
   the setup page sends it from the key you type in. */
export function authorized(req) {
  const secret = process.env.BRIDGE_SECRET || "";
  if (secret.length < 32) return false; // refuse to run with a weak or missing secret
  const h = req.headers || {};
  let given = "";
  const auth = h.authorization || h.Authorization || "";
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) given = auth.slice(7).trim();
  if (!given && typeof h["x-bridge-key"] === "string") given = h["x-bridge-key"].trim();
  if (!given) return false;
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function deny(res) {
  const weak = (process.env.BRIDGE_SECRET || "").length < 32;
  res.statusCode = 401;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({
    error: weak
      ? "BRIDGE_SECRET is missing or shorter than 32 characters. Set it in Vercel and redeploy."
      : "Unauthorized",
  }));
}

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}
