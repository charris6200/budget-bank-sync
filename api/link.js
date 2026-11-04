import { authorized, deny, json } from "../lib/auth.js";
import { plaid, plaidError } from "../lib/plaid.js";
import { saveItem, getItem, listItemsPublic, deleteItem } from "../lib/store.js";

/* One endpoint for the setup page, by action:
   GET                       -> linked banks (no tokens)
   POST {action:"token"}     -> Plaid Link token (add item_id to reconnect an existing bank)
   POST {action:"exchange"}  -> save a newly linked bank
   POST {action:"remove"}    -> unlink a bank at Plaid and forget it */
export default async function handler(req, res) {
  if (!authorized(req)) return deny(res);
  try {
    if (req.method === "GET") return json(res, 200, { banks: await listItemsPublic(), env: process.env.PLAID_ENV || "production" });
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed" });

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const action = body.action;

    if (action === "token") {
      const req_ = {
        user: { client_user_id: "owner" },
        client_name: "Budget Bank Sync",
        country_codes: ["US"],
        language: "en",
      };
      if (body.item_id) {
        // Update mode: re-authenticate an existing bank without creating a duplicate.
        const item = await getItem(body.item_id);
        if (!item) return json(res, 404, { error: "That bank isn't linked anymore." });
        req_.access_token = item.access_token;
      } else {
        req_.products = ["transactions"];
        req_.transactions = { days_requested: 730 };
      }
      const r = await plaid().linkTokenCreate(req_);
      return json(res, 200, { link_token: r.data.link_token });
    }

    if (action === "exchange") {
      if (!body.public_token) return json(res, 400, { error: "Missing public_token" });
      const ex = await plaid().itemPublicTokenExchange({ public_token: body.public_token });
      const { access_token, item_id } = ex.data;
      let institution = (body.institution && body.institution.name) || null;
      if (!institution) {
        try {
          const it = await plaid().itemGet({ access_token });
          const iid = it.data.item.institution_id;
          if (iid) institution = (await plaid().institutionsGetById({ institution_id: iid, country_codes: ["US"] })).data.institution.name;
        } catch { /* name is cosmetic */ }
      }
      const saved = await saveItem({ item_id, access_token, institution });
      return json(res, 200, { ok: true, bank: saved });
    }

    if (action === "remove") {
      const item = await getItem(body.item_id);
      if (item) {
        try { await plaid().itemRemove({ access_token: item.access_token }); } catch { /* forget it locally either way */ }
        await deleteItem(body.item_id);
      }
      return json(res, 200, { ok: true });
    }

    return json(res, 400, { error: "Unknown action" });
  } catch (e) {
    const err = plaidError(e);
    return json(res, 500, { error: err.error_message, code: err.error_code });
  }
}
