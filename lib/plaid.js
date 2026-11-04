import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { getItems } from "./store.js";

let client = null;
export function plaid() {
  if (client) return client;
  const id = process.env.PLAID_CLIENT_ID, secret = process.env.PLAID_SECRET;
  if (!id || !secret) throw new Error("PLAID_CLIENT_ID and PLAID_SECRET aren't set. Add them in Vercel and redeploy.");
  const env = (process.env.PLAID_ENV || "production").toLowerCase();
  if (!PlaidEnvironments[env]) throw new Error(`PLAID_ENV must be "production" or "sandbox", not "${env}".`);
  client = new PlaidApi(new Configuration({
    basePath: PlaidEnvironments[env],
    baseOptions: { headers: { "PLAID-CLIENT-ID": id, "PLAID-SECRET": secret, "Plaid-Version": "2020-09-14" } },
  }));
  return client;
}

/* Plaid errors carry a useful code and message in the response body. */
export function plaidError(e) {
  const d = e && e.response && e.response.data;
  if (d && d.error_code) return { error_code: d.error_code, error_message: d.display_message || d.error_message || d.error_code };
  return { error_code: "BRIDGE_ERROR", error_message: (e && e.message) || String(e) };
}

const FIX = {
  ITEM_LOGIN_REQUIRED: "The bank needs you to sign in again. Open the bridge setup page and tap Reconnect next to this bank.",
  PENDING_EXPIRATION: "This bank connection expires soon. Open the bridge setup page and tap Reconnect.",
  INSTITUTION_DOWN: "The bank is temporarily unavailable. Try again later.",
  INSTITUTION_NOT_RESPONDING: "The bank is temporarily unavailable. Try again later.",
  PRODUCT_NOT_READY: "The bank is still loading your history. Try again in a few minutes.",
};
export const fixFor = (code) => FIX[code] || null;

function slimAccount(a, item) {
  const b = a.balances || {};
  return {
    account_id: a.account_id,
    item_id: item.item_id,
    institution: item.institution,
    name: a.name,
    official_name: a.official_name || null,
    mask: a.mask || null,
    type: a.type,            // depository | credit | loan | investment | other
    subtype: a.subtype || null,
    balance_current: b.current ?? null,   // for credit/loan: amount owed
    balance_available: b.available ?? null,
    credit_limit: b.limit ?? null,
    currency: b.iso_currency_code || b.unofficial_currency_code || "USD",
  };
}

function slimTx(t, item, acctNames) {
  const pfc = t.personal_finance_category || {};
  return {
    id: t.transaction_id,
    item_id: item.item_id,
    account_id: t.account_id,
    account: acctNames[t.account_id] || null,
    date: t.date,
    authorized_date: t.authorized_date || null,
    name: t.name,
    merchant: t.merchant_name || null,
    amount: t.amount, // Plaid sign: positive = money out, negative = money in
    currency: t.iso_currency_code || t.unofficial_currency_code || "USD",
    pending: !!t.pending,
    pending_transaction_id: t.pending_transaction_id || null,
    category: pfc.primary || null,
    category_detailed: pfc.detailed || null,
    channel: t.payment_channel || null,
  };
}

export async function listAccounts() {
  const items = await getItems();
  const accounts = [], problems = [];
  await Promise.all(items.map(async (item) => {
    try {
      const r = await plaid().accountsGet({ access_token: item.access_token });
      for (const a of r.data.accounts) accounts.push(slimAccount(a, item));
    } catch (e) {
      const err = plaidError(e);
      problems.push({ item_id: item.item_id, institution: item.institution, ...err, fix: fixFor(err.error_code) });
    }
  }));
  return { linked_banks: items.length, accounts, problems, as_of: new Date().toISOString() };
}

/* Incremental sync. The caller keeps the cursors (one per bank) and passes them back next time,
   so several devices can sync independently and nothing is consumed on the server. */
