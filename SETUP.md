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
stored in D1. **Sign in with Google** (which imports all readable calendars and copies event colours) needs step 8 first.

## 8. Sign in with Google (optional, once — multiple accounts, calendars and Google colours)

Google only reveals event colours to apps you sign in to, so Pocketed needs its own Google "OAuth client".
It's free and takes about 10 minutes at **console.cloud.google.com**:

1. **Create a project**: project picker (top bar) → **New project** → name it `Pocketed` → Create, then
   select it.
2. **Turn on the Calendar API**: ☰ → **APIs & Services** → **Library** → search **Google Calendar API** →
   **Enable**.
3. **Consent screen**: ☰ → **APIs & Services** → **OAuth consent screen** (or **Google Auth Platform**) →
   Get started. App name `Pocketed`, your email as support and contact address, Audience **External**.
   - Under **Data access** → **Add or remove scopes**, add
     `https://www.googleapis.com/auth/calendar.readonly`, plus the basic sign-in scopes `openid` and
     `https://www.googleapis.com/auth/userinfo.email`, then Save. Pocketed reads only the signed-in account's own
     identity/email, not a roster or other people's profiles.
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

Then in the app: ⚙️ Settings → Google Calendar → **Sign in with Google** for your home account, then
**Add Google Calendar account** for your school account. All readable calendars on each account are
imported independently. Google's account chooser appears each time. Existing connections migrate
without losing their event IDs; existing Calendar tokens keep working, but the next reconnect also
requests basic identity. No extra OAuth client or Worker secrets are needed per account.

Under **Show Calendar events from**, untick the school account to isolate your home events while keeping
school **Classroom assignments** visible. You can also use these switches directly above the calendar.
Choices apply across all devices using this workspace; online devices pick them up on normal sync
(normally within 15 seconds). This only filters the calendar view: hidden events still sync and remain
in reminder lists/search, and their alerts continue. Turning an account back on restores its view without
reimporting or undoing manually completed reminders.

Use **External** audience for both personal and school identities. If the app is in Testing, add **both
Google addresses** to the test-user list where the school permits it. School administrators may block
Calendar permissions as well as Classroom; approval is separate from Google's publishing/verification.
Deploy the updated **server first, then website**, and reload/update all clients. Up to 10 Calendar accounts
and 10 Classroom accounts can be connected. These are integrations in one Pocketed workspace, **not
separate Pocketed users or private note spaces**. A secret link remains an alternative to all Calendar
accounts, not an additional account; replacing multiple accounts requires explicit confirmation.

If the Worker is served from a different address than its `workers.dev` URL (e.g. a custom domain), set
that callback address as the Worker secret `GOOGLE_REDIRECT_URI` too:
`npx wrangler secret put GOOGLE_REDIRECT_URI` in `server/`.

## 9. Google Classroom (optional — student assignment deadlines)

Classroom adds assignment deadlines to **Pocketed's** calendar; it does not create events in Google
Calendar or submit schoolwork. It works independently of the Calendar connection, including with a
separate school Google account. Multiple student connections can coexist; they and their reminders are
shared by the whole Pocketed workspace, not separate user logins.

Use the **same Google Cloud project and OAuth Web application client** as step 8. If Google OAuth is not
set up yet, create the project, consent screen and Web application client, then add `GOOGLE_CLIENT_ID`
and `GOOGLE_CLIENT_SECRET` to the Worker as in step 8. You do not need Calendar API access for a
Classroom-only connection.

1. **Enable Google Classroom API**: in **console.cloud.google.com**, select the project → **APIs & Services**
   → **Library** → search **Google Classroom API** → **Enable**.
2. **Add the read-only permissions** under **Google Auth Platform → Data access → Add or remove scopes**:

   | Scope | Why |
   | --- | --- |
   | `https://www.googleapis.com/auth/classroom.courses.readonly` | List the student's active enrolled classes |
   | `https://www.googleapis.com/auth/classroom.coursework.me.readonly` | Read published assignment/question metadata and deadlines for that student |

   The connection also requests `openid` and `email` to identify the connected account. Google's coursework
   permission label mentions **grades**, but Pocketed's requests do **not** fetch grades or submissions.
   Leave the existing Calendar permission in place if you use Calendar too; the Classroom button requests
   only the Classroom and basic identity scopes, not Calendar or Drive permissions.
3. **Add a redirect URI** to the existing Web application client under **Clients** (or **Credentials**):
   `https://pocketed.<your-subdomain>.workers.dev/v1/classroom/callback`, i.e. your `WORKER_URL` +
   `/v1/classroom/callback`. **Keep** the existing `/v1/google/callback` URI for Calendar.
