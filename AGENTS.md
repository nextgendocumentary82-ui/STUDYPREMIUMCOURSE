# AGENTS.md — Base44 dev environment notes

## What this app is

Single-process Node.js (Express 5) app: `server.js` (~145 KB) serves **both** the REST API (`/api/*`) and the static frontend (`public/`). One origin, one port. No build step — `public/` files are served as-is.

## Why commit 74b7fb3 "failed to start" on main

The commit changed `public/app.js`:

```js
// before: hardcoded Cloudflare Worker backend
const API_BASE = "https://studypremiumcourse.omprakashverma4344.workers.dev";
// after: same origin as the page
const API_BASE = window.location.origin;
```

This is the **correct** value for the single-origin Express setup (API and frontend on the same port). The "failure" was an environment/deployment issue, not a code bug: the app needs MongoDB + required env vars at boot, and the frontend previously pointed at an external Worker that was no longer the backend. With a local MongoDB and the required secrets the app boots and serves both pages and API from one origin.

## Required env vars at boot

- `JWT_SECRET` — app exits immediately if missing.
- `MONGODB_URI` — `startServer()` throws if missing. **Overridden in the sandbox** to point at the local compose `mongo` service; set your Atlas URI for production.
- `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_SECRET_KEY` — auto-creates the admin account on first boot.

Optional (lazy, won't block startup): `RAZORPAY_*`, `B2_*`, `CASHFREE_*`, `SMTP_*`, `PUBLIC_URL`.

## Running in the sandbox

```
docker compose -f docker-compose.base44.yml up -d --build
```

- `mongo` service: local MongoDB 7 with a named volume.
- `web` service: `node:22-slim`, source bind-mounted at `/app`, `node_modules` in a named volume. Deps install on container start; `nodemon` watches `server.js` for live reload.
- `MONGODB_URI` is set in compose `environment:` to `mongodb://mongo:27017/study-premium-course` — this intentionally overrides the user's Atlas URI so the sandbox uses the local DB.
- `PORT=3000` so the preview proxy (host port 3000) reaches the app.
- Healthcheck: `node -e "fetch('http://localhost:3000/')…"`.

## Verifying it works

- `curl http://localhost:3000/` → serves `public/index.html` (200).
- `curl http://localhost:3000/api/apps` → JSON array of demo apps.
- Open the preview: home page renders with dark/yellow theme, no console errors.
- Admin: `http://localhost:3000/admin.html` — login with `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_SECRET_KEY`.

## Frontend edits

`public/` files are static — edit and refresh the browser. `server.js` changes trigger nodemon auto-restart; if a change isn't picked up, call `reload_preview`.
