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

The secret-link Google Calendar import needs no extra setup: the link is pasted in the app's ⚙️ Settings and
stored in D1. **Sign in with Google** (which copies event colours) needs step 8 first.

## 8. Sign in with Google (optional, once — for Google Calendar colours)

Google only reveals event colours to apps you sign in to, so Pocketed needs its own Google "OAuth client".
It's free and takes about 10 minutes at **console.cloud.google.com**:

1. **Create a project**: project picker (top bar) → **New project** → name it `Pocketed` → Create, then
   select it.
2. **Turn on the Calendar API**: ☰ → **APIs & Services** → **Library** → search **Google Calendar API** →
   **Enable**.
3. **Consent screen**: ☰ → **APIs & Services** → **OAuth consent screen** (or **Google Auth Platform**) →
   Get started. App name `Pocketed`, your email as support and contact address, Audience **External**.
   - Under **Data access** → **Add or remove scopes**, add
     `https://www.googleapis.com/auth/calendar.readonly` and Save.
   - Under **Audience**, click **Publish app** (status **In production**). Leave it in *Testing* and Google
     signs Pocketed out **every 7 days**. You don't need Google's verification for personal use. When you sign
     in, Google shows a "Google hasn't verified this app" warning: click **Advanced** → **Go to Pocketed
     (unsafe)**. It's your own app.
4. **Create the client**: **Clients** (or **Credentials** → **Create credentials** → **OAuth client ID**) →
   type **Web application**, name `Pocketed`.
   - **Authorised redirect URIs**: add `https://pocketed.<your-subdomain>.workers.dev/v1/google/callback`,
     which is your `WORKER_URL` + `/v1/google/callback`.
   - Create, then copy the **Client ID** and **Client secret**.
5. **Give them to the Worker**: dash.cloudflare.com → **Workers & Pages** → **pocketed** → **Settings** →
   **Variables and Secrets** → **Add**.
   - Add type **Secret**, name `GOOGLE_CLIENT_ID`, value the Client ID → Save (deploy).
   - Do the same for `GOOGLE_CLIENT_SECRET`.
   - Secrets stay in place across future deploys, so this is a one-off. From a terminal, the same is
     `npx wrangler secret put GOOGLE_CLIENT_ID` (and `…_SECRET`) in `server/`.

Then in the app: ⚙️ Settings → Google Calendar → **Sign in with Google**. If a secret link was connected,
your imported reminders are kept and recoloured.

If the Worker is served from a different address than its `workers.dev` URL (e.g. a custom domain), set
that callback address as the Worker secret `GOOGLE_REDIRECT_URI` too:
`npx wrangler secret put GOOGLE_REDIRECT_URI` in `server/`.

## 9. Troubleshooting

- **CI fails on the build step**: `WORKER_URL` isn't set. Add it under Variables.
- **Deploy fails with an auth error**: the Cloudflare token is missing one of the permissions in step 5.
- **Site says "Can't reach that server address"**: check `/health` on the worker; check the address under
  "advanced: custom server address" on the login screen.
- **Google Calendar says "didn't accept that link"**: the secret address was reset in Google. Copy it again
  and use ⚙️ Settings → Google Calendar → **Change link**. Make sure it's the *secret* address, not the public one.
- **Google Calendar changes are slow to appear**: the app checks every 15 minutes while it's open. Tap
  **Check now** to check straight away.
- **Google Calendar says "The sync server needs updating"**: the website was deployed before the server.
  Re-run **Deploy Pocketed** from the Actions tab.
- **Google says "Error 400: redirect_uri_mismatch"**: the redirect URI in the Google client (step 8.4) must be
  exactly your worker address + `/v1/google/callback`, with `https://` and no trailing slash.
- **Google says "Access blocked: Pocketed has not completed the Google verification process"**: the app
  is still in *Testing*. Publish it (step 8.3), or add your Google address under **Audience** → **Test users**.
- **"Google no longer accepts Pocketed's sign-in"**: access was removed, the password changed, or the app was
  left in *Testing* (7-day limit). Tap **Sign in with Google again** in Settings.
- **No "Sign in with Google" button**: the Worker doesn't have both `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET` (step 8.5), or the server running is older than this feature. Re-run **Deploy
  Pocketed**, then reopen Settings.
- **Notifications don't appear**: check ⚙️ Settings → Reminder alerts. The app must be running (open or in the background).
