# Unsync Portal API

Minimal encrypted payload API for Unsync secure portal messages.

The server stores only encrypted payloads and encrypted metadata. It must never receive plaintext email bodies, raw access tokens, private keys, or credentials.

## Endpoints

- `GET /health` returns `{ "ok": true }`
- `POST /portal/create` stores an encrypted payload
- `POST /portal/:portalId/request-otp` validates recipient and access-token hash, then sends a 6-digit OTP
- `POST /portal/:portalId/verify-otp` validates OTP and returns a short-lived verified session token
- `GET /portal/:portalId` returns an encrypted payload when unexpired and the verified session matches
- `POST /portal/upload-session` creates a short-lived attachment staging session
- `POST /portal/:portalId/attachment/:attachmentId/chunk/:chunkIndex` stores one encrypted attachment chunk before portal creation
- `GET /portal/:portalId/attachment/:attachmentId/chunk/:chunkIndex` returns one encrypted attachment chunk to a verified session
- `GET /read/:portalId` serves the minimal browser reader
- `GET /ops/metrics` returns safe aggregate metrics when `x-unsync-admin-token` is valid
- `GET /ops` serves a simple protected operations dashboard

The browser reader sends `x-unsync-recipient-email` and `x-unsync-verified-session` to retrieve the encrypted payload. Raw access tokens and plaintext are not sent back to the API. The reader decrypts with Web Crypto locally in the browser.

## Abuse Controls

- IP rate limits protect portal payload retrieval, OTP request/verify, and encrypted attachment chunk downloads.
- OTP sends remain capped at 3 per hour per portal/recipient, with a 60 second cooldown by default.
- Repeated bad access-token hashes temporarily block the portal/IP pair.
- Attachment chunk staging requires a short-lived upload-session token tied to the portal ID and declared attachment manifest.
- Missing, expired, invalid, and unauthenticated portal access paths return generic errors where possible to reduce enumeration signals.
- Structured security logs include rate-limit blocks, invalid portal access, invalid token hashes, OTP throttles, and attachment throttles. Logs must never include plaintext, raw access tokens, OTP values, encrypted payload bodies, or attachment bytes.

## Run

```bash
npm install
npm run start
```

## Production Deployment

Suggested VPS path:

```bash
sudo mkdir -p /opt/unsync/unsync-portal-api
sudo chown -R unsync:unsync /opt/unsync
cd /opt/unsync/unsync-portal-api
npm install --omit=dev
mkdir -p data logs
chmod 700 data logs
pm2 start ecosystem.config.cjs --env production
pm2 save
pm2 startup
```

Health check:

```bash
curl -fsS http://127.0.0.1:8787/health
curl -fsS https://api.mail.unsync.uk/health
```

Update/restart:

```bash
cd /opt/unsync/unsync-portal-api
git pull
npm install --omit=dev
pm2 restart unsync-portal-api --update-env
pm2 logs unsync-portal-api --lines 100
```

Run the app only on localhost behind nginx or a Cloudflare Tunnel. Set `TRUST_PROXY=true` only when nginx/Cloudflare is the trusted entry point and the public internet cannot connect directly to the Node port.

DNS records:

- `mail.unsync.uk` serves reader links such as `https://mail.unsync.uk/read/<portalId>`.
- `api.mail.unsync.uk` serves API upload, OTP, payload, attachment, and ops endpoints.

The desktop app should use:

```bash
UNSYNC_PORTAL_READER_BASE_URL=https://mail.unsync.uk
UNSYNC_PORTAL_API_URL=https://api.mail.unsync.uk
```

`unsyncsoftware.com` and `unsyncnetwork.com` remain separate from the secure portal deployment.

## Environment

Copy `.env.example` into your process manager environment:

```bash
PORT=8787
PORTAL_DATA_DIR=./data
PORTAL_ALLOWED_ORIGIN=https://mail.unsync.uk
PORTAL_PUBLIC_READER_BASE_URL=https://mail.unsync.uk
PORTAL_PUBLIC_API_BASE_URL=https://api.mail.unsync.uk
PORTAL_MAX_BODY_BYTES=524288
PORTAL_MAX_JSON_BODY_BYTES=524288
PORTAL_MAX_ATTACHMENT_CHUNK_BYTES=1052672
TRUST_PROXY=true
PORTAL_ENABLE_HSTS=true
CLEANUP_INTERVAL_MS=300000
CONSUMED_PORTAL_RETENTION_MS=600000
PORTAL_RATE_LIMIT_WINDOW_MS=60000
PORTAL_RATE_LIMIT_MAX=60
OTP_COOLDOWN_MS=60000
BAD_TOKEN_BLOCK_MS=900000
ATTACHMENT_RATE_LIMIT_MAX=120
UPLOAD_SESSION_TTL_MS=900000
STAGED_UPLOAD_RETENTION_MS=900000
OPS_ADMIN_TOKEN=change-me-long-random-token
OPS_EVENTS_MAX=100
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_ALLOW_INSECURE_TRANSPORT=false
SMTP_USER=portal@example.com
SMTP_PASS=change-me
SMTP_FROM=portal@example.com
```

