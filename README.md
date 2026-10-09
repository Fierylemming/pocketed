# Pocketed v2

Your personal "things I need to remember" app.

- **Website** — a real URL on Cloudflare Pages. Open it, type your password once, done. No terminal, ever.
- **Phone app** — Android (Expo / React Native) with a home-screen widget and reminder notifications. *(being rebuilt right after this)*
- **Sync server** — a Cloudflare Worker + D1 database. Free tier, no maintenance.
- **Offline-first** — every device keeps a local copy; changes sync when online; conflicts resolve last-write-wins.

## Layout

```
packages/shared   sync engine, reminders, widget data (pure TS, used everywhere)
server            the Cloudflare Worker + D1 store
web               the website (React, static build -> Cloudflare Pages)
apps/mobile       the Android app (widget + notifications)
.github/workflows tests + auto-deploy on every push
```

## One-time setup (see SETUP.md for the full walkthrough)

1. `npm install`
2. `npx wrangler login`
3. `npx wrangler d1 create pocketed-v2` → paste the id into `server/wrangler.toml`
4. No password step — the website asks you to create one on first open
   (and shows a one-time recovery key). Change/reset lives in ⚙️ Settings.
5. `npm run deploy:server` → your worker URL
6. Create the Pages project once: `npx wrangler pages project create <name> --production-branch=main`
7. Push to GitHub; add the repo secrets/variables listed in `.github/workflows/deploy.yml`.
   Every push now redeploys server **and** website automatically.

## Local development (optional)

```
npm test                # all suites
npm run typecheck
npm run dev -w @pocketed/web   # http://localhost:5173
```
