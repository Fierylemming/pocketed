# Setup & deploy

This covers how Pocketed is deployed and what each piece needs. For everyday changes, you only
need the **push → pull request → merge** loop in the README; the workflows do the rest.

Commands below work in PowerShell, Command Prompt, macOS and Linux shells.

## 1. Accounts you need

- **GitHub**: the repository (`Fierylemming/pocketed`).
- **Cloudflare**: a free account with Workers and Pages enabled.

## 2. Install (once per machine, only if you run things locally)

Requires Node 20 or newer.

```
npm install
npx wrangler login          # opens a browser; only needed for manual deploys
```

## 3. Database (already set up for this project)

`server/wrangler.toml` already holds the D1 database id. If you ever start from scratch:

```
npx wrangler d1 create pocketed-v2
```

Paste the printed `database_id` into `server/wrangler.toml`.

## 4. Password and recovery key

Nothing to configure. On first visit the website asks you to create a password and shows a
one-time **recovery key**. Change the password or generate a new recovery key in ⚙️ Settings.

## 5. GitHub settings (once)

**Settings → Secrets and variables → Actions**

Secrets:

| Name | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Custom token with: Account · Workers Scripts: Edit, Account · D1: Edit, Account · Pages: Edit, Account · Account Settings: Read |
| `CLOUDFLARE_ACCOUNT_ID` | Shown on the Cloudflare **Workers & Pages** overview page |

Variables:

| Name | Value |
| --- | --- |
| `WORKER_URL` | Your worker address, e.g. `https://pocketed.<your-subdomain>.workers.dev` (baked into the site) |
| `PAGES_PROJECT` | Your Pages project name, e.g. `pocketed-yourname` |

## 6. Cloudflare Pages project (once)

```
npx wrangler pages project create pocketed-yourname --production-branch=main
```

Use the same name as `PAGES_PROJECT` above.

## 7. Deploy

Deploys are automatic: every merge to `main` runs **Deploy Pocketed** (tests → typecheck →
server → website). You can also run it by hand from the **Actions** tab (*Run workflow*).

Manual deploys from your machine, if ever needed:

```
npm run deploy:server       # sync server
npm run check               # tests + typecheck + build
VITE_SERVER_URL=https://pocketed.<your-subdomain>.workers.dev npm run build:web
npx wrangler pages deploy web/dist --project-name=pocketed-yourname --branch=main
```

Check the server with `https://<worker>/health`: it should report `"version":"2"`.

## 8. Troubleshooting

- **CI fails on the build step**: `WORKER_URL` isn't set. Add it under Variables.
- **Deploy fails with an auth error**: the Cloudflare token is missing one of the permissions in step 5.
- **Site says "Can't reach that server address"**: check `/health` on the worker; check the address under
  "advanced: custom server address" on the login screen.
- **Notifications don't appear**: check ⚙️ Settings → Reminder alerts. The app must be running (open or in the background).