export async function syncTransactions({ cursors = {}, since = null, include_pending = true, max_per_bank = 2000 } = {}) {
  const items = await getItems();
  const out = { banks: [], as_of: new Date().toISOString() };
  for (const item of items) {
    const start = cursors[item.item_id] || null;
    const bank = { item_id: item.item_id, institution: item.institution, next_cursor: start, added: [], modified: [], removed: [], accounts: [], truncated: false, status: "ok" };
    try {
      let attempt = 0;
      for (;;) {
        let cursor = start, added = [], modified = [], removed = [], accounts = [], pages = 0, has_more = true, upd = null;
        try {
          while (has_more && pages < 25) {
            const r = await plaid().transactionsSync({
              access_token: item.access_token,
              cursor: cursor || undefined,
              count: 500,
              options: { include_personal_finance_category: true },
            });
            const d = r.data;
            added.push(...d.added); modified.push(...d.modified); removed.push(...d.removed);
            if (d.accounts && d.accounts.length) accounts = d.accounts;
            if (d.transactions_update_status) upd = d.transactions_update_status;
            cursor = d.next_cursor; has_more = d.has_more; pages++;
          }
        } catch (e) {
          // Data changed mid-pagination: Plaid says restart from the original cursor.
          if (plaidError(e).error_code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" && attempt++ < 2) continue;
          throw e;
        }
        if (!accounts.length) {
          try { accounts = (await plaid().accountsGet({ access_token: item.access_token })).data.accounts; } catch { /* balances are optional */ }
        }
        const names = Object.fromEntries(accounts.map((a) => [a.account_id, a.name + (a.mask ? ` ••${a.mask}` : "")]));
        const keep = (t) => (include_pending || !t.pending) && (!since || t.date >= since);
        bank.accounts = accounts.map((a) => slimAccount(a, item));
        bank.added = added.filter(keep).map((t) => slimTx(t, item, names));
        bank.modified = modified.filter(keep).map((t) => slimTx(t, item, names));
        bank.removed = removed.map((r) => r.transaction_id);
        if (bank.added.length > max_per_bank) { bank.added = bank.added.sort((a, b) => b.date.localeCompare(a.date)).slice(0, max_per_bank); bank.truncated = true; }
        bank.next_cursor = cursor;
        bank.more_waiting = has_more; // only true if we stopped at the page cap; call again to continue
        if (upd === "NOT_READY") bank.status = "loading";
        else if (upd === "INITIAL_UPDATE_COMPLETE") bank.status = "partial_history";
        break;
      }
    } catch (e) {
      const err = plaidError(e);
      bank.status = "error"; bank.error = { ...err, fix: fixFor(err.error_code) };
    }
    out.banks.push(bank);
  }
  return out;
}

/* Date-range lookup, mainly for asking Claude questions in chat. */
export async function searchTransactions({ start_date, end_date, query = "", limit = 200 } = {}) {
  const items = await getItems();
  const q = String(query || "").toLowerCase().trim();
  const results = [], problems = [];
  for (const item of items) {
    try {
      let offset = 0, total = Infinity, accounts = [];
      const got = [];
      while (offset < total && offset < 2000) {
        const r = await plaid().transactionsGet({ access_token: item.access_token, start_date, end_date, options: { count: 500, offset, include_personal_finance_category: true } });
        total = r.data.total_transactions; accounts = r.data.accounts; got.push(...r.data.transactions); offset += r.data.transactions.length;
        if (!r.data.transactions.length) break;
      }
      const names = Object.fromEntries(accounts.map((a) => [a.account_id, a.name + (a.mask ? ` ••${a.mask}` : "")]));
      for (const t of got) {
        const s = slimTx(t, item, names);
        if (!q || `${s.name} ${s.merchant || ""} ${s.category || ""} ${s.category_detailed || ""}`.toLowerCase().includes(q)) results.push(s);
      }
    } catch (e) {
      const err = plaidError(e);
      problems.push({ item_id: item.item_id, institution: item.institution, ...err, fix: fixFor(err.error_code) });
    }
  }
  results.sort((a, b) => b.date.localeCompare(a.date));
  const lim = Math.max(1, Math.min(1000, limit | 0 || 200));
  const outflow = results.filter((t) => t.amount > 0).reduce((a, t) => a + t.amount, 0);
  const inflow = results.filter((t) => t.amount < 0).reduce((a, t) => a - t.amount, 0);
  return {
    start_date, end_date, query: q || null,
    count: results.length,
    total_out: Math.round(outflow * 100) / 100,
    total_in: Math.round(inflow * 100) / 100,
    transactions: results.slice(0, lim),
    truncated: results.length > lim,
    problems,
  };
}
