// Local smoke test: runs the Vercel handlers behind a tiny Node server and speaks MCP to them.
// No Plaid or database calls succeed here; it checks auth, the MCP handshake, the tool list,
// and that tool errors come back cleanly.
import http from "node:http";
import mcp from "../api/mcp.js";
import link from "../api/link.js";

process.env.BRIDGE_SECRET = "x".repeat(40);
process.env.ENCRYPTION_KEY = "y".repeat(40);
delete process.env.KV_REST_API_URL; delete process.env.UPSTASH_REDIS_REST_URL;

const srv = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    try { req.body = raw ? JSON.parse(raw) : undefined; } catch { req.body = raw; }
    const h = req.url.startsWith("/mcp") ? mcp : req.url.startsWith("/api/link") ? link : null;
    if (!h) { res.statusCode = 404; return res.end(); }
    h(req, res);
  });
});
await new Promise((r) => srv.listen(0, r));
const base = `http://127.0.0.1:${srv.address().port}`;
const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer " + "x".repeat(40) };
const rpc = (id, method, params) => fetch(base + "/mcp", { method: "POST", headers: H, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });

let fails = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!cond) fails++; };

// 1. Auth
let r = await fetch(base + "/mcp", { method: "POST", headers: { ...H, Authorization: "Bearer wrong" }, body: "{}" });
check("rejects wrong key", r.status === 401);
r = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
check("rejects missing key", r.status === 401);
r = await fetch(base + "/mcp", { method: "POST", headers: { ...H, Authorization: undefined, "X-Bridge-Key": "x".repeat(40) }, body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }) });
check("accepts X-Bridge-Key header", r.status === 200);

// 2. Handshake
r = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
let j = await r.json();
check("initialize", r.status === 200 && j.result && j.result.serverInfo && j.result.capabilities.tools, JSON.stringify(j.result && j.result.serverInfo));

// 3. Tools
r = await rpc(2, "tools/list", {});
j = await r.json();
const names = (j.result && j.result.tools || []).map((t) => t.name);
check("tools/list", ["list_accounts", "sync_transactions", "search_transactions"].every((n) => names.includes(n)), names.join(", "));
const sync = j.result.tools.find((t) => t.name === "sync_transactions");
check("sync schema has cursors/since", sync && sync.inputSchema.properties.cursors && sync.inputSchema.properties.since);
check("read-only annotation", sync.annotations && sync.annotations.readOnlyHint === true);

// 4. A tool call with no database configured fails cleanly as a tool error
r = await rpc(3, "tools/call", { name: "list_accounts", arguments: {} });
j = await r.json();
check("tool error is reported, not a crash", j.result && j.result.isError === true, j.result && j.result.content[0].text);

// 5. Bad input is rejected
r = await rpc(4, "tools/call", { name: "search_transactions", arguments: { start_date: "yesterday", end_date: "2026-11-01" } });
j = await r.json();
check("validates dates", (j.result && j.result.isError) || j.error, JSON.stringify(j).slice(0, 120));

// 6. Setup API needs the key too
r = await fetch(base + "/api/link", { headers: { Authorization: "Bearer nope" } });
check("setup API rejects wrong key", r.status === 401);
r = await fetch(base + "/api/link", { headers: { Authorization: H.Authorization } });
j = await r.json();
check("setup API reports missing database", r.status === 500 && /database/i.test(j.error || ""), j.error);

// 7. Encryption round trip
const { encrypt, decrypt } = await import("../lib/store.js");
const blob = encrypt("access-sandbox-123");
check("token encryption round-trips", decrypt(blob) === "access-sandbox-123" && !blob.includes("access-sandbox"));

// 8. Weak secret refuses to run
process.env.BRIDGE_SECRET = "short";
r = await fetch(base + "/mcp", { method: "POST", headers: { ...H, Authorization: "Bearer short" }, body: "{}" });
check("refuses weak BRIDGE_SECRET", r.status === 401);

srv.close();
console.log(fails ? `\n${fails} failed` : "\nAll passed");
process.exit(fails ? 1 : 0);
