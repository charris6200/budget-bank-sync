# Budget Bank Sync

A small personal server that links your bank through Plaid and gives Claude (and your Budget Builder app) read-only access to your balances and transactions as a custom connector.

```
Chase ──Plaid──▶ this server (Vercel) ──custom connector──▶ Claude ──▶ Budget Builder
```

- **Read-only.** It can list accounts and read transactions. It can't move money.
- **Locked.** Every request needs your `BRIDGE_SECRET`. Claude sends it from the connector's request header.
- **Encrypted.** Plaid access tokens are stored encrypted (AES-256-GCM) in Upstash Redis.
- **Stateless sync.** Budget Builder keeps its own sync cursors, so phone and laptop can both sync without double counting.

## Setup (about 20 minutes)

### 1. Plaid keys
1. Sign up at **dashboard.plaid.com/signup** and choose **Personal use** ("I want to use Plaid's APIs to build something for fun"). This gives you the free Trial plan with real bank data (up to 10 bank logins).
2. Go to **Developers → Keys** and copy your **client_id** and your **Production secret**.

### 2. Two random keys
Make two different long random strings. On a Mac, run this twice in Terminal:
```
openssl rand -hex 32
```
One is your **BRIDGE_SECRET**, the other your **ENCRYPTION_KEY**. Save both in your password manager. Don't change `ENCRYPTION_KEY` after you link a bank, or you'll have to re-link.

### 3. Deploy to Vercel
1. In Vercel: **Add New → Project**, import this repo. Framework preset: **Other**. No build settings needed.
2. Before deploying, open **Environment Variables** and add:

| Name | Value |
|---|---|
| `PLAID_CLIENT_ID` | from Plaid |
| `PLAID_SECRET` | Plaid Production secret |
| `PLAID_ENV` | `production` |
| `BRIDGE_SECRET` | random key #1 |
| `ENCRYPTION_KEY` | random key #2 |

3. Deploy.
4. In the project, open **Storage → Create Database → Upstash (Redis)**, free plan, and connect it to this project. That adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you.
5. **Redeploy** (Deployments → ⋯ → Redeploy) so the new variables take effect.

### 4. Link Chase
1. Open your deployment's URL, e.g. `https://budget-bank-sync-xxxx.vercel.app`.
2. Paste your `BRIDGE_SECRET` to unlock.
3. Click **+ Link a bank**, pick Chase, and sign in through Plaid's window. Choose every account you want (checking, savings, credit cards).
4. Repeat for any other banks.

### 5. Add the connector in Claude
1. Claude → **Customize → Connectors → Add custom connector**.
2. Name: `Budget Bank Sync` (exactly this; Budget Builder looks for this name).
3. URL: `https://<your-deployment>.vercel.app/mcp`
4. Authentication: **No sign in**. Under **Request headers**, add `Authorization` = `Bearer <your BRIDGE_SECRET>`.
5. Add it.

### 6. Sync
Open Budget Builder → **Spend** → **Sync now**, and choose **Allow** when Claude asks. After the first successful sync, it syncs on its own whenever you open the app.

The first sync can say "still loading your history" for a few minutes while Chase sends Plaid your transactions. Just try again shortly.

## Tools

| Tool | What it does |
|---|---|
| `list_accounts` | Every linked account with current and available balances |
| `sync_transactions` | What's new since your cursor, plus balances |
| `search_transactions` | Transactions between two dates, optionally matching a word ("costco"), with totals |

The search tool also works in any Claude chat with the connector turned on: "How much did I spend on dining in October?"

## When something goes wrong

- **"The bank needs you to sign in again"**: open the setup page and click **Reconnect** next to the bank. Banks ask for this every few months.
- **401 / Unauthorized**: the key in the connector's header doesn't match `BRIDGE_SECRET`. Remove the connector and re-add it with `Bearer ` plus the exact key.
- **"No database connected"**: Upstash isn't attached to the project, or you didn't redeploy after attaching it.
- **Chase isn't offered or fails to link on the Trial plan**: Plaid may need to approve production access for some banks. Check the Plaid dashboard for an access request.

## Local test
```
npm install
npm test
```
Checks auth, the MCP handshake, the tool list, input validation and token encryption, without calling Plaid.

## Security notes
- Keep the repo private. No secrets are committed; they live only in Vercel.
- To cut off access instantly: remove the bank on the setup page (revokes it at Plaid), or rotate `BRIDGE_SECRET` in Vercel and redeploy.
- Plaid only ever gets read access through this server. It requests the Transactions product only.