`PORTAL_MAX_JSON_BODY_BYTES` limits JSON API requests such as portal metadata and OTP. `PORTAL_MAX_ATTACHMENT_CHUNK_BYTES` limits encrypted binary chunk uploads. Keep nginx `client_max_body_size` at or slightly above these values so oversized requests are rejected before they reach Node.

When `TRUST_PROXY=false`, requests carrying `Forwarded`, `X-Forwarded-*`, `X-Real-IP`, or Cloudflare client-IP headers are rejected as suspicious. When `TRUST_PROXY=true`, the API uses `CF-Connecting-IP`, `X-Real-IP`, then the first `X-Forwarded-For` value for per-IP throttles.

OTP SMTP defaults to implicit TLS. If `SMTP_SECURE=false`, delivery is rejected unless `SMTP_ALLOW_INSECURE_TRANSPORT=true` is set intentionally for a trusted local relay.

`UPLOAD_SESSION_TTL_MS` controls how long encrypted attachment chunks may be staged before `/portal/create`. `STAGED_UPLOAD_RETENTION_MS` controls cleanup of abandoned staging directories after failed or interrupted sends.

`OPS_ADMIN_TOKEN` protects `/ops` and `/ops/metrics`; use a long random value and send it as `x-unsync-admin-token`. Ops responses expose counts, storage usage, and sanitized recent event metadata only.

## PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

The PM2 config runs one forked process, restarts after crashes with a delay, caps restarts, restarts over 256 MB, and writes logs under `./logs`. Keep `logs/` readable only by the service user because security logs contain portal IDs and hashed identifiers.

## nginx

Use [deploy/nginx-unsync-portal.conf](./deploy/nginx-unsync-portal.conf) as a starting point. It defines separate HTTPS server blocks for `mail.unsync.uk` and `api.mail.unsync.uk`, proxies both to `127.0.0.1:8787` for v1, sets `client_max_body_size`, disables caching for `/portal/*`, `/read/*`, `/reader/*`, and `/ops*`, forwards trusted proxy headers, and adds nginx-side rate-limit zones for API, OTP, and attachment paths.

After installing:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

## Cloudflare

- Use orange-cloud proxying or Cloudflare Tunnel so only HTTPS reaches users.
- Add WAF/rate limiting for `/portal/*`, `/read/*`, `/reader/*`, `/ops*`, and attachment chunk paths.
- Create cache rules that bypass cache for `/portal/*`, `/read/*`, `/reader/*`, and `/ops*`.
- Use “Always Use HTTPS” and a modern TLS mode. If using Tunnel, keep the Node API bound locally and leave `TRUST_PROXY=true`.
- Do not configure Cloudflare to cache API responses or reader HTML; encrypted payload metadata is still sensitive.

## Safe Ops

`GET /ops/metrics` returns JSON with aggregate counters, active session gauges, storage usage, and the bounded recent event ring. `GET /ops` renders the same information as a minimal dark dashboard. Both endpoints return `404` unless `OPS_ADMIN_TOKEN` is configured and the `x-unsync-admin-token` header matches.

Ops never returns plaintext, encrypted payload bodies, raw tokens, OTPs, full recipient emails, raw portal IDs, or attachment bytes. Recent events keep safe fields such as event type, timestamp, hashed IDs, reason, and counts.

## Storage

The v1 service uses `PORTAL_DATA_DIR/portal-records.json` plus encrypted chunk files under `PORTAL_DATA_DIR/attachments/<portalId>/<attachmentId>/<index>.chunk`. See `schema.sql` for the equivalent SQL schema.

One-time-read payloads are marked consumed after the first successful verified payload retrieval. They remain stored for `CONSUMED_PORTAL_RETENTION_MS` to avoid response race conditions, then the cleanup worker purges them.

Set the storage directory to `0700` and run the process as a dedicated unprivileged user. Backups contain encrypted payloads only, but they are still sensitive because they include access metadata, encrypted message blobs, and encrypted attachment chunks. The cleanup worker must remain running so expired and consumed portal records are purged.

## TODO

- Reader hardening and usability polish
- OTP/email delivery hardening and abuse monitoring
- One-time-read revoke
- Secure attachment streaming
- Session destruction
- Automatic cleanup workers
