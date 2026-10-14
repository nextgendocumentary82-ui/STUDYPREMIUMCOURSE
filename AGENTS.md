# Base44 dev environment — STUDY PREMIUM COURSE

## Stack
- Node.js 22 + Express (single `server.js`, ~5k lines). No bundler, no live-reload dev server.
- MongoDB (mongoose). Required at boot — the app exits if `MONGODB_URI` is missing.
- Static frontend is served from `public/` by Express itself.
- Health endpoint: `GET /api/health`.

## Running
```
docker compose -f docker-compose.base44.yml up -d --build
```
The app listens on host port 3000. There is no hot reload — after editing source, restart the `web` service (or call reload_preview).

## Required env (boot)
- `MONGODB_URI` — provided by the compose `mongo` service (local).
- `JWT_SECRET` — app exits without it. A dev placeholder is generated into `/run/base44/app.env`.
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_SECRET_KEY` — admin login. Dev placeholders generated; replace with real values for the admin panel.

## Optional external integrations (do not block boot)
- Razorpay (`RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET`) — paid checkout & signature verification.
- Cashfree (`CASHFREE_APP_ID` / `CASHFREE_SECRET_KEY`).
- Backblaze B2 (`B2_KEY_ID` / `B2_APPLICATION_KEY` / `B2_BUCKET_NAME` / `B2_BUCKET_ID`) — admin file uploads.
- SMTP (`SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`) — donation emails. `DONATION_DEV_OTP=true` enables dev OTP without SMTP.

Provide any of these via the Base44 secrets dashboard; they land in `/run/base44/app.env`.

## Admin
Open `/admin.html` and log in with the admin username/password/secret key.
