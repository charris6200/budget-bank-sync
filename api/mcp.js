import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { authorized, deny } from "../lib/auth.js";
import { listAccounts, syncTransactions, searchTransactions } from "../lib/plaid.js";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}
function fail(e) {
  return { isError: true, content: [{ type: "text", text: (e && e.message) || String(e) }] };
}

function buildServer() {
  const server = new McpServer({ name: "budget-bank-sync", version: "1.0.0" });

  server.registerTool("list_accounts", {
    title: "List bank accounts and balances",
    description: "Lists every account at the banks you've linked (checking, savings, credit cards, loans) with current and available balances. For credit cards and loans, balance_current is the amount owed.",
    inputSchema: {},
    annotations: RO,
  }, async () => { try { return ok(await listAccounts()); } catch (e) { return fail(e); } });

  server.registerTool("sync_transactions", {
    title: "Sync new bank transactions",
    description: "Returns transactions added, changed or removed since the last sync, per linked bank, plus current account balances. Pass back each bank's next_cursor (keyed by item_id) next time to get only what's new. With no cursors it returns full history, filtered by `since`. Amounts use Plaid's sign: positive is money out, negative is money in.",
    inputSchema: {
      cursors: z.record(z.string(), z.string()).optional().describe("Map of item_id to the next_cursor from your last sync"),
      since: date.optional().describe("Drop transactions dated before this day (YYYY-MM-DD). Useful on the first sync."),
      include_pending: z.boolean().optional().describe("Include pending transactions. Default true."),
    },
    annotations: RO,
  }, async (args) => { try { return ok(await syncTransactions(args || {})); } catch (e) { return fail(e); } });

  server.registerTool("search_transactions", {
    title: "Search transactions by date range",
    description: "Finds transactions between two dates across all linked banks, optionally filtered by a word in the merchant, description or category (for example 'costco' or 'restaurant'). Returns the matches plus total money out and in.",
    inputSchema: {
      start_date: date.describe("First day, YYYY-MM-DD"),
      end_date: date.describe("Last day, YYYY-MM-DD"),
      query: z.string().optional().describe("Optional word to match"),
      limit: z.number().int().min(1).max(1000).optional().describe("Max transactions to return. Default 200."),
    },
    annotations: RO,
  }, async (args) => { try { return ok(await searchTransactions(args)); } catch (e) { return fail(e); } });

  return server;
}

export default async function handler(req, res) {
  if (!authorized(req)) return deny(res);
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "POST");
    return res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));
  }
  // Stateless: a fresh server and transport for every request, JSON responses (no streaming needed).
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
    }
  }
}
