# 🚂 Multiverse — 24/7 Autonomous Railway Stealth Harvester & Daemon

This repository contains the standalone, headless Playwright worker and autonomous daemon for Multiverse.

## 🌟 What It Does
- Runs 24/7 on Railway via Docker.
- Automatically generates disposable emails, solves Cloudflare Turnstile, fetches OTPs, clears Terms of Service, and harvests Railway GraphQL API tokens.
- Directly updates Cloudflare D1 SQL database so the Vercel dashboard stays synced in real-time.

## 🚀 Railway Deployment Instructions
1. Push this repository to GitHub.
2. In Railway, click **New Project** -> **Deploy from GitHub repo**.
3. Select this repository.
4. Add your Environment Variables:
   - `CLOUDFLARE_ACCOUNT_ID`
   - `CLOUDFLARE_D1_DATABASE_ID`
   - `CLOUDFLARE_API_TOKEN`
   - `DAEMON_PORT=4000`
   - `POLL_INTERVAL_MS=4000`
5. Railway will automatically build the `Dockerfile` and run `node auto_railway_daemon.js` continuously!
