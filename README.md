# Rivvak Media — Cloud Automation Engine (v2.0.0)

Zero-dependency Node.js (`>= 18`) backend powering public website lead intake, multi-tenant client portals, PushPress Grow CSV migration, native TLS SMTP/IMAP email workflows, Stripe billing webhooks, and the 24/7 automation scheduler for **Rivvak Media Growth OS**.

Uses **only built-in Node.js modules** (`http`, `fs`, `path`, `crypto`, `url`, `querystring`, `tls`, `net`) and native global `fetch`. Zero `npm install` packages required.

---

## Quick Start

```bash
cd automation-backend
cp .env.example .env
npm start
```

Run the self-contained 20-test verification suite (ephemeral port `0`, isolated temp directories):

```bash
npm test
```

Default local server URL: `http://127.0.0.1:8787`
- Browser visit (`Accept: text/html`) at `GET /` serves the dark-obsidian (`#09090B`) **Rivvak Media — Cloud Automation Engine** status dashboard.
- API / curl visit at `GET /` (or `GET /?format=json`) returns service telemetry JSON (`version: "2.0.0"`).
- Health probe at `GET /api/health`.

---

## Multi-Tenant Authentication & Isolation

All `/api/state`, `/api/admin/*`, and `/api/client/*` routes require `Authorization: Bearer <token>` verified via constant-time `safeEqualToken(a, b)` (`crypto.timingSafeEqual` over SHA-256 digests):

| Token Type | Configuration | Access Scope |
|---|---|---|
| **Admin Passcode** (`ADMIN_PASSCODE`) | Set in `.env` / Render env | Full access to `GET/PUT /api/state`, `/api/admin/*`, and any `/api/client/:slug/*` |
| **Client Access Code** (`client.accessCode`) | Per-tenant in `store.json` | Restricted strictly to matching `/api/client/:slug/*`. Returns `403 Forbidden` on `/api/state`, `/api/admin/*`, or any other client slug |
| **Missing / Invalid Token** | — | Returns `401 Unauthorized` |

### Security & Reliability Controls
- Baseline HTTP security headers (`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`) on root and API responses.
- Strict CORS allowlist: `https://rivvak.com`, `https://www.rivvak.com`, `http://localhost:*`, `http://127.0.0.1:*`, plus `ALLOWED_ORIGINS`.
- Atomic `saveStore()` (`.tmp` + `fs.renameSync`) with automatic `.bak` snapshot and automatic `.bak` recovery in `loadStore()`.
- Graceful `SIGINT` / `SIGTERM` shutdown with idle socket cleanup.

---

## Seeded Data (`data/store.json`)

On first boot, `data/store.json` is automatically initialized with:
1. **`clean-results`**: Clean Results — House of Fitness (Bobby, West Palm Beach FL), Meta Ads campaign `CleanResults_ "Body by Bobby!"`, all 7 gym automation workflows, sample multi-channel inbox threads, upcoming bookings, starter contacts, pipeline opportunities, and Marketing Studio templates.
2. **`carleen-ligozio`**: Carleen Ligozio (West Palm Beach FL & Southampton NY), luxury apparel Brand Board, and GBP cleanup / website launch workflows.
3. **`publicLeads` seed**: Blue Diamond Pools (`Jaime`, `https://bluediamondpools.com/`, `(954) 755-0777`, `info@bluediamondpools.com`, Broward & Palm Beach County, `status: "qualified"`, `source: "Google Doc — Jaime Pool Company"`).

---

## API Reference

### Status & Public Intake
- `GET /` — Dark-obsidian HTML dashboard (when `Accept: text/html` and `format !== "json"`) or JSON telemetry (`version: "2.0.0"`).
- `GET /api/health` — Public health check (`{ ok, service, brand: "Rivvak Media", version: "2.0.0", clients, publicLeads, smtpConfigured, uptimeSeconds, timestamp }`).
- `GET /overlay.js` & `GET /api/client/carleen-ligozio/overlay.js` — Serves `carleen-overlay.js` (`application/javascript; charset=utf-8`).
- `POST /api/public/lead` — Public website & chat concierge intake:
  - Per-IP sliding-window rate limiter (`10 req / 10 min` -> `429 Too Many Requests`).
  - Honeypot `_hp` check (non-empty silently returns `200 { ok: true, ignored: true }`).
  - Validates and caps lengths for `{ name, business, email, phone, industry, scope, estimatedSetup, estimatedMonthly, message, source, pageUrl, ticketId }`.
  - Prepends into `store.publicLeads` (capped at `500`, newest first).
  - Dispatches alert email to `store.settings.agencyEmail || "connect@rivvak.com"` via Resend or Native TLS SMTP (or records `dry_run_queued`), plus optional branded 72-hour staging preview receipt from `"Rivvak Media <connect@rivvak.com>"` when `AUTO_REPLY_LEADS !== "false"`.
  - Returns `201 { ok: true, leadId, ticketId, emailDispatched, mode }`.