4. **Custom Worker address?** Add its exact Classroom callback address in Google too, and set the Worker
   secret `GOOGLE_CLASSROOM_REDIRECT_URI` to that address. This is separate from `GOOGLE_REDIRECT_URI`:
   do not replace Calendar's callback with Classroom's. Both callbacks must use `https://` and match exactly.
5. **Deploy both server and website**, then open ⚙️ Settings → **Google Classroom** → **Connect Google Classroom**.
   Select the **student's own account** and grant the read-only permissions. Pocketed imports immediately,
   and then checks every 15 minutes while open. Use **Add Classroom account** to add another student
   without replacing the first. **Check now** and **Disconnect Classroom** apply to the specific student
   card. Calendar event switches never hide Classroom assignments.

**School accounts:** the school's Google Workspace administrator may need to allow Pocketed's OAuth
client and Classroom permissions, especially for under-18 accounts. Ask the administrator rather than
trying to bypass their policy. A guardian/parent account cannot read the student's assignments with this
student-only integration. If the OAuth app is in **Testing**, add the student as a test user where the school
policy allows it; ongoing access can expire after 7 days. Publishing/verification and administrator approval
are separate Google requirements and may be needed for wider use.

Assignments without a due date are counted in Settings but cannot go on a dated calendar. The initial
window is the next 60 days plus the last 30 days, with up to 500 new imports per account per check. This does not read
submission status: already-submitted work may still show, and marking a reminder done in Pocketed never
submits it in Classroom. See the README for update, dismissal and disconnect behaviour.

## 10. Troubleshooting

- **CI fails on the build step**: `WORKER_URL` isn't set. Add it under Variables.
- **Deploy fails with an auth error**: the Cloudflare token is missing one of the permissions in step 5.
- **Site says "Can't reach that server address"**: check `/health` on the worker; check the address under
  "advanced: custom server address" on the login screen.
- **Google Calendar says "didn't accept that link"**: the secret address was reset in Google. Copy it again
  and use ⚙️ Settings → Google Calendar → **Use a secret link instead**. Make sure it's the *secret* address, not the public one.
- **Google Calendar changes are slow to appear**: the app checks every 15 minutes while it's open. Tap
  **Check now** to check straight away.
- **Google Calendar says "The sync server needs updating"**: the website was deployed before the server.
  Re-run **Deploy Pocketed** from the Actions tab.
- **Google says "Error 400: redirect_uri_mismatch"**: the redirect URI in the Google client (step 8.4) must be
  exactly your worker address + `/v1/google/callback`, with `https://` and no trailing slash.
- **Google says "Access blocked: Pocketed has not completed the Google verification process"**: the app
  is still in *Testing*. Publish it (step 8.3), or add your Google address under **Audience** → **Test users**.
- **"Google no longer accepts Pocketed's sign-in"**: access was removed, the password changed, or the app was
  left in *Testing* (7-day limit). Use **Reconnect** on that account's card and choose the same Google account.
- **No "Sign in with Google" button**: the Worker doesn't have both `GOOGLE_CLIENT_ID` and
  `GOOGLE_CLIENT_SECRET` (step 8.5), or the server running is older than this feature. Re-run **Deploy
  Pocketed**, then reopen Settings.
- **No Classroom connect button**: check `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` on the Worker,
  and deploy both the updated server and website. A missing Classroom API is reported on the first check.
- **Classroom "redirect_uri_mismatch"**: add `WORKER_URL` + `/v1/classroom/callback` to the OAuth Web
  client. A Calendar callback alone is not enough. For a custom address, check `GOOGLE_CLASSROOM_REDIRECT_URI`.
- **Classroom refuses access (403)**: enable **Google Classroom API** in the project that owns the OAuth
  client, grant both read-only scopes, and ask the school's administrator whether Pocketed is allowed.
- **No Classroom assignments appear**: connect the student's own account, not a guardian/parent account.
  Only active enrolled classes and published work with a valid deadline are imported. Undated work is counted
  in Settings, not added to the calendar; new deadlines outside the 60-day/30-day window are not imported.
- **Too many Classroom pages / too much coursework**: the check refuses a partial list to keep existing
  reminders safe. There are page and Worker subrequest limits; this version does not have a class selector.
- **Classroom says to connect again**: Google may have revoked or expired the token. Use **Reconnect** on
  the student's card and choose that same Google account. Other connections are not replaced.
- **An account's events are missing but assignments still appear**: check **Show Calendar events from**.
  An off account is hidden in the calendar on every updated device, not disconnected. Its Classroom work stays visible.
- **An account switch won't save**: changes require internet access. The previous choice stays in force if saving fails.
- **Old clients say to choose an account / accountId is required**: update/reload that client. The server refuses
  ambiguous multi-account feed or disconnect requests instead of accidentally using/removing the wrong account.
- **Notifications don't appear**: check ⚙️ Settings → Reminder alerts. The app must be running (open or in the background).
