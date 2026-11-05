# TrustGate Procurement

TrustGate Procurement helps student clubs and workshop organisers turn a goal into a reviewed, budget-checked purchase plan:

1. Describe the goal and provide a USD budget.
2. Resolve important questions and confirm assumptions.
3. Review AI-suggested baskets from the curated demo catalog, or build a basket by choosing products and quantities.
4. Review deterministic stock, compatibility, quantity, and budget checks.
5. Approve an exact plan version and, if desired, continue to PayPal Sandbox Checkout.
6. Follow edits, approvals, reservations, and payment results in the project audit trail.

**AI proposes; server code validates; an organiser approves; PayPal processes checkout.** TrustGate never automatically purchases.

## Product and safety boundaries

- One demo merchant and a curated MongoDB catalog. All listed items and stock are **demo inventory**, not live offers.
- USD only. Budgets, prices, shipping, tax, and totals are stored as integer cents.
- The demo store charges a fixed $12 shipping fee, adds $0 demo tax, and does not confirm delivery timing. These are demo rules, not carrier quotes or real-world tax calculations.
- A budget is a planning allocation, not money held by TrustGate. Inventory reservations are bookkeeping records for the demo catalog.
- No scraping, arbitrary merchant checkout, multi-seller settlement, payout, escrow, or automatic purchasing.
- The app has no owner authentication. It binds to loopback and is intended for local use only. **Do not expose or deploy it publicly** until owner authentication and authorization protect mutations, approval, and payment routes.
- Checkout uses MongoDB transactions. Use a replica-set-compatible MongoDB deployment; a standalone MongoDB server cannot provide the required atomic reservation behavior.
- PayPal integration is assumed to use the official PayPal JavaScript SDK Buttons with server-created Orders and server-side capture. All checkout is Sandbox-only.

## Requirements

- Node.js and npm
- MongoDB configured as a replica set for checkout
- Groq API key and a currently available model ID for AI requirement extraction (manual basket editing remains available if AI is unavailable)
- PayPal Sandbox REST app credentials with Checkout/Orders capability

## Setup

From the repository root:

```bash
cp .env.example .env
npm install
cd client
npm install
cd ..
```

Set the following in the root `.env` (do not commit it):

| Variable | Purpose |
|---|---|
| `PORT` | Local backend port; use `5000` with the Vite proxy |
| `MONGODB_URI` | MongoDB replica-set connection string for checkout |
| `GROQ_API_KEY` | Groq API key |
| `GROQ_MODEL` | A model currently available to your Groq account |
| `PAYPAL_CLIENT_ID` | PayPal Sandbox REST app client ID |
| `PAYPAL_CLIENT_SECRET` | PayPal Sandbox REST app secret |
| `PROCUREMENT_APPROVAL_HOURS` | Approval lifetime, clamped to 1–168 hours; default 24 |
| `PROCUREMENT_RESERVATION_HOURS` | Reservation review window, clamped to 1–72 hours; default 24 |

For local replica-set MongoDB, configure a replica set and use a URI that includes its replica-set name, for example `mongodb://127.0.0.1:27017/trustgate?replicaSet=rs0`. Configure MongoDB itself before relying on checkout; TrustGate does not replace transaction atomicity with in-process locks.

Seed the catalog from the repository root:

```bash
npm run seed:catalog
```

The seed is additive: it inserts the curated SKUs only when they do not already exist. It does not reset or overwrite product stock or prices.

## Run locally

Start the backend in one terminal:

```bash
npm run dev
```

Start the Vite frontend in a second terminal:

