# Pocketed v2 — setup (laptop, Windows, PowerShell)

Assumes v1 was completed: Node + Git installed, `wrangler login` done, GitHub repo exists,
Cloudflare account exists and the `POCKETED_TOKENS` secret is set (your password — it carries over).

## 1. New code on the laptop

Download `pocketed-v2.zip`. Rename the old folder `…\Calendar\pocketed` to `pocketed-old`
(keep it as a spare), extract the zip so you get a fresh `…\Calendar\pocketed`.

```powershell
cd C:\Users\maxha\Desktop\Apps\Calendar\pocketed
npm install
```

## 2. New database

```powershell
npx wrangler d1 create pocketed-v2
```
Copy the printed `database_id`, open `server\wrangler.toml` in Notepad,
replace `PASTE_YOUR_DATABASE_ID_HERE`, save.

## 3. Password — now lives in the app itself

Nothing to do in the terminal. When you first open the new website it asks you to
**create** a password and shows a one-time **recovery key** (write it down).
Later, ⚙️ Settings lets you change the password or generate a new recovery key.
PowerShell / dashboard are only ever needed for code updates.

## 4. Deploy the server once

```powershell
npm run deploy:server
```
✔ prints `https://pocketed-….workers.dev`. Open `…/health` → you should see `"version":"2"`.

## 5. Create the website's home (once)

```powershell
npx wrangler pages project create pocketed-fierylemming --production-branch=main
```
(Any name you like; `pocketed-<yourname>` is usually free. Remember it.)

## 6. GitHub plumbing (once)

1. Cloudflare dashboard → avatar → **My Profile → API Tokens** → your token → **Edit** →
   add the row *Account · Pages · Edit* → Save.
2. GitHub repo → **Settings → Secrets and variables → Actions → Variables** tab → add:
   - `WORKER_URL` = `https://pocketed-maxha.workers.dev` (your worker address from step 4)
   - `PAGES_PROJECT` = the name from step 5

(The two *secrets* from v1 stay as they are.)

## 7. Push the new code (replaces the old repo content)

```powershell
git init
git branch -M main
git add -A
git commit -m "Pocketed v2"
git remote add origin https://github.com/Fierylemming/pocketed.git
git push -u origin main --force
```
✔ Actions tab → "Deploy Pocketed" goes green (tests → server → website).

## 8. Use it

Open **https://pocketed-fierylemming.pages.dev** (your name from step 5).
Type your password once. Bookmark it / pin the tab. That's the whole daily ritual now:
open the page, type notes.

## 9. Optional v1 cleanup (after everything above works)

```powershell
npx wrangler d1 delete pocketed        # the old v1 database
```
and delete the `pocketed-old` folder on the laptop.

## 10. Phone app

Arrives as the next update; installs over nothing, uses the same password and server.