### Admin CRM, Inbox & Backup Routes (Admin Bearer Auth Only)
- `GET /api/state` / `PUT /api/state` — Full multi-tenant store read/write.
- `GET/POST /api/admin/clients`, `PUT/DELETE /api/admin/clients/:slug` — Client portal lifecycle.
- `GET /api/admin/leads` — List captured public leads (optional `?status=` filter).
- `PATCH /api/admin/leads/:id` — Update lead `status` (`new`, `contacted`, `qualified`, `won`, `archived`) and `notes`.
- `GET /api/admin/email-inbox` — Read-only native TLS IMAP header summary (`uid`, `date`, `from`, `subject`, `seen`) from `INBOX` (`8000ms` timeout, default `limit=12`), or honest `{ ok: true, mode: "dry_run_unconfigured", messages: [] }` when IMAP/SMTP credentials are omitted.
- `GET /api/admin/backup` — Downloads `store.json` with `Content-Disposition: attachment; filename="rivvak-store-backup.json"`.
- `POST /api/admin/restore` — Validates `clients` object, saves `.bak` of prior store, and atomically replaces `store.json`.
- `POST /api/admin/scheduler/tick` — Manual global or per-client scheduler execution.

### Client Portal Routes (`/api/client/:slug/*`)
- `GET /api/client/:slug/sync` / `PUT /api/client/:slug` — Client-scoped state pull/push.
- `POST /api/client/:slug/import-csv` — RFC-4180 PushPress Grow CSV migration & deduplication (`contacts` / `opportunities`).
- `POST /api/client/:slug/send-sms` — Twilio REST API (`dry_run_queued` fallback when env vars omitted).
- `POST /api/client/:slug/send-email` — Priority: Resend API (`RESEND_API_KEY`) -> Native TLS SMTP (`SMTP_HOST/SMTP_USER/SMTP_PASS`) -> `dry_run_queued`.
- `POST /api/client/:slug/send-ig-dm` — Meta Graph API (`dry_run_queued` fallback when env vars omitted).
- `POST /api/client/:slug/trigger-workflow` — Runs workflow template + channel dispatch / webhook forward.
- `POST /api/client/:slug/sync-meta-ads` — Meta Marketing API campaign sync.
- `POST /api/client/:slug/scheduler/tick` — Client-scoped scheduler execution.

### Inbound Webhooks
- `POST /webhooks/stripe` — Handles `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, and `customer.subscription.deleted`. Verifies `Stripe-Signature` HMAC-SHA256 (`t=...,v1=...`) via `crypto.timingSafeEqual` when `STRIPE_WEBHOOK_SECRET` is configured (`400` on invalid). Logs events into `store.stripeEvents` (cap `200`) and updates matching client billing/payment records & `executionLogs`.
- `POST /webhooks/twilio` — Accepts URL-encoded or JSON Twilio SMS payloads into Unified Inbox.
- `GET /webhooks/meta` & `POST /webhooks/meta` — Meta IG DM verification challenge & inbound DM ingestion.
- `POST /webhooks/gbp-review` — Logs incoming Google Business Profile reviews into Unified Inbox.

### 24/7 Scheduler Engine
Idempotently checks (via `client.processedScheduleKeys`):
1. Upcoming booking reminders (`24h` & `2h` windows)
2. Member birthdays matching `MM-DD`
3. Member retention check-ins at `7`, `14`, and `30` days
4. Due scheduled social posts (`scheduledAt <= now`)
5. 3-day-ahead retainer/renewal reminders (`0..3` days prior to due date)

---

## Deploying to Render / Docker

- **Render Blueprint (`render.yaml`)**: Ready-to-deploy web service (`automation-backend`, Node runtime, `node server.js`, `/api/health` check, `autoDeploy: true`). Add secrets (`ADMIN_PASSCODE`, `SMTP_PASS`, `STRIPE_WEBHOOK_SECRET`, etc.) inside the Render Dashboard — never commit `.env`.
- **Docker (`Dockerfile` + `.dockerignore`)**: Multi-layer `node:20-alpine` image running as non-root `node` user on port `8787` with built-in `/api/health` `HEALTHCHECK`. Mount persistent storage at `/app/data` (`DATA_DIR=/app/data`).