```bash
cd client
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Vite proxies `/api` requests to the backend at `127.0.0.1:5000`. Keep the backend bound to loopback; do not change it to a public interface.

For a local production-style run, build the client and start the backend from the repository root:

```bash
cd client
npm run build
cd ..
npm start
```

Open [http://localhost:5000](http://localhost:5000). The Express server serves `client/dist` when that build exists.

## PayPal Sandbox setup

1. Create or open a REST app under **PayPal Developer Dashboard → Apps & Credentials → Sandbox**.
2. Copy its Sandbox client ID and secret to the root `.env`.
3. Ensure the app has the Checkout/Orders capability enabled.
4. Restart the backend so it obtains a fresh Sandbox access token.
5. Use a PayPal Sandbox buyer account when testing the Checkout Buttons.

The client ID is sent to the browser for the official PayPal JavaScript SDK. The secret remains server-side. TrustGate reserves budget and demo stock atomically before asking PayPal to create an order, and records committed budget/stock only after confirmed capture. External PayPal calls are made outside database transactions. A failed or ambiguous payment is not treated as successful; ambiguous reservations are held for reconciliation and are not released by a timer.

## Using the workspace

- **Workspace:** create and reopen projects; the goal form accepts a title, beneficiaries, budget, and contingency.
- **Review AI plan:** answer critical questions, confirm demo assumptions, compare AI proposals, or create/edit a basket from the same curated products. Required items are linked to matching selected products automatically.
- **Plan approval:** approval applies to the exact version, currency, content hash, and total; edits create a new version and invalidate earlier approval.
- **Checkout:** the organiser chooses to continue to PayPal and a Sandbox buyer explicitly approves. TrustGate captures server-side and verifies amount and currency.
- **Audit trail:** inspect project, plan, approval, reservation, and payment events.
- **Demo catalog:** see the single merchant's products, stock, compatibility tags, and demo prices.
- **Guide:** use the in-app walkthrough and troubleshooting notes.

If AI extraction fails, the project remains saved. Retry extraction or manually build a basket; no successful plan is fabricated. If a checkout attempt reports reconciliation, do not start a second order or release its reservation until the PayPal result has been checked.

## Procurement API

All routes are mounted under `/api/procurement`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/storefront` | Demo merchant, active catalog, and PayPal configuration status |
| `GET` | `/projects` | List procurement projects |
| `POST` | `/projects` | Save a goal and attempt requirement extraction |
| `GET` | `/projects/:projectId` | Project, plans, approvals, checkout attempts, and audit events |
| `POST` | `/projects/:projectId/extract` | Retry AI extraction |
| `POST` | `/projects/:projectId/clarifications` | Save answers and assumption confirmation |
| `POST` | `/projects/:projectId/plans` | Generate bounded AI candidate plans and validate them |
| `POST` | `/projects/:projectId/plans/manual` | Create a manually assembled basket |
| `PUT` | `/projects/:projectId/plans/:planId` | Edit a basket as a new version |
| `POST` | `/projects/:projectId/plans/:planId/approve` | Approve a validated plan version |
| `POST` | `/projects/:projectId/checkout` | Atomically reserve demo stock/budget and create a PayPal order |
| `POST` | `/projects/:projectId/checkout/:attemptId/capture` | Verify and capture a buyer-approved PayPal order |
| `POST` | `/projects/:projectId/checkout/:attemptId/cancel` | Check PayPal state and release only after confirmed void/cancellation |

Legacy direct-payment routes remain in the codebase for compatibility, but are not part of the Procurement workflow.

## Planning notes

- The planner explores a bounded number of mandatory combinations and checks optional coverage within the usable budget. It does not claim global optimality.
- **Lowest cost** ranks feasible mandatory baskets by total. **Balanced** prefers earlier eligible AI catalog matches, then cost. **Maximum coverage** adds the greatest number of eligible optional requirements that fit the budget, then prefers lower cost. Identical baskets are shown once.
- All totals are recalculated by the server from current catalog data. AI-provided SKU suggestions are allowlisted; AI does not set prices, stock, merchant, compatibility facts, or payment status.
- Approval and checkout recheck current plan content, catalog snapshots, stock, budget, and expiry.
- PayPal calls stay outside MongoDB transactions. Budget and stock reservations use transactional MongoDB writes and conditional updates to avoid concurrent over-reservation.
- Reservations are not automatically deleted or released after expiry. Financial state must be reconciled first.

## License

MIT
