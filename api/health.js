/* Setup check: which settings this deployment can see. Never shows values, only whether
   each is set and how long it is, so it's safe to open without the bridge key. */
export default function handler(req, res) {
  const len = (k) => (process.env[k] || "").trim().length;
  const has = (k) => len(k) > 0;
  const enc = len("ENCRYPTION_KEY"), br = len("BRIDGE_SECRET");
  const checks = {
    PLAID_CLIENT_ID: has("PLAID_CLIENT_ID") ? "set" : "MISSING",
    PLAID_SECRET: has("PLAID_SECRET") ? "set" : "MISSING",
    PLAID_ENV: process.env.PLAID_ENV || "(not set, using production)",
    BRIDGE_SECRET: br >= 32 ? `set (${br} characters)` : br ? `TOO SHORT (${br} characters, need 32+)` : "MISSING",
    ENCRYPTION_KEY: enc >= 32 ? `set (${enc} characters)` : enc ? `TOO SHORT (${enc} characters, need 32+)` : "MISSING",
    database: (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) && (process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN) ? "connected" : "MISSING (add Upstash Redis in Storage, then redeploy)",
  };
  const ok = Object.values(checks).every((v) => !/MISSING|TOO SHORT/.test(v));
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify({
    ok,
    checks,
    vercel_environment: process.env.VERCEL_ENV || "unknown", // should say "production"
    deployment: process.env.VERCEL_URL || "unknown",
    built_from_commit: (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7) || "unknown",
    tip: ok ? "All settings found." : "Fix the items marked MISSING or TOO SHORT in Vercel → Settings → Environment Variables (with Production checked), then redeploy.",
  }, null, 2));
}
