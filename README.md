# Rivvak Media — Zero-Dependency Automation Backend

Zero-dependency Node.js (`>= 18`) backend powering multi-tenant client portals, PushPress Grow CSV migration, unified inbox webhooks, channel dispatchers, and the 24/7 workflow scheduler for **Rivvak Media Growth OS**.

Uses **only built-in Node.js modules** (`http`, `fs`, `path`, `crypto`, `url`, `querystring`, `tls`, `net`) and native global `fetch`. Zero `npm install` packages required.

---

## Quick Start

```bash
cd automation-backend
cp .env.example .env
npm start
```

Run the self-contained verification suite (ephemeral port `0`, temporary store cleanup):

```bash
npm test
```

Default server URL: `http://127.0.0.1:8787` (health check at `GET /api/health`).

---

## Multi-Tenant Authentication & Isolation

All `/api/*` endpoints (except `GET /api/health`) require `Authorization: Bearer <token>`:

| Token Type | Default Value | Access Scope |
|---|---|---|
| **Admin Passcode** (`ADMIN_PASSCODE`) | `RIVVAK-2026` | Full access to `GET/PUT /api/state`, `/api/admin/*`, and any `/api/client/:slug/*` |
| **Client Access Code** (`client.accessCode`) | `CLEAN-2026` / `CARLEEN-2026` | Restricted strictly to matching `/api/client/:slug/*`. Returns `403 Forbidden` on `/api/state`, `/api/admin/*`, or any other client slug |
| **Missing / Invalid Token** | — | Returns `401 Unauthorized` |

### Allowed CORS Origins
- `https://rivvak.com`
- `https://www.rivvak.com`
- `http://localhost:*`
- `http://127.0.0.1:*`
- Plus any extra origins listed in `ALLOWED_ORIGINS`.

---

## Seeded Clients (`data/store.json`)

On first boot, `data/store.json` is automatically initialized with:
1. **`clean-results`** (`accessCode: CLEAN-2026`): Clean Results — House of Fitness (Bobby, West Palm Beach FL), Meta Ads campaign `CleanResults_ "Body by Bobby!"`, all 7 gym automation workflows, sample multi-channel inbox threads, upcoming bookings, starter contacts, pipeline opportunities, and Marketing Studio templates.
2. **`carleen-ligozio`** (`accessCode: CARLEEN-2026`): Carleen Ligozio (West Palm Beach FL & Southampton NY), luxury apparel Brand Board, and GBP cleanup / website launch workflows.

---

## API Reference

### Health & State Sync
- `GET /api/health` — Public service status check.
- `GET /api/state` / `PUT /api/state` — Admin full multi-tenant store read/write.
- `GET /api/client/:slug/sync` / `PUT /api/client/:slug` — Client-scoped state pull/push.
- `GET/POST /api/admin/clients`, `PUT/DELETE /api/admin/clients/:slug` — Admin client portal lifecycle.

### PushPress Grow Migration
- `POST /api/client/:slug/import-csv`
  - Body: `{ "kind": "contacts" | "opportunities", "csvText": "..." }` (or JSON array `rows`).
  - Full RFC-4180 CSV parsing (quoted commas, embedded newlines, CRLF/LF, escaped quotes).
  - Auto-maps `First Name`, `Last Name`, `Email`, `Phone`, `Tags`, `Status`, `Source`, `Birthday`, `Injury Notes`, `Stage`, `Value`, `Membership Tier`.
  - Deduplicates contacts by normalized email/phone and opportunities by email/phone/`name+stage`.
  - Returns `{ ok: true, kind, added, updated, merged, total }`.

### Channel Dispatchers & Honest Dry-Run Mode
- `POST /api/client/:slug/send-sms` — Twilio REST API (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`)
- `POST /api/client/:slug/send-email` — Priority order:
  1. **Resend API** (`RESEND_API_KEY`) -> returns `mode: "live_resend"`
  2. **Native TLS SMTP** (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, e.g., Namecheap Private Email `mail.privateemail.com:465` SMTPS or `:587` STARTTLS) -> returns `mode: "live_smtp"` with exact RFC `Message-ID`
  3. **Honest Queue Fallback** -> appends to inbox/queue and returns `mode: "dry_run_queued"`, `missingEnv: ["RESEND_API_KEY or SMTP_*"]`
- `POST /api/client/:slug/send-ig-dm` — Meta Graph API (`META_ACCESS_TOKEN`, `META_IG_USER_ID`)
- `POST /api/client/:slug/trigger-workflow` — Runs workflow template + channel dispatch / webhook forward (`WEBHOOK_URL` or client `webhookUrl`)
- `POST /api/client/:slug/sync-meta-ads` — Meta Marketing API (`META_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID`)

#### Native Namecheap Private Email SMTP (`mail.privateemail.com:465`)
Configure in local gitignored `.env` (never commit `.env` or real passwords):
```env
SMTP_HOST=mail.privateemail.com
SMTP_PORT=465
SMTP_USER=connect@rivvak.com
SMTP_PASS=<your-privateemail-app-password>
SMTP_FROM=Rivvak Media <connect@rivvak.com>
```
`server.js` automatically loads `.env` at startup and exposes `verifySmtpAuth(cfg)` (performs `EHLO` + `AUTH LOGIN` + `QUIT` without sending mail) and `sendSmtpEmail(cfg)`.

Whenever required provider credentials are omitted from `.env`, the server **never fabricates live delivery**: it logs the message/run into `outboundQueue`, `inboxThreads`, and `executionLogs`, returning:

```json
{
  "ok": true,
  "mode": "dry_run_queued",
  "missingEnv": ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"]
}
```

### Inbound Webhooks
- `POST /webhooks/twilio` — Accepts URL-encoded or JSON Twilio SMS payloads (`From`, `To`, `Body`), appends to the matching client's Unified Inbox (`channel: "SMS"`), increments `unread`.
- `GET /webhooks/meta` — Verifies `hub.mode=subscribe` & `hub.verify_token` (`META_VERIFY_TOKEN`), echoes `hub.challenge`.
- `POST /webhooks/meta` — Parses Meta Instagram DM webhook payloads into Unified Inbox (`channel: "Instagram DM"`).
- `POST /webhooks/gbp-review` — Logs incoming Google Business Profile reviews into Unified Inbox (`channel: "Google Reviews"`).

### 24/7 Scheduler Engine
- Runs on `SCHEDULER_INTERVAL_MS` (default `60000`ms) and can be triggered manually via:
  - `POST /api/admin/scheduler/tick`
  - `POST /api/client/:slug/scheduler/tick`
- Idempotently checks:
  1. Upcoming booking reminders (`24h` & `2h` windows)
  2. Member birthdays matching `MM-DD`
  3. Member retention check-ins at `7`, `14`, and `30` days
  4. Due scheduled social posts (`scheduledAt <= now`)

---

## Deploying to Railway / Render / Fly.io / VPS

1. Push `automation-backend/` to a private repository or deploy directory.
2. Set Start Command to `node server.js` and mount a persistent volume at `/app/data` (`DATA_DIR=/app/data`).
3. Configure `ADMIN_PASSCODE` plus Twilio (`TWILIO_*`), Resend (`RESEND_*`), and Meta (`META_*`) environment variables when carrier/social accounts are connected.
4. Copy the live HTTPS URL (e.g., `https://api.rivvak-growth.example.com`) into `/pages/partner-dashboard` -> **Tab 9 (Client Portals & Growth OS)** -> **Cloud Sync & Webhook Automation** (`Backend API URL` + `Admin Secret`).
